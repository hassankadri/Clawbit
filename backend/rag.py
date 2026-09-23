from pathlib import Path
from typing import List
import json
import mimetypes
import re
from uuid import uuid4
from dotenv import load_dotenv
import os
import certifi

load_dotenv()

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

from langchain_chroma import Chroma
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import ChatGoogleGenerativeAI

import docx2txt
from pypdf import PdfReader


UPLOAD_ROOT = Path("uploads")
CHROMA_ROOT = Path("chroma_db")
UPLOAD_ROOT.mkdir(exist_ok=True)
CHROMA_ROOT.mkdir(exist_ok=True)

# Embeddings model
embeddings = GoogleGenerativeAIEmbeddings(model="gemini-embedding-001")

vision_model = ChatGoogleGenerativeAI(
    model="gemini-latest",
    temperature=0
)

vectorstore = Chroma(
    collection_name="agentic_chatbot_docs",
    embedding_function=embeddings,
    persist_directory=str(CHROMA_ROOT)
)

SUPPORTED_DOCUMENT_SUFFIXES = {".pdf", ".docx", ".txt", ".md", ".csv"}
SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def _thread_upload_dir(thread_id: str) -> Path:
    directory = UPLOAD_ROOT / thread_id
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _manifest_path(thread_id: str) -> Path:
    return _thread_upload_dir(thread_id) / "manifest.json"


def _load_manifest(thread_id: str) -> list[dict]:
    path = _manifest_path(thread_id)

    if not path.exists():
        return []

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_manifest(thread_id: str, manifest: list[dict]) -> None:
    _manifest_path(thread_id).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _sanitize_filename(filename: str) -> str:
    filename = Path(filename).name
    filename = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("._")
    return filename or "upload"


def _detect_kind(file_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix in SUPPORTED_DOCUMENT_SUFFIXES:
        return "document"
    if suffix in SUPPORTED_IMAGE_SUFFIXES:
        return "image"
    raise ValueError("Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, or image files.")


def _preview_text(text: str, limit: int = 5000) -> str:
    cleaned = " ".join(text.split())
    return cleaned[:limit]


def get_attachment_records(thread_id: str, attachment_ids: list[str] | None = None) -> list[dict]:
    manifest = _load_manifest(thread_id)

    if not attachment_ids:
        return manifest

    attachment_id_set = set(attachment_ids)
    return [item for item in manifest if item.get("attachment_id") in attachment_id_set]


def save_uploaded_file(file_path: str, thread_id: str, original_name: str | None = None):
    path = Path(file_path)
    kind = _detect_kind(path)
    attachment_id = uuid4().hex
    display_name = original_name or path.name
    mime_type = mimetypes.guess_type(display_name)[0] or path.suffix.lower().lstrip(".")

    record = {
        "attachment_id": attachment_id,
        "name": display_name,
        "kind": kind,
        "mime_type": mime_type,
        "size": path.stat().st_size,
        "path": str(path),
        "source": path.name,
        "preview": None,
        "rag_error": None,
    }

    if kind == "document":
        try:
            extracted_text = read_file_text(str(path))
        except Exception as exc:
            raise ValueError(f"Could not read this file: {exc}")

        if not extracted_text.strip():
            raise ValueError("No text could be extracted from this file.")

        record["preview"] = _preview_text(extracted_text)

        try:
            add_document_to_rag(
                str(path),
                thread_id,
                attachment_id=attachment_id,
                source=display_name,
            )
        except Exception as exc:
            record["rag_error"] = str(exc)

        if not record["preview"]:
            record["preview"] = None

    manifest = _load_manifest(thread_id)
    manifest = [item for item in manifest if item.get("attachment_id") != attachment_id]
    manifest.append(record)
    _save_manifest(thread_id, manifest)

    return record



def read_file_text(file_path: str) -> str:
    path = Path(file_path)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        reader = PdfReader(file_path)
        text = ""

        for page in reader.pages:
            text += page.extract_text() or ""
            text += "\n"

        return text

    if suffix == ".docx":
        return docx2txt.process(file_path)

    if suffix in [".txt", ".md", ".py", ".csv"]:
        return path.read_text(encoding="utf-8", errors="ignore")

    raise ValueError("Unsupported file type. Upload PDF, DOCX, TXT, MD, or CSV.")



def add_document_to_rag(file_path: str, thread_id: str, attachment_id: str | None = None, source: str | None = None):
    text = read_file_text(file_path)

    if not text.strip():
        raise ValueError("No text could be extracted from this file.")

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=900,
        chunk_overlap=150
    )

    chunks = splitter.split_text(text)

    docs: List[Document] = [
        Document(
            page_content=chunk,
            metadata={
                "thread_id": thread_id,
                "attachment_id": attachment_id or Path(file_path).name,
                "source": source or Path(file_path).name
            }
        )
        for chunk in chunks
    ]

    vectorstore.add_documents(docs)

    return {
        "filename": Path(file_path).name,
        "chunks": len(docs)
    }



def build_attachment_context(thread_id: str, attachment_ids: list[str] | None = None) -> str:
    records = get_attachment_records(thread_id, attachment_ids)

    if not records:
        return ""

    parts = ["Uploaded files available to this conversation:"]

    for record in records:
        line = f"- {record.get('name', 'uploaded file')} ({record.get('kind', 'file')})"
        preview = record.get("preview")
        if preview and record.get("kind") == "document":
            line += f"\n  Context preview: {preview[:2000]}"
        parts.append(line)

    return "\n".join(parts)


def retrieve_from_rag(query: str, thread_id: str, attachment_ids: list[str] | None = None, k: int = 4) -> str:
    try:
        docs = vectorstore.similarity_search(
            query,
            k=max(k * 4, 12),
            filter={"thread_id": thread_id}
        )
    except Exception:
        docs = []

    if attachment_ids:
        attachment_id_set = set(attachment_ids)
        docs = [
            doc
            for doc in docs
            if doc.metadata.get("attachment_id") in attachment_id_set
        ]

    docs = docs[:k]

    if not docs:
        records = get_attachment_records(thread_id, attachment_ids)
        previews = [
            f"[Source {index}: {record.get('name', 'uploaded document')}]\n{record.get('preview')}"
            for index, record in enumerate(records, start=1)
            if record.get("kind") == "document" and record.get("preview")
        ]

        if previews:
            return "\n\n".join(previews[:k])

        return "No relevant uploaded document content found."

    results = []

    for i, doc in enumerate(docs, start=1):
        source = doc.metadata.get("source", "uploaded document")
        results.append(
            f"[Source {i}: {source}]\n{doc.page_content}"
        )

    return "\n\n".join(results)