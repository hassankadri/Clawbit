
"""Offline security regressions for encrypted MCP credential persistence."""

import asyncio
import sqlite3

from langchain_core.tools import tool
import pytest

import mcp_client as mcp
import mcp_credentials as vault
import mcp_oauth as oauth
from ownership import owner_context
import usage_limits


@pytest.fixture
def fake_mcp_provider(monkeypatch):
    @tool
    async def offline_read() -> str:
        """Return a harmless offline fixture."""
        return "Offline result"

    offline_read.metadata = {"readOnlyHint": True}

    class Client:
        def __init__(self, connections):
            self.connections = connections

        async def get_tools(self):
            return [offline_read]

    monkeypatch.setattr(mcp, "MultiServerMCPClient", Client)


@pytest.mark.parametrize(
    "provider,connector",
    [
        ("github", "connect_github_mcp"),
        ("notion", "connect_notion_mcp"),
        ("stripe", "connect_stripe_mcp"),
    ],
)
def test_token_connection_survives_runtime_cache_reset(
    fake_mcp_provider,
    monkeypatch,
    provider,
    connector,
):
    secret = f"private-{provider}-credential"

    async def run():
        connected = await getattr(mcp, connector)(secret)
        assert connected["success"]

        before = await mcp.get_mcp_connections()
        assert provider in before

        # Simulate a new worker with an empty in-memory cache.
        monkeypatch.setattr(mcp, "_states", {})

        after = await mcp.get_mcp_connections()
        assert provider in after
        assert after[provider] == before[provider]

        catalog = next(
            entry
            for entry in mcp.get_mcp_catalog()
            if entry["id"] == provider
        )
        assert catalog["configured"]

    asyncio.run(run())

    # The disk database must not contain the plaintext token.
    assert secret.encode() not in vault.database_path().read_bytes()


def test_encrypted_records_are_principal_scoped():
    with owner_context("principal-one"):
        epoch = usage_limits.store.connector_epoch("github")

        vault.save_record(
            "github",
            "token",
            {"token": "principal-one-secret"},
            epoch,
        )

        assert vault.load_record("github")["value"]["token"] == (
            "principal-one-secret"
        )

    with owner_context("principal-two"):
        assert vault.load_record("github") is None


def test_disconnect_prevents_credential_restoration(
    fake_mcp_provider,
    monkeypatch,
):
    async def run():
        assert (
            await mcp.connect_github_mcp("revoked-private-token")
        )["success"]

        assert vault.load_record("github") is not None

        await mcp.disconnect_github_mcp()

        assert vault.load_record("github") is None

        monkeypatch.setattr(mcp, "_states", {})

        assert await mcp.get_mcp_connections() == {}

    asyncio.run(run())


def test_external_epoch_revocation_prevents_resurrection(
    fake_mcp_provider,
    monkeypatch,
):
    async def run():
        assert (
            await mcp.connect_github_mcp("offline-private-token")
        )["success"]

        other_worker = usage_limits.UsageStore(
            usage_limits.store.path
        )

        other_worker.connector_epoch(
            "github",
            advance=True,
        )

        monkeypatch.setattr(mcp, "_states", {})

        assert await mcp.get_mcp_connections() == {}
        assert vault.load_record("github") is None

    asyncio.run(run())


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
def test_oauth_token_restores_after_memory_reset(
    monkeypatch,
    provider,
):
    secret = f"{provider}-private-access-token"

    oauth._save_token(
        provider,
        {
            "access_token": secret,
            "expires_in": 3600,
        },
    )

    record = oauth.get_oauth_token_record(provider)
    assert record["access_token"] == secret

    # Simulate process restart without clearing persistent SQLite data.
    monkeypatch.setattr(oauth, "_oauth_tokens", {})
    monkeypatch.setattr(oauth, "_oauth_versions", {})

    restored = oauth.get_oauth_token_record(provider)

    assert restored is not None
    assert restored["access_token"] == secret
    assert oauth.is_oauth_connected(provider)

    assert secret.encode() not in vault.database_path().read_bytes()


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
def test_oauth_disconnect_deletes_persistent_credential(
    monkeypatch,
    provider,
):
    oauth._save_token(
        provider,
        {
            "access_token": "private-revoked-token",
            "expires_in": 3600,
        },
    )

    assert vault.load_record(provider) is not None

    oauth.disconnect_oauth_provider(provider)

    monkeypatch.setattr(oauth, "_oauth_tokens", {})

    assert vault.load_record(provider) is None
    assert oauth.get_oauth_token_record(provider) is None


def test_ciphertext_tampering_fails_closed():
    epoch = usage_limits.store.connector_epoch("github")

    vault.save_record(
        "github",
        "token",
        {"token": "must-not-be-disclosed"},
        epoch,
    )

    with sqlite3.connect(vault.database_path()) as connection:
        connection.execute(
            """
            UPDATE credentials
            SET ciphertext = ?
            WHERE provider = ?
            """,
            (b"DPAPI1:corrupted", "github"),
        )

    with pytest.raises(vault.CredentialStoreError) as error:
        vault.load_record("github")

    assert "must-not-be-disclosed" not in str(error.value)


def test_unsupported_credential_kind_is_rejected():
    epoch = usage_limits.store.connector_epoch("github")

    with pytest.raises(vault.CredentialStoreError):
        vault.save_record(
            "github",
            "oauth",
            {"access_token": "invalid-provider-combination"},
            epoch,
        )
