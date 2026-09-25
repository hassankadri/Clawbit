from langchain_core.documents import Document

import rag


def _doc(
    text: str,
    attachment_id: str,
    source: str,
    page: int | None = None,
) -> Document:
    metadata = {
        "attachment_id": attachment_id,
        "source": source,
    }

    if page is not None:
        metadata["page"] = page

    return Document(
        page_content=text,
        metadata=metadata,
    )


def setup_function():
    rag._RAG_CACHE.clear()


def teardown_function():
    rag._RAG_CACHE.clear()


def test_hybrid_rag_reranks_and_returns_inspector(monkeypatch):
    attachment_id = "atlas-id"

    monkeypatch.setattr(
        rag,
        "get_attachment_records",
        lambda thread_id, attachment_ids=None: [
            {
                "attachment_id": attachment_id,
                "name": "atlas.txt",
                "kind": "document",
                "preview": "Project Atlas uses PostgreSQL.",
            }
        ],
    )

    vector_docs = [
        _doc(
            "Project Atlas uses PostgreSQL.",
            attachment_id,
            "atlas.txt",
        ),
        _doc(
            "Project Atlas uses a blue interface.",
            attachment_id,
            "atlas.txt",
        ),
    ]

    bm25_docs = [
        _doc(
            "Project Atlas uses PostgreSQL.",
            attachment_id,
            "atlas.txt",
        ),
        _doc(
            "PostgreSQL stores customer orders.",
            attachment_id,
            "atlas.txt",
        ),
    ]

    monkeypatch.setattr(
        rag.vectorstore,
        "similarity_search",
        lambda *args, **kwargs: vector_docs,
    )

    monkeypatch.setattr(
        rag,
        "_bm25_search",
        lambda *args, **kwargs: bm25_docs,
    )

    def fake_rerank(query, docs, limit):
        preferred = sorted(
            docs,
            key=lambda doc: (
                "customer orders" not in doc.page_content.lower()
            ),
        )
        return preferred[:limit]

    monkeypatch.setattr(
        rag,
        "_rerank_documents",
        fake_rerank,
    )

    inspector = {}

    result = rag.retrieve_from_rag(
        query="What database does Project Atlas use?",
        thread_id="rag-test-thread",
        attachment_ids=[attachment_id],
        k=2,
        inspector=inspector,
    )

    assert "PostgreSQL stores customer orders." in result
    assert inspector["cache_hit"] is False
    assert inspector["vector_candidates"] == 2
    assert inspector["bm25_candidates"] == 2
    assert inspector["hybrid_candidates"] == 3
    assert inspector["after_deduplication"] == 3
    assert inspector["reranking_completed"] is True
    assert inspector["selected_chunks"] == 2
    assert inspector["sources"][0]["file"] == "atlas.txt"


def test_rag_cache_hits_on_second_identical_request(monkeypatch):
    attachment_id = "cache-doc"
    calls = {
        "vector": 0,
        "bm25": 0,
        "rerank": 0,
    }

    monkeypatch.setattr(
        rag,
        "get_attachment_records",
        lambda thread_id, attachment_ids=None: [
            {
                "attachment_id": attachment_id,
                "name": "cache.txt",
                "kind": "document",
                "preview": "Project Cache uses SQLite.",
            }
        ],
    )

    docs = [
        _doc(
            "Project Cache uses SQLite.",
            attachment_id,
            "cache.txt",
        )
    ]

    def fake_vector(*args, **kwargs):
        calls["vector"] += 1
        return docs

    def fake_bm25(*args, **kwargs):
        calls["bm25"] += 1
        return docs

    def fake_rerank(query, input_docs, limit):
        calls["rerank"] += 1
        return input_docs[:limit]

    monkeypatch.setattr(
        rag.vectorstore,
        "similarity_search",
        fake_vector,
    )

    monkeypatch.setattr(
        rag,
        "_bm25_search",
        fake_bm25,
    )

    monkeypatch.setattr(
        rag,
        "_rerank_documents",
        fake_rerank,
    )

    first_inspector = {}

    first_result = rag.retrieve_from_rag(
        query="Project Cache database",
        thread_id="cache-thread",
        attachment_ids=[attachment_id],
        inspector=first_inspector,
    )

    second_inspector = {}

    second_result = rag.retrieve_from_rag(
        query="Project Cache database",
        thread_id="cache-thread",
        attachment_ids=[attachment_id],
        inspector=second_inspector,
    )

    assert first_result == second_result
    assert first_inspector["cache_hit"] is False
    assert second_inspector["cache_hit"] is True
    assert calls == {
        "vector": 1,
        "bm25": 1,
        "rerank": 1,
    }


def test_rag_cache_does_not_cross_attachment_selection(monkeypatch):
    calls = {
        "vector": 0,
    }

    def fake_records(thread_id, attachment_ids=None):
        attachment_id = attachment_ids[0]

        return [
            {
                "attachment_id": attachment_id,
                "name": f"{attachment_id}.txt",
                "kind": "document",
                "preview": f"Content for {attachment_id}.",
            }
        ]

    def fake_vector(query, k, filter):
        calls["vector"] += 1

        attachment_filter = filter["$and"][1]["attachment_id"]

        return [
            _doc(
                f"Content for {attachment_filter}.",
                attachment_filter,
                f"{attachment_filter}.txt",
            )
        ]

    monkeypatch.setattr(
        rag,
        "get_attachment_records",
        fake_records,
    )

    monkeypatch.setattr(
        rag.vectorstore,
        "similarity_search",
        fake_vector,
    )

    monkeypatch.setattr(
        rag,
        "_bm25_search",
        lambda *args, **kwargs: [],
    )

    monkeypatch.setattr(
        rag,
        "_rerank_documents",
        lambda query, docs, limit: docs[:limit],
    )

    inspector_a = {}
    inspector_b = {}

    result_a = rag.retrieve_from_rag(
        query="same query",
        thread_id="same-thread",
        attachment_ids=["doc-a"],
        inspector=inspector_a,
    )

    result_b = rag.retrieve_from_rag(
        query="same query",
        thread_id="same-thread",
        attachment_ids=["doc-b"],
        inspector=inspector_b,
    )

    assert "doc-a" in result_a
    assert "doc-b" in result_b
    assert inspector_a["cache_hit"] is False
    assert inspector_b["cache_hit"] is False
    assert calls["vector"] == 2
