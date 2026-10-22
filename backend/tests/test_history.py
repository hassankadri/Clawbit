"""Exercise durable history, revision replay and transport failure with isolated stores."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.tools import tool
import pytest

import app as api
import history_store
from history_store import HistoryError, HistoryMessage, HistoryStore
from models import DEFAULT_MODEL, ModelError
from ownership import OwnershipError, current_owner, owner_context
from test_streaming_lifecycle import ChatTransport, assert_no_leases


def create(client, thread="history-thread", workspace=None):
    response = client.post("/history", json={
        "thread_id": thread, "workspace_id": workspace or thread,
        "id": f"display-{thread}", "model": DEFAULT_MODEL, "title": "Saved title",
    })
    assert response.status_code == 200, response.text
    return response.json()


def turn(saved, request_id="request-1", **changes):
    return {
        "message": "first question", "model": DEFAULT_MODEL, "mode": "normal",
        "thread_id": saved["thread_id"], "workspace_id": saved["workspace_id"],
        "request_id": request_id, "user_message_id": f"user-{request_id}",
        "assistant_message_id": f"assistant-{request_id}",
        "expected_version": saved["version"], **changes,
    }


@pytest.fixture
def graph(monkeypatch):
    calls = []

    class Graph:
        async def astream(self, state, config, stream_mode):
            calls.append((state, config))
            yield "messages", (AIMessageChunk(content="saved answer", id="answer"), {"langgraph_node": "chatbot"})
            yield "values", {"messages": [AIMessage(content="saved answer", id="answer")]}

    async def get(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get)
    return calls


def test_server_history_survives_restart_and_duplicate_request(owner_client, graph, monkeypatch):
    saved = create(owner_client)
    body = turn(saved)
    response = owner_client.post("/chat/stream", json=body)
    assert "event: done" in response.text
    first = owner_client.get("/history/history-thread").json()
    assert [item["id"] for item in first["messages"]] == ["user-request-1", "assistant-request-1"]
    assert first["messages"][-1]["status"] == "complete"
    assert first["messages"][-1]["content"] == "saved answer"
    monkeypatch.setattr(history_store, "store", HistoryStore(history_store.store.path))
    assert owner_client.get("/history/history-thread").json() == first
    assert "event: done" in owner_client.post("/chat/stream", json=body).text
    assert len(graph) == 1
    assert owner_client.post("/chat/stream", json={**body, "message": "different"}).status_code == 409
    assert owner_client.get("/history").json()["conversations"][0]["preview"] == "saved answer"
    assert_no_leases()


def test_history_metadata_versions_workspace_and_tombstone(owner_client, graph):
    saved = create(owner_client)
    response = owner_client.patch("/history/history-thread", json={"version": saved["version"], "title": "Renamed", "pinned": True, "workspace_id": "project"})
    assert response.status_code == 200
    changed = response.json()
    assert changed["title"] == "Renamed" and changed["pinned"]
    assert changed["workspace_id"] == "project"
    assert owner_client.patch("/history/history-thread", json={"version": saved["version"], "title": "stale"}).status_code == 409
    assert owner_client.delete(f"/history/history-thread?version={changed['version']}").status_code == 200
    assert owner_client.get("/history/history-thread").status_code == 404
    assert owner_client.get("/history").json() == {"conversations": [], "deleted_threads": ["history-thread"]}
    assert owner_client.post("/chat/stream", json=turn(changed)).status_code == 404
    with history_store.store.connection() as db:
        assert db.execute("SELECT deleted FROM history_conversations").fetchone()[0] == 1
    assert graph == []


@pytest.mark.parametrize("owner,other", [("alice", "bob"), ("bob", "alice")])
def test_history_isolation_in_both_directions(owner, other):
    store = history_store.store
    with owner_context(owner):
        store.create("private", "workspace", "display", DEFAULT_MODEL, "normal")
        request = turn({"thread_id": "private", "workspace_id": "workspace", "version": 0})
        request.update(version=request.pop("expected_version"), operation="send", attachment_ids=[])
        receipt, _ = store.begin("private", request)
        store.finish("private", receipt["id"], "private answer", "complete")
    with owner_context(other):
        assert store.list_conversations() == []
        for operation in (
            lambda: store.get("private"), lambda: store.mutate("private", 2, deleted=True),
            lambda: store.begin("private", request), lambda: store.revisions("private"),
            lambda: store.create("private", "workspace", "forged", DEFAULT_MODEL, "normal"),
            lambda: store.create("fresh", "workspace", "forged", DEFAULT_MODEL, "normal"),
            lambda: store.remove_message("private", "user-request-1", 2),
        ):
            with pytest.raises(OwnershipError):
                operation()


def test_history_mutations_require_authentication_csrf_and_reject_forged_owner(owner_client):
    saved = create(owner_client)
    assert owner_client.patch("/history/history-thread", json={"version": 0, "owner_id": "someone"}).status_code == 422
    csrf = owner_client.headers.pop("X-CSRF-Token")
    assert owner_client.delete("/history/history-thread?version=0").status_code == 403
    owner_client.headers["X-CSRF-Token"] = csrf
    owner_client.cookies.clear()
    for path in ("/history", f"/history/{saved['thread_id']}", "/history/history-thread/revisions"):
        assert owner_client.get(path).status_code == 401


def test_explicit_import_is_idempotent_conflict_safe_and_preserves_ids(owner_client):
    saved = create(owner_client)
    message = HistoryMessage(id="legacy-id", role="assistant", content="partial", status="streaming", createdAt=123).model_dump()
    body = {"version": 0, "import_id": "browser:old", "confirmed_principal": current_owner(), "messages": [message], "updatedAt": 456}
    assert owner_client.post("/history/history-thread/import", json={**body, "confirmed_principal": "foreign"}).status_code == 404
    first = owner_client.post("/history/history-thread/import", json=body)
    assert first.status_code == 200
    assert first.json()["messages"][0] == {**message, "status": "cancelled"}
    assert owner_client.post("/history/history-thread/import", json=body).json() == first.json()
    changed = {**body, "messages": [{**message, "content": "overwrite"}]}
    assert owner_client.post("/history/history-thread/import", json=changed).status_code == 409
    assert history_store.store.get(saved["thread_id"])["messages"][0]["content"] == "partial"


def test_additive_schema_backup_preserves_legacy_data_and_initializes_once(tmp_path):
    path = tmp_path / "memory.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE legacy (id INTEGER, payload BLOB)")
        db.execute("INSERT INTO legacy VALUES(7, ?)", (b"original",))
    store = HistoryStore(path)
    store.initialize()
    store.initialize()
    HistoryStore(path).initialize()
    backups = list(tmp_path.glob("*.backup"))
    assert len(backups) == 1
    for candidate in (path, backups[0]):
        with sqlite3.connect(candidate) as db:
            assert db.execute("SELECT * FROM legacy").fetchone() == (7, b"original")
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_transaction_failure_retains_previous_revision(owner_client, graph):
    saved = create(owner_client)
    owner_client.post("/chat/stream", json=turn(saved))
    before = history_store.store.get("history-thread")
    with history_store.store.connection() as db:
        db.execute("CREATE TRIGGER fail_revision BEFORE INSERT ON history_revisions BEGIN SELECT RAISE(ABORT, 'disk fixture'); END")
    request = turn(before, "request-2")
    request.update(version=request.pop("expected_version"), operation="send", attachment_ids=[])
    with pytest.raises(sqlite3.IntegrityError):
        history_store.store.begin("history-thread", request)
    assert history_store.store.get("history-thread") == before


def test_unknown_schema_version_fails_without_rewriting_data(tmp_path):
    path = tmp_path / "future.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE history_schema(version INTEGER)")
        db.execute("INSERT INTO history_schema VALUES(99)")
    before = path.read_bytes()
    with pytest.raises(RuntimeError, match="Unsupported"):
        HistoryStore(path).initialize()
    assert path.read_bytes() == before


@pytest.mark.parametrize("stage", ["headers", "token"])
def test_transport_failure_finalizes_durable_receipt(owner_client, graph, stage):
    saved = create(owner_client)

    async def run():
        request = ChatTransport(owner_client, turn(saved))
        original_send = request.send

        async def failing_send(message):
            if (stage == "headers" and message["type"] == "http.response.start") or (
                stage == "token" and b"event: token" in message.get("body", b"")
            ):
                raise OSError("Fixture transport closed")
            await original_send(message)

        request.send = failing_send
        await request.start()
        with pytest.raises(OSError):
            await asyncio.wait_for(request.task, 5)
        restored = history_store.store.get(saved["thread_id"])
        assert restored["messages"][-1]["status"] == "cancelled"
        assert restored["messages"][-1]["content"] == ("" if stage == "headers" else "saved answer")
        assert len(graph) == (0 if stage == "headers" else 1)
        assert_no_leases()

    asyncio.run(run())


def test_concurrent_request_receipt_dispatches_once(owner_client):
    saved = create(owner_client)
    principal = current_owner()
    path = history_store.store.path
    request = turn(saved)
    request.update(version=request.pop("expected_version"), operation="send", attachment_ids=[])

    def reserve(_):
        with owner_context(principal):
            return HistoryStore(path).begin("history-thread", request)[1]

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(reserve, range(4)))
    assert results.count(False) == 1 and results.count(True) == 3


@pytest.mark.parametrize("stage", ["before-token", "partial"])
def test_cancellation_retains_partial_and_releases_thread(owner_client, monkeypatch, stage):
    saved = create(owner_client)

    async def run():
        entered = asyncio.Event()
        closed = asyncio.Event()

        class Graph:
            async def astream(self, state, config, stream_mode):
                try:
                    if stage == "partial":
                        yield "messages", (AIMessageChunk(content="partial"), {"langgraph_node": "chatbot"})
                    entered.set()
                    await asyncio.Event().wait()
                finally:
                    closed.set()

        async def get(*args, **kwargs):
            return Graph()

        monkeypatch.setattr(api, "get_agent", get)
        transport = await ChatTransport(owner_client, turn(saved)).start()
        await asyncio.wait_for(entered.wait(), 5)
        conflict = await ChatTransport(owner_client, turn(saved, "overlap")).start()
        await asyncio.wait_for(conflict.task, 5)
        assert conflict.messages[0]["status"] == 429
        await transport.disconnect()
        assert closed.is_set()
        assert "event: done" not in transport.text
        current = history_store.store.get("history-thread")
        assert current["messages"][-1]["status"] == "cancelled"
        assert current["messages"][-1]["content"] == ("partial" if stage == "partial" else "")
        assert_no_leases()

    asyncio.run(run())


def test_restart_recovers_abandoned_receipt_without_inference(owner_client, graph):
    saved = create(owner_client)
    request = turn(saved)
    request.update(version=request.pop("expected_version"), operation="send", attachment_ids=[])
    receipt, _ = history_store.store.begin("history-thread", request)
    history_store.store.progress("history-thread", receipt["id"], "durable partial")
    restored = owner_client.get("/history/history-thread").json()
    assert restored["messages"][-1]["status"] == "cancelled"
    assert restored["messages"][-1]["content"] == "durable partial"
    assert graph == []


def test_legacy_checkpoint_requires_explicit_import_without_modifying_it(owner_client, graph):
    saved = create(owner_client)
    path = history_store.store.path.parent / "langgraph_checkpoints.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE checkpoints(thread_id TEXT, payload BLOB)")
        db.execute("INSERT INTO checkpoints VALUES('history-thread', ?)", (b"legacy state",))
    before = path.read_bytes()
    response = owner_client.post("/chat/stream", json=turn(saved))
    assert response.status_code == 409 and "import" in response.text
    assert graph == [] and path.read_bytes() == before
    body = {"version": 0, "import_id": "confirmed", "confirmed_principal": current_owner(), "messages": [], "updatedAt": 1}
    imported = owner_client.post("/history/history-thread/import", json=body).json()
    assert "event: done" in owner_client.post("/chat/stream", json=turn(imported)).text
    assert path.read_bytes() == before


def test_client_checkpoint_and_stale_versions_cannot_select_history(owner_client, graph):
    saved = create(owner_client)
    assert owner_client.post("/chat/stream", json=turn(saved, checkpoint_id="foreign-checkpoint")).status_code == 422
    assert owner_client.post("/chat/stream", json=turn(saved, expected_version=99)).status_code == 409
    assert owner_client.post("/chat/stream", json=turn(saved, operation="edit", target_message_id="foreign-message")).status_code == 404
    assert graph == []


def test_revision_reads_and_message_removal_preserve_old_records(owner_client, graph):
    saved = create(owner_client)
    owner_client.post("/chat/stream", json=turn(saved))
    saved = history_store.store.get("history-thread")
    old_revision = saved["revision_id"]
    removed = owner_client.delete(f"/history/history-thread/messages/assistant-request-1?version={saved['version']}")
    assert removed.status_code == 200
    assert [item["role"] for item in removed.json()["messages"]] == ["user"]
    original = owner_client.get(f"/history/history-thread/revisions/{old_revision}")
    assert original.json()["messages"] == saved["messages"]
    create(owner_client, "other-thread")
    assert owner_client.get(f"/history/other-thread/revisions/{old_revision}").status_code == 404
    assert owner_client.delete(f"/history/history-thread/messages/user-request-1?version={saved['version']}").status_code == 409


def test_missing_or_invalid_payload_fails_safely_without_deleting_history(owner_client, graph):
    saved = create(owner_client)
    owner_client.post("/chat/stream", json=turn(saved))
    with history_store.store.connection() as db:
        db.execute("UPDATE history_revisions SET messages='invalid json'")
    response = owner_client.get("/history/history-thread")
    assert response.status_code == 503 and "retained" in response.text
    assert owner_client.get("/history").status_code == 200
    with history_store.store.connection() as db:
        assert db.execute("SELECT messages FROM history_revisions").fetchone()[0] == "invalid json"


def test_failed_turn_retry_excludes_partial_context_and_preserves_receipts(owner_client, monkeypatch):
    saved = create(owner_client)
    contexts = []
    should_fail = True

    class Graph:
        async def astream(self, state, config, stream_mode):
            contexts.append(state)
            yield "messages", (AIMessageChunk(content="partial" if should_fail else "recovered"), {"langgraph_node": "chatbot"})
            if should_fail:
                raise ModelError("Provider unavailable.", 503)

    async def get(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get)
    response = owner_client.post("/chat/stream", json=turn(saved))
    assert '"status_code": 503' in response.text
    saved = history_store.store.get("history-thread")
    assert saved["messages"][-1]["content"] == "partial"
    assert saved["messages"][-1]["status"] == "error"
    should_fail = False
    body = turn(saved, "retry", operation="retry", target_message_id="assistant-request-1")
    assert "event: done" in owner_client.post("/chat/stream", json=body).text
    assert "partial" not in str(contexts[-1])
    assert str(contexts[-1]).count("first question") == 1
    assert len(history_store.store.get("history-thread")["messages"]) == 2
    assert len(history_store.store.revisions("history-thread")) == 2


def test_edit_preserves_attachment_references_and_citations(owner_client, monkeypatch):
    saved = create(owner_client)
    seen = []

    def attachment_records(thread, ids):
        seen.append((thread, ids))
        return [{"attachment_id": "doc", "name": "notes.txt", "kind": "document"}]

    import history_chat
    monkeypatch.setattr(history_chat, "get_attachment_records", attachment_records)

    class Graph:
        async def astream(self, state, config, stream_mode):
            assert config["configurable"]["attachment_ids"] == ["doc"]
            assert "notes.txt" in str(state)
            yield "messages", (AIMessageChunk(content="Answer [notes.txt]"), {"langgraph_node": "chatbot"})
            yield "values", {"messages": [ToolMessage(
                content="retrieved", tool_call_id="retrieval", name="search_uploaded_documents",
                artifact={"sources": [{"file": "notes.txt", "page": 2}], "internal": "not a visible message"},
            )]}

    async def get(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get)
    owner_client.post("/chat/stream", json=turn(saved, attachment_ids=["doc"]))
    saved = history_store.store.get("history-thread")
    response = owner_client.post("/chat/stream", json=turn(saved, "edit", operation="edit", target_message_id="user-request-1", message="updated", attachment_ids=[]))
    assert "event: done" in response.text
    assert seen == [("history-thread", ["doc"]), ("history-thread", ["doc"])]
    assert history_store.store.get("history-thread")["messages"][0]["attachmentIds"] == ["doc"]
    answer = history_store.store.get("history-thread")["messages"][-1]
    assert answer["sources"] == [{"file": "notes.txt", "page": 2}]
    assert "internal" not in answer and "not a visible message" not in json.dumps(answer)


def test_history_reads_do_not_consume_inference_and_turns_respect_chat_limit(owner_client, graph, monkeypatch):
    import usage_limits
    saved = create(owner_client)
    for _ in range(4):
        assert owner_client.get("/history/history-thread").status_code == 200
    with sqlite3.connect(usage_limits.store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM usage").fetchone()[0] == 0
    monkeypatch.setitem(usage_limits.store.policies, "chat", usage_limits.Policy(1, 500, 2, 4))
    monkeypatch.setattr(usage_limits.store, "clock", lambda: 1000)
    assert "event: done" in owner_client.post("/chat/stream", json=turn(saved)).text
    assert owner_client.post("/chat/stream", json=turn(saved)).status_code == 429
    assert len(graph) == 1
    assert_no_leases()


@pytest.mark.parametrize("mode", ["normal", "research"])
def test_real_checkpoint_edits_regeneration_and_tool_replay_safety(owner_client, monkeypatch, tmp_path, mode):
    import agent

    saved = create(owner_client)
    contexts = []
    actions = []
    request_tool = False
    fail = False

    @tool
    async def external_write() -> str:
        """Count an external write in an isolated fixture."""
        actions.append("write")
        return "written"

    class Model:
        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages, config):
            contexts.append([api.extract_text_content(message) for message in messages])
            if fail:
                raise ModelError("Offline provider failed.", 503)
            if request_tool and (config["configurable"].get("history_replay") or messages[-1].type == "human"):
                return AIMessage(content="", tool_calls=[{"id": "call", "name": "external_write", "args": {}}])
            prompt = next(item for item in reversed(messages) if isinstance(item, HumanMessage))
            return AIMessage(content="answer to " + api.extract_text_content(prompt))

    monkeypatch.setattr(agent, "build_chat_model", lambda *a, **k: Model())
    monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "graph.sqlite")
    monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])

    async def run():
        nonlocal saved, fail, request_tool
        graph = await agent.build_agent(DEFAULT_MODEL, mode, mcp_tools=[external_write])

        async def get(*args, **kwargs):
            return graph

        monkeypatch.setattr(api, "get_agent", get)

        async def execute(body):
            transport = await ChatTransport(owner_client, {**body, "mode": mode}).start()
            await asyncio.wait_for(transport.task, 10)
            return transport

        try:
            assert "event: done" in (await execute(turn(saved))).text
            saved = history_store.store.get("history-thread")
            assert "event: done" in (await execute(turn(saved, "second", message="discarded future"))).text
            saved = history_store.store.get("history-thread")
            edited = turn(saved, "edited", operation="edit", target_message_id="user-request-1", message="edited question")
            assert "event: done" in (await execute(edited)).text
            assert "discarded future" not in str(contexts[-1])
            assert "first question" not in str(contexts[-1])
            saved = history_store.store.get("history-thread")
            assert len(saved["messages"]) == 2
            assert saved["messages"][0]["id"] == "user-request-1"
            regenerate = turn(saved, "regen", operation="regenerate", target_message_id="assistant-edited")
            assert "event: done" in (await execute(regenerate)).text
            assert contexts[-1].count("edited question") == 1
            assert "answer to edited question" not in contexts[-1]
            saved = history_store.store.get("history-thread")
            fail = True
            failed = await execute(turn(saved, "failed", operation="edit", target_message_id="user-request-1", message="bad revision"))
            assert '"status_code": 503' in failed.text
            assert history_store.store.get("history-thread")["messages"] == saved["messages"]
            fail = False
            request_tool = True
            saved = history_store.store.get("history-thread")
            assert "event: done" in (await execute(turn(saved, "write", message="perform write"))).text
            assert actions == ["write"]
            saved = history_store.store.get("history-thread")
            rejected = await execute(turn(saved, "repeat", operation="regenerate", target_message_id="assistant-write"))
            assert '"status_code": 409' in rejected.text
            assert actions == ["write"]
            assert history_store.store.get("history-thread")["messages"] == saved["messages"]
            revisions = history_store.store.revisions("history-thread")
            assert len(revisions) == 7 and any(item["state"] == "error" for item in revisions)
            assert_no_leases()
        finally:
            await agent.close_agent_resources()

    asyncio.run(run())
