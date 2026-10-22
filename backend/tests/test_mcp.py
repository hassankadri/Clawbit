"""Exercise the bundled server through real stdio discovery and guarded tools."""

import asyncio
from importlib.metadata import version
import json

import pytest
from langchain_core.tools import ToolException

from mcp_client import connect_local_mcp, disconnect_local_mcp, load_mcp_tools
from ownership import OwnershipError, owner_context


def test_local_mcp_server_discovers_project_status_tool():
    async def run():
        assert await load_mcp_tools() == []
        assert (await connect_local_mcp())["success"]
        tools = await load_mcp_tools()
        assert {tool.name for tool in tools} == {"get_project_status"}
        assert tools[0].metadata["readOnlyHint"] is True
        assert tools[0].args_schema.get("properties", {}) == {}
        await disconnect_local_mcp()
        assert await load_mcp_tools() == []

    asyncio.run(run())


def test_local_mcp_project_status_tool_executes():
    async def run():
        assert (await connect_local_mcp())["success"]
        tool = next(item for item in await load_mcp_tools() if item.name == "get_project_status")
        result = await tool.ainvoke({})
        payload = json.loads(result[0]["text"])
        assert payload == {
            "project": "Clawbit", "transport": "stdio",
            "packages": {name: version(name) for name in (
                "fastapi", "langgraph", "mcp", "langchain-mcp-adapters",
            )},
        }
        with owner_context("other-owner"):
            assert await load_mcp_tools() == []
            with pytest.raises(ToolException):
                await tool.ainvoke({})
        await disconnect_local_mcp()
        with pytest.raises(ToolException):
            await tool.ainvoke({})
        assert (await connect_local_mcp())["success"]
        with pytest.raises(ToolException):
            await tool.ainvoke({})
        await disconnect_local_mcp()

    asyncio.run(run())


def test_local_mcp_requires_an_authenticated_principal():
    with owner_context(None), pytest.raises(OwnershipError):
        asyncio.run(connect_local_mcp())
