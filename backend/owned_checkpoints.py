"""Authorize checkpoint storage before SQLite reads or deserialization."""

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
    DeltaChannelHistory,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from ownership import OwnershipError, require_thread
from observability import persistence_boundary


def _authorize(config: RunnableConfig | None) -> None:
    if config is None:
        # An unscoped history query would enumerate every principal's state.
        raise OwnershipError()
    thread_id = config.get("configurable", {}).get("thread_id")
    if not isinstance(thread_id, str):
        raise OwnershipError()
    require_thread(thread_id, create=True)


class OwnedSqliteSaver(AsyncSqliteSaver):
    """Preserve checkpoint identifiers while guarding all async persistence paths.

    The upstream synchronous methods delegate to these async methods. Identity
    comes from the server context, never from config or checkpoint metadata.
    """

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            return await super().aget_tuple(config)

    async def alist(
        self, config: RunnableConfig | None, *, filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None, limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        _authorize(config)
        if before is not None:
            _authorize(before)
        with persistence_boundary("checkpoint"):
            async for checkpoint in super().alist(config, filter=filter, before=before, limit=limit):
                yield checkpoint

    async def aput(
        self, config: RunnableConfig, checkpoint: Checkpoint,
        metadata: CheckpointMetadata, new_versions: ChannelVersions,
    ) -> RunnableConfig:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            return await super().aput(config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self, config: RunnableConfig, writes: Sequence[tuple[str, Any]],
        task_id: str, task_path: str = "",
    ) -> None:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            await super().aput_writes(config, writes, task_id, task_path)

    async def adelete_thread(self, thread_id: str) -> None:
        require_thread(thread_id)
        with persistence_boundary("checkpoint"):
            await super().adelete_thread(thread_id)

    async def aget_delta_channel_history(
        self, *, config: RunnableConfig, channels: Sequence[str],
    ) -> Mapping[str, DeltaChannelHistory]:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            return await super().aget_delta_channel_history(config=config, channels=channels)
