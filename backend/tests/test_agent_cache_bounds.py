
"""Offline regression tests for bounded agent and checkpoint caching."""

import asyncio

import pytest

import agent
import agent_cache


def test_cache_reuses_graph_and_evicts_least_recently_used(monkeypatch):
    monkeypatch.setattr(agent_cache, "MAX_CACHED_AGENTS", 2)

    async def scenario():
        cache = {}
        builds = []

        async def build(name):
            builds.append(name)
            return object()

        async def get(name):
            return await agent_cache.cached_agent(
                cache,
                name,
                lambda: build(name),
            )

        first = await get("first")
        second = await get("second")

        assert await get("first") is first

        third = await get("third")

        assert list(cache) == ["first", "third"]
        assert len(cache) == 2

        assert await get("first") is first
        assert await get("second") is not second
        assert builds == [
            "first",
            "second",
            "third",
            "second",
        ]

        assert third is not first

    asyncio.run(scenario())


def test_concurrent_requests_build_one_graph():
    async def scenario():
        cache = {}
        started = asyncio.Event()
        release = asyncio.Event()
        calls = []

        async def build():
            calls.append(True)
            started.set()
            await release.wait()
            return object()

        first = asyncio.create_task(
            agent_cache.cached_agent(
                cache,
                "same-key",
                build,
            )
        )

        await asyncio.wait_for(started.wait(), 5)

        second = asyncio.create_task(
            agent_cache.cached_agent(
                cache,
                "same-key",
                build,
            )
        )

        await asyncio.sleep(0)
        release.set()

        a, b = await asyncio.wait_for(
            asyncio.gather(first, second),
            5,
        )

        assert a is b
        assert calls == [True]
        assert len(cache) == 1

    asyncio.run(scenario())


def test_cancelled_waiter_does_not_cancel_shared_build():
    async def scenario():
        cache = {}
        started = asyncio.Event()
        release = asyncio.Event()

        async def build():
            started.set()
            await release.wait()
            return object()

        creator = asyncio.create_task(
            agent_cache.cached_agent(cache, "key", build)
        )

        await started.wait()

        waiter = asyncio.create_task(
            agent_cache.cached_agent(cache, "key", build)
        )

        await asyncio.sleep(0)
        waiter.cancel()

        with pytest.raises(asyncio.CancelledError):
            await waiter

        release.set()
        graph = await asyncio.wait_for(creator, 5)

        assert cache["key"] is graph

    asyncio.run(scenario())


def test_failed_build_is_not_cached():
    async def scenario():
        cache = {}
        attempts = []

        async def build():
            attempts.append(True)

            if len(attempts) == 1:
                raise RuntimeError("Offline build failure")

            return object()

        with pytest.raises(RuntimeError, match="Offline"):
            await agent_cache.cached_agent(
                cache,
                "key",
                build,
            )

        assert cache == {}

        result = await agent_cache.cached_agent(
            cache,
            "key",
            build,
        )

        assert cache["key"] is result
        assert len(attempts) == 2

    asyncio.run(scenario())


def test_checkpoint_connection_is_shared_and_closed(tmp_path):
    async def scenario():
        connections = []
        database = tmp_path / "checkpoints.sqlite"

        savers = await asyncio.gather(
            *(
                agent_cache.get_checkpointer(
                    database,
                    connections,
                )
                for _ in range(8)
            )
        )

        assert len(connections) == 1
        assert all(saver is savers[0] for saver in savers)

        cursor = await connections[0].execute("SELECT 1")
        assert await cursor.fetchone() == (1,)
        await cursor.close()

        await agent_cache.close_checkpointers(connections)

        assert connections == []

    asyncio.run(scenario())


def test_eviction_cannot_close_active_checkpoint(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(agent_cache, "MAX_CACHED_AGENTS", 1)

    async def scenario():
        connections = []
        cache = {}
        database = tmp_path / "active-checkpoints.sqlite"

        saver = await agent_cache.get_checkpointer(
            database,
            connections,
        )

        class Graph:
            def __init__(self, checkpointer):
                self.checkpointer = checkpointer

            async def run(self):
                cursor = await connections[0].execute(
                    "SELECT 42"
                )

                try:
                    return await cursor.fetchone()
                finally:
                    await cursor.close()

        try:
            first = await agent_cache.cached_agent(
                cache,
                "first",
                lambda: asyncio.sleep(
                    0,
                    result=Graph(saver),
                ),
            )

            second = await agent_cache.cached_agent(
                cache,
                "second",
                lambda: asyncio.sleep(
                    0,
                    result=Graph(saver),
                ),
            )

            assert len(cache) == 1
            assert "first" not in cache
            assert first is not second

            # The evicted graph is still held by the request.
            assert await first.run() == (42,)
            assert first.checkpointer is second.checkpointer
            assert len(connections) == 1

        finally:
            await agent_cache.close_checkpointers(connections)

        assert connections == []

    asyncio.run(scenario())


def test_agent_entrypoint_uses_bounded_cache(monkeypatch):
    monkeypatch.setattr(agent_cache, "MAX_CACHED_AGENTS", 2)
    monkeypatch.setattr(agent, "_AGENT_CACHE", {})
    monkeypatch.setattr(
        agent,
        "normalize_model_name",
        lambda name: name or "model-one",
    )

    builds = []

    async def discover_tools():
        return []

    async def fake_build(model, mode, **kwargs):
        builds.append((model, mode))
        return object()

    monkeypatch.setattr(
        agent,
        "load_mcp_tools",
        discover_tools,
    )
    monkeypatch.setattr(
        agent,
        "build_agent",
        fake_build,
    )

    async def scenario():
        first = await agent.get_agent("model-one")
        assert await agent.get_agent("model-one") is first

        await agent.get_agent("model-two")
        await agent.get_agent("model-three")

        assert len(agent._AGENT_CACHE) == 2

        replacement = await agent.get_agent("model-one")

        assert replacement is not first
        assert builds == [
            ("model-one", "normal"),
            ("model-two", "normal"),
            ("model-three", "normal"),
            ("model-one", "normal"),
        ]

    asyncio.run(scenario())
