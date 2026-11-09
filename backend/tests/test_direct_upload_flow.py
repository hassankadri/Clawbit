"""Offline regressions for the Vercel direct-to-Neon upload flow."""

from contextlib import contextmanager
from pathlib import Path

import pytest

import managed_uploads
import object_storage
import rag
from upload_security import UploadError


def configure_direct_upload(monkeypatch, tmp_path, intent):
    monkeypatch.setattr(rag, "PERSISTENCE_BACKEND", "postgres")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()

    def thread_dir(thread_id, *, create=False):
        directory = upload_root / thread_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @contextmanager
    def upload_lock(thread_id):
        yield thread_dir(thread_id, create=True)

    monkeypatch.setattr(rag, "UPLOAD_ROOT", upload_root)
    monkeypatch.setattr(rag, "_thread_upload_dir", thread_dir)
    monkeypatch.setattr(rag, "_upload_lock", upload_lock)
    monkeypatch.setattr(rag, "require_thread", lambda *args, **kwargs: None)
    monkeypatch.setattr(rag, "_load_manifest", lambda thread_id: [])
    monkeypatch.setattr(rag, "_sweep_expired_upload_intents", lambda: None)
    monkeypatch.setattr(rag, "validate_file", lambda root, path: ("document", "text/plain"))
    monkeypatch.setattr(rag, "_extract_pages", lambda path: [(None, "hello world!")])
    monkeypatch.setattr(rag, "add_document_to_rag", lambda *args, **kwargs: {"chunks": 1})
    monkeypatch.setattr(rag, "_remove_file", lambda path: Path(path).unlink(missing_ok=True))
    monkeypatch.setattr(rag, "_RAG_CACHE", {})

    state = {
        "intent": dict(intent),
        "committed": [],
        "events": [],
        "objects": {
            intent["staging_key"]: {
                "bytes": b"hello world!",
                "size": len(b"hello world!"),
                "content_type": "text/plain",
            }
        },
    }

    def get_intent(thread_id, attachment_id):
        if state["intent"] is None:
            return None
        if attachment_id != state["intent"]["attachment_id"]:
            return None
        return dict(state["intent"])

    def set_final(thread_id, attachment_id, final_key):
        state["events"].append("set-final-key")
        state["intent"]["final_key"] = final_key

    def commit(thread_id, attachment_id, record):
        state["events"].append("commit-manifest")
        state["committed"].append(dict(record))
        state["intent"] = None
        return {**record, "thread_id": thread_id}

    def delete_intent(*args, **kwargs):
        state["intent"] = None
        return True

    monkeypatch.setattr(managed_uploads, "get_upload_intent", get_intent)
    monkeypatch.setattr(managed_uploads, "set_upload_intent_final_key", set_final)
    monkeypatch.setattr(managed_uploads, "commit_upload_intent", commit)
    monkeypatch.setattr(managed_uploads, "list_expired_upload_intents", lambda **kwargs: [])
    monkeypatch.setattr(managed_uploads, "delete_upload_intent", delete_intent)

    def head(key):
        state["events"].append(f"head:{key}")
        value = state["objects"].get(key)
        if value is None:
            raise FileNotFoundError(key)
        return {"size": value["size"], "content_type": value["content_type"]}

    def get(key, *, max_bytes):
        state["events"].append(f"get:{key}")
        raw = state["objects"][key]["bytes"]
        assert len(raw) <= max_bytes
        return raw

    def put(key, content, content_type):
        state["events"].append(f"put:{key}")
        state["objects"][key] = {
            "bytes": content,
            "size": len(content),
            "content_type": content_type,
        }

    def delete(key):
        state["events"].append(f"delete:{key}")
        state["objects"].pop(key, None)

    monkeypatch.setattr(object_storage, "head_object", head)
    monkeypatch.setattr(object_storage, "get_bytes", get)
    monkeypatch.setattr(object_storage, "put_bytes", put)
    monkeypatch.setattr(object_storage, "delete_object", delete)

    return state


def test_complete_direct_upload_validates_then_commits_immutable_object(monkeypatch, tmp_path):
    attachment_id = "f" * 32
    intent = {
        "attachment_id": attachment_id,
        "thread_id": "thread-direct",
        "staging_key": "pending-uploads/staging.txt",
        "final_key": None,
        "name": "notes.txt",
        "suffix": ".txt",
        "mime_type": "text/plain",
        "kind": "document",
        "expected_size": len(b"hello world!"),
        "created_at": 1.0,
        "expires_at": 9999999999,
    }
    state = configure_direct_upload(monkeypatch, tmp_path, intent)

    record = rag.complete_direct_upload("thread-direct", attachment_id)

    assert record["attachment_id"] == attachment_id
    assert record["kind"] == "document"
    assert record["object_key"].startswith("uploads/")
    assert record["object_key"] != intent["staging_key"]
    assert record["preview"] == "hello world!"
    assert intent["staging_key"] not in state["objects"]
    assert record["object_key"] in state["objects"]
    assert state["events"].index("set-final-key") < next(
        i for i, event in enumerate(state["events"]) if event.startswith("put:uploads/")
    )
    assert state["events"].index(f"delete:{intent['staging_key']}") < state["events"].index(
        "commit-manifest"
    )


def test_complete_direct_upload_rejects_unexpected_size_and_removes_staging(monkeypatch, tmp_path):
    attachment_id = "e" * 32
    intent = {
        "attachment_id": attachment_id,
        "thread_id": "thread-size",
        "staging_key": "pending-uploads/too-large.txt",
        "final_key": None,
        "name": "notes.txt",
        "suffix": ".txt",
        "mime_type": "text/plain",
        "kind": "document",
        "expected_size": len(b"hello world!"),
        "created_at": 1.0,
        "expires_at": 9999999999,
    }
    state = configure_direct_upload(monkeypatch, tmp_path, intent)
    state["objects"][intent["staging_key"]]["size"] += 1

    with pytest.raises(UploadError, match="size does not match"):
        rag.complete_direct_upload("thread-size", attachment_id)

    assert intent["staging_key"] not in state["objects"]
    assert state["committed"] == []
    assert state["intent"] is None


def test_complete_direct_upload_is_idempotent_after_manifest_commit(monkeypatch, tmp_path):
    attachment_id = "d" * 32
    committed = {
        "attachment_id": attachment_id,
        "thread_id": "thread-idempotent",
        "name": "done.txt",
        "kind": "document",
        "mime_type": "text/plain",
        "size": 12,
        "path": "uploads/immutable.txt",
        "object_key": "uploads/immutable.txt",
        "preview": "done",
    }
    monkeypatch.setattr(rag, "PERSISTENCE_BACKEND", "postgres")
    monkeypatch.setattr(rag, "require_thread", lambda *args, **kwargs: None)
    monkeypatch.setattr(rag, "_load_manifest", lambda thread_id: [committed])

    result = rag.complete_direct_upload("thread-idempotent", attachment_id)

    assert result == committed



def test_create_direct_upload_returns_short_lived_signed_put(monkeypatch):
    from contextlib import contextmanager

    import managed_uploads

    monkeypatch.setattr(rag, "PERSISTENCE_BACKEND", "postgres")
    monkeypatch.setattr(rag, "require_thread", lambda *args, **kwargs: None)
    monkeypatch.setattr(rag, "_sweep_expired_upload_intents", lambda: None)

    @contextmanager
    def no_lock(thread_id):
        yield None

    monkeypatch.setattr(rag, "_upload_lock", no_lock)

    created = {}
    signed = {}

    def create_intent(thread_id, **kwargs):
        created.update(kwargs)
        return {**kwargs, "thread_id": thread_id}

    monkeypatch.setattr(managed_uploads, "create_upload_intent", create_intent)
    monkeypatch.setattr(
        object_storage,
        "presign_put",
        lambda key, **kwargs: signed.update({"key": key, **kwargs}) or "https://storage.invalid/signed",
    )

    result = rag.create_direct_upload(
        "thread-create",
        "notes.txt",
        128,
    )

    assert result["mode"] == "direct"
    assert result["upload_url"] == "https://storage.invalid/signed"
    assert result["upload_headers"] == {"Content-Type": "text/plain"}
    assert created["expected_size"] == 128
    assert created["kind"] == "document"
    assert signed["content_type"] == "text/plain"
    assert signed["expires_in"] == 300
    assert signed["key"] == created["staging_key"]


def test_create_direct_upload_rejects_files_over_ten_mib(monkeypatch):
    monkeypatch.setattr(rag, "PERSISTENCE_BACKEND", "postgres")
    monkeypatch.setattr(rag, "_sweep_expired_upload_intents", lambda: None)

    with pytest.raises(UploadError, match="10 MiB"):
        rag.create_direct_upload(
            "thread-too-large",
            "oversized.pdf",
            10 * 1024 * 1024 + 1,
        )
