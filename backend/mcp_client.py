
"""Principal-scoped MCP connections; cached handles never carry credentials."""

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
import re
import shutil
import sys
from pathlib import Path
from threading import RLock
from typing import Any

from langchain_core.tools import StructuredTool, ToolException
from langchain_mcp_adapters.client import MultiServerMCPClient

from mcp_credentials import (
    CredentialStoreError,
    save_record,
    load_record,
    invalidate_record,
)
from mcp_oauth import (
    disconnect_oauth_provider,
    get_google_drive_access_token,
    get_oauth_token_record,
    get_slack_access_token,
    is_oauth_connected,
)
from mcp_approval import (
    ApprovalRejected,
    cancel_pending_approvals,
    needs_approval,
    require_mcp_approval,
)
from ownership import current_owner, require_active_owner
from usage_limits import UsageLimitError, limited
import usage_limits
from observability import event


GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
GOOGLE_DRIVE_MCP_URL = "https://drivemcp.googleapis.com/mcp/v1"
SLACK_MCP_URL = "https://mcp.slack.com/mcp"

MCP_TIMEOUT_SECONDS = 15.0

CONNECTION_ERROR = (
    "Connector unavailable or credentials expired. "
    "Reconnect and try again."
)

# Reviewed top-level npm versions. Do not use floating tags or ranges.
# Updating these requires an explicit dependency review.
MCP_PACKAGE_PINS = {
    "notion": "@notionhq/notion-mcp-server@2.5.2",
    "stripe": "@stripe/mcp@0.3.3",
}


@dataclass
class ConnectorState:
    connections: dict[str, dict] = field(default_factory=dict, repr=False)
    tools: list[Any] | None = field(default=None, repr=False)
    raw_tools: dict[str, list[Any]] = field(default_factory=dict, repr=False)
    errors: dict[str, str] = field(default_factory=dict)
    epochs: dict[str, int] = field(default_factory=dict)
    active: dict[str, set[asyncio.Task]] = field(default_factory=dict, repr=False)
    generation: int = 0
    lock: RLock = field(default_factory=RLock, repr=False)


_states: dict[str, ConnectorState] = {}
_states_lock = RLock()


def _state() -> ConnectorState:
    with _states_lock:
        state = _states.setdefault(
            require_active_owner(),
            ConnectorState(),
        )

    with state.lock:
        for provider, epoch in list(state.epochs.items()):
            if usage_limits.store.connector_epoch(provider) != epoch:
                state.connections.pop(provider, None)
                state.epochs.pop(provider, None)
                state.raw_tools.clear()
                state.tools = None
                state.generation += 1
                cancel_pending_approvals(provider)
                _cancel_sessions(state, provider)

    # Restore explicitly connected token providers after restart.
    with state.lock:
        for provider, builder in (
            ("github", _github_connection),
            ("notion", _notion_connection),
            ("stripe", _stripe_connection),
        ):
            if provider in state.connections:
                continue

            try:
                record = load_record(provider)

                if record is None or record["kind"] != "token":
                    continue

                token = record["value"].get("token")

                if not isinstance(token, str):
                    raise CredentialStoreError(
                        "Invalid stored connector token."
                    )

                config = builder(token)
                epoch = usage_limits.store.connector_epoch(
                    provider
                )

                if epoch != record["epoch"]:
                    continue

                state.connections[provider] = config
                state.epochs[provider] = epoch
                state.generation += 1

            except (CredentialStoreError, ValueError):
                state.errors[provider] = CONNECTION_ERROR
    return state


def _cancel_sessions(state: ConnectorState, provider: str) -> None:
    try:
        initiating_task = asyncio.current_task()
    except RuntimeError:
        initiating_task = None

    for task in state.active.pop(provider, set()):
        if task is not initiating_task and not task.done():
            task.get_loop().call_soon_threadsafe(task.cancel)


@contextmanager
def _active_connection(
    server_id: str,
    expected_generation: int | None = None,
):
    """Disconnect cancels this owner's active sessions, including tool execution."""
    state = _state()
    task = asyncio.current_task()

    if task is None:
        raise RuntimeError(
            "Connector operations require an active async task."
        )

    with state.lock:
        if (
            expected_generation is not None
            and state.generation != expected_generation
        ):
            raise ToolException(CONNECTION_ERROR)

        state.active.setdefault(server_id, set()).add(task)

    try:
        yield
    finally:
        with state.lock:
            state.active.get(server_id, set()).discard(task)


def _server_name(server_id: str) -> str:
    return {
        "github": "GitHub",
        "notion": "Notion",
        "stripe": "Stripe",
        "google-drive": "Google Drive",
        "slack": "Slack",
    }.get(server_id, server_id)


def _http_connection(url: str, token: str) -> dict:
    _validate_token(token)

    return {
        "transport": "streamable_http",
        "url": url,
        "headers": {
            "Authorization": f"Bearer {token}",
        },
    }


def _github_connection(token: str) -> dict:
    return _http_connection(GITHUB_MCP_URL, token)


def _stdio_connection(
    provider: str,
    variable: str,
    token: str,
) -> dict:
    """Construct an stdio server using an approved, pinned package.

    The caller selects a known provider, not an arbitrary package.
    npm remains responsible for resolving that package's dependencies.
    """
    _validate_token(token)

    # Reject unsupported providers rather than forming an npm package
    # specification from uncontrolled text.
    package = MCP_PACKAGE_PINS[provider]

    # The MCP SDK inherits process essentials. The adapter expands
    # ${VAR} in explicit env values, so connector credentials must
    # never contain that syntax.
    return {
        "transport": "stdio",
        "command": (
            shutil.which("npx.cmd")
            or shutil.which("npx")
            or "npx"
        ),
        "args": ["-y", package],
        "env": {
            variable: token,
        },
    }


def _validate_token(token: str) -> None:
    if not re.fullmatch(
        r"[A-Za-z0-9_./=+:-]{1,4096}",
        token,
    ):
        raise ValueError(
            "Invalid connector credential format."
        )


def _notion_connection(token: str) -> dict:
    return _stdio_connection(
        "notion",
        "NOTION_TOKEN",
        token,
    )


def _stripe_connection(token: str) -> dict:
    return _stdio_connection(
        "stripe",
        "STRIPE_SECRET_KEY",
        token,
    )


def _google_drive_connection(token: str) -> dict:
    return _http_connection(
        GOOGLE_DRIVE_MCP_URL,
        token,
    )


def _slack_connection(token: str) -> dict:
    return _http_connection(
        SLACK_MCP_URL,
        token,
    )


async def get_mcp_connections() -> dict[str, dict]:
    state = _state()

    with state.lock:
        connections = {
            provider: {
                **config,
                "_clawbit_epoch": state.epochs[provider],
            }
            for provider, config in state.connections.items()
        }
        state.errors.clear()

    for provider in ("google-drive", "slack"):
        if not is_oauth_connected(provider):
            continue

        try:
            token = (
                await get_google_drive_access_token()
                if provider == "google-drive"
                else get_slack_access_token()
            )

            if token:
                record = get_oauth_token_record(provider)

                if not record:
                    continue

                builder = (
                    _google_drive_connection
                    if provider == "google-drive"
                    else _slack_connection
                )

                connections[provider] = {
                    **builder(record["access_token"]),
                    "_clawbit_epoch": record["connection_epoch"],
                }

        except UsageLimitError:
            raise
        except Exception:
            state.errors[provider] = CONNECTION_ERROR

    return connections


def _serialize_tool(tool: Any) -> dict:
    return {
        "name": str(
            getattr(tool, "name", "Unknown tool")
        ),
        "description": str(
            getattr(tool, "description", "")
        ),
    }


@limited("mcp")
async def _get_server_tools(
    server_id: str,
    config: dict,
) -> list[Any]:
    with _active_connection(server_id):
        epoch = config.get("_clawbit_epoch")

        if epoch is not None:
            usage_limits.store.connector_epoch(
                server_id,
                expected=epoch,
            )

        transport_config = {
            key: value
            for key, value in config.items()
            if key != "_clawbit_epoch"
        }

        return await MultiServerMCPClient({
            server_id: transport_config,
        }).get_tools()


async def _inspect_server(
    server_id: str,
    config: dict,
) -> dict:
    result = {
        "id": server_id,
        "name": _server_name(server_id),
        "transport": config.get(
            "transport",
            "unknown",
        ),
        "tools": [],
    }

    try:
        tools = await asyncio.wait_for(
            _get_server_tools(server_id, config),
            MCP_TIMEOUT_SECONDS,
        )

        result.update(
            status="connected",
            tools=[
                _serialize_tool(tool)
                for tool in tools
            ],
        )

    except UsageLimitError:
        raise
    except Exception:
        result.update(
            status="error",
            error=CONNECTION_ERROR,
        )

    return result


def _guarded_tool(
    server_id: str,
    tool: Any,
    generation: int,
) -> StructuredTool:
    principal = current_owner()
    name = tool.name
    metadata = getattr(tool, "metadata", None) or {}
    read_only = metadata.get("readOnlyHint") is True

    @limited("mcp_execution")
    async def execute(**arguments):
        if current_owner() != principal:
            raise ToolException(CONNECTION_ERROR)

        state = _state()

        with state.lock:
            if state.generation != generation:
                raise ToolException(CONNECTION_ERROR)

        connections = await get_mcp_connections()

        if server_id not in connections:
            raise ToolException(CONNECTION_ERROR)

        try:
            # OAuth tokens may have refreshed since discovery.
            if server_id in {"google-drive", "slack"}:
                tools = await asyncio.wait_for(
                    _get_server_tools(
                        server_id,
                        connections[server_id],
                    ),
                    MCP_TIMEOUT_SECONDS,
                )
            else:
                tools = state.raw_tools.get(
                    server_id,
                    [],
                )

            with state.lock:
                if state.generation != generation:
                    raise ToolException(CONNECTION_ERROR)

                selected = next(
                    item
                    for item in tools
                    if item.name == name
                )

                selected_metadata = (
                    getattr(selected, "metadata", None) or {}
                )

                if (
                    read_only
                    and selected_metadata.get("readOnlyHint") is not True
                ):
                    raise ToolException(CONNECTION_ERROR)

        except UsageLimitError:
            raise
        except Exception:
            if _state().generation == generation:
                _disconnect_runtime_server(server_id)

                if server_id in {"google-drive", "slack"}:
                    disconnect_oauth_provider(server_id)

            raise ToolException(CONNECTION_ERROR) from None

        # Approval happens before invoking the external tool.
        # Missing or uncertain read-only metadata requires approval.
        if (
            needs_approval(name, metadata)
            or needs_approval(name, selected_metadata)
        ):
            try:
                await require_mcp_approval(
                    server_id,
                    name,
                    arguments,
                )
            except ApprovalRejected as exc:
                raise ToolException(str(exc)) from None

        # Revalidate after the approval wait.
        require_active_owner()

        with state.lock:
            if state.generation != generation:
                raise ToolException(CONNECTION_ERROR)

        connections = await get_mcp_connections()

        if server_id not in connections:
            raise ToolException(CONNECTION_ERROR)

        try:
            with _active_connection(server_id, generation):
                return await asyncio.wait_for(
                    selected.coroutine(**arguments),
                    timeout=60,
                )

        except UsageLimitError:
            raise
        except Exception:
            if _state().generation == generation:
                _disconnect_runtime_server(server_id)

                if server_id in {"google-drive", "slack"}:
                    disconnect_oauth_provider(server_id)

            raise ToolException(CONNECTION_ERROR) from None

    return StructuredTool(
        name=name,
        description=tool.description,
        args_schema=tool.args_schema,
        coroutine=execute,
        response_format=getattr(
            tool,
            "response_format",
            "content",
        ),
        metadata={
            **metadata,
            "clawbit_mcp": server_id,
        },
    )


@limited("mcp")
async def load_mcp_tools(
    force_refresh: bool = False,
) -> list[Any]:
    state = _state()

    if state.tools is not None and not force_refresh:
        return state.tools

    generation = state.generation
    connections = await get_mcp_connections()
    combined = []
    raw_tools = {}

    for server_id, config in connections.items():
        try:
            epoch = config["_clawbit_epoch"]

            tools = await asyncio.wait_for(
                _get_server_tools(
                    server_id,
                    config,
                ),
                MCP_TIMEOUT_SECONDS,
            )

            usage_limits.store.connector_epoch(
                server_id,
                expected=epoch,
            )
            state.epochs[server_id] = epoch

            if server_id not in {"google-drive", "slack"}:
                raw_tools[server_id] = tools

            combined.extend(
                _guarded_tool(
                    server_id,
                    tool,
                    generation,
                )
                for tool in tools
            )

        except UsageLimitError:
            raise
        except Exception:
            state.errors[server_id] = CONNECTION_ERROR

    with state.lock:
        if state.generation != generation:
            return []

        state.raw_tools = raw_tools
        state.tools = combined

    return combined


@limited("mcp")
async def get_mcp_status(
    force_refresh: bool = False,
) -> dict:
    state = _state()
    connections = await get_mcp_connections()
    servers = []

    for server_id, config in connections.items():
        result = await _inspect_server(
            server_id,
            config,
        )
        servers.append(result)

    for server_id, error in state.errors.items():
        if not any(
            server["id"] == server_id
            for server in servers
        ):
            servers.append({
                "id": server_id,
                "name": _server_name(server_id),
                "transport": "streamable_http",
                "status": "error",
                "tools": [],
                "error": error,
            })

    connected = [
        server
        for server in servers
        if server["status"] == "connected"
    ]

    return {
        "connected": bool(connected),
        "server_count": len(servers),
        "connected_server_count": len(connected),
        "tool_count": sum(
            len(server["tools"])
            for server in connected
        ),
        "servers": servers,
    }


def clear_mcp_cache() -> None:
    state = _state()

    with state.lock:
        state.generation += 1
        state.tools = None
        state.raw_tools.clear()
        cancel_pending_approvals()


async def refresh_mcp_tools() -> dict:
    clear_mcp_cache()
    return await get_mcp_status(
        force_refresh=True,
    )


@limited("mcp")
async def _connect_token_server(
    server_id: str,
    config: dict,
) -> dict:
    state = _state()
    generation = state.generation
    epoch = usage_limits.store.connector_epoch(
        server_id,
    )

    result = await _inspect_server(
        server_id,
        config,
    )

    if result["status"] != "connected":
        event(
            "mcp",
            "failed",
            category="unavailable",
        )
        return {
            "success": False,
            "error": CONNECTION_ERROR,
        }

    with state.lock:
        if state.generation != generation:
            return {
                "success": False,
                "error": CONNECTION_ERROR,
            }

        require_active_owner()

        try:
            state.epochs[server_id] = (
                usage_limits.store.connector_epoch(
                    server_id,
                    advance=True,
                    expected=epoch,
                )
            )

        except RuntimeError:
            return {
                "success": False,
                "error": CONNECTION_ERROR,
            }

        state.connections[server_id] = config
        clear_mcp_cache()

    event(
        "mcp",
        "complete",
        action="connect",
    )

    return {
        "success": True,
        "server": result,
    }


async def connect_github_mcp(token: str) -> dict:
    return await _connect_token(
        "github",
        token,
    )


async def connect_local_mcp() -> dict:
    """Attach the bundled diagnostic server to the active principal.

    Neither the executable nor its arguments are user input.
    """
    return await _connect_token_server(
        "local",
        {
            "transport": "stdio",
            "command": sys.executable,
            "args": [
                str(
                    Path(__file__).with_name(
                        "mcp_server.py"
                    )
                )
            ],
            "env": {
                "PYTHON_DOTENV_DISABLED": "1",
            },
        },
    )


async def disconnect_local_mcp() -> dict:
    return _disconnect_runtime_server(
        "local",
    )


async def connect_notion_mcp(token: str) -> dict:
    return await _connect_token(
        "notion",
        token,
    )


async def connect_stripe_mcp(secret_key: str) -> dict:
    return await _connect_token(
        "stripe",
        secret_key,
    )


async def _connect_token(
    server_id: str,
    token: str,
) -> dict:
    _state()

    builders = {
        "github": _github_connection,
        "notion": _notion_connection,
        "stripe": _stripe_connection,
    }

    try:
        config = builders[server_id](
            token.strip()
        )
    except ValueError:
        return {
            "success": False,
            "error": "Invalid connector credential format.",
        }

    result = await _connect_token_server(
        server_id,
        config,
    )

    if result.get("success"):
        try:
            epoch = _state().epochs[server_id]

            save_record(
                server_id,
                "token",
                {"token": token.strip()},
                epoch,
            )

        except (CredentialStoreError, KeyError):
            _disconnect_runtime_server(server_id)

            return {
                "success": False,
                "error": CONNECTION_ERROR,
            }

    return result


def _disconnect_runtime_server(
    server_id: str,
) -> dict:
    state = _state()

    with state.lock:
        usage_limits.store.connector_epoch(
            server_id,
            advance=True,
        )

        existed = (
            state.connections.pop(
                server_id,
                None,
            )
            is not None
        )

        state.epochs.pop(
            server_id,
            None,
        )
        try:
            invalidate_record(server_id)
        except CredentialStoreError:
            state.errors[server_id] = CONNECTION_ERROR
        state.errors.pop(
            server_id,
            None,
        )

        cancel_pending_approvals(server_id)
        clear_mcp_cache()
        _cancel_sessions(
            state,
            server_id,
        )

    event(
        "mcp",
        "complete",
        action="disconnect",
        count=int(existed),
    )

    return {
        "success": True,
        "disconnected": existed,
    }


async def disconnect_github_mcp() -> dict:
    return _disconnect_runtime_server(
        "github",
    )


async def disconnect_notion_mcp() -> dict:
    return _disconnect_runtime_server(
        "notion",
    )


async def disconnect_stripe_mcp() -> dict:
    return _disconnect_runtime_server(
        "stripe",
    )


async def disconnect_google_drive_mcp() -> dict:
    disconnect_oauth_provider(
        "google-drive",
    )
    _disconnect_runtime_server(
        "google-drive",
    )
    return {
        "success": True,
        "disconnected": True,
    }


async def disconnect_slack_mcp() -> dict:
    disconnect_oauth_provider(
        "slack",
    )
    _disconnect_runtime_server(
        "slack",
    )
    return {
        "success": True,
        "disconnected": True,
    }


def get_mcp_catalog() -> list[dict]:
    connections = _state().connections

    entries = [
        (
            "github",
            "Development",
            "token",
            "GitHub access token",
            "Work with repositories, issues, pull requests and GitHub workflows.",
        ),
        (
            "notion",
            "Knowledge",
            "token",
            "Notion integration token",
            "Search, read and work with Notion pages and databases.",
        ),
        (
            "stripe",
            "Payments",
            "token",
            "Stripe restricted key",
            "Work with customers, payments, products and Stripe billing.",
        ),
        (
            "google-drive",
            "Storage",
            "oauth",
            None,
            "Search and work with files stored in Google Drive.",
        ),
        (
            "slack",
            "Communication",
            "oauth",
            None,
            "Search messages, read channels, files and perform Slack actions.",
        ),
    ]

    return [
        {
            "id": name,
            "name": _server_name(name),
            "description": description,
            "category": category,
            "auth": auth,
            "available": True,
            "configured": (
                is_oauth_connected(name)
                if auth == "oauth"
                else name in connections
            ),
            **(
                {"credential_label": label}
                if label
                else {}
            ),
        }
        for name, category, auth, label, description in entries
    ]
