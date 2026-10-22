"""Two-way ownership attacks against actual storage and session boundaries."""

import asyncio
from contextlib import closing
import os
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import aiosqlite
from fastapi.testclient import TestClient
from langchain_core.documents import Document
from langgraph.checkpoint.base import empty_checkpoint
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app as api
from auth_store import AuthStore
import database
from owned_checkpoints import OwnedSqliteSaver
import ownership
from ownership import OwnershipError, bind_resources, owner_context, require_thread
from ownership_migration import claim_legacy, inventory, rollback_claim
import rag
from test_upload_security import LocalIndex
import tool


def test_checkpoint_runtime_root_matches_other_private_stores():
    import agent

    root = Path(os.environ["CLAWBIT_RUNTIME_DIR"])
    assert agent.CHECKPOINT_DB_PATH == root / "data" / "langgraph_checkpoints.sqlite"
    assert database.DATABASE_PATH == root / "data" / "chatbot_memory.db"


@pytest.fixture
def private_storage(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'memory.sqlite3'}")
    database.Base.metadata.create_all(engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    root = tmp_path / "uploads"
    root.mkdir()
    monkeypatch.setattr(rag, "UPLOAD_ROOT", root)
    monkeypatch.setattr(rag, "vectorstore", LocalIndex())
    monkeypatch.setattr(rag, "_rerank_documents", lambda query, docs, limit: docs[:limit])
    rag._RAG_CACHE.clear()
    yield root
    rag._RAG_CACHE.clear()
    engine.dispose()


@pytest.mark.parametrize("owner,other", [("alice", "bob"), ("bob", "alice")])
def test_conversations_memory_workspaces_and_thread_reuse(private_storage, owner, other):
    with owner_context(owner):
        database.create_or_update_conversation("private-thread", "Private title", "project")
        database.save_chat_message("private-thread", "user", "Private message", "project")
        database.save_memory("private-thread", "Private preference", "project")
        assert database.get_chat_history("private-thread")[0].content == "Private message"
        remembered = database.search_memory("second-thread", "preference", "project")
        assert "Private preference" in remembered
        assert len(database.list_conversations()) == 1
    with owner_context(other):
        assert database.list_conversations() == []
        operations = [
            lambda: database.get_chat_history("private-thread"),
            lambda: database.save_chat_message("private-thread", "user", "forged"),
            lambda: database.create_or_update_conversation("private-thread", "overwrite"),
            lambda: database.ensure_workspace("project", "overwrite"),
            lambda: database.list_conversations("project"),
            lambda: database.search_memory("other-thread", "preference", "project"),
            lambda: database.save_memory("other-thread", "overwrite", "project"),
        ]
        for operation in operations:
            with pytest.raises(OwnershipError, match="Resource not found"):
                operation()
    with owner_context(owner):
        assert database.get_chat_history("private-thread")[0].content == "Private message"


def upload_document(root: Path, principal: str, thread: str, text: str) -> dict:
    with owner_context(principal):
        bind_resources(thread, thread)
        directory = root / thread
        directory.mkdir()
        source = directory / "source.txt"
        source.write_text(text, encoding="utf-8")
        return rag.save_uploaded_file(str(source), thread)


@pytest.mark.parametrize("owner,other", [("alice", "bob"), ("bob", "alice")])
def test_attachments_paths_rag_and_cached_results(private_storage, owner, other):
    record = upload_document(private_storage, owner, "private-thread", "Private SQLite design")
    with owner_context(owner):
        assert "Private SQLite" in rag.retrieve_from_rag("SQLite", "private-thread")
        assert rag._RAG_CACHE
    with owner_context(other):
        bind_resources("other-thread", "other-thread")
        operations = [
            lambda: rag.get_attachment_records("private-thread"),
            lambda: rag.get_attachment_records("other-thread", [record["attachment_id"]]),
            lambda: rag.delete_attachment("private-thread", record["attachment_id"]),
            lambda: rag.read_file_text(record["path"]),
            lambda: rag.read_attachment_bytes(record),
            lambda: rag.add_document_to_rag(record["path"], "private-thread"),
            lambda: rag.retrieve_from_rag("SQLite", "private-thread"),
            lambda: rag._bm25_search("SQLite", "private-thread", [record["attachment_id"]]),
        ]
        for operation in operations:
            with pytest.raises(OwnershipError):
                operation()
    with owner_context(owner):
        assert Path(record["path"]).exists()
        assert rag.delete_attachment("private-thread", record["attachment_id"])


def test_vector_bm25_results_are_filtered_before_reranking(private_storage, monkeypatch):
    own = upload_document(private_storage, "alice", "alice-thread", "Alice SQLite content")
    foreign = upload_document(private_storage, "bob", "bob-thread", "Bob private password")
    leaked = Document(page_content="Bob private password", metadata={
        "thread_id": "bob-thread", "attachment_id": foreign["attachment_id"],
    })
    valid = Document(page_content="Alice SQLite content", metadata={
        "thread_id": "alice-thread", "attachment_id": own["attachment_id"],
    })
    monkeypatch.setattr(rag.vectorstore, "similarity_search", lambda *a, **k: [leaked, valid])
    monkeypatch.setattr(rag.vectorstore, "get", lambda **k: {
        "documents": [leaked.page_content, valid.page_content],
        "metadatas": [leaked.metadata, valid.metadata],
    })

    def rerank(query, docs, limit):
        assert docs and all("Bob" not in doc.page_content for doc in docs)
        return docs

    monkeypatch.setattr(rag, "_rerank_documents", rerank)
    with owner_context("alice"):
        result = rag.retrieve_from_rag("SQLite", "alice-thread")
        assert "Alice" in result and "Bob" not in result


def test_forged_attachment_id_cannot_overwrite_another_threads_vectors(private_storage):
    foreign = upload_document(private_storage, "bob", "bob-thread", "Bob private document")
    own = upload_document(private_storage, "alice", "alice-thread", "Alice document")
    with owner_context("alice"):
        rag.add_document_to_rag(own["path"], "alice-thread", attachment_id=foreign["attachment_id"])
    with owner_context("bob"):
        result = rag.retrieve_from_rag("document", "bob-thread")
        assert "Bob private document" in result
        assert "Alice" not in result


@pytest.mark.parametrize("owner,other", [("alice", "bob"), ("bob", "alice")])
def test_checkpoint_read_write_history_delete_and_sync_bridge(tmp_path, owner, other):
    async def run():
        async with aiosqlite.connect(tmp_path / "checkpoints.sqlite") as connection:
            saver = OwnedSqliteSaver(connection)
            config = {"configurable": {"thread_id": "checkpoint-thread", "checkpoint_ns": ""}}
            checkpoint = empty_checkpoint()
            checkpoint["channel_values"] = {"private": "saved state"}
            with owner_context(owner):
                saved = await saver.aput(config, checkpoint, {}, {})
                await saver.aput_writes(saved, [("private", "pending")], "task")
                restored = await saver.aget_tuple(config)
                assert restored.checkpoint["channel_values"]["private"] == "saved state"
                assert await asyncio.to_thread(saver.get_tuple, config)
            with owner_context(other):
                forged = {"configurable": {**saved["configurable"], "owner_id": owner}}
                for operation in (
                    lambda: saver.aget_tuple(forged),
                    lambda: saver.aput(forged, checkpoint, {}, {}),
                    lambda: saver.aput_writes(forged, [("private", "replace")], "task"),
                    lambda: saver.adelete_thread("checkpoint-thread"),
                    lambda: saver.aget_delta_channel_history(config=forged, channels=["private"]),
                    lambda: asyncio.to_thread(saver.get_tuple, forged),
                ):
                    with pytest.raises(OwnershipError):
                        await operation()
                with pytest.raises(OwnershipError):
                    await anext(saver.alist(forged))
                with pytest.raises(OwnershipError):
                    await anext(saver.alist(None))
            with owner_context(owner):
                assert (await saver.aget_tuple(saved)).checkpoint == checkpoint
                await saver.adelete_thread("checkpoint-thread")
                assert await saver.aget_tuple(config) is None

    asyncio.run(run())


def test_tools_cannot_override_owner_through_runtime_config(private_storage):
    with owner_context("alice"):
        database.save_memory("alice-thread", "Alice private memory", "alice-workspace")
    runtime = SimpleNamespace(config={"configurable": {
        "thread_id": "alice-thread", "workspace_id": "alice-workspace", "owner_id": "alice",
        "user_id": "alice", "principal_id": "alice",
    }})
    with owner_context("bob"):
        for function, argument in (
            (tool.recall_memory.func, "private"), (tool.remember_this.func, "replace"),
            (tool.search_uploaded_documents.func, "private"),
        ):
            with pytest.raises(OwnershipError):
                function(argument, runtime)


def test_concurrent_contexts_and_creation_race():
    async def worker(principal):
        with owner_context(principal):
            await asyncio.sleep(0)
            assert await asyncio.to_thread(ownership.current_owner) == principal
            await asyncio.to_thread(bind_resources, principal + "-thread", principal + "-workspace")
            try:
                await asyncio.to_thread(require_thread, "contested-thread", create=True)
                return principal
            except OwnershipError:
                return None

    async def run():
        results = await asyncio.gather(worker("alice"), worker("bob"))
        assert sum(result is not None for result in results) == 1
    asyncio.run(run())
    with owner_context(None), pytest.raises(OwnershipError):
        require_thread("contested-thread")


def test_real_sessions_reject_foreign_chat_retry_upload_and_workspace(
    auth_store, tmp_path, monkeypatch,
):
    stores = [auth_store, AuthStore(tmp_path / "second-auth.sqlite3")]
    clients = []
    principals = []
    try:
        for index, store in enumerate(stores):
            username = f"test-owner-{index}"
            store.create_owner(username, "Saffron rivers carry seven boats!")
            monkeypatch.setattr(api.app.state, "auth_store", store)
            client = TestClient(api.app, base_url="http://localhost:8000")
            clients.append(client)
            client.headers["Origin"] = "http://localhost:3000"
            client.headers["X-CSRF-Token"] = client.get("/auth/session").json()["csrf_token"]
            response = client.post("/auth/login", json={
                "username": username, "password": "Saffron rivers carry seven boats!",
            })
            assert response.status_code == 200
            client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
            principal = store.lookup(client.cookies["clawbit_session"]).principal_id
            principals.append(principal)
            with owner_context(principal):
                bind_resources(f"thread-{index}", f"workspace-{index}")

        # Two independent singleton stores provide real verified sessions in this
        # test only. Production still has exactly one owner row and no signup.
        class TestSessions:
            def lookup(self, token):
                return next((session for store in stores if (session := store.lookup(token))), None)

        monkeypatch.setattr(api.app.state, "auth_store", TestSessions())

        async def forbidden(*args, **kwargs):
            pytest.fail("Foreign requests must not start a graph")

        monkeypatch.setattr(api, "get_agent", forbidden)
        for index, client in enumerate(clients):
            other = 1 - index
            for endpoint in ("/chat", "/chat/stream"):
                for overrides in (
                    {"thread_id": f"thread-{other}"},
                    {"thread_id": f"thread-{index}", "workspace_id": f"workspace-{other}"},
                    {"thread_id": f"thread-{other}", "owner_id": principals[other]},
                    {"thread_id": f"thread-{index}", "attachment_ids": ["guessed-id"]},
                ):
                    response = client.post(endpoint, json={"message": "retry or edit", **overrides})
                    assert response.status_code == 404
                    assert response.json() == {"detail": "Resource not found."}
            response = client.post("/attachments/upload", data={"thread_id": f"thread-{other}"},
                                   files={"file": ("test.txt", b"private")})
            assert response.status_code == 404
            assert client.delete(f"/attachments/thread-{other}/guessed-id").status_code == 404
    finally:
        for client in clients:
            client.close()


def test_sse_keeps_verified_owner_through_stream_and_worker_threads(
    owner_client, auth_store, monkeypatch,
):
    from langchain_core.messages import AIMessageChunk

    principal = auth_store.lookup(owner_client.cookies["clawbit_session"]).principal_id

    class OfflineGraph:
        async def astream(self, messages, config, stream_mode):
            assert ownership.current_owner() == principal
            assert await asyncio.to_thread(ownership.current_owner) == principal
            require_thread(config["configurable"]["thread_id"])
            yield "messages", (AIMessageChunk(content="owned token"), {"langgraph_node": "chatbot"})

    async def get_graph(*args, **kwargs):
        return OfflineGraph()

    monkeypatch.setattr(api, "get_agent", get_graph)
    response = owner_client.post("/chat/stream", json={
        "message": "hello", "thread_id": "owned-sse",
    })
    assert response.status_code == 200
    assert "owned token" in response.text
    assert "event: done" in response.text


def test_legacy_claim_is_explicit_idempotent_and_recoverable(tmp_path):
    root = tmp_path / "legacy"
    (root / "data").mkdir(parents=True)
    auth = AuthStore(root / "data" / "auth.sqlite3")
    auth.create_owner("legacy-owner", "Saffron rivers carry seven boats!")
    with auth.connection() as connection:
        principal = connection.execute("SELECT principal_id FROM owner_identity").fetchone()[0]
    path = root / "data" / "langgraph_checkpoints.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE checkpoints (thread_id TEXT, checkpoint BLOB)")
        connection.execute("INSERT INTO checkpoints VALUES ('legacy-thread', ?)", (b"unchanged",))
    directory = root / "uploads" / "legacy-thread"
    directory.mkdir(parents=True)
    document = directory / "old.txt"
    document.write_bytes(b"legacy content")
    (directory / "manifest.json").write_text('[]', encoding="utf-8")
    before = path.read_bytes()
    assert inventory(root) == {("thread", "legacy-thread")}
    assert not (root / "data" / "ownership.sqlite3").exists()
    registry = ownership.OwnershipStore(root)
    with owner_context(principal), pytest.raises(OwnershipError):
        registry.authorize("thread", "legacy-thread", create=True)
    with pytest.raises(ValueError):
        claim_legacy(root, "wrong-owner")
    result = claim_legacy(root, "legacy-owner")
    assert result["resource_count"] == 1
    assert claim_legacy(root, "legacy-owner")["resource_count"] == 0
    assert path.read_bytes() == before
    assert document.read_bytes() == b"legacy content"
    with owner_context(principal):
        registry.authorize("thread", "legacy-thread")
    backup = Path(result["backup"])
    with closing(sqlite3.connect(backup / "data" / "ownership.sqlite3")) as connection:
        assert connection.execute("SELECT principal_id FROM resources").fetchone() == (None,)
    with registry.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 2
    assert (backup / "uploads" / "legacy-thread" / "manifest.json").read_text() == '[]'
    with owner_context(principal):
        registry.authorize("thread", "new-thread", create=True)
    assert rollback_claim(root, result["claim_id"])["rolled_back"] == 1
    assert rollback_claim(root, result["claim_id"])["rolled_back"] == 0
    with owner_context(principal):
        registry.authorize("thread", "new-thread")
        with pytest.raises(OwnershipError):
            registry.authorize("thread", "legacy-thread")
    assert document.read_bytes() == b"legacy content"


def test_auth_v1_migration_keeps_sessions_and_identity(tmp_path):
    path = tmp_path / "auth.sqlite3"
    store = AuthStore(path)
    store.create_owner("existing-owner", "Saffron rivers carry seven boats!")
    with store.connection() as connection:
        token, _ = store._insert_session(connection, 1)
        connection.execute("DROP TABLE owner_identity")
        connection.execute("PRAGMA user_version = 1")
    migrated = AuthStore(path)
    session = migrated.lookup(token)
    assert session.username == "existing-owner"
    assert len(session.principal_id) == 64
    assert AuthStore(path).lookup(token).principal_id == session.principal_id
    assert list(tmp_path.glob("auth.sqlite3.*.backup"))


def test_agent_and_rag_caches_are_principal_scoped(monkeypatch):
    import agent

    built = []

    async def no_connectors():
        return []

    async def build(*args, **kwargs):
        instance = object()
        built.append(instance)
        return instance

    monkeypatch.setattr(agent, "load_mcp_tools", no_connectors)
    monkeypatch.setattr(agent, "build_agent", build)
    monkeypatch.setattr(agent, "_AGENT_CACHE", {})

    async def run():
        with owner_context("alice"):
            first = await agent.get_agent()
            assert await agent.get_agent() is first
            key = rag._build_rag_cache_key("query", "cache-thread", [], 4)
            rag._set_rag_cache(key, "private cached text", {})
        with owner_context("bob"):
            assert await agent.get_agent() is not first
            with pytest.raises(OwnershipError):
                rag._get_rag_cache(key)
        assert len(built) == 2
    asyncio.run(run())


def test_graph_restoration_edits_and_retries_cannot_cross_owners(tmp_path, monkeypatch):
    import agent
    from langchain_core.messages import AIMessage, HumanMessage

    class OfflineModel:
        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages, config):
            return AIMessage(content="Offline answer")

    monkeypatch.setattr(agent, "build_chat_model", lambda *a, **k: OfflineModel())
    monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "graph.sqlite")
    monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])

    async def run():
        graph = await agent.build_agent("gemini-3.1-flash-lite", mcp_tools=[])
        try:
            for owner, other in (("alice", "bob"), ("bob", "alice")):
                config = {"configurable": {"thread_id": owner + "-graph"}}
                with owner_context(owner):
                    await graph.ainvoke(
                        {"messages": [HumanMessage(content=owner + " private")]}, config,
                    )
                    state = await graph.aget_state(config)
                    assert any(
                        message.content == owner + " private"
                        for message in state.values["messages"]
                    )
                    await graph.aupdate_state(
                        config, {"messages": [HumanMessage(content="own edit")]},
                    )
                with owner_context(other):
                    for action in (
                        lambda: graph.aget_state(config),
                        lambda: graph.aupdate_state(
                            config, {"messages": [HumanMessage(content="forged edit")]},
                        ),
                        lambda: graph.ainvoke(
                            {"messages": [HumanMessage(content="retry")]}, config,
                        ),
                    ):
                        with pytest.raises(OwnershipError):
                            await action()
                with owner_context(owner):
                    restored = await graph.aget_state(config)
                    assert any(
                        message.content == "own edit"
                        for message in restored.values["messages"]
                    )
        finally:
            await agent.close_agent_resources()

    asyncio.run(run())
