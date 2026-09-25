from pathlib import Path
from typing import List
import json
import mimetypes
import re
from uuid import uuid4
from dotenv import load_dotenv
import os
import certifi
from rank_bm25 import BM25Okapi
from flashrank import Ranker, RerankRequest

ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

from langchain_chroma import Chroma
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import ChatGoogleGenerativeAI

import docx2txt
from pypdf import PdfReader


BACKEND_DIR = Path(__file__).resolve().parent

UPLOAD_ROOT = BACKEND_DIR / "uploads"
CHROMA_ROOT = BACKEND_DIR / "chroma_db"

UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
CHROMA_ROOT.mkdir(parents=True, exist_ok=True)

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



def add_document_to_rag(
    file_path: str,
    thread_id: str,
    attachment_id: str | None = None,
    source: str | None = None,
):
    path = Path(file_path)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=900,
        chunk_overlap=150
    )

    docs: List[Document] = []

    if path.suffix.lower() == ".pdf":
        reader = PdfReader(file_path)

        for page_number, page in enumerate(reader.pages, start=1):
            page_text = page.extract_text() or ""

            if not page_text.strip():
                continue

            chunks = splitter.split_text(page_text)

            for chunk in chunks:
                docs.append(
                    Document(
                        page_content=chunk,
                        metadata={
                            "thread_id": thread_id,
                            "attachment_id": attachment_id or path.name,
                            "source": source or path.name,
                            "page": page_number,
                        },
                    )
                )

    else:
        text = read_file_text(file_path)

        if not text.strip():
            raise ValueError("No text could be extracted from this file.")

        chunks = splitter.split_text(text)

        for chunk in chunks:
            docs.append(
                Document(
                    page_content=chunk,
                    metadata={
                        "thread_id": thread_id,
                        "attachment_id": attachment_id or path.name,
                        "source": source or path.name,
                    },
                )
            )

    if not docs:
        raise ValueError("No text could be extracted from this file.")

    vectorstore.add_documents(docs)

    return {
        "filename": path.name,
        "chunks": len(docs),
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

def _tokenize_for_bm25(text: str) -> list[str]:
    return re.findall(
        r"[a-z0-9]+(?:[-_./][a-z0-9]+)*",
        text.lower(),
    )

def _bm25_search(
    query: str,
    thread_id: str,
    attachment_ids: list[str] | None = None,
    limit: int = 12,
) -> list[Document]:
    search_filter = {"thread_id": thread_id}

    if attachment_ids:
        if len(attachment_ids) == 1:
            attachment_filter = attachment_ids[0]
        else:
            attachment_filter = {"$in": attachment_ids}

        search_filter = {
            "$and": [
                {"thread_id": thread_id},
                {"attachment_id": attachment_filter},
            ]
        }

    data = vectorstore.get(
        where=search_filter,
        include=["documents", "metadatas"],
    )

    documents = data.get("documents") or []
    metadatas = data.get("metadatas") or []

    if not documents:
        return []

    tokenized_documents = [
        _tokenize_for_bm25(document)
        for document in documents
    ]

    tokenized_query = _tokenize_for_bm25(query)

    if not tokenized_query:
        return []

    bm25 = BM25Okapi(tokenized_documents)
    scores = bm25.get_scores(tokenized_query)

    ranked_indexes = sorted(
        range(len(documents)),
        key=lambda index: scores[index],
        reverse=True,
    )

    results = []

    for index in ranked_indexes[:limit]:
        results.append(
            Document(
                page_content=documents[index],
                metadata=metadatas[index],
            )
        )

    return results

def _merge_hybrid_results(
    vector_docs: list[Document],
    bm25_docs: list[Document],
    limit: int = 12,
) -> list[Document]:
    scores = {}
    documents = {}

    for ranked_docs in (vector_docs, bm25_docs):
        for rank, doc in enumerate(ranked_docs, start=1):
            key = (
                doc.metadata.get("attachment_id"),
                doc.metadata.get("page"),
                doc.page_content,
            )

            documents[key] = doc

            scores[key] = scores.get(key, 0) + (1 / rank)

    ranked_keys = sorted(
        scores,
        key=scores.get,
        reverse=True,
    )

    return [
        documents[key]
        for key in ranked_keys[:limit]
    ]

_RERANKER = None


def _get_reranker() -> Ranker:
    global _RERANKER

    if _RERANKER is None:
        cache_dir = BACKEND_DIR / "data" / "flashrank"
        cache_dir.mkdir(parents=True, exist_ok=True)

        _RERANKER = Ranker(
            cache_dir=str(cache_dir),
        )

    return _RERANKER


def _rerank_documents(
    query: str,
    docs: list[Document],
    limit: int = 4,
) -> list[Document]:
    if not docs:
        return []

    passages = [
        {
            "id": str(index),
            "text": doc.page_content,
            "meta": {},
        }
        for index, doc in enumerate(docs)
    ]

    request = RerankRequest(
        query=query,
        passages=passages,
    )

    ranked_results = _get_reranker().rerank(request)

    reranked_docs = []

    for result in ranked_results[:limit]:
        index = int(result["id"])
        reranked_docs.append(docs[index])

    return reranked_docs

def retrieve_from_rag(
    query: str,
    thread_id: str,
    attachment_ids: list[str] | None = None,
    k: int = 4,
    inspector: dict | None = None,
) -> str:
    records = get_attachment_records(
        thread_id,
        attachment_ids,
    )

    document_attachment_ids = [
        record["attachment_id"]
        for record in records
        if (
            record.get("kind") == "document"
            and record.get("attachment_id")
        )
    ]

    search_limit = max(k * 4, 12)

    vector_docs = []
    bm25_docs = []
    docs = []

    retrieval_error = False

    try:
        if attachment_ids and not document_attachment_ids:
            vector_docs = []
            bm25_docs = []

        else:
            search_filter = {
                "thread_id": thread_id
            }

            if document_attachment_ids:
                if len(document_attachment_ids) == 1:
                    attachment_filter = (
                        document_attachment_ids[0]
                    )
                else:
                    attachment_filter = {
                        "$in": document_attachment_ids
                    }

                search_filter = {
                    "$and": [
                        {
                            "thread_id": thread_id
                        },
                        {
                            "attachment_id":
                                attachment_filter
                        },
                    ]
                }

            vector_docs = vectorstore.similarity_search(
                query,
                k=search_limit,
                filter=search_filter,
            )

            bm25_docs = _bm25_search(
                query,
                thread_id,
                document_attachment_ids,
                limit=search_limit,
            )

        docs = _merge_hybrid_results(
            vector_docs,
            bm25_docs,
            limit=search_limit,
        )

    except Exception:
        docs = []
        retrieval_error = True

    if inspector is not None:
        inspector.update(
            {
                "search_limit": search_limit,
                "vector_candidates": len(
                    vector_docs
                ),
                "bm25_candidates": len(
                    bm25_docs
                ),
                "hybrid_candidates": len(
                    docs
                ),
                "retrieval_error": retrieval_error,
            }
        )

    unique_docs = []
    seen_chunks = set()

    for doc in docs:
        chunk_key = (
            doc.metadata.get("attachment_id"),
            doc.metadata.get("page"),
            doc.page_content,
        )

        if chunk_key in seen_chunks:
            continue

        seen_chunks.add(chunk_key)
        unique_docs.append(doc)

    if inspector is not None:
        inspector["after_deduplication"] = len(
            unique_docs
        )

    reranking_completed = False

    try:
        unique_docs = _rerank_documents(
            query,
            unique_docs,
            limit=search_limit,
        )

        reranking_completed = True

    except Exception:
        pass

    if inspector is not None:
        inspector.update(
            {
                "reranking_completed":
                    reranking_completed,
                "reranked_candidates": len(
                    unique_docs
                ),
            }
        )

    selected_docs = []
    selected_keys = set()
    seen_attachments = set()

    # First pass:
    # Prefer one relevant chunk from each document.
    for doc in unique_docs:
        attachment_id = doc.metadata.get(
            "attachment_id"
        )

        if attachment_id in seen_attachments:
            continue

        selected_docs.append(doc)

        selected_keys.add(
            (
                attachment_id,
                doc.metadata.get("page"),
                doc.page_content,
            )
        )

        seen_attachments.add(attachment_id)

        if len(selected_docs) >= k:
            break

    # Second pass:
    # Fill remaining slots with next best chunks.
    if len(selected_docs) < k:
        for doc in unique_docs:
            chunk_key = (
                doc.metadata.get(
                    "attachment_id"
                ),
                doc.metadata.get("page"),
                doc.page_content,
            )

            if chunk_key in selected_keys:
                continue

            selected_docs.append(doc)
            selected_keys.add(chunk_key)

            if len(selected_docs) >= k:
                break

    if inspector is not None:
        inspector["selected_chunks"] = len(
            selected_docs
        )

    if not selected_docs:
        previews = [
            (
                f"[Source {index}: "
                f"{record.get('name', 'uploaded document')}]\n"
                f"{record.get('preview')}"
            )
            for index, record in enumerate(
                records,
                start=1,
            )
            if (
                record.get("kind") == "document"
                and record.get("preview")
            )
        ]

        if previews:
            if inspector is not None:
                inspector["fallback_used"] = True
                inspector["sources"] = [
                    {
                        "file": record.get(
                            "name",
                            "uploaded document",
                        ),
                        "page": None,
                    }
                    for record in records
                    if (
                        record.get("kind")
                        == "document"
                        and record.get("preview")
                    )
                ][:k]

            return "\n\n".join(
                previews[:k]
            )

        if inspector is not None:
            inspector["fallback_used"] = False
            inspector["sources"] = []

        return (
            "No relevant uploaded document "
            "content found."
        )

    results = []
    inspector_sources = []

    for i, doc in enumerate(
        selected_docs,
        start=1,
    ):
        source = doc.metadata.get(
            "source",
            "uploaded document",
        )

        page = doc.metadata.get("page")

        if page:
            source_label = (
                f"{source} - Page {page}"
            )
        else:
            source_label = source

        results.append(
            f"[Source {i}: {source_label}]\n"
            f"{doc.page_content}"
        )

        inspector_sources.append(
            {
                "file": source,
                "page": page,
            }
        )

    if inspector is not None:
        inspector["fallback_used"] = False
        inspector["sources"] = inspector_sources

    return "\n\n".join(results)
