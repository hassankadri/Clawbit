"""Offline regression coverage for the existing GitHub connector contract."""
import asyncio

from langchain_core.tools import tool
import pytest

import app as api
import mcp_client as mcp


@pytest.fixture
def connector(monkeypatch):
    monkeypatch.setattr(mcp, "_states", {})
    monkeypatch.setattr(mcp, "is_oauth_connected", lambda provider: False)
    calls = []

    @tool
    async def get_me() -> dict:
        """Return the offline fixture identity."""
        return {"login": "offline-fixture"}

    get_me.metadata = {"readOnlyHint": True}

    class Client:
        def __init__(self, connections):
            calls.append(connections)

        async def get_tools(self):
            return [get_me]

    monkeypatch.setattr(mcp, "MultiServerMCPClient", Client)
    return calls


def test_github_connect_discover_execute_cache_and_disconnect(owner_client, connector):
    client = owner_client
    response = client.post("/mcp/connect/github", json={"token": " offline-token "})
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert connector[0] == {"github": {
        "transport": "streamable_http", "url": "https://api.githubcopilot.com/mcp/",
        "headers": {"Authorization": "Bearer offline-token"},
    }}
    tools = asyncio.run(mcp.load_mcp_tools())
    assert [item.name for item in tools] == ["get_me"]
    assert asyncio.run(tools[0].ainvoke({})) == {"login": "offline-fixture"}
    requests = len(connector)
    assert asyncio.run(mcp.load_mcp_tools()) is tools
    assert len(connector) == requests
    assert client.post("/mcp/disconnect/github").json()["success"] is True
    assert asyncio.run(mcp.load_mcp_tools()) == []
    assert "github" not in mcp._state().connections


def test_github_environment_token_requires_explicit_owner_connection(connector, monkeypatch):
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "offline-environment-token")
    connections = asyncio.run(mcp.get_mcp_connections())
    assert "github" not in connections
    assert not next(item for item in mcp.get_mcp_catalog() if item["id"] == "github")["configured"]
    assert asyncio.run(mcp.connect_github_mcp("offline-environment-token"))["success"]
    connections = asyncio.run(mcp.get_mcp_connections())
    assert connections["github"]["headers"]["Authorization"] == "Bearer offline-environment-token"
    assert next(item for item in mcp.get_mcp_catalog() if item["id"] == "github")["configured"]
    assert asyncio.run(mcp.disconnect_github_mcp())["success"] is True
    assert "github" not in asyncio.run(mcp.get_mcp_connections())


def test_failed_github_auth_does_not_save_connection(owner_client, connector, monkeypatch):
    async def denied(*args, **kwargs):
        raise RuntimeError("Unauthorized")
    monkeypatch.setattr(mcp, "_get_server_tools", denied)
    response = owner_client.post("/mcp/connect/github", json={"token": "offline-invalid-token"})
    assert response.status_code == 400
    assert "github" not in mcp._state().connections
    assert asyncio.run(mcp.load_mcp_tools()) == []
