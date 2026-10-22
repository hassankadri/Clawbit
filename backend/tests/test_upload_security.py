import asyncio
import base64
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import zipfile

from langchain_core.messages import AIMessage, AIMessageChunk
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
import pytest

import app as api
import database
import rag
import upload_security as security
from upload_security import MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, UploadError


THREAD = "attachment-test-001"


class LocalIndex:
    """In-memory replacement for embeddings and Chroma, including partial failures."""
    def __init__(self):
        self.docs = {}
        self.fail_add = self.fail_delete = False

    @staticmethod
    def matches(metadata, where):
        if not where:
            return True
        if "$and" in where:
            return all(LocalIndex.matches(metadata, part) for part in where["$and"])
        return all(metadata.get(key) in value["$in"] if isinstance(value, dict)
                   else metadata.get(key) == value for key, value in where.items())

    def add_documents(self, docs, ids):
        self.docs.update(zip(ids, docs))
        if self.fail_add:
            raise RuntimeError("Simulated partial index failure")

    def delete(self, ids=None, where=None):
        if self.fail_delete:
            raise RuntimeError("Simulated unavailable index")
        for key, doc in list(self.docs.items()):
            if (ids is None or key in ids) and self.matches(doc.metadata, where):
                del self.docs[key]

    def get(self, where=None, **kwargs):
        docs = [doc for doc in self.docs.values() if self.matches(doc.metadata, where)]
        return {"documents": [doc.page_content for doc in docs],
                "metadatas": [doc.metadata for doc in docs]}

    def similarity_search(self, query, k, filter):
        return [doc for doc in self.docs.values() if self.matches(doc.metadata, filter)][:k]


@pytest.fixture
def storage(owner_client, tmp_path, monkeypatch):
    root = tmp_path / "uploads"
    root.mkdir()
    index = LocalIndex()
    monkeypatch.setattr(rag, "UPLOAD_ROOT", root)
    monkeypatch.setattr(rag, "vectorstore", index)
    monkeypatch.setattr(rag, "_rerank_documents", lambda query, docs, limit: docs[:limit])
    rag._RAG_CACHE.clear()
    yield SimpleNamespace(root=root, index=index, client=owner_client)
    rag._RAG_CACHE.clear()


def pdf_bytes(pages=1):
    writer = PdfWriter()
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                             NameObject("/Subtype"): NameObject("/Type1"),
                             NameObject("/BaseFont"): NameObject("/Helvetica")})
    for _ in range(pages):
        page = writer.add_blank_page(width=300, height=300)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        contents = DecodedStreamObject()
        contents.set_data(b"BT /F1 12 Tf 20 200 Td (Security fixture uses SQLite.) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(contents)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def docx_bytes(extra=None, text="Security fixture uses SQLite."):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>')
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return output.getvalue()


def image_bytes(format="PNG", size=(2, 2)):
    output = io.BytesIO()
    Image.new("RGB", size, "blue").save(output, format=format)
    return output.getvalue()


def upload(storage, name="notes.txt", data=b"Security fixture uses SQLite.", thread=THREAD, mime="application/octet-stream"):
    return storage.client.post("/attachments/upload", data={"thread_id": thread},
                               files={"file": (name, data, mime)})


def assert_clean(storage, thread=THREAD):
    assert not storage.index.docs
    assert rag.get_attachment_records(thread) == []
    directory = storage.root / thread
    if directory.exists():
        assert {path.name for path in directory.iterdir()} <= {".attachment.lock", "manifest.json"}


@pytest.mark.parametrize("suffix,contents,kind", [
    (".pdf", pdf_bytes, "document"), (".docx", docx_bytes, "document"),
    (".txt", lambda: b"Text & punctuation < >\n  indentation", "document"),
    (".md", lambda: b"# Heading\n\n**Markdown**", "document"),
    (".csv", lambda: b'name,value\n"Alice, Bob",42\n', "document"),
    (".png", image_bytes, "image"),
    (".jpg", lambda: image_bytes("JPEG"), "image"),
    (".jpeg", lambda: image_bytes("JPEG"), "image"),
    (".webp", lambda: image_bytes("WEBP"), "image"),
])
def test_valid_formats_generated_names_and_metadata(storage, suffix, contents, kind):
    data = contents()
    response = upload(storage, "Original name" + suffix, data, mime="application/x-untrusted")
    assert response.status_code == 200, response.text
    record = rag.get_attachment_records(THREAD)[0]
    assert record["kind"] == kind
    assert record["name"] == "Original name" + suffix
    assert len(record["attachment_id"]) == 32
    assert Path(record["path"]).name == record["attachment_id"] + suffix
    assert Path(record["path"]).read_bytes() == data
    assert record["mime_type"] == security.MIME_BY_SUFFIX[suffix]
    assert record["rag_error"] is None
    if kind == "document":
        assert storage.index.docs
        for doc in storage.index.docs.values():
            assert doc.metadata["thread_id"] == THREAD
            assert doc.metadata["source"] == record["name"]
            assert doc.metadata["attachment_id"] == record["attachment_id"]
        if suffix == ".pdf":
            assert next(iter(storage.index.docs.values())).metadata["page"] == 1
        assert record["name"] in rag.retrieve_from_rag("Security", THREAD)
    else:
        assert not storage.index.docs
        assert rag.read_attachment_bytes(record) == data
        content = api._build_user_message("Describe", [record], "gemini-3.1-flash-lite")
        images = [item for item in content if item.get("type") == "image"]
        assert len(images) == 1
        assert base64.b64decode(images[0]["base64"]) == data
        assert images[0]["mime_type"] == record["mime_type"]


@pytest.mark.parametrize("thread", ["", "../escape", "..", "a/b", "a\\b", "C:\\tmp", "/tmp", "a:stream", "NUL", "CON", "COM1", "trailing.", " space", "a\x00b", "a" * 129, "日本語"])
def test_malicious_thread_ids_before_io(storage, monkeypatch, thread):
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid ID reached database or agent")
    monkeypatch.setattr(api, "get_agent", forbidden)
    monkeypatch.setattr(database, "SessionLocal", forbidden)
    assert upload(storage, thread=thread).status_code == 400
    for route in ("/chat", "/chat/stream"):
        assert storage.client.post(route, json={"message": "hello", "thread_id": thread}).status_code == 400
    for call in (lambda: rag.get_attachment_records(thread),
                 lambda: rag.retrieve_from_rag("query", thread),
                 lambda: database.get_chat_history(thread),
                 lambda: database.search_memory(thread, "query")):
        with pytest.raises(UploadError):
            call()
    assert list(storage.root.iterdir()) == []


@pytest.mark.parametrize("name", ["../escape.txt", "..\\escape.txt", "/tmp/escape.txt", "C:\\temp\\escape.txt", "file.txt:stream", "file\x00.txt"])
def test_filename_traversal_rejected_before_writing(storage, name):
    # Test the boundary directly: multipart clients may sanitize Windows basenames.
    with pytest.raises(UploadError):
        security.upload_suffix(name)
    fake = SimpleNamespace(filename=name, size=1)
    with pytest.raises(UploadError):
        asyncio.run(rag.receive_uploaded_file(fake, THREAD))
    assert list(storage.root.iterdir()) == []


@pytest.mark.parametrize("name,data", [
    ("script.py", b"print('hello')"), ("file.gif", b"GIF89a"),
    ("file.png", b"not an image"), ("file.jpg", image_bytes()),
    ("file.pdf", b"plain text"), ("file.pdf", b"%PDF-1.7\ninvalid"),
    ("file.docx", b"PK\x03\x04invalid"), ("file.txt", b"binary\x00data"),
    ("file.md", b"%PDF-1.7 fake"), ("file.csv", b"\xff\xfe\x00"),
    ("file.txt", b""), ("file.png", image_bytes()[:40]),
    ("file.docx", docx_bytes({"../escape.txt": "bad"})),
    ("file.docx", docx_bytes({"word/vbaProject.bin": "macro"})),
    ("file.docx", docx_bytes({"custom.xml": '<!DOCTYPE x [<!ENTITY e "bomb">]><x>&e;</x>'})),
    ("file.docx", docx_bytes({"custom.xml": '<!DOCTYPE x [<!ENTITY e "bomb">]><x>&e;</x>'.encode("utf-16-le")})),
])
def test_unsupported_disguised_and_malformed_files_leave_nothing(storage, name, data):
    response = upload(storage, name, data, mime="text/plain")
    assert response.status_code == 400, response.text
    assert_clean(storage)


@pytest.mark.parametrize("pages,status", [(200, 200), (201, 400)])
def test_pdf_page_limit_before_extraction(storage, monkeypatch, pages, status):
    if pages > 200:
        monkeypatch.setattr(rag, "_extract_pages", lambda *_: pytest.fail("Oversized PDF reached extraction"))
    response = upload(storage, "pages.pdf", pdf_bytes(pages))
    assert response.status_code == status, response.text
    if status == 200:
        assert len(storage.index.docs) == 200
    else:
        assert_clean(storage)


def test_docx_expansion_limit_before_extraction(storage, monkeypatch):
    data = docx_bytes({"word/large.bin": b"x" * (security.MAX_DOCX_EXPANDED_BYTES + 1)})
    monkeypatch.setattr(rag, "_extract_pages", lambda *_: pytest.fail("ZIP bomb reached extraction"))
    assert upload(storage, "bomb.docx", data).status_code == 400
    assert_clean(storage)


def test_image_pixel_limit_before_decode(storage, monkeypatch):
    data = image_bytes(size=(3, 3))
    monkeypatch.setattr(security, "MAX_IMAGE_PIXELS", 8)
    monkeypatch.setattr(Image.Image, "load", lambda *_: pytest.fail("Large image was decoded"))
    assert upload(storage, "large.png", data).status_code == 400
    assert_clean(storage)


class ChunkedUpload:
    filename = "file.txt"
    size = None

    def __init__(self, size, error=None):
        self.remaining = size
        self.error = error
        self.read_sizes = []
        self.closed = False

    async def read(self, size):
        assert size == UPLOAD_CHUNK_BYTES
        self.read_sizes.append(size)
        if self.error and len(self.read_sizes) > 1:
            raise self.error
        chunk = b"x" * min(size, self.remaining)
        self.remaining -= len(chunk)
        return chunk

    async def close(self):
        self.closed = True


@pytest.mark.parametrize("declared_size", [None, 1])
def test_unknown_size_upload_has_hard_chunked_limit(storage, declared_size):
    file = ChunkedUpload(MAX_UPLOAD_BYTES + 1)
    file.size = declared_size
    with pytest.raises(UploadError) as error:
        asyncio.run(rag.receive_uploaded_file(file, THREAD))
    assert error.value.status_code == 413
    assert len(file.read_sizes) > 1 and file.closed
    assert_clean(storage)


@pytest.mark.parametrize("error", [OSError("read failed"), asyncio.CancelledError()])
def test_interrupted_stream_cleans_partial_file(storage, error):
    file = ChunkedUpload(MAX_UPLOAD_BYTES, error)
    with pytest.raises(type(error)):
        asyncio.run(rag.receive_uploaded_file(file, THREAD))
    assert file.closed
    assert_clean(storage)


def test_http_oversized_body_and_exact_file_limit(storage):
    assert upload(storage, data=b"x" * (MAX_UPLOAD_BYTES + 1)).status_code == 413
    assert upload(storage, data=b"x" * (MAX_UPLOAD_BYTES + UPLOAD_CHUNK_BYTES)).status_code == 413
    # Byte limit is independent of the lower extracted-text limit.
    directory = security.thread_directory(storage.root, THREAD, create=True)
    path = directory / "boundary.txt"
    path.write_bytes(b"x" * MAX_UPLOAD_BYTES)
    assert len(security.read_bounded(storage.root, path)) == MAX_UPLOAD_BYTES
    path.unlink()
    assert_clean(storage)


def test_multipart_without_content_length_is_bounded_and_closed(storage, monkeypatch):
    import starlette.formparsers
    original = starlette.formparsers.SpooledTemporaryFile
    spools = []

    def track(*args, **kwargs):
        spool = original(*args, **kwargs)
        spools.append(spool)
        return spool

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", track)
    async def body():
        yield b'--boundary\r\nContent-Disposition: form-data; name="thread_id"\r\n\r\nattachment-test-001\r\n'
        yield b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n'
        for _ in range(MAX_UPLOAD_BYTES // UPLOAD_CHUNK_BYTES + 2):
            yield b"x" * UPLOAD_CHUNK_BYTES
        yield b'\r\n--boundary--\r\n'
    async def request():
        import httpx
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api.app),
            base_url="http://localhost:8000",
            cookies=storage.client.cookies,
            headers=storage.client.headers,
        ) as client:
            return await client.post("/attachments/upload", content=body(),
                                     headers={"Content-Type": "multipart/form-data; boundary=boundary"})
    response = asyncio.run(request())
    assert response.status_code == 413
    assert spools and all(spool.closed for spool in spools)
    assert_clean(storage)


def test_capacity_deletion_and_thread_scoping(storage, monkeypatch):
    import usage_limits

    now = [120.0]
    monkeypatch.setattr(usage_limits.store, "clock", lambda: now[0])
    for _ in range(10):
        assert upload(storage).status_code == 200
    records = rag.get_attachment_records(THREAD)
    assert len(records) == 10
    # This test targets persistent storage capacity after the request window resets.
    now[0] += 60
    assert upload(storage).status_code == 409
    first = records[0]
    assert storage.client.delete(f'/attachments/other-thread/{first["attachment_id"]}').status_code == 404
    assert Path(first["path"]).exists()
    assert storage.client.delete(f'/attachments/{THREAD}/{first["attachment_id"]}').status_code == 200
    assert not Path(first["path"]).exists()
    assert len(rag.get_attachment_records(THREAD)) == 9
    assert all(doc.metadata["attachment_id"] != first["attachment_id"] for doc in storage.index.docs.values())
    assert upload(storage).status_code == 200
    assert len(rag.get_attachment_records(THREAD)) == 10


def test_ingestion_quota_rejection_preserves_committed_uploads(storage):
    from dataclasses import replace
    import usage_limits

    policy = usage_limits.store.policies["ingestion"]
    usage_limits.store.policies["ingestion"] = replace(policy, per_day=1)
    assert upload(storage).status_code == 200
    before = rag.get_attachment_records(THREAD)
    response = upload(storage)
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0
    assert "daily usage quota" in response.json()["detail"]
    assert rag.get_attachment_records(THREAD) == before
    assert Path(before[0]["path"]).exists()
    assert not list(storage.root.rglob(".pending.json"))


@pytest.mark.parametrize("failure", ["index", "manifest", "extraction"])
def test_failed_ingestion_rolls_back_file_manifest_and_index(storage, monkeypatch, failure):
    assert upload(storage).status_code == 200
    before = rag.get_attachment_records(THREAD)
    ids = set(storage.index.docs)
    if failure == "index":
        storage.index.fail_add = True
    elif failure == "manifest":
        monkeypatch.setattr(rag, "_save_manifest", lambda *args: (_ for _ in ()).throw(OSError("disk full")))
    else:
        monkeypatch.setattr(rag, "_extract_pages", lambda *args: (_ for _ in ()).throw(UploadError("Malformed document")))
    response = upload(storage)
    assert response.status_code == (400 if failure == "extraction" else 503)
    assert rag.get_attachment_records(THREAD) == before
    assert set(storage.index.docs) == ids
    assert {path.name for path in (storage.root / THREAD).iterdir()} == {
        ".attachment.lock", "manifest.json", Path(before[0]["path"]).name}


def test_unavailable_rollback_is_journaled_hidden_and_recovered(storage):
    storage.index.fail_add = storage.index.fail_delete = True
    assert upload(storage).status_code == 503
    assert rag.get_attachment_records(THREAD) == []
    assert storage.index.docs  # Partial index is quarantined from retrieval.
    assert "SQLite" not in rag.retrieve_from_rag("SQLite", THREAD)
    assert {path.name for path in (storage.root / THREAD).iterdir()} == {".attachment.lock", ".pending.json"}
    storage.index.fail_add = storage.index.fail_delete = False
    assert upload(storage).status_code == 200
    assert len(storage.index.docs) == 1
    assert not (storage.root / THREAD / ".pending.json").exists()


def test_committed_upload_survives_journal_cleanup_failure(storage, monkeypatch):
    remove = rag._remove_file
    def fail_journal(path):
        if path.name == ".pending.json":
            raise OSError("Temporary sharing violation")
        return remove(path)
    monkeypatch.setattr(rag, "_remove_file", fail_journal)
    assert upload(storage).status_code == 200
    record = rag.get_attachment_records(THREAD)[0]
    assert Path(record["path"]).exists()
    monkeypatch.setattr(rag, "_remove_file", remove)
    assert upload(storage).status_code == 200
    assert len(rag.get_attachment_records(THREAD)) == 2
    assert not (storage.root / THREAD / ".pending.json").exists()


def test_error_after_manifest_commit_preserves_successful_upload(storage, monkeypatch):
    save = rag._save_manifest
    def save_then_fail(thread, records):
        save(thread, records)
        raise OSError("Post-commit cleanup failed")
    monkeypatch.setattr(rag, "_save_manifest", save_then_fail)
    assert upload(storage).status_code == 200
    record = rag.get_attachment_records(THREAD)[0]
    assert Path(record["path"]).read_text() == "Security fixture uses SQLite."
    assert len(storage.index.docs) == 1
    monkeypatch.setattr(rag, "_save_manifest", save)
    assert upload(storage).status_code == 200
    assert len(rag.get_attachment_records(THREAD)) == 2
    assert not (storage.root / THREAD / ".pending.json").exists()


@pytest.mark.parametrize("stage", ["commit", "journal-removed", "manifest-unreadable"])
def test_interruption_after_commit_never_deletes_committed_file(storage, monkeypatch, stage):
    save, remove, load = rag._save_manifest, rag._remove_file, rag._load_manifest
    committed = False

    def save_then_interrupt(thread, records):
        nonlocal committed
        save(thread, records)
        committed = True
        raise asyncio.CancelledError()

    def remove_then_interrupt(path):
        remove(path)
        if path.name == ".pending.json":
            raise asyncio.CancelledError()

    def unreadable_after_commit(thread):
        if committed:
            raise UploadError("Temporarily unreadable manifest")
        return load(thread)

    if stage == "journal-removed":
        monkeypatch.setattr(rag, "_remove_file", remove_then_interrupt)
    else:
        monkeypatch.setattr(rag, "_save_manifest", save_then_interrupt)
    if stage == "manifest-unreadable":
        monkeypatch.setattr(rag, "_load_manifest", unreadable_after_commit)
    file = ChunkedUpload(20)
    with pytest.raises(UploadError if stage == "manifest-unreadable" else asyncio.CancelledError):
        asyncio.run(rag.receive_uploaded_file(file, THREAD))
    monkeypatch.setattr(rag, "_save_manifest", save)
    monkeypatch.setattr(rag, "_remove_file", remove)
    monkeypatch.setattr(rag, "_load_manifest", load)
    record = rag.get_attachment_records(THREAD)[0]
    assert Path(record["path"]).read_bytes() == b"x" * 20
    assert len(storage.index.docs) == 1 and file.closed
    assert upload(storage).status_code == 200
    assert len(rag.get_attachment_records(THREAD)) == 2
    assert not (storage.root / THREAD / ".pending.json").exists()


def test_duplicate_python_save_preserves_existing_attachment(storage):
    assert upload(storage).status_code == 200
    record = rag.get_attachment_records(THREAD)[0]
    with pytest.raises(UploadError, match="already exists"):
        rag.save_uploaded_file(record["path"], THREAD)
    assert Path(record["path"]).exists()
    assert len(storage.index.docs) == 1


def test_thread_lock_prevents_concurrent_mutations(storage):
    with security.thread_lock(storage.root, THREAD):
        response = upload(storage)
        assert response.status_code == 409
    assert upload(storage).status_code == 200


def test_hardlinked_file_is_not_read_or_indexed(storage, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("private")
    directory = security.thread_directory(storage.root, THREAD, create=True)
    linked = directory / "linked.txt"
    os.link(outside, linked)
    with pytest.raises(UploadError):
        security.read_bounded(storage.root, linked)
    assert outside.read_text() == "private"
    assert not storage.index.docs


def test_symlink_or_windows_junction_cannot_escape(storage, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "private.txt"
    sentinel.write_text("private")
    link = storage.root / THREAD
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(outside), str(link))
    else:
        link.symlink_to(outside, target_is_directory=True)
    try:
        assert upload(storage).status_code == 400
        with pytest.raises(UploadError):
            rag.read_file_text(str(link / "private.txt"))
        assert sentinel.read_text() == "private"
        assert list(outside.iterdir()) == [sentinel]
    finally:
        if os.name == "nt":
            link.rmdir()  # Remove only the junction, never its target.
        else:
            link.unlink()


def test_manifest_cannot_reference_other_thread_or_external_file(storage, tmp_path):
    assert upload(storage).status_code == 200
    record = rag.get_attachment_records(THREAD)[0]
    outside = tmp_path / "private.txt"
    outside.write_text("private")
    for path in (outside, storage.root / "other-thread" / "private.txt"):
        rag._save_manifest(THREAD, [{**record, "path": str(path)}])
        with pytest.raises(UploadError):
            rag.get_attachment_records(THREAD)
        with pytest.raises(UploadError):
            rag.delete_attachment(THREAD, record["attachment_id"])
    assert outside.read_text() == "private"


def test_legacy_names_and_ids_remain_readable(storage):
    from ownership import require_thread

    require_thread(THREAD, create=True)
    directory = security.thread_directory(storage.root, THREAD, create=True)
    legacy = directory / "old-prefix_original name.txt"
    legacy.write_text("Legacy content.")
    record = {"attachment_id": "legacy-id", "name": "original name.txt", "kind": "document", "path": str(legacy)}
    rag._save_manifest(THREAD, [record])
    assert rag.get_attachment_records(THREAD, ["legacy-id"]) == [record]
    assert rag.read_file_text(str(legacy)) == "Legacy content."


@pytest.mark.parametrize("thread", [THREAD, "53495f66-0768-4891-a123-3e36ee358ba7", "Legacy_Thread-A", None])
def test_existing_chat_thread_and_provider_contract(storage, monkeypatch, thread):
    calls = []
    class Agent:
        async def ainvoke(self, state, config):
            calls.append(config["configurable"])
            return {"messages": [AIMessage(content="Local test reply")]}
    async def get_agent(model, mode):
        return Agent()
    monkeypatch.setattr(api, "get_agent", get_agent)
    response = storage.client.post("/chat", json={"message": "hello", "thread_id": thread})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["response"] == "Local test reply"
    assert result["thread_id"] == (thread or calls[0]["thread_id"])
    assert calls[0]["thread_id"] == result["thread_id"]
    assert calls[0]["workspace_id"] == result["thread_id"]


def test_existing_streaming_contract(storage, monkeypatch):
    class Agent:
        async def astream(self, state, config, stream_mode):
            assert config["configurable"]["thread_id"] == THREAD
            assert config["configurable"]["model"] == "gemini-3.1-flash-lite"
            yield "messages", (AIMessageChunk(content="Stream reply"), {"langgraph_node": "chatbot"})
            yield "values", {"messages": [AIMessage(content="Stream reply")]}

    async def get_agent(model, mode, streaming=False):
        assert streaming
        return Agent()

    monkeypatch.setattr(api, "get_agent", get_agent)
    response = storage.client.post("/chat/stream", json={"message": "hello", "thread_id": THREAD})
    assert response.status_code == 200
    assert "event: start" in response.text
    assert "event: token" in response.text and "Stream reply" in response.text
    assert "event: done" in response.text
    assert "event: error" not in response.text


def test_deletion_failure_hides_stale_vectors_and_recovers(storage):
    assert upload(storage).status_code == 200
    record = rag.get_attachment_records(THREAD)[0]
    assert "SQLite" in rag.retrieve_from_rag("SQLite", THREAD)
    storage.index.fail_delete = True
    response = storage.client.delete(f'/attachments/{THREAD}/{record["attachment_id"]}')
    assert response.status_code == 503
    assert rag.get_attachment_records(THREAD) == []
    assert not Path(record["path"]).exists()
    assert "SQLite" not in rag.retrieve_from_rag("SQLite", THREAD)
    storage.index.fail_delete = False
    assert upload(storage).status_code == 200
    assert len(storage.index.docs) == 1
    assert not (storage.root / THREAD / ".pending.json").exists()


def test_corrupt_manifest_fails_closed_without_overwrite(storage):
    directory = security.thread_directory(storage.root, THREAD, create=True)
    manifest = directory / "manifest.json"
    manifest.write_text("not JSON")
    response = upload(storage)
    assert response.status_code == 400
    assert manifest.read_text() == "not JSON"
    assert not storage.index.docs
    assert {path.name for path in directory.iterdir()} == {"manifest.json", ".attachment.lock"}


def test_text_limit_before_embedding(storage):
    assert upload(storage, data=b"x" * (security.MAX_EXTRACTED_CHARS + 1)).status_code == 400
    assert_clean(storage)


def test_chunk_limit_before_embedding(storage, monkeypatch):
    monkeypatch.setattr(rag, "MAX_DOCUMENT_CHUNKS", 1)
    assert upload(storage, data=b"paragraph\n" * 200).status_code == 400
    assert_clean(storage)


def test_manifest_write_is_atomic_when_replace_fails(storage, monkeypatch):
    assert upload(storage).status_code == 200
    before = rag.get_attachment_records(THREAD)
    replace = os.replace
    def fail_manifest(source, destination):
        if Path(destination).name == "manifest.json":
            raise OSError("Simulated replace failure")
        return replace(source, destination)
    monkeypatch.setattr(os, "replace", fail_manifest)
    assert upload(storage).status_code == 503
    assert rag.get_attachment_records(THREAD) == before
    assert len(storage.index.docs) == 1
    assert not list((storage.root / THREAD).glob("*.tmp"))
    assert not (storage.root / THREAD / ".pending.json").exists()


def test_uncommitted_journal_recovers_after_interruption(storage):
    directory = security.thread_directory(storage.root, THREAD, create=True)
    partial = directory / "unfinished.txt"
    partial.write_text("Partial content")
    journal = directory / ".pending.json"
    journal.write_text(json.dumps({"operation": "upload", "attachment_id": "unfinished", "path": str(partial)}))
    assert upload(storage).status_code == 200
    assert not partial.exists() and not journal.exists()
    assert len(rag.get_attachment_records(THREAD)) == 1


def test_partial_stream_journal_needs_no_index_cleanup(storage):
    directory = security.thread_directory(storage.root, THREAD, create=True)
    partial = directory / "unfinished.txt"
    partial.write_text("Partial content")
    journal = directory / ".pending.json"
    journal.write_text(json.dumps({"operation": "upload", "attachment_id": "unfinished",
                                   "path": str(partial), "indexed": False}))
    storage.index.fail_delete = True
    assert upload(storage).status_code == 200
    assert not partial.exists() and not journal.exists()


def test_same_id_with_another_extension_cannot_overwrite_index(storage):
    assert upload(storage).status_code == 200
    record = rag.get_attachment_records(THREAD)[0]
    other = Path(record["path"]).with_suffix(".md")
    other.write_text("Different content")
    with pytest.raises(UploadError, match="already exists"):
        rag.save_uploaded_file(str(other), THREAD)
    assert Path(record["path"]).read_text() == "Security fixture uses SQLite."
    assert next(iter(storage.index.docs.values())).page_content == "Security fixture uses SQLite."
    assert rag.get_attachment_records(THREAD) == [record]


def test_real_chroma_index_and_delete_with_local_embeddings(storage, monkeypatch, tmp_path):
    from langchain_core.embeddings import Embeddings
    from langchain_chroma import Chroma

    class LocalEmbeddings(Embeddings):
        def embed_documents(self, texts):
            return [[1.0, float(len(text) % 7)] for text in texts]

        def embed_query(self, text):
            return self.embed_documents([text])[0]

    index = Chroma(collection_name="security-regression", embedding_function=LocalEmbeddings(),
                   persist_directory=str(tmp_path / "test-chroma"))
    monkeypatch.setattr(rag, "vectorstore", index)
    assert upload(storage).status_code == 200
    assert upload(storage, data=b"Second independent document.").status_code == 200
    records = rag.get_attachment_records(THREAD)
    assert len(index.get()["ids"]) == 2
    assert "SQLite" in rag.retrieve_from_rag("SQLite", THREAD, [records[0]["attachment_id"]])
    assert rag.delete_attachment(THREAD, records[0]["attachment_id"])
    remaining = index.get()
    assert len(remaining["ids"]) == 1
    assert remaining["metadatas"][0]["attachment_id"] == records[1]["attachment_id"]
