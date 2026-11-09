
"""Cookie authentication, CSRF enforcement and public sign-in endpoints."""

from dataclasses import dataclass
import ipaddress
import hmac
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from auth_store import (
    AccountAlreadyExists,
    AdministratorNotInitialized,
    AuthStore,
    LoginThrottled,
    OwnerAlreadyInitialized,
    OwnerSetupError,
    PreSessionThrottled,
    PRESESSION_SECONDS,
    SESSION_SECONDS,
    Session,
    SetupThrottled,
    SignupThrottled,
    SetupTokenInvalid,
    csrf_token,
)
from ownership import owner_context
from chat_execution import run_chat_request
from usage_limits import UsageLimitError, operation_budget, request_budget
from observability import event
from turnstile_security import verify_turnstile


def _is_private_lan_host(hostname: str) -> bool:
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False

    return (
        address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_unspecified
    )


@dataclass(frozen=True)
class AuthSettings:
    """Use insecure cookies only for explicitly local development hosts."""

    origins: tuple[str, ...]
    secure: bool = False
    allow_lan_dev: bool = False

    @property
    def cookie_name(self) -> str:
        return "__Host-clawbit_session" if self.secure else "clawbit_session"

    @classmethod
    def from_environment(cls) -> "AuthSettings":
        mode = os.getenv("CLAWBIT_AUTH_MODE", "local")
        if mode not in {"local", "production"}:
            raise ValueError("CLAWBIT_AUTH_MODE must be local or production.")

        secure = mode == "production"
        allow_lan_dev = os.getenv(
            "CLAWBIT_ALLOW_LAN_DEV", ""
        ).lower() in {"1", "true", "yes"}

        if secure and allow_lan_dev:
            raise ValueError(
                "CLAWBIT_ALLOW_LAN_DEV cannot be enabled in production."
            )

        raw_origins = os.getenv("CLAWBIT_ALLOWED_ORIGINS", "")
        if secure and not raw_origins:
            raise ValueError(
                "Production requires explicit CLAWBIT_ALLOWED_ORIGINS."
            )

        origins = tuple(
            part.strip()
            for part in (
                raw_origins or "http://localhost:3000,http://127.0.0.1:3000"
            ).split(",")
        )

        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.path
                or parsed.query
                or parsed.fragment
                or "*" in origin
                or (secure and parsed.scheme != "https")
                or (
                    not secure
                    and parsed.hostname not in {
                        "localhost", "127.0.0.1", "::1"
                    }
                    and not (
                        allow_lan_dev
                        and _is_private_lan_host(parsed.hostname)
                    )
                )
            ):
                raise ValueError(
                    "Allowed origins must be exact, trusted web origins."
                )
        return cls(
            origins=origins,
            secure=secure,
            allow_lan_dev=allow_lan_dev,
        )


def auth_database_path() -> Path:
    root = Path(
        os.getenv(
            "CLAWBIT_RUNTIME_DIR",
            Path(__file__).resolve().parent,
        )
    )
    return root / "data" / "auth.sqlite3"


def create_auth_store():
    """Select durable Postgres for deployed mode, SQLite for local development."""
    backend = os.getenv("CLAWBIT_PERSISTENCE_BACKEND", "sqlite").strip().lower()

    if backend == "postgres":
        from postgres_auth_store import PostgresAuthStore

        return PostgresAuthStore()

    if backend == "sqlite":
        return AuthStore(auth_database_path())

    raise ValueError("CLAWBIT_PERSISTENCE_BACKEND must be sqlite or postgres.")


def _failure(status: int, message: str) -> JSONResponse:
    category = {
        "Origin is not allowed.": "origin",
        "Session verification failed. Reload and try again.": "csrf",
        "HTTPS is required.": "transport",
        "Remote access requires production authentication settings.": "transport",
        "Too many sign-in attempts. Try again in a minute.": "rate",
        "Too many session requests. Try again in a minute.": "rate",
        "Too many account creation attempts. Try again later.": "rate",
        "Too many setup attempts. Try again in a minute.": "rate",
        "Complete the signup security check and try again.": "bot_challenge",
        "The signup security check failed. Complete it again.": "bot_challenge",
        "Account registration is temporarily unavailable.": "configuration",
    }.get(message, "authentication")

    event(
        "auth",
        "denied",
        status_code=status,
        category=category,
    )

    return JSONResponse(
        {"detail": message},
        status_code=status,
        headers={"Cache-Control": "no-store"},
    )


class MCPApprovalDecision(BaseModel):
    approve: bool


class AuthenticationMiddleware:
    """Deny protected requests before bodies or streaming are consumed."""

    def __init__(
        self,
        app: ASGIApp,
        application: FastAPI,
        settings: AuthSettings,
    ):
        self.app = app
        self.application = application
        self.settings = settings

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return

        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        settings = self.settings

        if settings.secure and request.url.scheme != "https":
            await _failure(
                403, "HTTPS is required."
            )(scope, receive, send)
            return

        if (
            not settings.secure
            and request.url.hostname not in {
                "localhost", "127.0.0.1", "::1"
            }
            and not (
                settings.allow_lan_dev
                and _is_private_lan_host(request.url.hostname or "")
            )
        ):
            await _failure(
                403,
                "Remote access requires production authentication settings.",
            )(scope, receive, send)
            return

        origin = request.headers.get("origin")
        if origin is not None and origin not in settings.origins:
            await _failure(
                403, "Origin is not allowed."
            )(scope, receive, send)
            return

        store: AuthStore = self.application.state.auth_store
        token = request.cookies.get(settings.cookie_name, "")
        session = await run_in_threadpool(store.lookup, token)
        scope.setdefault("state", {})["auth_session"] = session

        # First-owner setup is the only additional anonymous mutation.
        # It requires an existing anonymous pre-session; the normal CSRF
        # validation below must also succeed.
        setup_bootstrap = (
            request.method == "POST"
            and request.url.path == "/auth/setup"
            and session is not None
            and session.username is None
            and session.principal_id is None
        )

        register_bootstrap = (
            request.method == "POST"
            and request.url.path == "/auth/register"
            and session is not None
            and session.username is None
            and session.principal_id is None
        )

        public = (
            (request.method, request.url.path) in {
                ("GET", "/"),
                ("GET", "/auth/session"),
                ("POST", "/auth/login"),
            }
            or setup_bootstrap
            or register_bootstrap
        )

        if not public and (
            session is None
            or session.username is None
            or session.principal_id is None
        ):
            await _failure(
                401, "Sign in to continue."
            )(scope, receive, send)
            return

        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            provided = request.headers.get("x-csrf-token", "")
            if (
                origin not in settings.origins
                or session is None
                or not hmac.compare_digest(
                    provided.encode("utf-8"),
                    csrf_token(token).encode("ascii"),
                )
            ):
                await _failure(
                    403,
                    "Session verification failed. Reload and try again.",
                )(scope, receive, send)
                return

        async def send_private(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend([
                    (b"cache-control", b"no-store"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-content-type-options", b"nosniff"),
                ])
                message = {**message, "headers": headers}
            await send(message)

        downstream_receive = receive
        if (
            request.url.path.startswith(
                ("/mcp/", "/history", "/memories")
            )
            and request.method in {"POST", "PATCH"}
        ):
            received_bytes = 0
            body_limit = (
                4 * 1024 * 1024
                if request.url.path.startswith("/history")
                else 16384
            )

            async def receive_connector_body() -> Message:
                nonlocal received_bytes
                message = await receive()
                received_bytes += len(message.get("body", b""))
                if received_bytes > body_limit:
                    raise HTTPException(
                        413, "Request is too large."
                    )
                return message

            downstream_receive = receive_connector_body

        with owner_context(
            session.principal_id if session else None,
            validate_session=lambda: (
                store.lookup(token) == session and session is not None
            ),
        ):
            operation = None

            if request.url.path in {"/chat", "/chat/stream"}:
                operation = "chat"
            elif request.url.path == "/attachments/upload":
                operation = "upload"
            elif (
                request.url.path.startswith("/mcp/")
                and "/disconnect/" not in request.url.path
                and not request.url.path.startswith("/mcp/approvals")
            ):
                operation = "mcp"

            with request_budget():
                if operation is None:
                    await self.app(
                        scope, downstream_receive, send_private
                    )
                else:
                    try:
                        with operation_budget(operation):
                            if operation == "chat":
                                await run_chat_request(
                                    self.app,
                                    scope,
                                    downstream_receive,
                                    send_private,
                                )
                            else:
                                await self.app(
                                    scope,
                                    downstream_receive,
                                    send_private,
                                )
                    except UsageLimitError as exc:
                        response = JSONResponse(
                            {
                                "detail": str(exc),
                                "retry_after": exc.retry_after,
                            },
                            status_code=429,
                            headers={
                                "Retry-After": str(exc.retry_after)
                            },
                        )
                        await response(
                            scope, receive, send_private
                        )


def _session_response(
    settings: AuthSettings,
    token: str,
    session: Session | None,
    *,
    new_cookie: bool,
    secure_transport: bool,
    setup_required: bool,
) -> JSONResponse:
    username = session.username if session else None
    response = JSONResponse({
        "user": (
            {
                "username": username,
                "email": session.email,
                "role": session.role,
                "principal_id": session.principal_id,
            }
            if username else None
        ),
        "csrf_token": csrf_token(token),
        "expires_at": session.expires_at if session else None,
        "setup_required": setup_required,
    })

    if new_cookie:
        response.set_cookie(
            settings.cookie_name,
            token,
            max_age=(
                SESSION_SECONDS if username else PRESESSION_SECONDS
            ),
            httponly=True,
            secure=settings.secure or secure_transport,
            samesite="lax",
            path="/",
        )
    return response


async def _read_json_object(
    request: Request,
    *,
    error_message: str,
) -> dict | JSONResponse:
    body = bytearray()

    async for chunk in request.stream():
        if len(body) + len(chunk) > 4096:
            return _failure(400, error_message)
        body.extend(chunk)

    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return _failure(400, error_message)

    if not isinstance(payload, dict):
        return _failure(400, error_message)

    return payload


def install_authentication(app: FastAPI) -> None:
    """Install one default-deny boundary for all application routes."""
    settings = AuthSettings.from_environment()
    app.state.auth_settings = settings
    app.state.auth_store = create_auth_store()

    @app.get("/auth/session")
    async def current_session(request: Request) -> JSONResponse:
        store = app.state.auth_store
        token = request.cookies.get(settings.cookie_name, "")
        session = request.state.auth_session
        new_cookie = session is None

        if new_cookie:
            # Read only the transport peer. Do not trust an arbitrary
            # X-Forwarded-For header provided by the browser.
            client_address = (
                request.client.host if request.client else "unknown"
            )
            try:
                token, _ = await run_in_threadpool(
                    store.create_presession,
                    client_address,
                )
            except PreSessionThrottled:
                response = _failure(
                    429,
                    "Too many session requests. Try again in a minute.",
                )
                response.headers["Retry-After"] = "60"
                return response

            session = await run_in_threadpool(
                store.lookup,
                token,
            )

        return _session_response(
            settings,
            token,
            session,
            new_cookie=new_cookie,
            secure_transport=request.url.scheme == "https",
            setup_required=not await run_in_threadpool(store.has_owner),
        )

    @app.post("/auth/setup")
    async def setup_owner(request: Request) -> JSONResponse:
        payload = await _read_json_object(
            request,
            error_message="Invalid account setup request.",
        )
        if isinstance(payload, JSONResponse):
            return payload

        username = payload.get("username")
        password = payload.get("password")
        setup_token = payload.get("setup_token")

        if (
            not isinstance(username, str)
            or not isinstance(password, str)
            or not isinstance(setup_token, str)
            or not 3 <= len(username) <= 64
            or not 15 <= len(password) <= 128
            or len(setup_token) > 128
        ):
            return _failure(400, "Invalid account setup request.")

        try:
            password.encode("utf-8")
        except UnicodeEncodeError:
            return _failure(400, "Invalid account setup request.")

        store = app.state.auth_store
        previous_token = request.cookies.get(settings.cookie_name, "")
        client_address = (
            request.client.host if request.client else "unknown"
        )

        try:
            token, _ = await run_in_threadpool(
                store.create_owner_with_setup_token,
                username,
                password,
                setup_token,
                previous_token,
                client_address,
            )
        except SetupThrottled:
            response = _failure(
                429,
                "Too many setup attempts. Try again in a minute.",
            )
            response.headers["Retry-After"] = "60"
            return response
        except OwnerAlreadyInitialized:
            return _failure(
                409,
                "This Clawbit installation already has an owner.",
            )
        except SetupTokenInvalid:
            return _failure(
                400,
                "The setup token is invalid or expired. Generate a new token on the Clawbit server.",
            )
        except OwnerSetupError as exc:
            return _failure(400, str(exc))

        session = await run_in_threadpool(store.lookup, token)

        return _session_response(
            settings,
            token,
            session,
            new_cookie=True,
            secure_transport=request.url.scheme == "https",
            setup_required=False,
        )

    @app.post("/auth/register")
    async def register(request: Request) -> JSONResponse:
        payload = await _read_json_object(
            request,
            error_message="Invalid account registration request.",
        )
        if isinstance(payload, JSONResponse):
            return payload

        email = payload.get("email")
        password = payload.get("password")
        if (
            not isinstance(email, str)
            or not 3 <= len(email.strip()) <= 254
            or not isinstance(password, str)
            or not 15 <= len(password) <= 128
        ):
            return _failure(400, "Enter a valid email and passphrase.")

        try:
            password.encode("utf-8")
        except UnicodeEncodeError:
            return _failure(400, "Enter a valid email and passphrase.")

        store = app.state.auth_store
        previous_token = request.cookies.get(settings.cookie_name, "")
        client_address = request.client.host if request.client else "unknown"

        # Production signup is closed unless server-side bot verification is
        # configured. Local development remains usable without Cloudflare keys.
        turnstile_secret = os.getenv("CLAWBIT_TURNSTILE_SECRET_KEY", "").strip()
        if settings.secure and not turnstile_secret:
            return _failure(
                503,
                "Account registration is temporarily unavailable.",
            )

        if turnstile_secret:
            turnstile_token = payload.get("turnstile_token")
            if not isinstance(turnstile_token, str) or not turnstile_token:
                return _failure(
                    428,
                    "Complete the signup security check and try again.",
                )

            expected_hostnames = {
                parsed.hostname
                for parsed in (urlsplit(origin) for origin in settings.origins)
                if parsed.hostname
            }
            is_verified = await run_in_threadpool(
                verify_turnstile,
                turnstile_token,
                turnstile_secret,
                expected_hostnames=expected_hostnames,
                expected_action=(
                    "test"
                    if os.getenv(
                        "CLAWBIT_TURNSTILE_TEST_MODE", ""
                    ).lower() in {"1", "true", "yes"}
                    else "signup"
                ),
                remote_ip=client_address,
            )
            if not is_verified:
                return _failure(
                    422,
                    "The signup security check failed. Complete it again.",
                )

        try:
            token, _ = await run_in_threadpool(
                store.register_user,
                email,
                password,
                previous_token,
                client_address,
            )
        except AdministratorNotInitialized:
            return _failure(
                503,
                "Clawbit administrator setup is required before public registration is enabled.",
            )
        except SignupThrottled:
            response = _failure(
                429,
                "Too many account creation attempts. Try again later.",
            )
            response.headers["Retry-After"] = "3600"
            return response
        except AccountAlreadyExists:
            # Keep both the status and message indistinguishable from invalid
            # registration details so the endpoint does not become an email oracle.
            return _failure(
                400,
                "Unable to create an account with those details. Check your information or try signing in.",
            )
        except (OwnerSetupError, SetupTokenInvalid) as exc:
            return _failure(400, str(exc))

        session = await run_in_threadpool(store.lookup, token)
        return _session_response(
            settings,
            token,
            session,
            new_cookie=True,
            secure_transport=request.url.scheme == "https",
            setup_required=False,
        )

    @app.post("/auth/login")
    async def login(request: Request) -> JSONResponse:
        payload = await _read_json_object(
            request,
            error_message="Invalid sign-in request.",
        )
        if isinstance(payload, JSONResponse):
            return payload

        username = payload.get("username")
        password = payload.get("password")

        if (
            not isinstance(username, str)
            or not 1 <= len(username.strip()) <= 254
            or not isinstance(password, str)
            or not 1 <= len(password) <= 128
        ):
            return _failure(401, "Invalid username or password.")

        try:
            password.encode("utf-8")
        except UnicodeEncodeError:
            return _failure(401, "Invalid username or password.")

        store = app.state.auth_store
        previous = request.cookies.get(
            settings.cookie_name, ""
        )
        client_address = (
            request.client.host if request.client else "unknown"
        )

        try:
            result = await run_in_threadpool(
                store.login,
                username,
                password,
                previous,
                client_address,
            )
        except LoginThrottled:
            response = _failure(
                429,
                "Too many sign-in attempts. Try again in a minute.",
            )
            response.headers["Retry-After"] = "60"
            return response

        if result is None:
            return _failure(
                401, "Invalid username or password."
            )

        token, _ = result
        session = await run_in_threadpool(
            store.lookup, token
        )

        return _session_response(
            settings,
            token,
            session,
            new_cookie=True,
            secure_transport=request.url.scheme == "https",
            setup_required=False,
        )

    @app.post("/auth/logout")
    async def logout(request: Request) -> JSONResponse:
        from mcp_approval import cancel_pending_approvals

        cancel_pending_approvals()

        token = request.cookies.get(settings.cookie_name, "")
        await run_in_threadpool(
            app.state.auth_store.revoke, token
        )

        response = JSONResponse({"success": True})
        response.delete_cookie(
            settings.cookie_name,
            path="/",
            secure=settings.secure or request.url.scheme == "https",
            httponly=True,
            samesite="lax",
        )
        return response

    @app.get("/mcp/approvals")
    async def list_mcp_approvals() -> JSONResponse:
        from mcp_approval import pending_approvals

        return JSONResponse({
            "pending": pending_approvals()
        })

    @app.post("/mcp/approvals/{approval_id}")
    async def resolve_mcp_approval(
        approval_id: str,
        decision: MCPApprovalDecision,
    ) -> JSONResponse:
        from mcp_approval import decide_approval

        if not decide_approval(
            approval_id,
            decision.approve,
        ):
            return JSONResponse(
                {"detail": "Approval expired or not found."},
                status_code=404,
            )
        return JSONResponse({"resolved": True})

    app.add_middleware(
        AuthenticationMiddleware,
        application=app,
        settings=settings,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.origins),
        allow_credentials=True,
        allow_methods=[
            "GET", "POST", "PATCH", "DELETE", "OPTIONS"
        ],
        allow_headers=[
            "Content-Type", "X-CSRF-Token"
        ],
        expose_headers=["Retry-After"],
    )
