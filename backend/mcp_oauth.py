"""Memory-only OAuth credentials bound to principal, session and connection epoch."""

import asyncio
import base64
from collections.abc import Callable
import hashlib
import json
import math
import os
import secrets
from threading import Lock, RLock
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from ownership import current_owner, require_active_owner
from usage_limits import limited
import usage_limits

STATE_TTL_SECONDS = 600
TOKEN_EXPIRY_SKEW_SECONDS = 60
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
SLACK_AUTH_URL = "https://slack.com/oauth/v2_user/authorize"
SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.user.access"
OAUTH_ERROR = "Connector credentials expired or authorization failed. Reconnect and try again."

GOOGLE_DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
]
SLACK_SCOPES = [
    "search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
    "search:read.files", "files:read", "files:write", "emoji:read", "search:read.users",
    "chat:write", "channels:history", "groups:history", "mpim:history", "im:history",
    "channels:read", "groups:read", "im:read", "mpim:read", "reactions:read",
    "reactions:write", "users:read", "users:read.email",
]

_oauth_states: dict[str, dict] = {}
_oauth_tokens: dict[tuple[str, str], dict] = {}
_oauth_versions: dict[tuple[str, str], int] = {}
_refresh_locks: dict[tuple[str, str], Lock] = {}
_store_lock = RLock()


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise RuntimeError(OAUTH_ERROR)


def _key(provider: str) -> tuple[str, str]:
    return require_active_owner(), provider


def _backend_url(request_origin: str | None = None) -> str:
    default = request_origin or "http://127.0.0.1:8000"
    return os.getenv("CLAWBIT_PUBLIC_BACKEND_URL", default).strip().rstrip("/")


def _frontend_url() -> str:
    return os.getenv("CLAWBIT_FRONTEND_URL", "http://localhost:3000").strip().rstrip("/")


def get_frontend_url() -> str:
    return _frontend_url()


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not configured.")
    return value


def _create_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return verifier, base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _create_state(
    provider: str, redirect_uri: str, verifier: str, session_id: str,
    frontend_url: str | None = None,
) -> str:
    key = _key(provider)
    if not session_id:
        raise RuntimeError("An authenticated session is required.")
    now = time.time()
    with _store_lock:
        expired = [state for state, record in _oauth_states.items()
                   if now - record["created_at"] > STATE_TTL_SECONDS]
        for state in expired:
            _oauth_states.pop(state, None)
        if sum(record["principal"] == key[0] for record in _oauth_states.values()) >= 32:
            raise RuntimeError("Too many pending connections. Try again later.")
        state = secrets.token_urlsafe(32)
        _oauth_states[state] = {
            "principal": key[0], "provider": provider, "session_id": session_id,
            "version": _oauth_versions.get(key, 0), "redirect_uri": redirect_uri,
            "connection_epoch": usage_limits.store.connector_epoch(provider),
            "verifier": verifier, "created_at": now,
            "frontend_url": frontend_url or _frontend_url(),
        }
    return state


def _consume_state(state: str, provider: str, session_id: str) -> dict:
    key = _key(provider)
    with _store_lock:
        record = _oauth_states.pop(state, None)
        if (not record or not session_id or record["session_id"] != session_id
                or record["principal"] != key[0] or record["provider"] != provider
                or time.time() - record["created_at"] > STATE_TTL_SECONDS
                or record["connection_epoch"] != usage_limits.store.connector_epoch(provider)
                or record["version"] != _oauth_versions.get(key, 0)):
            raise RuntimeError("Invalid or expired OAuth state.")
    return record


def discard_oauth_state(state: str, provider: str, session_id: str) -> None:
    """A denied or canceled callback consumes its state without changing tokens."""
    try:
        _consume_state(state, provider, session_id)
    except RuntimeError:
        pass


def _post_form_sync(url: str, data: dict, *, basic_auth: tuple[str, str] | None = None) -> dict:
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    if basic_auth:
        credential = base64.b64encode(":".join(basic_auth).encode()).decode("ascii")
        headers["Authorization"] = f"Basic {credential}"
    request = Request(url, data=urlencode(data).encode(), headers=headers, method="POST")
    try:
        with build_opener(_NoRedirects()).open(request, timeout=20) as response:
            parsed = json.loads(response.read(1024 * 1024))
    except (HTTPError, URLError, ValueError, OSError):
        # Provider response bodies can contain codes and tokens; never propagate them.
        raise RuntimeError(OAUTH_ERROR) from None
    if not isinstance(parsed, dict):
        raise RuntimeError(OAUTH_ERROR)
    return parsed


async def _post_form(url: str, data: dict, *, basic_auth: tuple[str, str] | None = None) -> dict:
    return await asyncio.to_thread(_post_form_sync, url, data, basic_auth=basic_auth)


def _save_token(
    provider: str, payload: dict, *, expected_version: int | None = None,
    expected_epoch: int | None = None, refreshing: bool = False,
) -> None:
    key = _key(provider)
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token.strip():
        raise RuntimeError(OAUTH_ERROR)
    expires_in = payload.get("expires_in")
    if expires_in is not None and (
        isinstance(expires_in, bool) or not isinstance(expires_in, (int, float))
        or not math.isfinite(expires_in)
    ):
        raise RuntimeError(OAUTH_ERROR)
    expires_at = time.time() + float(expires_in) if isinstance(expires_in, (int, float)) else None
    with _store_lock:
        if expected_version is not None and _oauth_versions.get(key, 0) != expected_version:
            raise RuntimeError(OAUTH_ERROR)
        epoch = usage_limits.store.connector_epoch(
            provider, advance=not refreshing, expected=expected_epoch,
        )
        _oauth_versions[key] = _oauth_versions.get(key, 0) + 1
        _oauth_tokens[key] = {
            "access_token": access_token, "refresh_token": payload.get("refresh_token"),
            "expires_at": expires_at,
            "connection_epoch": epoch,
        }


def get_oauth_token_record(provider: str) -> dict | None:
    with _store_lock:
        key = _key(provider)
        record = _oauth_tokens.get(key)
        if record and record["connection_epoch"] != usage_limits.store.connector_epoch(provider):
            _oauth_tokens.pop(key, None)
            _oauth_versions[key] = _oauth_versions.get(key, 0) + 1
            return None
        return dict(record) if record else None


def disconnect_oauth_provider(provider: str) -> None:
    key = _key(provider)
    with _store_lock:
        usage_limits.store.connector_epoch(provider, advance=True)
        _oauth_versions[key] = _oauth_versions.get(key, 0) + 1
        _oauth_tokens.pop(key, None)
        for state, record in list(_oauth_states.items()):
            if (record["principal"], record["provider"]) == key:
                _oauth_states.pop(state, None)


def is_oauth_connected(provider: str) -> bool:
    record = get_oauth_token_record(provider)
    if not record:
        return False
    expires = record.get("expires_at")
    if expires is not None and time.time() >= expires - TOKEN_EXPIRY_SKEW_SECONDS:
        if provider != "google-drive" or not record.get("refresh_token"):
            disconnect_oauth_provider(provider)
            return False
    return True


@limited("mcp")
def start_google_drive_oauth(
    session_id: str, *, backend_url: str | None = None, frontend_url: str | None = None,
) -> dict:
    client_id = _require_env("GOOGLE_MCP_CLIENT_ID")
    _require_env("GOOGLE_MCP_CLIENT_SECRET")
    redirect_uri = f"{_backend_url(backend_url)}/mcp/oauth/google-drive/callback"
    verifier, challenge = _create_pkce()
    state = _create_state("google-drive", redirect_uri, verifier, session_id, frontend_url)
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
              "scope": " ".join(GOOGLE_DRIVE_SCOPES), "access_type": "offline",
              "include_granted_scopes": "true", "prompt": "consent", "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256"}
    return {"authorization_url": f"{GOOGLE_AUTH_URL}?{urlencode(params)}", "provider": "google-drive"}


@limited("mcp")
def start_slack_oauth(
    session_id: str, *, backend_url: str | None = None, frontend_url: str | None = None,
) -> dict:
    client_id = _require_env("SLACK_MCP_CLIENT_ID")
    _require_env("SLACK_MCP_CLIENT_SECRET")
    redirect_uri = f"{_backend_url(backend_url)}/mcp/oauth/slack/callback"
    if not redirect_uri.startswith("https://"):
        raise RuntimeError(
            "Slack OAuth requires an HTTPS callback. Configure CLAWBIT_PUBLIC_BACKEND_URL."
        )
    state = _create_state("slack", redirect_uri, "", session_id, frontend_url)
    params = {"client_id": client_id, "redirect_uri": redirect_uri,
              "scope": ",".join(SLACK_SCOPES), "state": state}
    return {"authorization_url": f"{SLACK_AUTH_URL}?{urlencode(params)}", "provider": "slack"}


def _validate_completion(provider: str, record: dict, validate_session: Callable[[], bool]) -> None:
    if current_owner() != record["principal"] or not validate_session():
        raise RuntimeError("The initiating session has expired. Connect again.")
    if _oauth_versions.get(_key(provider), 0) != record["version"]:
        raise RuntimeError(OAUTH_ERROR)
    usage_limits.store.connector_epoch(provider, expected=record["connection_epoch"])


@limited("mcp")
async def complete_google_drive_oauth(
    *, code: str, state: str, session_id: str, validate_session: Callable[[], bool],
) -> dict:
    record = _consume_state(state, "google-drive", session_id)
    _validate_completion("google-drive", record, validate_session)
    payload = await _post_form(GOOGLE_TOKEN_URL, {
        "code": code, "client_id": _require_env("GOOGLE_MCP_CLIENT_ID"),
        "client_secret": _require_env("GOOGLE_MCP_CLIENT_SECRET"),
        "redirect_uri": record["redirect_uri"], "grant_type": "authorization_code",
        "code_verifier": record["verifier"],
    })
    with _store_lock:
        _validate_completion("google-drive", record, validate_session)
        _save_token(
            "google-drive", payload, expected_version=record["version"],
            expected_epoch=record["connection_epoch"],
        )
    return {"frontend_url": record["frontend_url"], "success": True, "provider": "google-drive"}


@limited("mcp")
async def complete_slack_oauth(
    *, code: str, state: str, session_id: str, validate_session: Callable[[], bool],
) -> dict:
    record = _consume_state(state, "slack", session_id)
    _validate_completion("slack", record, validate_session)
    payload = await _post_form(SLACK_TOKEN_URL, {
        "code": code, "redirect_uri": record["redirect_uri"], "grant_type": "authorization_code",
    }, basic_auth=(_require_env("SLACK_MCP_CLIENT_ID"), _require_env("SLACK_MCP_CLIENT_SECRET")))
    if payload.get("ok") is False:
        raise RuntimeError(OAUTH_ERROR)
    with _store_lock:
        _validate_completion("slack", record, validate_session)
        _save_token(
            "slack", payload, expected_version=record["version"],
            expected_epoch=record["connection_epoch"],
        )
    return {"frontend_url": record["frontend_url"], "success": True, "provider": "slack"}


@limited("mcp")
async def get_google_drive_access_token() -> str | None:
    key = _key("google-drive")
    with _store_lock:
        lock = _refresh_locks.setdefault(key, Lock())
    # A thread lock also works across TestClient loops and sync disconnects;
    # nonblocking acquisition keeps cancellation responsive while waiting.
    while not lock.acquire(blocking=False):
        await asyncio.sleep(0.01)
    try:
        record = get_oauth_token_record("google-drive")
        if not record:
            return None
        expires = record.get("expires_at")
        if expires is None or time.time() < expires - TOKEN_EXPIRY_SKEW_SECONDS:
            return record["access_token"]
        version = _oauth_versions.get(key, 0)
        try:
            if not record.get("refresh_token"):
                raise RuntimeError(OAUTH_ERROR)
            payload = await _post_form(GOOGLE_TOKEN_URL, {
                "client_id": _require_env("GOOGLE_MCP_CLIENT_ID"),
                "client_secret": _require_env("GOOGLE_MCP_CLIENT_SECRET"),
                "refresh_token": record["refresh_token"], "grant_type": "refresh_token",
            })
            payload["refresh_token"] = payload.get("refresh_token") or record["refresh_token"]
            _save_token(
                "google-drive", payload, expected_version=version,
                expected_epoch=record["connection_epoch"], refreshing=True,
            )
            return payload["access_token"]
        except Exception:
            with _store_lock:
                if (
                    _oauth_versions.get(key, 0) == version
                    and usage_limits.store.connector_epoch("google-drive")
                    == record["connection_epoch"]
                ):
                    disconnect_oauth_provider("google-drive")
            raise RuntimeError(OAUTH_ERROR) from None
    finally:
        lock.release()


def get_slack_access_token() -> str | None:
    if not is_oauth_connected("slack"):
        return None
    record = get_oauth_token_record("slack")
    return record["access_token"] if record else None


def get_oauth_status() -> dict:
    return {provider: {"connected": is_oauth_connected(provider)}
            for provider in ("google-drive", "slack")}
