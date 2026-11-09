"""Principal-scoped PostgreSQL checkpoints for serverless deployments."""

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
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from observability import persistence_boundary
from ownership import OwnershipError, require_thread


def _authorize(config: RunnableConfig | None) -> None:
    """Authorize the requested thread before checkpoint reads or writes.

    Principal identity comes from the verified request context. Values such as
    owner_id or principal_id supplied in RunnableConfig are deliberately ignored.
    """
    if config is None:
        raise OwnershipError()

    configurable = config.get("configurable") or {}
    thread_id = configurable.get("thread_id")

    if not isinstance(thread_id, str) or not thread_id:
        raise OwnershipError()

    require_thread(thread_id, create=True)


class OwnedPostgresSaver(AsyncPostgresSaver):
    """Async PostgreSQL saver with the same ownership boundary as SQLite.

    Keep authorization ahead of every upstream operation. In particular, do
    not deserialize stored checkpoint data before the current principal has
    been authorized for its thread.
    """

    async def aget_tuple(
        self,
        config: RunnableConfig,
    ) -> CheckpointTuple | None:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            return await super().aget_tuple(config)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        _authorize(config)

        if before is not None:
            _authorize(before)

        with persistence_boundary("checkpoint"):
            async for checkpoint in super().alist(
                config,
                filter=filter,
                before=before,
                limit=limit,
            ):
                yield checkpoint

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            return await super().aput(
                config,
                checkpoint,
                metadata,
                new_versions,
            )

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            await super().aput_writes(
                config,
                writes,
                task_id,
                task_path,
            )

    async def adelete_thread(self, thread_id: str) -> None:
        # The thread ID is resolved against the verified current principal.
        require_thread(thread_id)
        with persistence_boundary("checkpoint"):
            await super().adelete_thread(thread_id)

    async def aget_delta_channel_history(
        self,
        *,
        config: RunnableConfig,
        channels: Sequence[str],
    ) -> Mapping[str, DeltaChannelHistory]:
        _authorize(config)
        with persistence_boundary("checkpoint"):
            return await super().aget_delta_channel_history(
                config=config,
                channels=channels,
            )
