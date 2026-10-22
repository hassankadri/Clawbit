"""Measured retrieval fixtures; no hosted embeddings, reranker downloads or inference."""

from collections import Counter
import asyncio
import json
import math
from pathlib import Path
import time
from types import SimpleNamespace

from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
import pytest

import evidence
import evaluate
from evaluate import EvaluationResults
import memory_store
from ownership import OwnershipError, bind_resources, owner_context
import rag

CORPUS = Path(__file__).resolve().parents[1] / "evals" / "retrieval.json"


def retrieval_metrics(selected: list[Document], relevant: set[str], corpus: list[Document], k: int) -> dict:
    identifiers = [doc.metadata["chunk_id"] for doc in selected]
    hits = relevant.intersection(identifiers)
    expected_sources = {
        doc.metadata["attachment_id"] for doc in corpus
        if doc.metadata["chunk_id"] in relevant
    }
    sources = {doc.metadata["attachment_id"] for doc in selected if doc.metadata["chunk_id"] in relevant}
    ranks = [index for index, identifier in enumerate(identifiers, 1) if identifier in relevant]
    return {
        "recall_at_k": len(hits) / len(relevant) if relevant else None,
        "precision_at_k": len(hits) / k,
        "mrr": 1 / min(ranks) if ranks else 0.0,
        "hit_rate_at_k": float(bool(hits)) if relevant else None,
        "source_coverage": len(sources) / len(expected_sources) if expected_sources else None,
        "duplicate_content_rate": (
            1 - len({doc.page_content for doc in selected}) / len(selected) if selected else 0.0
        ),
    }


def lexical_candidates(query: str, documents: list[Document]) -> list[Document]:
    """Controlled cosine candidate source, explicitly not a semantic vector model."""
    query_terms = Counter(rag._tokenize_for_bm25(query))

    def score(document):
        terms = Counter(rag._tokenize_for_bm25(document.page_content))
        numerator = sum(count * terms[word] for word, count in query_terms.items())
        denominator = math.sqrt(sum(n * n for n in terms.values()) * sum(n * n for n in query_terms.values()))
        return numerator / denominator if denominator else 0.0

    return sorted(documents, key=score, reverse=True)


def test_labeled_retrieval_benchmark(monkeypatch, record_property):
    fixture = json.loads(CORPUS.read_text(encoding="utf-8"))
    documents = [Document(page_content=item["text"], metadata={
        "thread_id": item.get("thread", "eval-thread"), "attachment_id": item["source"],
        "source": item["source"] + ".txt", "chunk_id": item["id"], "page": item["page"],
    }) for item in fixture["documents"]]
    own = [doc for doc in documents if doc.metadata["thread_id"] == "eval-thread"]
    attachments = sorted({doc.metadata["attachment_id"] for doc in own})
    bind_resources("eval-thread", "eval-workspace")
    monkeypatch.setattr(rag.vectorstore, "get", lambda **kwargs: {
        "documents": [doc.page_content for doc in documents],
        "metadatas": [doc.metadata for doc in documents],
    })
    monkeypatch.setattr(rag, "get_attachment_records", lambda *args: [
        {"attachment_id": identifier, "name": identifier + ".txt", "kind": "document", "preview": ""}
        for identifier in attachments
    ])
    monkeypatch.setattr(
        rag.vectorstore, "similarity_search",
        lambda query, **kwargs: lexical_candidates(query, documents),
    )
    # Exercise production rerank index handling without downloading a learned model.
    monkeypatch.setattr(rag, "_get_reranker", lambda: SimpleNamespace(
        rerank=lambda request: [{"id": item["id"]} for item in request.passages],
    ))
    rows = []
    citation_count = 0
    unsupported_detected = 0
    for case in fixture["queries"]:
        for method in ("bm25", "hybrid_controlled_candidates_identity_reranker"):
            rag._RAG_CACHE.clear()
            evidence.begin_evidence("eval-thread")
            started = time.perf_counter()
            if method == "bm25":
                selected = rag._bm25_search(case["query"], "eval-thread", attachments, limit=3)
            else:
                inspector = {}
                rag.retrieve_from_rag(case["query"], "eval-thread", attachments, k=3, inspector=inspector)
                selected = [next(doc for doc in own if doc.metadata["chunk_id"] == source["chunk_id"])
                            for source in inspector["sources"]]
                assert inspector["reranking_completed"]
                source_ids = [source["source_id"] for source in inspector["sources"]]
                resolved = {}
                answer = " ".join(f"[{identifier}]" for identifier in source_ids) + " [Sfake]"
                evidence.resolve_answer(answer, resolved, research=True)
                assert resolved["sources"] == inspector["sources"]
                assert (
                    "Unrecognized citation references are unverified."
                    in resolved["research"]["limitations"]
                )
                unsupported_detected += 1
                for source in resolved["sources"]:
                    original = next(doc for doc in own if doc.metadata["chunk_id"] == source["chunk_id"])
                    assert source["page"] == original.metadata["page"]
                    assert source["file"] == original.metadata["source"]
                    evidence.SourceRecord.model_validate(source)
                    citation_count += 1
            elapsed = (time.perf_counter() - started) * 1000
            assert all(doc.metadata["thread_id"] == "eval-thread" for doc in selected)
            rows.append({"case": case["id"], "method": method, "k": 3,
                         "selected": [doc.metadata["chunk_id"] for doc in selected],
                         **retrieval_metrics(selected, set(case["relevant"]), own, 3),
                         "latency_ms": round(elapsed, 3)})
    with owner_context("other-principal"), pytest.raises(OwnershipError):
        rag.retrieve_from_rag("SQLite", "eval-thread", attachments)
    # Quality gate for an exact rare-term lookup; paraphrase/conflict scores are
    # baseline measurements, not thresholds chosen after observing the results.
    direct = next(row for row in rows if row["case"] == "direct" and row["method"] == "bm25")
    assert direct["mrr"] == 1.0
    record_property("evaluation_metrics", json.dumps({
        "retrieval": rows, "citation_records_checked": citation_count,
        "citation_id_validity": 1.0, "provenance_resolution_rate": 1.0,
        "metadata_preservation_rate": 1.0,
        "unsupported_citation_detection": unsupported_detected / len(fixture["queries"]),
        "foreign_metadata_rejection_rate": 1.0, "cross_owner_rejections": 1,
        "gates": {"direct_bm25_mrr": 1.0, "citation_and_isolation_invariants": "all must pass"},
        "limitations": (
            "No semantic embeddings, learned reranking, model faithfulness or live research "
            "measured. Missing-evidence queries may return unrelated chunks."
        ),
    }))


def test_memory_labeled_relevance(record_property):
    facts = ["Orion database uses SQLite", "Prefer concise Python examples", "Garden tomatoes need sunlight"]
    for fact in facts:
        memory_store.store.save(fact, "workspace", "eval-workspace")
    cases = [("SQLite database", [facts[0]]), ("Python examples", [facts[1]]), ("spacecraft", [])]
    hits = 0
    returned = 0
    for query, expected in cases:
        actual = memory_store.store.context(query, "eval-workspace").splitlines()
        actual = [line.removeprefix("- ") for line in actual]
        assert actual == expected
        hits += len(set(actual).intersection(expected))
        returned += len(actual)
    record_property("evaluation_metrics", json.dumps({
        "lexical_memory_precision": hits / returned, "lexical_memory_recall": hits / 2,
        "queries": len(cases), "missing_evidence_correct": 1,
        "scope": "Exact lexical fixtures; no semantic-memory claim.",
    }))


def test_evaluation_metrics_penalize_misses_and_duplicates():
    first = Document(page_content="same", metadata={"chunk_id": "a", "attachment_id": "one"})
    second = Document(page_content="same", metadata={"chunk_id": "b", "attachment_id": "two"})
    metrics = retrieval_metrics([second, first], {"a", "missing"}, [first, second], 3)
    assert metrics["recall_at_k"] == 0.5
    assert metrics["precision_at_k"] == pytest.approx(1 / 3)
    assert metrics["mrr"] == 0.5
    assert metrics["duplicate_content_rate"] == 0.5


def test_evaluation_teardown_failure_overrides_passing_call():
    results = EvaluationResults([{"id": "fixture", "test": "tests/fake.py::test_case"}])
    for stage, passed in (("call", True), ("teardown", False)):
        results.pytest_runtest_logreport(SimpleNamespace(
            nodeid="tests/fake.py::test_case", when=stage, passed=passed, duration=0.1, user_properties=[],
        ))
    assert results.results["tests/fake.py::test_case"]["status"] == "failed"


@pytest.mark.parametrize("mode", ["normal", "research"])
@pytest.mark.parametrize("name,arguments", [
    ("read_fixture", {}), ("read_fixture", {"number": "not-an-integer"}), ("unknown_tool", {}),
])
def test_graph_rejects_invalid_tool_arguments(monkeypatch, tmp_path, record_property, mode, name, arguments):
    import agent

    executions = []

    @tool
    def read_fixture(number: int) -> str:
        """Read a numbered fixture without side effects."""
        executions.append(number)
        return "fixture"

    class Model:
        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages, config):
            results = [message for message in messages if isinstance(message, ToolMessage)]
            if not results:
                return AIMessage(content="", tool_calls=[{"id": "invalid", "name": name, "args": arguments}])
            assert len(results) == 1 and results[0].status == "error"
            return AIMessage(content="The requested tool could not execute.")

    monkeypatch.setattr(agent, "build_chat_model", lambda *args, **kwargs: Model())
    monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "arguments.sqlite3")
    monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])

    async def run():
        graph = await agent.build_agent("gemini-3.1-flash-lite", mode=mode, mcp_tools=[read_fixture])
        try:
            result = await graph.ainvoke(
                {"messages": [HumanMessage(content="Read the fixture")]},
                {"configurable": {"thread_id": "invalid-arguments"}},
            )
            assert isinstance(result["messages"][-1], AIMessage)
            assert len([item for item in result["messages"] if isinstance(item, ToolMessage)]) == 1
        finally:
            await agent.close_agent_resources()

    asyncio.run(run())
    assert executions == []
    record_property("evaluation_metrics", json.dumps({
        "tool_executions": len(executions), "error_tool_messages": 1,
    }))


@pytest.mark.parametrize("outcome", ["passed", "failed", "skipped", "missing"])
def test_evaluation_cli_gates_and_writes_reports(monkeypatch, tmp_path, outcome):
    manifest = tmp_path / "scenarios.json"
    manifest.write_text(json.dumps([{
        "id": "gate", "category": "agent", "test": "tests/fake.py::test_gate",
        "failure_category": "fixture",
    }]), encoding="utf-8")
    monkeypatch.setattr(evaluate, "MANIFEST", manifest)

    def controlled_pytest(arguments, plugins):
        if outcome != "missing":
            plugins[0].pytest_runtest_logreport(SimpleNamespace(
                nodeid="tests/fake.py::test_gate", when="call", passed=outcome == "passed",
                duration=0.1, user_properties=[],
            ))
        # Even pytest exit zero cannot conceal skipped or missing scenarios.
        return 0

    monkeypatch.setattr(evaluate.pytest, "main", controlled_pytest)
    output = tmp_path / "reports"
    code = evaluate.main(["--category", "agent", "--output", str(output)])
    assert code == (0 if outcome == "passed" else 1)
    assert (output / "summary.md").is_file()
    report = json.loads((output / "results.json").read_text(encoding="utf-8"))
    assert report["passed"] == int(outcome == "passed")
