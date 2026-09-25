import json
from pathlib import Path

from langchain_core.documents import Document

import rag


CASES_PATH = (
    Path(__file__).resolve().parents[1]
    / "evals"
    / "rag_cases.json"
)


def _make_doc(
    text: str,
    attachment_id: str,
    source: str,
) -> Document:
    return Document(
        page_content=text,
        metadata={
            "attachment_id": attachment_id,
            "source": source,
        },
    )


def setup_function():
    rag._RAG_CACHE.clear()


def teardown_function():
    rag._RAG_CACHE.clear()


def test_offline_rag_evaluation(monkeypatch):
    cases = json.loads(
        CASES_PATH.read_text(
            encoding="utf-8"
        )
    )

    keyword_hits = 0
    source_hits = 0

    for case in cases:
        rag._RAG_CACHE.clear()

        attachment_id = case[
            "attachment_id"
        ]
        source = case["source"]

        monkeypatch.setattr(
            rag,
            "get_attachment_records",
            lambda thread_id,
            attachment_ids=None,
            attachment_id=attachment_id,
            source=source: [
                {
                    "attachment_id":
                        attachment_id,
                    "name": source,
                    "kind": "document",
                    "preview": "",
                }
            ],
        )

        vector_docs = [
            _make_doc(
                text,
                attachment_id,
                source,
            )
            for text in case[
                "vector_candidates"
            ]
        ]

        bm25_docs = [
            _make_doc(
                text,
                attachment_id,
                source,
            )
            for text in case[
                "bm25_candidates"
            ]
        ]

        monkeypatch.setattr(
            rag.vectorstore,
            "similarity_search",
            lambda *args,
            vector_docs=vector_docs,
            **kwargs: vector_docs,
        )

        monkeypatch.setattr(
            rag,
            "_bm25_search",
            lambda *args,
            bm25_docs=bm25_docs,
            **kwargs: bm25_docs,
        )

        def fake_rerank(
            query,
            docs,
            limit,
            expected_keyword=case[
                "expected_keyword"
            ],
        ):
            ranked = sorted(
                docs,
                key=lambda doc:
                    expected_keyword
                    not in doc.page_content.lower(),
            )

            return ranked[:limit]

        monkeypatch.setattr(
            rag,
            "_rerank_documents",
            fake_rerank,
        )

        inspector = {}

        result = rag.retrieve_from_rag(
            query=case["question"],
            thread_id=case[
                "thread_id"
            ],
            attachment_ids=[
                attachment_id
            ],
            k=2,
            inspector=inspector,
        )

        if (
            case["expected_keyword"]
            in result.lower()
        ):
            keyword_hits += 1

        if any(
            item["file"] == source
            for item in inspector[
                "sources"
            ]
        ):
            source_hits += 1

    total = len(cases)

    keyword_hit_rate = (
        keyword_hits / total
    )

    source_hit_rate = (
        source_hits / total
    )

    print(
        f"RAG keyword hit rate: "
        f"{keyword_hit_rate:.0%}"
    )

    print(
        f"RAG source hit rate: "
        f"{source_hit_rate:.0%}"
    )

    assert keyword_hit_rate == 1.0
    assert source_hit_rate == 1.0
