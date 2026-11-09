""""Offline tests for owner-scoped managed upload metadata."""

import json
from contextlib import contextmanager

from postgres_db import HybridRow
import managed_uploads
from ownership import owner_context, OwnershipError
import pytest


class Cursor:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = rows or []

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._row


class Connection:
    def __init__(self, rows=None, row=None):
        self.rows = rows or []
        self.row = row
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        compact = " ".join(sql.split()).lower()
        if "returning object_key" in compact:
            return Cursor(self.row)
        return Cursor(rows=self.rows)

    def executemany(self, sql, params):
        self.calls.append((sql, list(params)))
        return Cursor()


def install(monkeypatch, connection):
    @contextmanager
    def fake_connection():
        yield connection
    monkeypatch.setattr(managed_uploads, "postgres_connection", fake_connection)


def test_load_manifest_is_scoped_to_current_principal_and_thread(monkeypatch):
    row = HybridRow({
        "attachment_id": "file-1", "name": "private.pdf", "kind": "document",
        "mime_type": "application/pdf", "size": 12, "object_key": "uploads/key.pdf",
        "source": "private.pdf", "preview": "preview", "rag_error": None, "created_at": 1.0,
    })
    db = Connection(rows=[row])
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread, **kwargs: None)

    with owner_context("principal-a"):
        result = managed_uploads.load_manifest("thread-a")

    sql, params = db.calls[0]
    assert "principal=? AND thread_id=?" in sql
    assert params == ("principal-a", "thread-a")
    assert result[0]["object_key"] == "uploads/key.pdf"
    assert result[0]["path"] == "uploads/key.pdf"
    assert result[0]["thread_id"] == "thread-a"


def test_save_manifest_deletes_and_reinserts_only_owned_thread(monkeypatch):
    db = Connection()
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread: None)

    with owner_context("principal-b"):
        managed_uploads.save_manifest("thread-b", [{
            "attachment_id": "file-2", "object_key": "uploads/key-2.pdf",
            "name": "report.pdf", "kind": "document", "mime_type": "application/pdf",
            "size": 20, "source": "report.pdf", "created_at": 2.0,
        }])

    assert "pg_advisory_xact_lock" in db.calls[0][0]
    assert db.calls[1][1] == ("principal-b", "thread-b")
    insert_sql, rows = db.calls[2]
    assert "INSERT INTO upload_attachments" in insert_sql
    assert rows[0][0:3] == ("principal-b", "thread-b", "file-2")
    assert rows[0][7] == "uploads/key-2.pdf"


def test_delete_attachment_record_uses_current_principal(monkeypatch):
    db = Connection(row=HybridRow({"object_key": "uploads/private-object"}))
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread: None)

    with owner_context("principal-c"):
        result = managed_uploads.delete_attachment_record("thread-c", "file-c")

    sql, params = db.calls[0]
    assert "DELETE FROM upload_attachments" in sql
    assert "principal=? AND thread_id=? AND attachment_id=?" in sql
    assert params == ("principal-c", "thread-c", "file-c")
    assert result == {"object_key": "uploads/private-object"}


def test_thread_for_object_does_not_resolve_foreign_object(monkeypatch):
    db = Connection()
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread: None)

    with owner_context("principal-d"):
        with pytest.raises(OwnershipError):
            managed_uploads.thread_for_object("uploads/guessed-key")

    sql, params = db.calls[0]
    assert "principal=? AND object_key=?" in sql
    assert params == ("principal-d", "uploads/guessed-key")


def test_manifest_rejects_malformed_object_metadata(monkeypatch):
    db = Connection()
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread: None)

    with owner_context("principal-e"):
        with pytest.raises(ValueError, match="metadata is incomplete"):
            managed_uploads.save_manifest("thread-e", [{"attachment_id": "file-e"}])

    # Validation occurs before any mutation query.
    assert db.calls == []


class SequenceConnection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        row = self.rows.pop(0) if self.rows else None
        if isinstance(row, BaseException):
            raise row
        return Cursor(row=row)

    def executemany(self, sql, params):
        self.calls.append((sql, list(params)))
        return Cursor()


def test_create_upload_intent_reserves_slot_for_current_principal(monkeypatch):
    db = SequenceConnection([(2,), (1,), None])
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread, **kwargs: None)

    with owner_context("principal-upload"):
        record = managed_uploads.create_upload_intent(
            "thread-upload",
            attachment_id="a" * 32,
            staging_key="pending-uploads/random.pdf",
            name="report.pdf",
            suffix=".pdf",
            mime_type="application/pdf",
            kind="document",
            expected_size=1234,
            expires_at=9999999999,
            max_attachments=10,
        )

    assert record["attachment_id"] == "a" * 32
    assert record["expected_size"] == 1234
    assert "pg_advisory_xact_lock" in db.calls[0][0]
    assert db.calls[1][1] == ("principal-upload", "thread-upload")
    assert db.calls[2][1][0:4] == (
        "a" * 32,
        "principal-upload",
        "thread-upload",
        "pending-uploads/random.pdf",
    )
    assert "INSERT INTO upload_intents" in db.calls[2][0]


def test_create_upload_intent_rejects_when_attachment_slots_are_full(monkeypatch):
    db = SequenceConnection([(10,), (0,)])
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread, **kwargs: None)

    with owner_context("principal-full"):
        with pytest.raises(Exception, match="at most 10 attachments"):
            managed_uploads.create_upload_intent(
                "thread-full",
                attachment_id="b" * 32,
                staging_key="pending-uploads/full.txt",
                name="full.txt",
                suffix=".txt",
                mime_type="text/plain",
                kind="document",
                expected_size=100,
                expires_at=9999999999,
                max_attachments=10,
            )

    assert all("INSERT INTO upload_intents" not in call[0] for call in db.calls)


def test_get_upload_intent_is_owner_and_expiry_scoped(monkeypatch):
    row = HybridRow({
        "attachment_id": "c" * 32,
        "thread_id": "thread-c",
        "staging_key": "pending-uploads/c.txt",
        "final_key": None,
        "name": "c.txt",
        "suffix": ".txt",
        "mime_type": "text/plain",
        "kind": "document",
        "expected_size": 12,
        "created_at": 1.0,
        "expires_at": 9999999999,
    })
    db = Connection(row=row)
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread, **kwargs: None)

    with owner_context("principal-c"):
        intent = managed_uploads.get_upload_intent("thread-c", "c" * 32)

    sql, params = db.calls[0]
    assert "principal=? AND thread_id=? AND attachment_id=? AND expires_at>?" in sql
    assert params[:3] == ("principal-c", "thread-c", "c" * 32)
    assert intent["staging_key"] == "pending-uploads/c.txt"


def test_commit_upload_intent_is_atomic_and_rechecks_reservation(monkeypatch):
    existing_row = None
    reserved = HybridRow({
        "final_key": "uploads/final.pdf",
        "expected_size": 100,
        "name": "report.pdf",
        "suffix": ".pdf",
        "mime_type": "application/pdf",
        "kind": "document",
    })
    db = SequenceConnection([None, existing_row, reserved, None, None])
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread: None)

    record = {
        "attachment_id": "d" * 32,
        "name": "report.pdf",
        "kind": "document",
        "mime_type": "application/pdf",
        "size": 100,
        "path": "uploads/final.pdf",
        "object_key": "uploads/final.pdf",
        "source": "report.pdf",
        "preview": "preview",
        "rag_error": None,
        "created_at": 5.0,
    }
    with owner_context("principal-d"):
        saved = managed_uploads.commit_upload_intent("thread-d", "d" * 32, record)

    assert saved["object_key"] == "uploads/final.pdf"
    assert "pg_advisory_xact_lock" in db.calls[0][0]
    assert "SELECT attachment_id,name,kind" in db.calls[1][0]
    assert db.calls[1][1] == ("principal-d", "thread-d", "d" * 32)
    assert "SELECT final_key,expected_size" in db.calls[2][0]
    assert db.calls[2][1][:3] == ("principal-d", "thread-d", "d" * 32)
    assert "INSERT INTO upload_attachments" in db.calls[3][0]
    assert "DELETE FROM upload_intents" in db.calls[4][0]


def test_commit_upload_intent_rejects_wrong_immutable_key(monkeypatch):
    reserved = HybridRow({
        "final_key": "uploads/expected.pdf",
        "expected_size": 100,
        "name": "report.pdf",
        "suffix": ".pdf",
        "mime_type": "application/pdf",
        "kind": "document",
    })
    db = SequenceConnection([None, None, reserved])
    install(monkeypatch, db)
    monkeypatch.setattr(managed_uploads, "require_thread", lambda thread: None)

    with owner_context("principal-e"):
        with pytest.raises(OwnershipError):
            managed_uploads.commit_upload_intent("thread-e", "e" * 32, {
                "attachment_id": "e" * 32,
                "name": "report.pdf",
                "kind": "document",
                "mime_type": "application/pdf",
                "size": 100,
                "path": "uploads/forged.pdf",
                "object_key": "uploads/forged.pdf",
            })

    assert all("INSERT INTO upload_attachments" not in call[0] for call in db.calls)
