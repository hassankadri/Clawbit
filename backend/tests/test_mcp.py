import asyncio

from mcp_client import load_mcp_tools


def test_local_mcp_server_discovers_project_status_tool():
    async def run():
        tools = await load_mcp_tools()

        names = {
            tool.name
            for tool in tools
        }

        assert "get_project_status" in names

    asyncio.run(run())


def test_local_mcp_project_status_tool_executes():
    async def run():
        tools = await load_mcp_tools()

        tool = next(
            item
            for item in tools
            if item.name == "get_project_status"
        )

        result = await tool.ainvoke({})

        text = str(result).lower()

        assert "working successfully" in text

    asyncio.run(run())
