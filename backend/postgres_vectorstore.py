"""Principal- and thread-scoped pgvector adapter for the existing RAG API."""

from __future__ import annotations

import json
from typing import Any

from langchain_core.documents import Document

from ownership import OwnershipError, current_owner, require_thread
from postgres_db import postgres_connection


EMBEDDING_DIMENSIONS = 3072


def _vector_literal(values: list[float]) -> str:
    if len(values) != EMBEDDING_DIMENSIONS:
        raise ValueError(
            f"Expected {EMBEDDING_DIMENSIONS}-dimension embeddings, got {len(values)}."
        )
    return "[" + ",".join(format(float(value), ".9g") for value in values) + "]"


def _compile_where(where: dict[str, Any]) -> tuple[str, list[Any], str]:
    """Compile the small Chroma where-filter subset used by Clawbit."""
    if not isinstance(where, dict) or not where:
        raise OwnershipError()

    clauses: list[str] = []
    params: list[Any] = []

    if "$and" in where:
        children = where["$and"]
        if not isinstance(children, list) or not children:
            raise ValueError("Invalid vector filter.")
        for child in children:
            sql, values, _ = _compile_where(child)
            clauses.append(sql)
            params.extend(values)
        return "(" + " AND ".join(clauses) + ")", params, ""

    for key, value in where.items():
        if key not in {"thread_id", "attachment_id"}:
            raise ValueError("Unsupported vector metadata filter.")
        if isinstance(value, dict):
            if set(value) != {"$in"} or not isinstance(value["$in"], list) or not value["$in"]:
                raise ValueError("Unsupported vector metadata filter.")
            choices = value["$in"]
            clauses.append(f"{key} IN ({','.join('?' for _ in choices)})")
            params.extend(choices)
        else:
            clauses.append(f"{key} = ?")
            params.append(value)

    return "(" + " AND ".join(clauses) + ")", params, ""


class PostgresVectorStore:
    """Minimal vectorstore interface consumed by backend/rag.py.

    Queries always include the verified principal as a separate SQL predicate.
    Caller-provided metadata filters can only narrow that scope, never broaden it.
    """

    def __init__(self, embedding_function: Any):
        self.embedding_function = embedding_function

    def add_documents(self, documents: list[Document], ids: list[str] | None = None):
        if not documents:
            return []
        if ids is None or len(ids) != len(documents) or len(set(ids)) != len(ids):
            raise ValueError("A unique ID is required for every document.")

        principal = current_owner()
        texts = [document.page_content for document in documents]
        vectors = self.embedding_function.embed_documents(texts)
        if len(vectors) != len(documents):
            raise RuntimeError("Embedding provider returned an unexpected result count.")

        rows = []
        for document_id, document, vector in zip(ids, documents, vectors):
            metadata = dict(document.metadata or {})
            thread_id = metadata.get("thread_id")
            attachment_id = metadata.get("attachment_id")
            if not isinstance(thread_id, str) or not isinstance(attachment_id, str):
                raise ValueError("Every RAG document must include thread and attachment IDs.")
            require_thread(thread_id)
            rows.append((
                document_id,
                principal,
                thread_id,
                attachment_id,
                document.page_content,
                _vector_literal(vector),
                json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
            ))

        with postgres_connection() as db:
            db.executemany(
                """
                INSERT INTO rag_documents
                    (id,principal,thread_id,attachment_id,content,embedding,metadata)
                VALUES(?,?,?,?,?,?,?::jsonb)
                """,
                rows,
            )
        return ids

    def get(
        self,
        *,
        where: dict[str, Any],
        include: list[str] | None = None,
        ids: list[str] | None = None,
    ) -> dict[str, Any]:
        principal = current_owner()
        where_sql, where_params, _ = _compile_where(where)
        clauses = ["principal = ?", where_sql]
        params: list[Any] = [principal, *where_params]

        if ids is not None:
            if not ids:
                return {"ids": [], "documents": [], "metadatas": [], "embeddings": []}
            clauses.append(f"id IN ({','.join('?' for _ in ids)})")
            params.extend(ids)

        select = ["id", "metadata::text AS metadata"]
        if include and "documents" in include:
            select.append("content")
        if include and "embeddings" in include:
            select.append("embedding::text AS embedding")

        with postgres_connection() as db:
            rows = db.execute(
                f"SELECT {', '.join(select)} FROM rag_documents WHERE "
                + " AND ".join(clauses),
                tuple(params),
            ).fetchall()

        result: dict[str, Any] = {"ids": [], "documents": [], "metadatas": [], "embeddings": []}
        for row in rows:
            result["ids"].append(row["id"])
            result["metadatas"].append(
                row["metadata"] if isinstance(row["metadata"], dict)
                else json.loads(row["metadata"])
            )
            if include and "documents" in include:
                result["documents"].append(row["content"])
            if include and "embeddings" in include:
                raw = row["embedding"].strip("[]")
                result["embeddings"].append(
                    [float(value) for value in raw.split(",")] if raw else []
                )
        return result

    def delete(
        self,
        *,
        where: dict[str, Any] | None = None,
        ids: list[str] | None = None,
    ) -> None:
        if not where and not ids:
            raise OwnershipError()

        principal = current_owner()
        clauses = ["principal = ?"]
        params: list[Any] = [principal]

        if where:
            where_sql, where_params, _ = _compile_where(where)
            clauses.append(where_sql)
            params.extend(where_params)

        if ids is not None:
            if not ids:
                return
            clauses.append(f"id IN ({','.join('?' for _ in ids)})")
            params.extend(ids)

        with postgres_connection() as db:
            rows = db.execute(
                "SELECT DISTINCT thread_id FROM rag_documents WHERE " + " AND ".join(clauses),
                tuple(params),
            ).fetchall()
            for row in rows:
                require_thread(row["thread_id"])

            db.execute(
                "DELETE FROM rag_documents WHERE " + " AND ".join(clauses),
                tuple(params),
            )

    def similarity_search(
        self,
        query: str,
        *,
        k: int = 4,
        filter: dict[str, Any] | None = None,
    ) -> list[Document]:
        if not filter:
            raise OwnershipError()

        principal = current_owner()
        where_sql, where_params, _ = _compile_where(filter)
        vector = self.embedding_function.embed_query(query)
        literal = _vector_literal(vector)

        # Exact cosine search is intentionally used first. The clean-slate
        # collection is small; a halfvec HNSW index can be added after measuring
        # real corpus size and retrieval quality.
        with postgres_connection() as db:
            rows = db.execute(
                """
                SELECT content, metadata::text AS metadata
                FROM rag_documents
                WHERE principal=? AND
                """
                + where_sql
                + """
                ORDER BY embedding <=> ?::vector
                LIMIT ?
                """,
                (principal, *where_params, literal, max(1, int(k))),
            ).fetchall()

        documents = []
        for row in rows:
            metadata = (
                row["metadata"] if isinstance(row["metadata"], dict)
                else json.loads(row["metadata"])
            )
            thread_id = metadata.get("thread_id")
            require_thread(thread_id)
            documents.append(Document(page_content=row["content"], metadata=metadata))
        return documents
