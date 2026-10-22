"""Offline ASGI transport, cancellation and checkpoint lifecycle regressions."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
from threading import Barrier, Event

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.tools import tool
import pytest

import app as api
import chat_execution
from models import DEFAULT_MODEL, ModelError
from ownership import current_owner, owner_context
import usage_limits as limits


class ChatTransport:
    """Drive the real app without a buffering HTTP test transport."""

    def __init__(self, client, body=None, endpoint="/chat/stream"):
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        self.messages = []
        self.body = body or {"message": "hello", "thread_id": "lifecycle"}
        self.scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
            "method": "POST", "scheme": "http", "path": endpoint,
            "query_string": b"", "server": ("localhost", 8000),
            "client": ("127.0.0.1", 1),
            "headers": [
                (b"host", b"localhost:8000"), (b"origin", b"http://localhost:3000"),
                (b"content-type", b"application/json"),
                (b"cookie", f"clawbit_session={client.cookies['clawbit_session']}".encode()),
                (b"x-csrf-token", client.headers["X-CSRF-Token"].encode()),
            ],
        }

    async def start(self):
        await self.incoming.put({"type": "http.request", "body": json.dumps(self.body).encode()})
        self.task = asyncio.create_task(api.app(self.scope, self.incoming.get, self.send))
        return self

    async def send(self, message):
        self.messages.append(message)
        await self.outgoing.put(message)

    async def until(self, text):
        while text not in self.text:
            await asyncio.wait_for(self.outgoing.get(), 5)

    async def disconnect(self):
        await self.incoming.put({"type": "http.disconnect"})
        await asyncio.wait_for(self.task, 5)

    @property
    def text(self):
        return b"".join(item.get("body", b"") for item in self.messages).decode()


def assert_no_leases():
    with sqlite3.connect(limits.store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_progressive_sse_preserves_order_and_exact_text(owner_client, monkeypatch):
    async def run():
        release = asyncio.Event()
        parts = ["  ```python\n", "print('雪 😀')\n", "```\n\nDone.  "]

        class Graph:
            async def astream(self, state, config, stream_mode):
                for index, text in enumerate(parts):
                    if index == 1:
                        await release.wait()
                    yield "messages", (
                        AIMessageChunk(content=text, id="answer"), {"langgraph_node": "chatbot"},
                    )
                yield "values", {"messages": [AIMessage(content="".join(parts), id="answer")]}

        async def get(*args, **kwargs):
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        request = await ChatTransport(owner_client).start()
        await request.until("event: token")
        assert not request.task.done()
        assert "event: done" not in request.text
        release.set()
        await asyncio.wait_for(request.task, 5)
        blocks = request.text.strip().split("\n\n")
        assert [block.splitlines()[0] for block in blocks] == [
            "event: start", "event: token", "event: token", "event: token", "event: done",
        ]
        data = [json.loads(block.split("data: ", 1)[1]) for block in blocks]
        assert "".join(item["text"] for item in data[1:-1]) == "".join(parts)
        assert data[-1]["inspector"]["rag_used"] is False
        assert_no_leases()

    asyncio.run(run())


@pytest.mark.parametrize("mode", ["normal", "research"])
def test_real_graph_uses_one_progressive_model_stream(owner_client, monkeypatch, tmp_path, mode):
    import agent
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGenerationChunk

    async def run():
        release = asyncio.Event()
        provider_calls = []
        parts = ["first ", "雪 😀\n", "```text\nlast\n```"]

        class StreamingModel(BaseChatModel):
            @property
            def _llm_type(self):
                return "offline-streaming-fixture"

            def bind_tools(self, tools, **kwargs):
                return self

            def _generate(self, *args, **kwargs):
                pytest.fail("Streaming must not use the synchronous generation path.")

            @limits.limited("inference")
            async def _astream(self, *args, **kwargs):
                provider_calls.append(True)
                for index, part in enumerate(parts):
                    if index == 1:
                        await release.wait()
                    yield ChatGenerationChunk(message=AIMessageChunk(content=part))

        builds = []

        def build(model, **kwargs):
            builds.append((model, kwargs))
            return StreamingModel()

        monkeypatch.setattr(agent, "build_chat_model", build)
        monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "stream.sqlite")
        monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])
        graph = await agent.build_agent(DEFAULT_MODEL, mode, streaming=True)

        async def get(*args, **kwargs):
            return graph

        monkeypatch.setattr(api, "get_agent", get)
        request = await ChatTransport(owner_client, {
            "message": "hello", "thread_id": "real-stream", "mode": mode,
        }).start()
        try:
            await request.until("event: token")
            assert not request.task.done() and provider_calls == [True]
            release.set()
            await asyncio.wait_for(request.task, 5)
            blocks = request.text.strip().split("\n\n")
            tokens = [json.loads(block.split("data: ", 1)[1])["text"]
                      for block in blocks if block.startswith("event: token")]
            assert "".join(tokens) == "".join(parts)
            assert request.text.count("event: done") == 1
            assert provider_calls == [True]
            assert builds[0][0] == DEFAULT_MODEL and builds[0][1]["streaming"] is True
            with sqlite3.connect(limits.store.path) as db:
                assert db.execute(
                    "SELECT count FROM usage WHERE operation='inference' "
                    "AND period=60 AND principal!='*'"
                ).fetchone()[0] == 1
            assert_no_leases()
        finally:
            release.set()
            if not request.task.done():
                await request.disconnect()
            await agent.close_agent_resources()

    asyncio.run(run())


@pytest.mark.parametrize("phase", ["preparation", "before_token", "after_token"])
def test_disconnect_cancels_preparation_and_generation(owner_client, monkeypatch, phase):
    async def run():
        started = asyncio.Event()
        closed = []
        parent_owner = current_owner()

        class Graph:
            async def astream(self, *args, **kwargs):
                try:
                    if phase == "after_token":
                        yield "messages", (AIMessageChunk(content="partial"), {"langgraph_node": "chatbot"})
                    started.set()
                    await asyncio.Event().wait()
                    pytest.fail("Cancelled work must never finish normally.")
                finally:
                    closed.append("graph")

        async def get(*args, **kwargs):
            if phase == "preparation":
                try:
                    started.set()
                    await asyncio.Event().wait()
                finally:
                    closed.append("preparation")
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        request = await ChatTransport(owner_client).start()
        await asyncio.wait_for(started.wait(), 5)
        await request.disconnect()
        assert closed == ["preparation" if phase == "preparation" else "graph"]
        assert "event: done" not in request.text
        assert "event: error" not in request.text
        if phase == "preparation":
            assert request.messages == []
        assert_no_leases()
        assert current_owner() == parent_owner
        assert chat_execution._execution.get() is None

    asyncio.run(run())


@pytest.mark.parametrize("endpoint", ["/chat", "/chat/stream"])
def test_same_thread_rejected_then_fresh_request_succeeds(owner_client, monkeypatch, endpoint):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []

        class Graph:
            async def ainvoke(self, state, config):
                calls.append(config["configurable"]["thread_id"])
                started.set()
                await release.wait()
                return {"messages": [AIMessage(content="answer")]}

            async def astream(self, state, config, stream_mode):
                yield "values", await self.ainvoke(state, config)

        async def get(*args, **kwargs):
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        first = await ChatTransport(owner_client, endpoint=endpoint).start()
        await asyncio.wait_for(started.wait(), 5)
        second = await ChatTransport(owner_client, endpoint=endpoint).start()
        await asyncio.wait_for(second.task, 5)
        assert second.messages[0]["status"] == 429
        assert dict(second.messages[0]["headers"])[b"retry-after"] == b"5"
        assert calls == ["lifecycle"]
        await first.disconnect()
        release.set()
        third = await ChatTransport(owner_client, endpoint=endpoint).start()
        await asyncio.wait_for(third.task, 5)
        assert third.messages[0]["status"] == 200
        assert calls == ["lifecycle", "lifecycle"]
        assert_no_leases()

    asyncio.run(run())


@pytest.mark.parametrize("status", [401, 403, 404, 429, 502, 503, 504])
def test_midstream_failure_has_one_error_and_no_done(owner_client, monkeypatch, status):
    class Graph:
        async def astream(self, *args, **kwargs):
            yield "messages", (AIMessageChunk(content="partial"), {"langgraph_node": "chatbot"})
            raise ModelError("Safe failure.", status, 17)

    async def get(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get)
    response = owner_client.post("/chat/stream", json={"message": "hi"})
    assert response.status_code == 200
    assert response.text.count("event: error") == 1
    assert "event: done" not in response.text
    assert f'"status_code": {status}' in response.text
    assert '"retry_after": 17' in response.text
    assert_no_leases()


def test_empty_graph_is_an_error_not_success(owner_client, monkeypatch):
    class Graph:
        async def astream(self, *args, **kwargs):
            yield "values", {"messages": []}

    async def get(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get)
    response = owner_client.post("/chat/stream", json={"message": "hi"})
    assert "event: error" in response.text and "event: done" not in response.text
    assert_no_leases()


def test_thread_lease_is_atomic_across_sqlite_connections(tmp_path):
    store = limits.UsageStore(tmp_path / "usage.sqlite3")
    first = Barrier(8)
    second = Barrier(8)

    def attempt(index):
        worker = limits.UsageStore(store.path)
        with owner_context("same-owner"):
            first.wait()
            lease = None
            try:
                lease = worker.acquire_thread("same-thread")
            except limits.UsageLimitError:
                pass
            second.wait()
            if lease:
                worker.release(lease)
            return lease is not None

    with ThreadPoolExecutor(max_workers=8) as executor:
        assert sum(executor.map(attempt, range(8))) == 1


def test_send_failure_closes_graph_and_releases_only_its_leases(owner_client, monkeypatch):
    async def run():
        closed = []

        class Graph:
            async def astream(self, *args, **kwargs):
                try:
                    yield "messages", (AIMessageChunk(content="partial"), {"langgraph_node": "chatbot"})
                    await asyncio.Event().wait()
                finally:
                    closed.append(True)

        async def get(*args, **kwargs):
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        other_lease = limits.store.acquire("inference")
        request = ChatTransport(owner_client)
        original_send = request.send

        async def failing_send(message):
            if b"event: token" in message.get("body", b""):
                raise OSError("Client transport closed")
            await original_send(message)

        request.send = failing_send
        try:
            await request.start()
            with pytest.raises(OSError):
                await asyncio.wait_for(request.task, 5)
            assert closed == [True]
            with sqlite3.connect(limits.store.path) as db:
                assert db.execute("SELECT id FROM leases").fetchall() == [(other_lease,)]
        finally:
            limits.store.release(other_lease)
        assert_no_leases()

    asyncio.run(run())


def test_session_revocation_before_next_operation_preserves_401(owner_client, auth_store, monkeypatch):
    calls = []

    @limits.limited("inference")
    def provider():
        calls.append(True)

    class Graph:
        async def astream(self, *args, **kwargs):
            provider()
            yield "messages", (AIMessageChunk(content="partial"), {"langgraph_node": "chatbot"})
            auth_store.revoke(owner_client.cookies["clawbit_session"])
            provider()

    async def get(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get)
    response = owner_client.post("/chat/stream", json={"message": "hi"})
    assert '"status_code": 401' in response.text
    assert "session expired" in response.text
    assert "event: done" not in response.text
    assert calls == [True]
    assert_no_leases()


def test_disconnected_sync_worker_cannot_start_another_operation(owner_client, monkeypatch):
    async def run():
        started, release, finished = Event(), Event(), Event()
        outcomes = []

        @limits.limited("tool")
        def worker():
            try:
                started.set()
                assert release.wait(5)
                with limits.operation_budget("embedding"):
                    pytest.fail("No new provider operation may start after cancellation.")
            except asyncio.CancelledError:
                outcomes.append("cancelled")
            finally:
                finished.set()

        class Graph:
            async def astream(self, *args, **kwargs):
                await asyncio.to_thread(worker)
                yield "values", {"messages": [AIMessage(content="unreachable")]}

        async def get(*args, **kwargs):
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        request = await ChatTransport(owner_client).start()
        try:
            assert await asyncio.to_thread(started.wait, 5)
            await request.disconnect()
            with sqlite3.connect(limits.store.path) as db:
                # Already-dispatched sync work keeps its own slot until it exits.
                assert db.execute("SELECT operation FROM leases").fetchall() == [("tool",)]
        finally:
            release.set()
            assert await asyncio.to_thread(finished.wait, 5)
        # The function's finally precedes the decorator's release by one instruction.
        for _ in range(100):
            with sqlite3.connect(limits.store.path) as db:
                if db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0:
                    break
            await asyncio.sleep(0.01)
        assert outcomes == ["cancelled"]
        assert_no_leases()

    asyncio.run(run())


def test_cancelled_mcp_tool_retains_safe_reusable_connection(owner_client, monkeypatch):
    import mcp_client as mcp

    async def run():
        started = asyncio.Event()
        attempts = []

        @tool
        async def fixture_mcp() -> str:
            """Return a fixture connector result."""
            attempts.append(True)
            if len(attempts) == 1:
                started.set()
                await asyncio.Event().wait()
            return "MCP answer"

        class Client:
            def __init__(self, connections):
                pass

            async def get_tools(self):
                return [fixture_mcp]

        monkeypatch.setattr(mcp, "MultiServerMCPClient", Client)
        assert (await mcp.connect_github_mcp("offline-token"))["success"]
        handle = (await mcp.load_mcp_tools())[0]

        class Graph:
            async def astream(self, *args, **kwargs):
                answer = await handle.ainvoke({})
                yield "values", {"messages": [AIMessage(content=answer)]}

        async def get(*args, **kwargs):
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        request = await ChatTransport(owner_client).start()
        await asyncio.wait_for(started.wait(), 5)
        await request.disconnect()
        assert mcp._state().active == {"github": set()}
        assert "github" in await mcp.get_mcp_connections()
        assert_no_leases()
        fresh = await ChatTransport(owner_client).start()
        await asyncio.wait_for(fresh.task, 5)
        assert "MCP answer" in fresh.text and "event: done" in fresh.text
        assert len(attempts) == 2
        assert_no_leases()

    asyncio.run(run())


def test_incomplete_tool_history_filters_outbound_pairs_without_mutating_storage():
    from langchain_core.messages import ToolMessage
    from untrusted_content import completed_tool_history, prepare_model_messages

    request = AIMessage(content="Tool preamble", tool_calls=[
        {"id": "complete", "name": "fixture", "args": {}},
        {"id": "unfinished", "name": "fixture", "args": {}},
    ], additional_kwargs={"tool_calls": ["raw-provider-format"]})
    result = ToolMessage(content="external data", tool_call_id="complete")
    history = [HumanMessage(content="Old turn"), request, result, HumanMessage(content="New turn")]
    outgoing = prepare_model_messages(completed_tool_history(history))
    assert [call["id"] for call in outgoing[1].tool_calls] == ["complete"]
    assert outgoing[1].additional_kwargs == {}
    assert json.loads(outgoing[2].content)["kind"] == "untrusted_tool_data"
    assert len(request.tool_calls) == 2 and result.content == "external data"
    assert completed_tool_history([result, HumanMessage(content="hi")]) == [HumanMessage(content="hi")]


@pytest.mark.parametrize("mode", ["normal", "research"])
@pytest.mark.parametrize("operation", ["mcp_execution", "retrieval"])
def test_real_graph_cancellation_preserves_checkpoints_without_replaying_tools(
    owner_client, monkeypatch, tmp_path, mode, operation,
):
    import agent
    from langchain_core.messages import ToolMessage

    async def run():
        started = asyncio.Event()
        closed, calls, model_calls = [], [], []

        @tool
        @limits.limited(operation)
        async def fixture_operation() -> str:
            """Wait for a controlled tool or retrieval operation."""
            calls.append(True)
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                closed.append(True)
            return "unreachable"

        class Model:
            def bind_tools(self, tools):
                return self

            async def ainvoke(self, messages, config):
                model_calls.append(messages)
                if len(model_calls) == 1:
                    return AIMessage(content="", tool_calls=[{
                        "id": "pending", "name": "fixture_operation", "args": {},
                    }])
                assert not any(isinstance(m, AIMessage) and m.tool_calls for m in messages)
                return AIMessage(content="Fresh answer")

        monkeypatch.setattr(agent, "build_chat_model", lambda *a, **k: Model())
        monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "checkpoints.sqlite")
        monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])
        graph = await agent.build_agent(DEFAULT_MODEL, mode, mcp_tools=[fixture_operation], streaming=True)

        async def get(*args, **kwargs):
            assert args == (DEFAULT_MODEL, mode)
            return graph

        monkeypatch.setattr(api, "get_agent", get)
        body = {"message": "Use the fixture", "thread_id": "checkpoint-cancel", "mode": mode}
        try:
            request = await ChatTransport(owner_client, body).start()
            await asyncio.wait_for(started.wait(), 5)
            await request.disconnect()
            assert closed == [True]
            assert calls == [True]
            assert len(model_calls) == 1
            assert_no_leases()
            config = {"configurable": {"thread_id": "checkpoint-cancel"}}
            state = await graph.aget_state(config)
            assert any(isinstance(m, HumanMessage) for m in state.values["messages"])
            assert not any(isinstance(m, ToolMessage) for m in state.values["messages"])
            fresh = await ChatTransport(owner_client, {**body, "message": "New question"}).start()
            await asyncio.wait_for(fresh.task, 5)
            assert "Fresh answer" in fresh.text and "event: done" in fresh.text
            assert calls == [True] and len(model_calls) == 2
            stored = await graph.aget_state(config)
            assert any(isinstance(m, AIMessage) and m.tool_calls for m in stored.values["messages"])
            assert stored.values["messages"][-1].content == "Fresh answer"
            assert_no_leases()
        finally:
            await agent.close_agent_resources()

    asyncio.run(run())
