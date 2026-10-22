"""Offline admission, persistence and cancellation tests with real SQLite stores."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
import sqlite3
from threading import Barrier

import pytest

import usage_limits as limits
from ownership import OwnershipError, owner_context


def configure(monkeypatch, tmp_path, operation="inference", **changes):
    policies = dict(limits.DEFAULTS)
    policies[operation] = replace(policies[operation], **changes)
    now = [120.0]
    store = limits.UsageStore(tmp_path / "limits.sqlite3", policies, lambda: now[0])
    monkeypatch.setattr(limits, "store", store)
    return store, now


def test_rate_quota_restart_and_utc_reset(monkeypatch, tmp_path):
    store, now = configure(monkeypatch, tmp_path, per_minute=2, per_day=3)
    for _ in range(2):
        store.release(store.acquire("inference"))
    with pytest.raises(limits.UsageLimitError) as rejected:
        store.acquire("inference")
    assert rejected.value.kind == "rate" and rejected.value.retry_after == 60
    now[0] += 60
    restarted = limits.UsageStore(store.path, store.policies, lambda: now[0])
    restarted.release(restarted.acquire("inference"))
    with pytest.raises(limits.UsageLimitError) as rejected:
        restarted.acquire("inference")
    assert rejected.value.kind == "quota"
    assert rejected.value.retry_after == 86400 - 180
    now[0] = 86400
    restarted.release(restarted.acquire("inference"))


def test_principals_have_separate_counters_and_global_quota(monkeypatch, tmp_path):
    store, _ = configure(monkeypatch, tmp_path, per_minute=1, per_day=1)
    for principal in ("a", "b", "c", "d"):
        with owner_context(principal):
            store.release(store.acquire("inference"))
            with pytest.raises(limits.UsageLimitError):
                store.acquire("inference")
    with owner_context("e"), pytest.raises(limits.UsageLimitError):
        store.acquire("inference")
    with owner_context(None), pytest.raises(OwnershipError):
        store.acquire("inference")


def test_sqlite_atomic_admission_across_store_instances(monkeypatch, tmp_path):
    store, _ = configure(monkeypatch, tmp_path, per_minute=1)
    # Initialize schema before the simultaneous independent worker transactions.
    with closing(store._connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM usage").fetchone()[0] == 0
    gate = Barrier(8)

    def request():
        worker = limits.UsageStore(store.path, store.policies, lambda: 120)
        with owner_context("shared-principal"):
            gate.wait()
            try:
                lease = worker.acquire("inference")
                worker.release(lease)
                return True
            except limits.UsageLimitError:
                return False

    with ThreadPoolExecutor(max_workers=8) as executor:
        assert sum(executor.map(lambda _: request(), range(8))) == 1


def test_concurrency_separate_principals_global_capacity_and_dead_worker(monkeypatch, tmp_path):
    store, _ = configure(monkeypatch, tmp_path, concurrent=1, global_concurrent=2)
    with owner_context("a"):
        first = store.acquire("inference")
        with pytest.raises(limits.UsageLimitError, match="already running"):
            store.acquire("inference")
    with owner_context("b"):
        second = store.acquire("inference")
    with owner_context("c"), pytest.raises(limits.UsageLimitError):
        store.acquire("inference")
    store.release(first)
    with owner_context("a"):
        store.release(store.acquire("inference"))
    store.release(second)
    with sqlite3.connect(store.path) as db:
        db.execute("INSERT INTO leases VALUES('dead','a','inference',99999999,'dead')")
    with owner_context("a"):
        store.release(store.acquire("inference"))
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_decorator_counts_stream_once_and_releases_on_close(monkeypatch, tmp_path):
    store, _ = configure(monkeypatch, tmp_path, per_minute=1, concurrent=1)

    @limits.limited("inference")
    async def stream():
        for _ in range(100):
            yield "token"

    async def run():
        generator = stream()
        assert await anext(generator) == "token"
        await generator.aclose()

    asyncio.run(run())
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0
        assert db.execute(
            "SELECT count FROM usage WHERE principal!='*' AND period=60"
        ).fetchone()[0] == 1


@pytest.mark.parametrize("failure", ["error", "cancel"])
def test_async_error_and_cancellation_release_capacity(monkeypatch, tmp_path, failure):
    store, _ = configure(monkeypatch, tmp_path, concurrent=1)

    @limits.limited("inference")
    async def work():
        if failure == "error":
            raise RuntimeError("offline failure")
        raise asyncio.CancelledError

    with pytest.raises((RuntimeError, asyncio.CancelledError)):
        asyncio.run(work())
    store.release(store.acquire("inference"))
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_nested_sdk_calls_charge_once_but_other_principal_cannot_reuse_lease(monkeypatch, tmp_path):
    store, _ = configure(monkeypatch, tmp_path)
    with owner_context("a"), limits.operation_budget("inference"):
        with limits.operation_budget("inference"):
            pass
        with owner_context("b"), limits.operation_budget("inference"):
            pass
    with sqlite3.connect(store.path) as db:
        assert db.execute(
            "SELECT principal,count FROM usage WHERE period=60 AND principal!='*' ORDER BY principal"
        ).fetchall() == [("a", 1), ("b", 1)]


def test_tool_budget_is_atomic_and_shared_by_request_tasks(monkeypatch):
    monkeypatch.setenv("CLAWBIT_TOOL_CALLS_PER_RESPONSE", "2")
    with limits.request_budget():
        limits.reserve_tool_calls(1)
        limits.reserve_tool_calls(1)
        with pytest.raises(limits.UsageLimitError, match="tool-call budget"):
            limits.reserve_tool_calls(1)
    with limits.request_budget():
        limits.reserve_tool_calls(2)


@pytest.mark.parametrize("operation", ["upload", "ingestion", "retrieval", "tool", "mcp_execution", "embedding"])
def test_expensive_operation_rejected_before_body(monkeypatch, tmp_path, operation):
    store, _ = configure(monkeypatch, tmp_path, operation, per_minute=1)
    store.release(store.acquire(operation))
    calls = []

    @limits.limited(operation)
    def expensive():
        calls.append(True)

    with pytest.raises(limits.UsageLimitError):
        expensive()
    assert calls == []


@pytest.mark.parametrize("path", ["/chat", "/chat/stream"])
def test_http_admission_precedes_provider_and_returns_retry(owner_client, monkeypatch, tmp_path, path):
    import app as api

    store, _ = configure(monkeypatch, tmp_path, "chat", per_minute=1)
    store.release(store.acquire("chat"))

    def forbidden(*args, **kwargs):
        pytest.fail("Rejected requests must not reach model discovery or inference.")

    monkeypatch.setattr(api, "ensure_model_available", forbidden)
    response = owner_client.post(path, json={
        "message": "hello", "thread_id": "different-thread", "owner": "forged",
        "principal_id": "forged",
    })
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"
    assert "Try again in 60 seconds" in response.json()["detail"]
    assert owner_client.get("/auth/session").status_code == 200
    assert owner_client.get("/").status_code == 200


def test_sse_limit_error_has_structured_retry_and_releases_slot(owner_client, monkeypatch, tmp_path):
    import app as api

    store, _ = configure(monkeypatch, tmp_path, "chat", concurrent=1)

    class Agent:
        async def astream(self, *args, **kwargs):
            raise limits.UsageLimitError("quota", 123)
            yield

    async def get_agent(*args, **kwargs):
        return Agent()

    monkeypatch.setattr(api, "get_agent", get_agent)
    response = owner_client.post("/chat/stream", json={"message": "hello"})
    assert response.status_code == 200
    assert "event: start" in response.text and "event: error" in response.text
    assert '"status_code": 429' in response.text
    assert '"retry_after": 123' in response.text
    assert "daily usage quota" in response.text
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_real_agent_stops_tool_loop_before_excess_execution(monkeypatch, tmp_path):
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tools import tool
    import agent

    monkeypatch.setenv("CLAWBIT_TOOL_CALLS_PER_RESPONSE", "2")
    executions = []

    @tool
    def counter() -> str:
        """Count a fixture tool call."""
        executions.append(True)
        return "done"

    class Model:
        def bind_tools(self, tools):
            return self

        async def ainvoke(self, *args, **kwargs):
            return AIMessage(content="", tool_calls=[
                {"id": f"call-{len(executions)}", "name": "counter", "args": {}},
            ])

    monkeypatch.setattr(agent, "build_chat_model", lambda *a, **k: Model())
    monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "checkpoints.sqlite")
    monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])

    async def run():
        graph = await agent.build_agent("gemini-3.1-flash-lite", mcp_tools=[counter])
        try:
            with limits.request_budget(), pytest.raises(limits.UsageLimitError):
                await graph.ainvoke({"messages": [HumanMessage(content="Count")]},
                                    {"configurable": {"thread_id": "tool-loop"}})
        finally:
            await agent.close_agent_resources()
    asyncio.run(run())
    assert executions == [True, True]


def test_real_upload_and_retrieval_entry_points_reject_before_work(monkeypatch, tmp_path):
    import rag

    store, _ = configure(monkeypatch, tmp_path, "upload", per_minute=1)
    store.policies["retrieval"] = replace(store.policies["retrieval"], per_minute=1)
    store.release(store.acquire("upload"))
    store.release(store.acquire("retrieval"))
    with pytest.raises(limits.UsageLimitError):
        asyncio.run(rag.receive_uploaded_file(None, "not-processed"))
    with pytest.raises(limits.UsageLimitError):
        rag.retrieve_from_rag("private query", "not-processed")


def test_real_sse_disconnect_releases_chat_lease(owner_client, monkeypatch, tmp_path):
    import json
    import app as api

    store, _ = configure(monkeypatch, tmp_path, "chat", concurrent=1)

    async def run():
        started = asyncio.Event()
        closed = []

        class Agent:
            async def astream(self, *args, **kwargs):
                try:
                    started.set()
                    await asyncio.Event().wait()
                    yield
                finally:
                    closed.append(True)

        async def get_agent(*args, **kwargs):
            return Agent()

        monkeypatch.setattr(api, "get_agent", get_agent)
        sent_body = False

        async def receive():
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": json.dumps({"message": "hello"}).encode()}
            await started.wait()
            return {"type": "http.disconnect"}

        messages = []

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
            "method": "POST", "scheme": "http", "path": "/chat/stream",
            "query_string": b"", "server": ("localhost", 8000), "client": ("127.0.0.1", 1),
            "headers": [
                (b"host", b"localhost:8000"), (b"origin", b"http://localhost:3000"),
                (b"content-type", b"application/json"),
                (b"cookie", f"clawbit_session={owner_client.cookies['clawbit_session']}".encode()),
                (b"x-csrf-token", owner_client.headers["X-CSRF-Token"].encode()),
            ],
        }
        await asyncio.wait_for(api.app(scope, receive, send), 5)
        assert messages[0]["status"] == 200
        assert closed == [True]

    asyncio.run(run())
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_smoke_cli_authenticates_existing_owner_without_leaving_sessions(auth_store, monkeypatch):
    import model_smoke

    auth_store.create_owner("offline", "Saffron rivers carry seven boats!")
    monkeypatch.setattr(model_smoke, "auth_database_path", lambda: auth_store.path)
    with model_smoke.authenticated_smoke("offline", "Saffron rivers carry seven boats!"):
        from ownership import require_active_owner
        assert require_active_owner()
    with auth_store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    with pytest.raises(RuntimeError, match="Invalid username"):
        with model_smoke.authenticated_smoke("offline", "wrong"):
            pytest.fail("An invalid login must not reach inference.")


@pytest.mark.parametrize("asynchronous", [False, True])
def test_embedding_batches_are_counted_before_each_provider_request(
    monkeypatch, tmp_path, asynchronous,
):
    from models import FreeGoogleEmbeddings

    store, _ = configure(monkeypatch, tmp_path, "embedding", per_minute=1)
    calls = []

    class Client:
        def embed_documents(self, texts, **kwargs):
            calls.append((texts, kwargs))
            return [[1.0] for _ in texts]

        async def aembed_documents(self, texts, **kwargs):
            return self.embed_documents(texts, **kwargs)

    embeddings = FreeGoogleEmbeddings("offline")
    monkeypatch.setattr(embeddings, "_get_client", lambda: Client())
    with pytest.raises(limits.UsageLimitError):
        if asynchronous:
            asyncio.run(embeddings.aembed_documents(
                ["one", "two", "three"], batch_size=2, titles=["a", "b", "c"],
            ))
        else:
            embeddings.embed_documents(
                ["one", "two", "three"], batch_size=2, titles=["a", "b", "c"],
            )
    assert calls == [(["one", "two"], {"batch_size": 2, "titles": ["a", "b"]})]
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


@pytest.mark.parametrize("provider", ["google", "groq"])
def test_provider_adapter_rejects_over_quota_before_sdk(monkeypatch, tmp_path, provider):
    import models

    configure(monkeypatch, tmp_path, "inference", per_minute=1)
    calls = []
    base = models._ChatGoogleGenerativeAI if provider == "google" else models._ChatGroq

    def generate(*args, **kwargs):
        calls.append(True)
        return "offline-result"

    monkeypatch.setattr(base, "_generate", generate)
    name = models.DEFAULT_MODEL if provider == "google" else "openai/gpt-oss-20b"
    model = models.build_chat_model(name)
    assert model._generate([]) == "offline-result"
    with pytest.raises(limits.UsageLimitError):
        model._generate([])
    assert calls == [True]
