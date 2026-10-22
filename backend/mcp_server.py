"""Read-only local diagnostics over MCP stdio; no application stores are opened."""

from importlib.metadata import PackageNotFoundError, version

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations


mcp = FastMCP("Clawbit MCP")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
def get_project_status() -> dict:
    """Report installed backend component versions, not provider health.

    The fixed package allowlist avoids exposing environment values, filesystem
    paths, user records or arbitrary package inventories.
    """
    packages = {}
    for name in ("fastapi", "langgraph", "mcp", "langchain-mcp-adapters"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    return {"project": "Clawbit", "transport": "stdio", "packages": packages}


if __name__ == "__main__":
    mcp.run()
