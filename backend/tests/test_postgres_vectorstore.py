"""Offline regression tests for principal-isolated pgvector operations."""

import json

import pytest
from langchain_core.documents import Document

import postgres_vectorstore
from postgres_vectorstore import EMBEDDING_DIMENSIONS, PostgresVectorStore, _compile_where, _vector_literal
from postgres_db import HybridRow
from ownership import owner_context, OwnershipError


class FakeCursor:
    def __init__(self, rows=None):
        self.rows = rows or []

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConnection:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append(("execute", sql, params))
        compact = " ".join(sql.split()).lower()
        if "select distinct thread_id" in compact:
            return FakeCursor(self.rows)
        return FakeCursor(self.rows)

    def executemany(self, sql, params):
        self.calls.append(("executemany", sql, list(params)))
        return FakeCursor()


class FakeEmbeddings:
    def __init__(self):
        self.document_calls = []
        self.query_calls = []

    def embed_documents(self, texts):
        self.document_calls.append(texts)
        return [[0.0] * EMBEDDING_DIMENSIONS for _ in texts]

    def embed_query(self, query):
        self.query_calls.append(query)
        return [0.0] * EMBEDDING_DIMENSIONS


def install_connection(monkeypatch, connection):
    from contextlib import contextmanager

    @contextmanager
    def fake_connection():
        yield connection

    monkeypatch.setattr(postgres_vectorstore, "postgres_connection", fake_connection)


def test_filter_compiler_allows_only_thread_and_attachment_scope():
    sql, params, _ = _compile_where({
        "$and": [
            {"thread_id": "thread-1"},
            {"attachment_id": {"$in": ["file-1", "file-2"]}},
        ]
    })

    assert "thread_id = ?" in sql
    assert "attachment_id IN (?,?)" in sql
    assert params == ["thread-1", "file-1", "file-2"]


def test_filter_compiler_rejects_unscoped_and_unknown_fields():
    with pytest.raises(OwnershipError):
        _compile_where({})

    with pytest.raises(ValueError, match="Unsupported"):
        _compile_where({"principal": "forged-owner"})

    with pytest.raises(ValueError, match="Unsupported"):
        _compile_where({"thread_id": {"$ne": "thread-1"}})


def test_vector_literal_requires_exact_embedding_dimensions():
    value = _vector_literal([0.0] * EMBEDDING_DIMENSIONS)
    assert value.startswith("[0,0,0")
    assert value.endswith("]")
    with pytest.raises(ValueError, match="Expected"):
        _vector_literal([0.0] * 3)


def test_add_documents_always_saves_verified_principal_and_owned_thread(monkeypatch):
    connection = FakeConnection()
    install_connection(monkeypatch, connection)
    monkeypatch.setattr(postgres_vectorstore, "require_thread", lambda thread: None)

    store = PostgresVectorStore(FakeEmbeddings())
    monkeypatch.setattr(store, "_ensure_schema", lambda: None)

    with owner_context("principal-a"):
        result = store.add_documents(
            [Document(page_content="hello", metadata={
                "thread_id": "thread-1",
                "attachment_id": "attachment-1",
            })],
            ids=["chunk-1"],
        )

    assert result == ["chunk-1"]
    call = connection.calls[0]
    assert call[0] == "executemany"
    assert "principal" in call[1]
    row = call[2][0]
    assert row[0] == "chunk-1"
    assert row[1] == "principal-a"
    assert row[2:4] == ("thread-1", "attachment-1")


def test_similarity_search_adds_principal_and_thread_filters(monkeypatch):
    metadata = {"thread_id": "thread-1", "attachment_id": "file-1"}
    connection = FakeConnection([
        HybridRow({"content": "private chunk", "metadata": json.dumps(metadata)})
    ])
    install_connection(monkeypatch, connection)
    authorized = []
    monkeypatch.setattr(
        postgres_vectorstore,
        "require_thread",
        lambda thread: authorized.append(thread),
    )

    embeddings = FakeEmbeddings()
    store = PostgresVectorStore(embeddings)
    monkeypatch.setattr(store, "_ensure_schema", lambda: None)

    with owner_context("principal-a"):
        docs = store.similarity_search(
            "question",
            filter={"$and": [
                {"thread_id": "thread-1"},
                {"attachment_id": "file-1"},
            ]},
        )

    sql, params = connection.calls[0][1], connection.calls[0][2]
    assert "principal=?" in sql
    assert "thread_id = ?" in sql
    assert params[0] == "principal-a"
    assert params[1:3] == ("thread-1", "file-1")
    assert authorized == ["thread-1"]
    assert docs[0].page_content == "private chunk"
    assert embeddings.query_calls == ["question"]


def test_get_and_delete_are_principal_scoped(monkeypatch):
    connection = FakeConnection([
        HybridRow({"id": "chunk-1", "metadata": json.dumps({
            "thread_id": "thread-1", "attachment_id": "file-1",
        })})
    ])
    install_connection(monkeypatch, connection)
    monkeypatch.setattr(postgres_vectorstore, "require_thread", lambda thread: None)

    store = PostgresVectorStore(FakeEmbeddings())
    monkeypatch.setattr(store, "_ensure_schema", lambda: None)

    with owner_context("principal-b"):
        store.get(
            where={"thread_id": "thread-1"},
            include=["metadatas"],
        )
        store.delete(where={"thread_id": "thread-1"})

    selects = [call for call in connection.calls if call[0] == "execute"]
    assert all("principal = ?" in call[1] for call in selects)
    assert all(call[2][0] == "principal-b" for call in selects)
    assert any("DELETE FROM rag_documents" in call[1] for call in selects)


def test_vector_store_rejects_documents_without_ownership_metadata(monkeypatch):
    connection = FakeConnection()
    install_connection(monkeypatch, connection)
    store = PostgresVectorStore(FakeEmbeddings())
    monkeypatch.setattr(store, "_ensure_schema", lambda: None)

    with owner_context("principal-a"):
        with pytest.raises(ValueError, match="thread and attachment"):
            store.add_documents(
                [Document(page_content="no owner metadata", metadata={})],
                ids=["chunk-1"],
            )

    assert connection.calls == []
