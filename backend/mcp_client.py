import sys
from pathlib import Path

from langchain_mcp_adapters.client import MultiServerMCPClient


BACKEND_DIR = Path(__file__).resolve().parent

_MCP_CLIENT = None
_MCP_TOOLS = None


def _build_mcp_client() -> MultiServerMCPClient:
    return MultiServerMCPClient(
        {
            "clawbit": {
                "transport": "stdio",
                "command": sys.executable,
                "args": [
                    str(BACKEND_DIR / "mcp_server.py"),
                ],
            }
        }
    )


async def load_mcp_tools():
    global _MCP_CLIENT, _MCP_TOOLS

    if _MCP_TOOLS is not None:
        return _MCP_TOOLS

    if _MCP_CLIENT is None:
        _MCP_CLIENT = _build_mcp_client()

    _MCP_TOOLS = await _MCP_CLIENT.get_tools()

    return _MCP_TOOLS