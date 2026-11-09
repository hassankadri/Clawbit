"""Vercel serverless deployments must not spawn local MCP stdio processes."""

import pytest

import mcp_client


def test_stdio_mcp_connectors_are_disabled_in_postgres_mode(monkeypatch):
    monkeypatch.setenv("CLAWBIT_PERSISTENCE_BACKEND", "postgres")

    with pytest.raises(ValueError, match="disabled in the Vercel serverless deployment"):
        mcp_client._stdio_connection("notion", "NOTION_TOKEN", "secret-token")

    with pytest.raises(ValueError, match="disabled in the Vercel serverless deployment"):
        mcp_client._stdio_connection("stripe", "STRIPE_SECRET_KEY", "sk_test_123")


def test_bundled_local_mcp_is_disabled_in_postgres_mode(monkeypatch):
    import asyncio

    monkeypatch.setenv("CLAWBIT_PERSISTENCE_BACKEND", "postgres")

    async def run():
        result = await mcp_client.connect_local_mcp()
        assert result["success"] is False
        assert "child process" in result["error"]

    asyncio.run(run())
