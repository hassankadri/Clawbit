
"""Bounded agent reuse and shared SQLite checkpoint resources.

Cache eviction releases only the cache's reference to a graph.
An in-flight request retains its graph, and the checkpoint
connection stays open until application shutdown.
"""

import asyncio
from concurrent.futures import Future
from collections.abc import Awaitable, Callable, Hashable
from pathlib import Path
from threading import RLock
from typing import Any, TypeVar

import aiosqlite

from owned_checkpoints import OwnedSqliteSaver


T = TypeVar("T")

MAX_CACHED_AGENTS = 16

_guard = RLock()

_agent_builds: dict[tuple[int, Hashable], Future[Any]] = {}

_checkpoint_resources: dict[
    tuple[int, str],
    tuple[list[Any], OwnedSqliteSaver, aiosqlite.Connection],
] = {}

_checkpoint_builds: dict[
    tuple[int, str],
    Future[OwnedSqliteSaver],
] = {}


async def cached_agent(
    cache: dict[Hashable, T],
    key: Hashable,
    builder: Callable[[], Awaitable[T]],
) -> T:
    """Return a bounded, least-recently-used agent.

    In-flight builds are coordinated across asyncio event loops.
    A cancelled waiter cannot cancel the shared build. A cancelled
    builder leaves no failed entry in the cache.
    """
    build_key = (id(cache), key)

    with _guard:
        if key in cache:
            existing = cache.pop(key)
            cache[key] = existing
            return existing

        pending = _agent_builds.get(build_key)

        if pending is None:
            pending = Future()
            _agent_builds[build_key] = pending
            is_builder = True
        else:
            is_builder = False

    if not is_builder:
        return await asyncio.shield(
            asyncio.wrap_future(pending)
        )

    try:
        graph = await builder()
    except BaseException as exc:
        with _guard:
            _agent_builds.pop(build_key, None)

            if isinstance(exc, asyncio.CancelledError):
                pending.cancel()
            else:
                pending.set_exception(exc)

        raise

    with _guard:
        cache[key] = graph

        while len(cache) > MAX_CACHED_AGENTS:
            # Python dictionaries preserve insertion order.
            # The first entry is the least recently used.
            oldest_key = next(iter(cache))
            cache.pop(oldest_key)

        _agent_builds.pop(build_key, None)
        pending.set_result(graph)

    return graph


async def get_checkpointer(
    path: str | Path,
    connections: list[Any],
) -> OwnedSqliteSaver:
    """Reuse a single checkpoint saver for each database and owner list.

    The same saver is shared by compiled graphs, ensuring its internal
    SQLite coordination lock is also shared.
    """
    database = str(Path(path).resolve())
    resource_key = (id(connections), database)

    with _guard:
        resource = _checkpoint_resources.get(resource_key)

        if resource is not None:
            return resource[1]

        pending = _checkpoint_builds.get(resource_key)

        if pending is None:
            pending = Future()
            _checkpoint_builds[resource_key] = pending
            is_builder = True
        else:
            is_builder = False

    if not is_builder:
        return await asyncio.shield(
            asyncio.wrap_future(pending)
        )

    connection = None

    try:
        connection = await aiosqlite.connect(database)
        saver = OwnedSqliteSaver(connection)

    except BaseException as exc:
        if connection is not None:
            await connection.close()

        with _guard:
            _checkpoint_builds.pop(resource_key, None)

            if isinstance(exc, asyncio.CancelledError):
                pending.cancel()
            else:
                pending.set_exception(exc)

        raise

    with _guard:
        connections.append(connection)

        _checkpoint_resources[resource_key] = (
            connections,
            saver,
            connection,
        )

        _checkpoint_builds.pop(resource_key, None)
        pending.set_result(saver)

    return saver


async def close_checkpointers(
    connections: list[Any],
) -> None:
    """Close resources after all application requests have settled.

    Called from FastAPI's lifespan shutdown, never from LRU eviction.
    Also closes connections tracked by legacy code.
    """
    with _guard:
        resources = list(_checkpoint_resources.values())
        _checkpoint_resources.clear()

        to_close: list[Any] = []
        seen: set[int] = set()

        def collect(connection: Any) -> None:
            if id(connection) not in seen:
                seen.add(id(connection))
                to_close.append(connection)

        for owner_list, _, connection in resources:
            collect(connection)

            owner_list[:] = [
                item
                for item in owner_list
                if item is not connection
            ]

        for connection in connections:
            collect(connection)

        connections.clear()

    for connection in to_close:
        try:
            await connection.close()
        except Exception:
            # Continue closing the other connections during shutdown.
            pass
