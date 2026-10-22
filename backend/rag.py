from pathlib import Path
from typing import List
import json
import hashlib
import io
import re
from uuid import uuid4
from dotenv import load_dotenv
import os
import certifi
from rank_bm25 import BM25Okapi
from flashrank import Ranker, RerankRequest
import time
from threading import Lock

ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

from langchain_chroma import Chroma
from models import FreeGoogleEmbeddings
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

import docx2txt
from upload_security import (
    MAX_ATTACHMENTS, MAX_DOCUMENT_CHUNKS, MAX_EXTRACTED_CHARS, MAX_UPLOAD_BYTES,
    UPLOAD_CHUNK_BYTES, SUPPORTED_DOCUMENT_SUFFIXES, SUPPORTED_IMAGE_SUFFIXES,
    UploadError, checked_pdf, guarded_path, read_bounded, safe_open,
    thread_directory, thread_lock, upload_suffix, validate_file, validate_thread_id,
)
from ownership import OwnershipError, current_owner, require_thread
from usage_limits import UsageLimitError, limited
from evidence import document_source, evidence_note, register_sources


BACKEND_DIR = Path(__file__).resolve().parent

RUNTIME_DIR = Path(os.environ.get("CLAWBIT_RUNTIME_DIR", BACKEND_DIR))
UPLOAD_ROOT = RUNTIME_DIR / "uploads"
CHROMA_ROOT = RUNTIME_DIR / "chroma_db"

UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
CHROMA_ROOT.mkdir(parents=True, exist_ok=True)

# Embeddings model
embeddings = FreeGoogleEmbeddings(model="gemini-embedding-001")

vectorstore = Chroma(
    collection_name="agentic_chatbot_docs",
    embedding_function=embeddings,
    persist_directory=str(CHROMA_ROOT)
)

RAG_CACHE_TTL_SECONDS = 300
RAG_CACHE_MAX_ENTRIES = 128

_RAG_CACHE = {}
_RAG_CACHE_LOCK = Lock()


def _thread_upload_dir(thread_id: str, *, create=False) -> Path:
    require_thread(thread_id, create=create, missing_ok=not create)
    return thread_directory(UPLOAD_ROOT, thread_id, create=create)


def _manifest_path(thread_id: str) -> Path:
    return _thread_upload_dir(thread_id) / "manifest.json"


def _load_manifest(thread_id: str) -> list[dict]:
    path = _manifest_path(thread_id)

    guarded_path(UPLOAD_ROOT, path)
    if not path.exists():
        return []

    try:
        manifest = json.loads(read_bounded(UPLOAD_ROOT, path, 1024 * 1024))
        if not isinstance(manifest, list) or not all(isinstance(item, dict) for item in manifest):
            raise ValueError("Invalid manifest")
        return manifest
    except (ValueError, OSError) as exc:
        raise UploadError("Attachment metadata could not be read safely.") from exc


def _save_manifest(thread_id: str, manifest: list[dict]) -> None:
    _write_json(_manifest_path(thread_id), manifest)


def _write_json(path: Path, value) -> None:
    _attachment_path(str(path))
    temporary = path.with_name(f".manifest-{uuid4().hex}.tmp")
    try:
        with safe_open(UPLOAD_ROOT, temporary, "xb") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        guarded_path(UPLOAD_ROOT, path)
        os.replace(temporary, path)
    finally:
        _remove_file(temporary)


def _remove_file(path: Path):
    _attachment_path(str(path)).unlink(missing_ok=True)


def _attachment_path(file_path: str, thread_id: str | None = None) -> Path:
    path = guarded_path(UPLOAD_ROOT, Path(file_path))
    relative = path.relative_to(UPLOAD_ROOT.absolute())
    if len(relative.parts) != 2:
        raise UploadError("Invalid attachment path.")
    validate_thread_id(relative.parts[0])
    if thread_id is not None and path.parent != _thread_upload_dir(thread_id):
        raise UploadError("Attachment does not belong to this thread.")
    require_thread(relative.parts[0])
    return path


def read_attachment_bytes(record: dict) -> bytes:
    path = _attachment_path(record["path"])
    kind, _ = validate_file(UPLOAD_ROOT, path)
    if kind != "image":
        raise UploadError("Expected an image attachment.")
    return read_bounded(UPLOAD_ROOT, path)


def read_source_bytes(thread_id: str, attachment_id: str) -> bytes:
    """Read an owned citation document through the same upload path guards."""
    require_thread(thread_id)
    record = get_attachment_records(thread_id, [attachment_id])[0]
    path = _attachment_path(record["path"], thread_id)
    try:
        kind, _ = validate_file(UPLOAD_ROOT, path)
        if kind != "document":
            raise UploadError("Expected a document source.")
        return read_bounded(UPLOAD_ROOT, path)
    except OSError as exc:
        raise UploadError("Source is unavailable. It may have been removed.") from exc


def _preview_text(text: str, limit: int = 5000) -> str:
    cleaned = " ".join(text.split())
    return cleaned[:limit]


def get_attachment_records(thread_id: str, attachment_ids: list[str] | None = None) -> list[dict]:
    manifest = _load_manifest(thread_id)

    attachment_id_set = set(attachment_ids or [])
    records = [item for item in manifest if not attachment_ids or item.get("attachment_id") in attachment_id_set]
    if attachment_ids and {item.get("attachment_id") for item in records} != attachment_id_set:
        raise OwnershipError()
    for record in records:
        _attachment_path(record.get("path", ""), thread_id)
    return records


def _index_filter(thread_id, attachment_id):
    return {"$and": [{"thread_id": thread_id}, {"attachment_id": attachment_id}]}


def _recover_pending(thread_id):
    """Finish interrupted cleanup under the thread lock; never expose pending vectors."""
    journal = _thread_upload_dir(thread_id) / ".pending.json"
    guarded_path(UPLOAD_ROOT, journal)
    if not journal.exists():
        return
    pending = json.loads(read_bounded(UPLOAD_ROOT, journal, 16 * 1024))
    path = _attachment_path(pending["path"], thread_id)
    manifest = _load_manifest(thread_id)
    committed = any(item.get("attachment_id") == pending["attachment_id"] for item in manifest)
    if pending["operation"] == "delete" or not committed:
        if committed:
            _save_manifest(thread_id, [item for item in manifest if item.get("attachment_id") != pending["attachment_id"]])
            _RAG_CACHE.clear()
        try:
            if pending.get("indexed", True):
                vectorstore.delete(where=_index_filter(thread_id, pending["attachment_id"]))
        except Exception as exc:
            _remove_file(path)
            raise UploadError("Attachment cleanup is pending. Please retry when storage is available.", 503) from exc
        _remove_file(path)
    _remove_file(journal)


def _check_capacity(thread_id):
    if len(_load_manifest(thread_id)) >= MAX_ATTACHMENTS:
        raise UploadError("A thread may contain at most 10 attachments.", 409)


@limited("upload")
async def receive_uploaded_file(upload, thread_id: str):
    validate_thread_id(thread_id)
    require_thread(thread_id, create=True)
    suffix = upload_suffix(upload.filename or "")
    if upload.size is not None and upload.size > MAX_UPLOAD_BYTES:
        raise UploadError("Upload exceeds 10 MiB.", 413)
    with thread_lock(UPLOAD_ROOT, thread_id) as directory:
        _recover_pending(thread_id)
        _check_capacity(thread_id)
        path = directory / f"{uuid4().hex}{suffix}"
        journal = directory / ".pending.json"
        created = False
        try:
            with safe_open(UPLOAD_ROOT, path, "xb") as stream:
                created = True
                _write_json(journal, {"operation": "upload", "attachment_id": path.stem,
                                      "path": str(path), "indexed": False})
                size = 0
                while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise UploadError("Upload exceeds 10 MiB.", 413)
                    stream.write(chunk)
            return _save_uploaded_file(path, thread_id, upload.filename)
        except BaseException:
            if created:
                if journal.exists():
                    _recover_pending(thread_id)
                elif not any(item.get("attachment_id") == path.stem for item in _load_manifest(thread_id)):
                    # Cleanup itself may have removed the journal before raising.
                    # Check the durable commit before deleting; an unreadable
                    # manifest must also leave the attachment intact.
                    _remove_file(path)
            raise
        finally:
            await upload.close()


@limited("upload")
def save_uploaded_file(file_path: str, thread_id: str, original_name: str | None = None):
    require_thread(thread_id)
    path = _attachment_path(file_path, thread_id)
    with thread_lock(UPLOAD_ROOT, thread_id):
        _recover_pending(thread_id)
        _check_capacity(thread_id)
        if any(_attachment_path(item["path"], thread_id) == path for item in _load_manifest(thread_id)):
            raise UploadError("Attachment already exists.")
        return _save_uploaded_file(path, thread_id, original_name)


@limited("ingestion")
def _save_uploaded_file(path: Path, thread_id: str, original_name: str | None):
    kind, mime_type = validate_file(UPLOAD_ROOT, path)
    # The HTTP receiver already generates this UUID. Legacy names are not reused
    # for new attachments saved through the Python helper.
    attachment_id = path.stem if re.fullmatch(r"[a-f0-9]{32}", path.stem) else uuid4().hex
    if any(item.get("attachment_id") == attachment_id for item in _load_manifest(thread_id)):
        raise UploadError("Attachment already exists.")
    display_name = original_name or path.name
    destination = path.with_name(attachment_id + path.suffix.lower())
    if path != destination:
        created = False
        try:
            with safe_open(UPLOAD_ROOT, path, "rb") as source, safe_open(UPLOAD_ROOT, destination, "xb") as target:
                created = True
                while chunk := source.read(UPLOAD_CHUNK_BYTES):
                    target.write(chunk)
        except BaseException:
            if created:
                _remove_file(destination)
            raise
        _remove_file(path)
        path = destination

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

    journal = path.parent / ".pending.json"
    try:
        pages = _extract_pages(path) if kind == "document" else []
        if kind == "document":
            extracted_text = "\n".join(text for _, text in pages)
            if not extracted_text.strip():
                raise UploadError("No text could be extracted from this file.")
            record["preview"] = _preview_text(extracted_text)
        _write_json(journal, {"operation": "upload", "attachment_id": attachment_id, "path": str(path)})
        if kind == "document":
            add_document_to_rag(
                str(path), thread_id, attachment_id=attachment_id, source=display_name, _pages=pages,
            )
        manifest = _load_manifest(thread_id)
        if any(item.get("attachment_id") == attachment_id for item in manifest):
            raise UploadError("Attachment already exists.")
        _save_manifest(thread_id, [*manifest, record])
    except BaseException as exc:
        # An atomic replace can commit successfully before a cleanup error or
        # interruption. Never roll back the file underneath a committed record.
        if any(item.get("attachment_id") == attachment_id for item in _load_manifest(thread_id)):
            _RAG_CACHE.clear()
            if isinstance(exc, Exception):
                return record  # The pending marker is cleaned on the next mutation.
            raise
        _remove_file(path)
        if journal.exists():
            _recover_pending(thread_id)
        if isinstance(exc, UploadError) or not isinstance(exc, Exception):
            raise
        raise UploadError("The file could not be indexed. Please retry.", 503) from exc
    # If interrupted here, recovery recognizes the committed manifest and keeps it.
    try:
        _remove_file(journal)
    except OSError:
        # A committed upload remains valid. The next mutation removes this marker.
        pass
    _RAG_CACHE.clear()
    return record



def read_file_text(file_path: str) -> str:
    path = _attachment_path(file_path)
    validate_file(UPLOAD_ROOT, path)
    return "\n".join(text for _, text in _extract_pages(path))


def _extract_pages(path: Path) -> list[tuple[int | None, str]]:
    _attachment_path(str(path))
    try:
        if path.suffix.lower() == ".pdf":
            reader = checked_pdf(read_bounded(UPLOAD_ROOT, path))
            pages, size = [], 0
            for number, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                size += len(text)
                if size > MAX_EXTRACTED_CHARS:
                    raise UploadError("Extracted document text exceeds the limit.")
                pages.append((number, text))
            return pages
        if path.suffix.lower() == ".docx":
            text = docx2txt.process(io.BytesIO(read_bounded(UPLOAD_ROOT, path)))
        elif path.suffix.lower() in {".txt", ".md", ".csv"}:
            text = read_bounded(UPLOAD_ROOT, path).decode("utf-8-sig")
        else:
            raise UploadError("Unsupported document format.")
        if len(text) > MAX_EXTRACTED_CHARS:
            raise UploadError("Extracted document text exceeds the limit.")
        return [(None, text)]
    except UploadError:
        raise
    except Exception as exc:
        raise UploadError("Could not extract text from this file.") from exc



@limited("ingestion")
def add_document_to_rag(
    file_path: str,
    thread_id: str,
    attachment_id: str | None = None,
    source: str | None = None,
    _pages: list[tuple[int | None, str]] | None = None,
):
    path = _attachment_path(file_path, thread_id)
    if _pages is None:
        validate_file(UPLOAD_ROOT, path)
        _pages = _extract_pages(path)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=900,
        chunk_overlap=150
    )

    docs: List[Document] = []

    for page_number, text in _pages:
        for chunk in splitter.split_text(text):
            metadata = {
                "thread_id": thread_id,
                "attachment_id": attachment_id or path.name,
                "source": source or path.name,
                "chunk_id": str(len(docs)),
                "content_hash": hashlib.sha256(chunk.encode()).hexdigest(),
            }
            if page_number is not None:
                metadata["page"] = page_number
            docs.append(
                Document(
                    page_content=chunk,
                    metadata=metadata,
                )
            )
            if len(docs) > MAX_DOCUMENT_CHUNKS:
                raise UploadError("Document contains too many chunks to index.")

    if not docs:
        raise ValueError("No text could be extracted from this file.")

    # A caller-supplied attachment ID cannot overwrite another thread's vectors.
    # Legacy vector IDs remain readable through the existing metadata filters.
    ids = [f"{thread_id}:{attachment_id or path.name}:{index}" for index in range(len(docs))]
    existing = vectorstore.get(
        where=_index_filter(thread_id, attachment_id or path.name), include=["metadatas"],
    )
    if existing.get("ids"):
        hashes = {
            key: metadata.get("content_hash")
            for key, metadata in zip(existing["ids"], existing.get("metadatas", []))
        }
        if len(hashes) == len(ids) and all(
            hashes.get(key) == document.metadata["content_hash"]
            for key, document in zip(ids, docs)
        ):
            return {"filename": path.name, "chunks": len(docs)}
        raise UploadError("This attachment is already indexed. Upload a new attachment to replace it.")
    try:
        vectorstore.add_documents(docs, ids=ids)
    except Exception:
        vectorstore.delete(ids=ids)
        raise

    _RAG_CACHE.clear()
    return {"filename": path.name, "chunks": len(docs)}


def delete_attachment(thread_id: str, attachment_id: str) -> bool:
    require_thread(thread_id)
    with thread_lock(UPLOAD_ROOT, thread_id):
        _recover_pending(thread_id)
        records = get_attachment_records(thread_id, [attachment_id])
        if not records:
            return False
        record = records[0]
        journal = _thread_upload_dir(thread_id) / ".pending.json"
        _write_json(journal, {"operation": "delete", "attachment_id": attachment_id, "path": record["path"]})
        _recover_pending(thread_id)
        _RAG_CACHE.clear()
        return True



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
    validate_thread_id(thread_id)
    require_thread(thread_id, missing_ok=True)
    if not attachment_ids:
        return []
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

    authorized = [
        (document, metadata)
        for document, metadata in zip(data.get("documents") or [], data.get("metadatas") or [])
        if metadata and metadata.get("thread_id") == thread_id
        and metadata.get("attachment_id") in attachment_ids
    ]
    documents = [document for document, _ in authorized]
    metadatas = [metadata for _, metadata in authorized]

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

def _authorized_documents(
    documents: list[Document], thread_id: str, attachment_ids: list[str],
) -> list[Document]:
    return [
        document for document in documents
        if document.metadata.get("thread_id") == thread_id
        and document.metadata.get("attachment_id") in attachment_ids
    ]


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

    from observability import event

    event("reranking", "started", count=len(docs))

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
        if index < 0 or index >= len(docs):
            raise ValueError("Reranker returned an unknown passage.")
        if docs[index] not in reranked_docs:
            reranked_docs.append(docs[index])

    event("reranking", "complete", count=len(reranked_docs))
    return reranked_docs


def _build_rag_cache_key(
    query: str,
    thread_id: str,
    document_attachment_ids: list[str],
    k: int,
) -> tuple:
    return (
        current_owner(),
        thread_id,
        tuple(sorted(document_attachment_ids)),
        query.strip().lower(),
        k,
    )


def _get_rag_cache(
    cache_key: tuple,
):
    if not cache_key or cache_key[0] != current_owner():
        raise OwnershipError()
    now = time.monotonic()

    with _RAG_CACHE_LOCK:
        cached = _RAG_CACHE.get(
            cache_key
        )

        if not cached:
            return None

        created_at, result, metadata = cached

        if (
            now - created_at
            > RAG_CACHE_TTL_SECONDS
        ):
            _RAG_CACHE.pop(
                cache_key,
                None,
            )
            return None

        return (
            result,
            metadata.copy(),
        )


def _set_rag_cache(
    cache_key: tuple,
    result: str,
    metadata: dict,
):
    if not cache_key or cache_key[0] != current_owner():
        raise OwnershipError()
    now = time.monotonic()

    with _RAG_CACHE_LOCK:
        expired_keys = [
            key
            for key, value
            in _RAG_CACHE.items()
            if (
                now - value[0]
                > RAG_CACHE_TTL_SECONDS
            )
        ]

        for key in expired_keys:
            _RAG_CACHE.pop(
                key,
                None,
            )

        if (
            len(_RAG_CACHE)
            >= RAG_CACHE_MAX_ENTRIES
        ):
            oldest_key = min(
                _RAG_CACHE,
                key=lambda key:
                    _RAG_CACHE[key][0],
            )

            _RAG_CACHE.pop(
                oldest_key,
                None,
            )

        _RAG_CACHE[cache_key] = (
            now,
            result,
            metadata.copy(),
        )

def _register_rag_evidence(metadata: dict) -> None:
    register_sources(metadata.get("sources", []))
    if metadata.get("retrieval_error"):
        evidence_note("Document search failed; any cited excerpts come from stored previews.")
    elif metadata.get("fallback_used"):
        evidence_note("Search returned no ranked chunks; cited excerpts use stored previews.")
    elif metadata.get("sources") and not metadata.get("reranking_completed"):
        evidence_note("Document reranking was unavailable; retrieval order was retained.")


@limited("retrieval")
def retrieve_from_rag(
    query: str,
    thread_id: str,
    attachment_ids: list[str] | None = None,
    k: int = 4,
    inspector: dict | None = None,
) -> str:
    validate_thread_id(thread_id)
    require_thread(thread_id, missing_ok=True)
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

    search_limit = max(
        k * 4,
        12,
    )

    cache_key = _build_rag_cache_key(
        query=query,
        thread_id=thread_id,
        document_attachment_ids=(
            document_attachment_ids
        ),
        k=k,
    )

    cached = _get_rag_cache(
        cache_key
    )

    if cached is not None:
        cached_result, cached_metadata = (
            cached
        )

        if inspector is not None:
            inspector.update(
                cached_metadata
            )
            inspector["cache_hit"] = True

        _register_rag_evidence(cached_metadata)
        return cached_result

    metadata = {
        "cache_hit": False,
        "search_limit": search_limit,
    }

    vector_docs = []
    bm25_docs = []
    docs = []

    retrieval_error = False

    try:
        if not document_attachment_ids:
            vector_docs = []
            bm25_docs = []

        else:
            search_filter = {
                "thread_id": thread_id
            }

            if document_attachment_ids:
                if (
                    len(
                        document_attachment_ids
                    )
                    == 1
                ):
                    attachment_filter = (
                        document_attachment_ids[0]
                    )

                else:
                    attachment_filter = {
                        "$in":
                            document_attachment_ids
                    }

                search_filter = {
                    "$and": [
                        {
                            "thread_id":
                                thread_id
                        },
                        {
                            "attachment_id":
                                attachment_filter
                        },
                    ]
                }

            vector_docs = (
                vectorstore.similarity_search(
                    query,
                    k=search_limit,
                    filter=search_filter,
                )
            )

            bm25_docs = _bm25_search(
                query,
                thread_id,
                document_attachment_ids,
                limit=search_limit,
            )

        # Check returned metadata as well as the database filter before any
        # private text enters hybrid ranking, reranking, citations or caches.
        vector_docs = _authorized_documents(vector_docs, thread_id, document_attachment_ids)
        bm25_docs = _authorized_documents(bm25_docs, thread_id, document_attachment_ids)
        docs = _merge_hybrid_results(
            vector_docs,
            bm25_docs,
            limit=search_limit,
        )

    except UsageLimitError:
        raise
    except Exception:
        docs = []
        retrieval_error = True

    metadata.update(
        {
            "vector_candidates": len(
                vector_docs
            ),
            "bm25_candidates": len(
                bm25_docs
            ),
            "hybrid_candidates": len(
                docs
            ),
            "retrieval_error":
                retrieval_error,
        }
    )

    unique_docs = []
    seen_chunks = set()

    for doc in docs:
        chunk_key = (
            doc.metadata.get(
                "attachment_id"
            ),
            doc.metadata.get("page"),
            doc.page_content,
        )

        if chunk_key in seen_chunks:
            continue

        seen_chunks.add(
            chunk_key
        )

        unique_docs.append(
            doc
        )

    metadata[
        "after_deduplication"
    ] = len(unique_docs)

    reranking_completed = False

    try:
        unique_docs = (
            _rerank_documents(
                query,
                unique_docs,
                limit=search_limit,
            )
        )

        reranking_completed = True

    except Exception as exc:
        from observability import event

        event("reranking", "failed", error=exc)

    metadata.update(
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
        attachment_id = (
            doc.metadata.get(
                "attachment_id"
            )
        )

        if (
            attachment_id
            in seen_attachments
        ):
            continue

        selected_docs.append(
            doc
        )

        selected_keys.add(
            (
                attachment_id,
                doc.metadata.get(
                    "page"
                ),
                doc.page_content,
            )
        )

        seen_attachments.add(
            attachment_id
        )

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
                doc.metadata.get(
                    "page"
                ),
                doc.page_content,
            )

            if (
                chunk_key
                in selected_keys
            ):
                continue

            selected_docs.append(
                doc
            )

            selected_keys.add(
                chunk_key
            )

            if (
                len(selected_docs)
                >= k
            ):
                break

    metadata[
        "selected_chunks"
    ] = len(selected_docs)

    if not selected_docs:
        # Keep the existing bounded preview fallback, explicitly identified as such.
        selected_docs = [
            Document(page_content=record["preview"][:2000], metadata={
                "thread_id": thread_id, "attachment_id": record["attachment_id"],
                "source": record.get("name", "uploaded document"), "chunk_id": "preview",
            })
            for record in records
            if record.get("kind") == "document" and record.get("preview")
        ][:k]
        metadata["fallback_used"] = bool(selected_docs)
    else:
        metadata["fallback_used"] = False

    results = []
    inspector_sources = []
    remaining = 12000
    for index, doc in enumerate(selected_docs, start=1):
        content = doc.page_content[:min(3000, remaining)]
        if not content:
            break
        remaining -= len(content)
        source = document_source(thread_id, doc.metadata, doc.page_content)
        location = f" - Page {source['page']}" if source.get("page") else ""
        preview = " (preview fallback)" if metadata["fallback_used"] else ""
        results.append(
            f"[Source {index}: {source['file']}{location}] "
            f"[{source['source_id']}]{preview}\n{content}"
        )
        inspector_sources.append(source)
    metadata["sources"] = inspector_sources
    _register_rag_evidence(metadata)
    if not results:
        if inspector is not None:
            inspector.update(metadata)
        return "No relevant uploaded document content found."

    result = "\n\n".join(
        results
    )

    if inspector is not None:
        inspector.update(
            metadata
        )

    # Cache only successful retrievals.
    if not retrieval_error:
        _set_rag_cache(
            cache_key,
            result,
            metadata,
        )

    return result
