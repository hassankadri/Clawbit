import asyncio
import base64
import hashlib
import json
import os
import secrets
import time

from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


# =========================================================
# CONFIG
# =========================================================

STATE_TTL_SECONDS = 600

TOKEN_EXPIRY_SKEW_SECONDS = 60


GOOGLE_AUTH_URL = (
    "https://accounts.google.com/o/oauth2/v2/auth"
)

GOOGLE_TOKEN_URL = (
    "https://oauth2.googleapis.com/token"
)


SLACK_AUTH_URL = (
    "https://slack.com/oauth/v2_user/authorize"
)

SLACK_TOKEN_URL = (
    "https://slack.com/api/oauth.v2.user.access"
)


# =========================================================
# GOOGLE DRIVE SCOPE
# =========================================================

GOOGLE_DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
]


# =========================================================
# SLACK MCP SCOPES
# =========================================================

SLACK_SCOPES = [
    "search:read.public",
    "search:read.private",
    "search:read.mpim",
    "search:read.im",
    "search:read.files",
    "files:read",
    "files:write",
    "emoji:read",
    "search:read.users",
    "chat:write",
    "channels:history",
    "groups:history",
    "mpim:history",
    "im:history",
    "channels:read",
    "groups:read",
    "im:read",
    "mpim:read",
    "reactions:read",
    "reactions:write",
    "users:read",
    "users:read.email",
]


# =========================================================
# IN-MEMORY STORAGE
# =========================================================

_oauth_states: dict[
    str,
    dict,
] = {}


_oauth_tokens: dict[
    str,
    dict,
] = {}


# =========================================================
# URL HELPERS
# =========================================================

def _backend_url() -> str:
    return (
        os.getenv(
            "CLAWBIT_PUBLIC_BACKEND_URL",
            "http://127.0.0.1:8000",
        )
        .strip()
        .rstrip("/")
    )


def _frontend_url() -> str:
    return (
        os.getenv(
            "CLAWBIT_FRONTEND_URL",
            "http://localhost:3000",
        )
        .strip()
        .rstrip("/")
    )


def get_frontend_url() -> str:
    return _frontend_url()


def _google_redirect_uri() -> str:
    return (
        f"{_backend_url()}"
        "/mcp/oauth/google-drive/callback"
    )


def _slack_redirect_uri() -> str:
    return (
        f"{_backend_url()}"
        "/mcp/oauth/slack/callback"
    )


# =========================================================
# ENV HELPERS
# =========================================================

def _require_env(
    name: str,
) -> str:
    value = (
        os.getenv(
            name,
        )
        or ""
    ).strip()

    if not value:
        raise RuntimeError(
            f"{name} is not configured."
        )

    return value


# =========================================================
# PKCE
# =========================================================

def _create_pkce() -> tuple[
    str,
    str,
]:
    verifier = (
        secrets.token_urlsafe(
            64
        )
    )

    digest = hashlib.sha256(
        verifier.encode(
            "utf-8"
        )
    ).digest()

    challenge = (
        base64.urlsafe_b64encode(
            digest
        )
        .decode(
            "utf-8"
        )
        .rstrip("=")
    )

    return (
        verifier,
        challenge,
    )


# =========================================================
# STATE
# =========================================================

def _create_state(
    provider: str,
    redirect_uri: str,
    verifier: str,
) -> str:
    state = (
        secrets.token_urlsafe(
            32
        )
    )

    _oauth_states[
        state
    ] = {
        "provider":
            provider,

        "redirect_uri":
            redirect_uri,

        "verifier":
            verifier,

        "created_at":
            time.time(),
    }

    return state


def _consume_state(
    state: str,
    provider: str,
) -> dict:
    record = (
        _oauth_states.pop(
            state,
            None,
        )
    )

    if not record:
        raise RuntimeError(
            "Invalid or expired OAuth state."
        )

    if (
        record.get(
            "provider"
        )
        != provider
    ):
        raise RuntimeError(
            "OAuth provider mismatch."
        )

    created_at = float(
        record.get(
            "created_at",
            0,
        )
    )

    if (
        time.time()
        - created_at
        > STATE_TTL_SECONDS
    ):
        raise RuntimeError(
            "OAuth request expired. Try connecting again."
        )

    return record


# =========================================================
# HTTP
# =========================================================

def _post_form_sync(
    url: str,
    data: dict,
    *,
    basic_auth:
        tuple[
            str,
            str,
        ]
        | None = None,
) -> dict:
    encoded = urlencode(
        data
    ).encode(
        "utf-8"
    )

    headers = {
        "Content-Type":
            "application/x-www-form-urlencoded",

        "Accept":
            "application/json",
    }

    if basic_auth:
        username, password = (
            basic_auth
        )

        credential = (
            f"{username}:{password}"
        )

        encoded_auth = (
            base64.b64encode(
                credential.encode(
                    "utf-8"
                )
            )
            .decode(
                "utf-8"
            )
        )

        headers[
            "Authorization"
        ] = (
            f"Basic {encoded_auth}"
        )

    request = Request(
        url,

        data=
            encoded,

        headers=
            headers,

        method=
            "POST",
    )

    try:
        with urlopen(
            request,
            timeout=20,
        ) as response:
            body = (
                response
                .read()
                .decode(
                    "utf-8"
                )
            )

    except HTTPError as exc:
        try:
            body = (
                exc.read()
                .decode(
                    "utf-8"
                )
            )

        except Exception:
            body = str(
                exc
            )

        raise RuntimeError(
            body
            or "OAuth request failed."
        ) from exc

    except URLError as exc:
        raise RuntimeError(
            f"OAuth provider could not be reached: {exc}"
        ) from exc

    try:
        parsed = json.loads(
            body
        )

    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "OAuth provider returned an invalid response."
        ) from exc

    if not isinstance(
        parsed,
        dict,
    ):
        raise RuntimeError(
            "OAuth provider returned an invalid response."
        )

    return parsed


async def _post_form(
    url: str,
    data: dict,
    *,
    basic_auth:
        tuple[
            str,
            str,
        ]
        | None = None,
) -> dict:
    return await asyncio.to_thread(
        _post_form_sync,
        url,
        data,
        basic_auth=
            basic_auth,
    )


# =========================================================
# TOKEN STORE
# =========================================================

def _save_token(
    provider: str,
    payload: dict,
) -> None:
    expires_in = (
        payload.get(
            "expires_in"
        )
    )

    expires_at = None

    if isinstance(
        expires_in,
        (
            int,
            float,
        ),
    ):
        expires_at = (
            time.time()
            + float(
                expires_in
            )
        )

    _oauth_tokens[
        provider
    ] = {
        **payload,

        "expires_at":
            expires_at,
    }


def get_oauth_token_record(
    provider: str,
) -> dict | None:
    token = (
        _oauth_tokens.get(
            provider
        )
    )

    if not token:
        return None

    return dict(
        token
    )


def disconnect_oauth_provider(
    provider: str,
) -> None:
    _oauth_tokens.pop(
        provider,
        None,
    )


def is_oauth_connected(
    provider: str,
) -> bool:
    return (
        provider
        in _oauth_tokens
    )


# =========================================================
# GOOGLE DRIVE START
# =========================================================

def start_google_drive_oauth() -> dict:
    client_id = (
        _require_env(
            "GOOGLE_MCP_CLIENT_ID"
        )
    )

    _require_env(
        "GOOGLE_MCP_CLIENT_SECRET"
    )

    redirect_uri = (
        _google_redirect_uri()
    )

    (
        verifier,
        challenge,
    ) = _create_pkce()

    state = _create_state(
        "google-drive",
        redirect_uri,
        verifier,
    )

    params = {
        "client_id":
            client_id,

        "redirect_uri":
            redirect_uri,

        "response_type":
            "code",

        "scope":
            " ".join(
                GOOGLE_DRIVE_SCOPES
            ),

        "access_type":
            "offline",

        "include_granted_scopes":
            "true",

        "prompt":
            "consent",

        "state":
            state,

        "code_challenge":
            challenge,

        "code_challenge_method":
            "S256",
    }

    return {
        "authorization_url":
            (
                f"{GOOGLE_AUTH_URL}"
                f"?{urlencode(params)}"
            ),

        "provider":
            "google-drive",
    }


# =========================================================
# GOOGLE DRIVE CALLBACK
# =========================================================

async def complete_google_drive_oauth(
    *,
    code: str,
    state: str,
) -> dict:
    state_record = (
        _consume_state(
            state,
            "google-drive",
        )
    )

    client_id = (
        _require_env(
            "GOOGLE_MCP_CLIENT_ID"
        )
    )

    client_secret = (
        _require_env(
            "GOOGLE_MCP_CLIENT_SECRET"
        )
    )

    payload = await _post_form(
        GOOGLE_TOKEN_URL,

        {
            "code":
                code,

            "client_id":
                client_id,

            "client_secret":
                client_secret,

            "redirect_uri":
                state_record[
                    "redirect_uri"
                ],

            "grant_type":
                "authorization_code",

            "code_verifier":
                state_record[
                    "verifier"
                ],
        },
    )

    access_token = (
        payload.get(
            "access_token"
        )
    )

    if not access_token:
        raise RuntimeError(
            payload.get(
                "error_description"
            )
            or payload.get(
                "error"
            )
            or "Google did not return an access token."
        )

    _save_token(
        "google-drive",
        payload,
    )

    return {
        "success":
            True,

        "provider":
            "google-drive",
    }


# =========================================================
# GOOGLE TOKEN REFRESH
# =========================================================

async def _refresh_google_drive_token(
    token_record: dict,
) -> str:
    refresh_token = (
        token_record.get(
            "refresh_token"
        )
    )

    if not refresh_token:
        raise RuntimeError(
            "Google session expired. Reconnect Google Drive."
        )

    payload = await _post_form(
        GOOGLE_TOKEN_URL,

        {
            "client_id":
                _require_env(
                    "GOOGLE_MCP_CLIENT_ID"
                ),

            "client_secret":
                _require_env(
                    "GOOGLE_MCP_CLIENT_SECRET"
                ),

            "refresh_token":
                refresh_token,

            "grant_type":
                "refresh_token",
        },
    )

    access_token = (
        payload.get(
            "access_token"
        )
    )

    if not access_token:
        raise RuntimeError(
            "Google Drive token refresh failed."
        )

    payload[
        "refresh_token"
    ] = refresh_token

    _save_token(
        "google-drive",
        payload,
    )

    return str(
        access_token
    )


async def get_google_drive_access_token() -> (
    str | None
):
    token_record = (
        get_oauth_token_record(
            "google-drive"
        )
    )

    if not token_record:
        return None

    access_token = (
        token_record.get(
            "access_token"
        )
    )

    if not access_token:
        return None

    expires_at = (
        token_record.get(
            "expires_at"
        )
    )

    if (
        isinstance(
            expires_at,
            (
                int,
                float,
            ),
        )
        and time.time()
        >= (
            float(
                expires_at
            )
            - TOKEN_EXPIRY_SKEW_SECONDS
        )
    ):
        return await _refresh_google_drive_token(
            token_record
        )

    return str(
        access_token
    )


# =========================================================
# SLACK START
# =========================================================

def start_slack_oauth() -> dict:
    client_id = _require_env(
        "SLACK_MCP_CLIENT_ID"
    )

    _require_env(
        "SLACK_MCP_CLIENT_SECRET"
    )

    redirect_uri = (
        _slack_redirect_uri()
    )

    # Slack requires HTTPS for this callback
    # in our current local setup.
    if not redirect_uri.startswith(
        "https://"
    ):
        raise RuntimeError(
            "Slack OAuth requires an HTTPS callback. "
            "Set CLAWBIT_PUBLIC_BACKEND_URL "
            "to your HTTPS ngrok URL."
        )

    state = _create_state(
        "slack",
        redirect_uri,
        "",
    )

    params = {
        "client_id":
            client_id,

        "redirect_uri":
            redirect_uri,

        "scope":
            ",".join(
                SLACK_SCOPES
            ),

        "state":
            state,
    }

    return {
        "authorization_url":
            (
                f"{SLACK_AUTH_URL}"
                f"?{urlencode(params)}"
            ),

        "provider":
            "slack",
    }


# =========================================================
# SLACK CALLBACK
# =========================================================

async def complete_slack_oauth(
    *,
    code: str,
    state: str,
) -> dict:
    state_record = _consume_state(
        state,
        "slack",
    )

    client_id = _require_env(
        "SLACK_MCP_CLIENT_ID"
    )

    client_secret = _require_env(
        "SLACK_MCP_CLIENT_SECRET"
    )

    payload = await _post_form(
        SLACK_TOKEN_URL,

        {
            "code":
                code,

            "redirect_uri":
                state_record[
                    "redirect_uri"
                ],

            "grant_type":
                "authorization_code",
        },

        basic_auth=(
            client_id,
            client_secret,
        ),
    )

    if (
        payload.get(
            "ok"
        )
        is False
    ):
        raise RuntimeError(
            payload.get(
                "error",
                "Slack OAuth failed.",
            )
        )

    access_token = (
        payload.get(
            "access_token"
        )
    )

    if not access_token:
        raise RuntimeError(
            "Slack did not return a user access token."
        )

    _save_token(
        "slack",
        payload,
    )

    return {
        "success":
            True,

        "provider":
            "slack",

        "team":
            payload.get(
                "team"
            ),
    }


def get_slack_access_token() -> (
    str | None
):
    token_record = (
        get_oauth_token_record(
            "slack"
        )
    )

    if not token_record:
        return None

    token = (
        token_record.get(
            "access_token"
        )
    )

    if not token:
        return None

    return str(
        token
    )


# =========================================================
# STATUS
# =========================================================

def get_oauth_status() -> dict:
    return {
        "google-drive":
            {
                "connected":
                    is_oauth_connected(
                        "google-drive"
                    ),
            },

        "slack":
            {
                "connected":
                    is_oauth_connected(
                        "slack"
                    ),
            },
    }