from mcp.server.fastmcp import FastMCP


mcp = FastMCP("Clawbit MCP")


@mcp.tool()
def get_project_status() -> str:
    """
    Return the current status of the Clawbit project.
    """
    return "Clawbit MCP connection is working successfully."


if __name__ == "__main__":
    mcp.run()