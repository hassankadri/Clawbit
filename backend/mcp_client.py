import asyncio
import os
import shutil

from typing import Any

from langchain_mcp_adapters.client import (
    MultiServerMCPClient,
)

from mcp_oauth import (
    disconnect_oauth_provider,
    get_google_drive_access_token,
    get_slack_access_token,
    is_oauth_connected,
)


# =========================================================
# CONFIG
# =========================================================

GITHUB_MCP_URL = (
    "https://api.githubcopilot.com/mcp/"
)

GOOGLE_DRIVE_MCP_URL = (
    "https://drivemcp.googleapis.com/mcp/v1"
)

SLACK_MCP_URL = (
    "https://mcp.slack.com/mcp"
)

MCP_TIMEOUT_SECONDS = 15.0


# =========================================================
# RUNTIME CONNECTIONS
# =========================================================

_runtime_connections: dict[
    str,
    dict,
] = {}


# =========================================================
# CACHE
# =========================================================

_MCP_TOOLS: list[Any] | None = None

_SERVER_STATUS_CACHE: dict[
    str,
    dict,
] = {}

_OAUTH_CONNECTION_ERRORS: dict[
    str,
    str,
] = {}


# =========================================================
# EXECUTABLE HELPERS
# =========================================================

def _find_npx() -> str:
    return (
        shutil.which(
            "npx.cmd"
        )
        or shutil.which(
            "npx"
        )
        or "npx"
    )


# =========================================================
# DISPLAY NAMES
# =========================================================

def _server_name(
    server_id: str,
) -> str:
    names = {
        "github":
            "GitHub",

        "notion":
            "Notion",

        "stripe":
            "Stripe",

        "google-drive":
            "Google Drive",

        "slack":
            "Slack",
    }

    return names.get(
        server_id,
        server_id,
    )


# =========================================================
# GITHUB
# =========================================================

def _github_connection(
    token: str,
) -> dict:
    return {
        "transport":
            "streamable_http",

        "url":
            GITHUB_MCP_URL,

        "headers": {
            "Authorization":
                f"Bearer {token}",
        },
    }


# =========================================================
# NOTION
# =========================================================

def _notion_connection(
    token: str,
) -> dict:
    env = dict(
        os.environ
    )

    env[
        "NOTION_TOKEN"
    ] = token

    return {
        "transport":
            "stdio",

        "command":
            _find_npx(),

        "args": [
            "-y",
            "@notionhq/notion-mcp-server",
        ],

        "env":
            env,
    }


# =========================================================
# STRIPE
# =========================================================

def _stripe_connection(
    secret_key: str,
) -> dict:
    env = dict(
        os.environ
    )

    env[
        "STRIPE_SECRET_KEY"
    ] = secret_key

    return {
        "transport":
            "stdio",

        "command":
            _find_npx(),

        "args": [
            "-y",
            "@stripe/mcp",
        ],

        "env":
            env,
    }


# =========================================================
# GOOGLE DRIVE
# =========================================================

def _google_drive_connection(
    access_token: str,
) -> dict:
    return {
        "transport":
            "streamable_http",

        "url":
            GOOGLE_DRIVE_MCP_URL,

        "headers": {
            "Authorization":
                f"Bearer {access_token}",
        },
    }


# =========================================================
# SLACK
# =========================================================

def _slack_connection(
    access_token: str,
) -> dict:
    return {
        "transport":
            "streamable_http",

        "url":
            SLACK_MCP_URL,

        "headers": {
            "Authorization":
                f"Bearer {access_token}",
        },
    }


# =========================================================
# CONNECTIONS
# =========================================================

async def get_mcp_connections() -> dict[
    str,
    dict,
]:
    connections: dict[
        str,
        dict,
    ] = {}

    _OAUTH_CONNECTION_ERRORS.clear()

    # -----------------------------------------------------
    # RUNTIME TOKEN CONNECTORS
    # -----------------------------------------------------

    connections.update(
        _runtime_connections
    )

    # -----------------------------------------------------
    # GITHUB ENV
    # -----------------------------------------------------

    github_token = (
        os.getenv(
            "GITHUB_PERSONAL_ACCESS_TOKEN"
        )
        or ""
    ).strip()

    if (
        github_token
        and "github"
        not in connections
    ):
        connections[
            "github"
        ] = _github_connection(
            github_token
        )

    # -----------------------------------------------------
    # NOTION ENV
    # -----------------------------------------------------

    notion_token = (
        os.getenv(
            "NOTION_TOKEN"
        )
        or ""
    ).strip()

    if (
        notion_token
        and "notion"
        not in connections
    ):
        connections[
            "notion"
        ] = _notion_connection(
            notion_token
        )

    # -----------------------------------------------------
    # STRIPE ENV
    # -----------------------------------------------------

    stripe_key = (
        os.getenv(
            "STRIPE_SECRET_KEY"
        )
        or ""
    ).strip()

    if (
        stripe_key
        and "stripe"
        not in connections
    ):
        connections[
            "stripe"
        ] = _stripe_connection(
            stripe_key
        )

    # -----------------------------------------------------
    # GOOGLE DRIVE OAUTH
    # -----------------------------------------------------

    if is_oauth_connected(
        "google-drive"
    ):
        try:
            google_token = (
                await get_google_drive_access_token()
            )

            if google_token:
                connections[
                    "google-drive"
                ] = _google_drive_connection(
                    google_token
                )

        except Exception as exc:
            _OAUTH_CONNECTION_ERRORS[
                "google-drive"
            ] = str(
                exc
            )

    # -----------------------------------------------------
    # SLACK OAUTH
    # -----------------------------------------------------

    if is_oauth_connected(
        "slack"
    ):
        try:
            slack_token = (
                get_slack_access_token()
            )

            if slack_token:
                connections[
                    "slack"
                ] = _slack_connection(
                    slack_token
                )

        except Exception as exc:
            _OAUTH_CONNECTION_ERRORS[
                "slack"
            ] = str(
                exc
            )

    return connections


# =========================================================
# SERIALIZE TOOL
# =========================================================

def _serialize_tool(
    tool: Any,
) -> dict:
    name = getattr(
        tool,
        "name",
        "Unknown tool",
    )

    description = getattr(
        tool,
        "description",
        "",
    )

    if not isinstance(
        description,
        str,
    ):
        description = str(
            description
        )

    return {
        "name":
            name,

        "description":
            description,
    }


# =========================================================
# LOAD SERVER TOOLS
# =========================================================

async def _get_server_tools(
    server_id: str,
    config: dict,
) -> list[Any]:
    client = (
        MultiServerMCPClient(
            {
                server_id:
                    config,
            }
        )
    )

    return await client.get_tools()


# =========================================================
# INSPECT SERVER
# =========================================================

async def _inspect_server(
    server_id: str,
    config: dict,
) -> dict:
    try:
        tools = await asyncio.wait_for(
            _get_server_tools(
                server_id,
                config,
            ),

            timeout=
                MCP_TIMEOUT_SECONDS,
        )

        result = {
            "id":
                server_id,

            "name":
                _server_name(
                    server_id
                ),

            "transport":
                config.get(
                    "transport",
                    "unknown",
                ),

            "status":
                "connected",

            "tools": [
                _serialize_tool(
                    tool
                )

                for tool
                in tools
            ],
        }

        _SERVER_STATUS_CACHE[
            server_id
        ] = result

        return result

    except asyncio.TimeoutError:
        result = {
            "id":
                server_id,

            "name":
                _server_name(
                    server_id
                ),

            "transport":
                config.get(
                    "transport",
                    "unknown",
                ),

            "status":
                "error",

            "tools":
                [],

            "error": (
                f"{_server_name(server_id)} "
                "MCP connection timed out."
            ),
        }

        _SERVER_STATUS_CACHE[
            server_id
        ] = result

        return result

    except asyncio.CancelledError:
        raise

    except Exception as exc:
        result = {
            "id":
                server_id,

            "name":
                _server_name(
                    server_id
                ),

            "transport":
                config.get(
                    "transport",
                    "unknown",
                ),

            "status":
                "error",

            "tools":
                [],

            "error":
                str(exc),
        }

        _SERVER_STATUS_CACHE[
            server_id
        ] = result

        return result


# =========================================================
# LOAD MCP TOOLS INTO AGENT
# =========================================================

async def load_mcp_tools(
    force_refresh: bool = False,
) -> list[Any]:
    global _MCP_TOOLS

    if (
        _MCP_TOOLS is not None
        and not force_refresh
    ):
        return _MCP_TOOLS

    connections = (
        await get_mcp_connections()
    )

    if not connections:
        _MCP_TOOLS = []

        return []

    async def load_one(
        server_id: str,
        config: dict,
    ) -> list[Any]:
        try:
            tools = await asyncio.wait_for(
                _get_server_tools(
                    server_id,
                    config,
                ),

                timeout=
                    MCP_TIMEOUT_SECONDS,
            )

            _SERVER_STATUS_CACHE[
                server_id
            ] = {
                "id":
                    server_id,

                "name":
                    _server_name(
                        server_id
                    ),

                "transport":
                    config.get(
                        "transport",
                        "unknown",
                    ),

                "status":
                    "connected",

                "tools": [
                    _serialize_tool(
                        tool
                    )

                    for tool
                    in tools
                ],
            }

            return tools

        except asyncio.CancelledError:
            raise

        except Exception:
            return []

    results = await asyncio.gather(
        *[
            load_one(
                server_id,
                config,
            )

            for (
                server_id,
                config,
            )
            in connections.items()
        ],
    )

    combined: list[
        Any
    ] = []

    for server_tools in results:
        combined.extend(
            server_tools
        )

    _MCP_TOOLS = combined

    return _MCP_TOOLS


# =========================================================
# STATUS
# =========================================================

async def get_mcp_status(
    force_refresh: bool = False,
) -> dict:
    connections = (
        await get_mcp_connections()
    )

    if force_refresh:
        _SERVER_STATUS_CACHE.clear()

    servers = []

    if connections:
        servers = list(
            await asyncio.gather(
                *[
                    _inspect_server(
                        server_id,
                        config,
                    )

                    for (
                        server_id,
                        config,
                    )
                    in connections.items()
                ],
            )
        )

    # -----------------------------------------------------
    # OAUTH ERRORS
    # -----------------------------------------------------

    for (
        server_id,
        error_message,
    ) in _OAUTH_CONNECTION_ERRORS.items():
        if any(
            server.get(
                "id"
            )
            == server_id

            for server
            in servers
        ):
            continue

        servers.append(
            {
                "id":
                    server_id,

                "name":
                    _server_name(
                        server_id
                    ),

                "transport":
                    "streamable_http",

                "status":
                    "error",

                "tools":
                    [],

                "error":
                    error_message,
            }
        )

    connected_servers = [
        server

        for server
        in servers

        if server.get(
            "status"
        ) == "connected"
    ]

    tool_count = sum(
        len(
            server.get(
                "tools",
                [],
            )
        )

        for server
        in connected_servers
    )

    return {
        "connected":
            bool(
                connected_servers
            ),

        "server_count":
            len(
                servers
            ),

        "connected_server_count":
            len(
                connected_servers
            ),

        "tool_count":
            tool_count,

        "servers":
            servers,
    }


# =========================================================
# REFRESH
# =========================================================

async def refresh_mcp_tools() -> dict:
    global _MCP_TOOLS

    _MCP_TOOLS = None

    _SERVER_STATUS_CACHE.clear()

    return await get_mcp_status(
        force_refresh=True,
    )


# =========================================================
# CLEAR CACHE
# =========================================================

def clear_mcp_cache() -> None:
    global _MCP_TOOLS

    _MCP_TOOLS = None

    _SERVER_STATUS_CACHE.clear()


# =========================================================
# GENERIC TOKEN CONNECTOR
# =========================================================

async def _connect_token_server(
    server_id: str,
    config: dict,
) -> dict:
    result = await _inspect_server(
        server_id,
        config,
    )

    if (
        result.get(
            "status"
        )
        != "connected"
    ):
        return {
            "success":
                False,

            "error":
                result.get(
                    "error",
                    (
                        "Could not connect "
                        f"{_server_name(server_id)}."
                    ),
                ),
        }

    _runtime_connections[
        server_id
    ] = config

    global _MCP_TOOLS

    _MCP_TOOLS = None

    return {
        "success":
            True,

        "server":
            result,
    }


# =========================================================
# GITHUB
# =========================================================

async def connect_github_mcp(
    token: str,
) -> dict:
    token = (
        token.strip()
    )

    if not token:
        return {
            "success":
                False,

            "error":
                "GitHub token is required.",
        }

    return await _connect_token_server(
        "github",

        _github_connection(
            token
        ),
    )


async def disconnect_github_mcp() -> dict:
    env_token = (
        os.getenv(
            "GITHUB_PERSONAL_ACCESS_TOKEN"
        )
        or ""
    ).strip()

    if env_token:
        return {
            "success":
                False,

            "error": (
                "GitHub is configured through "
                "GITHUB_PERSONAL_ACCESS_TOKEN."
            ),
        }

    return _disconnect_runtime_server(
        "github"
    )


# =========================================================
# NOTION
# =========================================================

async def connect_notion_mcp(
    token: str,
) -> dict:
    token = (
        token.strip()
    )

    if not token:
        return {
            "success":
                False,

            "error":
                "Notion integration token is required.",
        }

    return await _connect_token_server(
        "notion",

        _notion_connection(
            token
        ),
    )


async def disconnect_notion_mcp() -> dict:
    env_token = (
        os.getenv(
            "NOTION_TOKEN"
        )
        or ""
    ).strip()

    if env_token:
        return {
            "success":
                False,

            "error": (
                "Notion is configured through "
                "NOTION_TOKEN."
            ),
        }

    return _disconnect_runtime_server(
        "notion"
    )


# =========================================================
# STRIPE
# =========================================================

async def connect_stripe_mcp(
    secret_key: str,
) -> dict:
    secret_key = (
        secret_key.strip()
    )

    if not secret_key:
        return {
            "success":
                False,

            "error":
                "Stripe key is required.",
        }

    return await _connect_token_server(
        "stripe",

        _stripe_connection(
            secret_key
        ),
    )


async def disconnect_stripe_mcp() -> dict:
    env_key = (
        os.getenv(
            "STRIPE_SECRET_KEY"
        )
        or ""
    ).strip()

    if env_key:
        return {
            "success":
                False,

            "error": (
                "Stripe is configured through "
                "STRIPE_SECRET_KEY."
            ),
        }

    return _disconnect_runtime_server(
        "stripe"
    )


# =========================================================
# GOOGLE DRIVE
# =========================================================

def disconnect_google_drive_mcp() -> dict:
    disconnect_oauth_provider(
        "google-drive"
    )

    clear_mcp_cache()

    _OAUTH_CONNECTION_ERRORS.pop(
        "google-drive",
        None,
    )

    return {
        "success":
            True,

        "disconnected":
            True,
    }


# =========================================================
# SLACK
# =========================================================

def disconnect_slack_mcp() -> dict:
    disconnect_oauth_provider(
        "slack"
    )

    clear_mcp_cache()

    _OAUTH_CONNECTION_ERRORS.pop(
        "slack",
        None,
    )

    return {
        "success":
            True,

        "disconnected":
            True,
    }


# =========================================================
# RUNTIME DISCONNECT
# =========================================================

def _disconnect_runtime_server(
    server_id: str,
) -> dict:
    existed = (
        server_id
        in _runtime_connections
    )

    _runtime_connections.pop(
        server_id,
        None,
    )

    _SERVER_STATUS_CACHE.pop(
        server_id,
        None,
    )

    global _MCP_TOOLS

    _MCP_TOOLS = None

    return {
        "success":
            True,

        "disconnected":
            existed,
    }


# =========================================================
# CATALOG
# =========================================================

def get_mcp_catalog() -> list[
    dict
]:
    github_configured = (
        "github"
        in _runtime_connections

        or bool(
            (
                os.getenv(
                    "GITHUB_PERSONAL_ACCESS_TOKEN"
                )
                or ""
            ).strip()
        )
    )

    notion_configured = (
        "notion"
        in _runtime_connections

        or bool(
            (
                os.getenv(
                    "NOTION_TOKEN"
                )
                or ""
            ).strip()
        )
    )

    stripe_configured = (
        "stripe"
        in _runtime_connections

        or bool(
            (
                os.getenv(
                    "STRIPE_SECRET_KEY"
                )
                or ""
            ).strip()
        )
    )

    return [
        {
            "id":
                "github",

            "name":
                "GitHub",

            "description": (
                "Work with repositories, issues, "
                "pull requests and GitHub workflows."
            ),

            "category":
                "Development",

            "configured":
                github_configured,

            "auth":
                "token",

            "credential_label":
                "GitHub access token",

            "available":
                True,
        },

        {
            "id":
                "notion",

            "name":
                "Notion",

            "description": (
                "Search, read and work with "
                "Notion pages and databases."
            ),

            "category":
                "Knowledge",

            "configured":
                notion_configured,

            "auth":
                "token",

            "credential_label":
                "Notion integration token",

            "available":
                True,
        },

        {
            "id":
                "stripe",

            "name":
                "Stripe",

            "description": (
                "Work with customers, payments, "
                "products and Stripe billing."
            ),

            "category":
                "Payments",

            "configured":
                stripe_configured,

            "auth":
                "token",

            "credential_label":
                "Stripe restricted key",

            "available":
                True,
        },

        {
            "id":
                "google-drive",

            "name":
                "Google Drive",

            "description": (
                "Search and work with files "
                "stored in Google Drive."
            ),

            "category":
                "Storage",

            "configured":
                is_oauth_connected(
                    "google-drive"
                ),

            "auth":
                "oauth",

            "available":
                True,
        },

        {
            "id":
                "slack",

            "name":
                "Slack",

            "description": (
                "Search messages, read channels, "
                "files and perform Slack actions."
            ),

            "category":
                "Communication",

            "configured":
                is_oauth_connected(
                    "slack"
                ),

            "auth":
                "oauth",

            "available":
                True,
        },
    ]