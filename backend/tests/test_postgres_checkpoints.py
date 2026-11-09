"""Offline tests for the PostgreSQL checkpoint ownership boundary."""

import pytest

import owned_postgres_checkpoints as postgres_checkpoints
from ownership import OwnershipError


def test_unscoped_postgres_checkpoint_query_is_rejected():
    with pytest.raises(OwnershipError):
        postgres_checkpoints._authorize(None)


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"configurable": {}},
        {"configurable": {"thread_id": ""}},
        {"configurable": {"thread_id": None}},
    ],
)
def test_postgres_checkpoint_requires_a_nonempty_thread_id(config):
    with pytest.raises(OwnershipError):
        postgres_checkpoints._authorize(config)


def test_postgres_checkpoint_uses_verified_context_not_config_identity(monkeypatch):
    authorized = []

    def require_owned_thread(thread_id, *, create=False):
        authorized.append((thread_id, create))

    monkeypatch.setattr(
        postgres_checkpoints,
        "require_thread",
        require_owned_thread,
    )

    postgres_checkpoints._authorize({
        "configurable": {
            "thread_id": "new-thread-id",
            "owner_id": "forged-owner",
            "principal_id": "forged-principal",
        }
    })

    assert authorized == [("new-thread-id", True)]


def test_postgres_checkpoint_saver_is_the_async_postgres_implementation():
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    assert issubclass(
        postgres_checkpoints.OwnedPostgresSaver,
        AsyncPostgresSaver,
    )



def test_postgres_backend_requires_a_database_url(monkeypatch):
    import asyncio

    from agent_cache import get_postgres_checkpointer

    monkeypatch.delenv("DATABASE_URL", raising=False)

    async def run():
        with pytest.raises(RuntimeError, match="DATABASE_URL is required"):
            await get_postgres_checkpointer([])

    asyncio.run(run())
