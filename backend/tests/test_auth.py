"""Offline tests of the actual cookie, CSRF, owner setup and OAuth boundaries."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import app as api
from auth import AuthSettings, install_authentication
from auth_store import (
    AuthStore,
    OwnerSetupError,
    csrf_token,
    token_digest,
    verify_password,
)
import mcp_oauth
import setup_owner


USERNAME = "local-owner"
PASSWORD = "Lanterns drift beyond seven rivers!"
ORIGIN = "http://localhost:3000"


@pytest.fixture
def anonymous(auth_store):
    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = ORIGIN
        yield client


def prepare_login(client):
    response = client.get("/auth/session")
    assert response.status_code == 200
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response


def login(client, username=USERNAME, password=PASSWORD):
    prepare_login(client)
    response = client.post("/auth/login", json={"username": username, "password": password})
    if response.status_code == 200:
        client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response


def test_setup_hashes_password_and_prevents_second_owner(auth_store):
    auth_store.create_owner(USERNAME, PASSWORD)
    with auth_store.connection() as connection:
        row = connection.execute("SELECT * FROM owner").fetchone()
    assert row["password_hash"].startswith("scrypt$131072$8$1$")
    assert PASSWORD not in row["password_hash"]
    assert verify_password(PASSWORD, row["password_hash"])
    assert not verify_password("incorrect password", row["password_hash"])
    with pytest.raises(OwnerSetupError, match="already"):
        auth_store.create_owner("another-owner", PASSWORD)


@pytest.mark.parametrize("username,password", [
    ("a", PASSWORD), ("owner@example.com", PASSWORD), (USERNAME, "short"),
    (USERNAME, "x" * 20), (USERNAME, "password123456789"),
    (USERNAME, "a" * 129), (USERNAME, "local-owner lives by the rivers!"),
])
def test_weak_or_invalid_setup_is_rejected(auth_store, username, password):
    with pytest.raises(OwnerSetupError):
        auth_store.create_owner(username, password)
    assert not auth_store.has_owner()


def test_racing_initialization_has_only_one_winner(tmp_path):
    path = tmp_path / "auth.sqlite3"
    AuthStore(path).initialize()

    def initialize(username):
        try:
            AuthStore(path).create_owner(username, PASSWORD)
            return True
        except OwnerSetupError:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(initialize, ["first-owner", "second-owner"])) == [False, True]
    with AuthStore(path).connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM owner").fetchone()[0] == 1


def test_cli_requires_interactive_explicit_initialization(auth_store, monkeypatch, capsys):
    monkeypatch.setattr(setup_owner, "auth_database_path", lambda: auth_store.path)
    monkeypatch.setattr(setup_owner.sys, "argv", ["setup_owner.py"])
    monkeypatch.setattr(setup_owner.sys.stdin, "isatty", lambda: True)
    answers = iter(["INITIALIZE", USERNAME])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    monkeypatch.setattr(setup_owner, "getpass", lambda prompt: PASSWORD)
    assert setup_owner.main() == 0
    assert setup_owner.main() == 1
    assert PASSWORD not in capsys.readouterr().out


def test_cli_rejects_password_arguments_and_noninteractive_input(monkeypatch, capsys):
    monkeypatch.setattr(setup_owner.sys, "argv", ["setup_owner.py", "--password", PASSWORD])
    assert setup_owner.main() == 1
    assert PASSWORD not in capsys.readouterr().out
    monkeypatch.setattr(setup_owner.sys, "argv", ["setup_owner.py"])
    monkeypatch.setattr(setup_owner.sys.stdin, "isatty", lambda: False)
    assert setup_owner.main() == 1


def test_schema_initialization_preserves_and_backs_up_existing_database(tmp_path):
    legacy = tmp_path / "chatbot_memory.db"
    legacy.write_bytes(b"existing application data")
    path = tmp_path / "auth.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE preserved (value TEXT)")
        connection.execute("INSERT INTO preserved VALUES ('keep')")
    store = AuthStore(path)
    store.initialize()
    store.initialize()
    AuthStore(path).initialize()
    backups = list(tmp_path.glob("*.backup"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as connection:
        assert connection.execute("SELECT value FROM preserved").fetchone() == ("keep",)
    with store.connection() as connection:
        assert connection.execute("SELECT value FROM preserved").fetchone()[0] == "keep"
    assert legacy.read_bytes() == b"existing application data"


def test_login_rotates_token_persists_hash_and_restores_after_restart(anonymous, auth_store):
    auth_store.create_owner(USERNAME, PASSWORD)
    prepare_login(anonymous)
    previous = anonymous.cookies["clawbit_session"]
    response = login(anonymous)
    assert response.status_code == 200
    token = anonymous.cookies["clawbit_session"]
    assert token != previous and auth_store.lookup(previous) is None
    assert response.json()["user"]["username"] == USERNAME
    assert response.json()["user"]["principal_id"] == auth_store.lookup(
        anonymous.cookies["clawbit_session"]
    ).principal_id
    assert token not in response.text
    with auth_store.connection() as connection:
        rows = connection.execute("SELECT * FROM sessions").fetchall()
    assert len(rows) == 1 and rows[0]["token_hash"] == token_digest(token)
    assert token not in str([tuple(row) for row in rows])
    restored = AuthStore(auth_store.path).lookup(token)
    assert restored.username == USERNAME
    assert anonymous.get("/auth/session").json()["user"]["username"] == USERNAME
    assert anonymous.get("/models").status_code == 200


@pytest.mark.parametrize("payload", [
    {}, {"username": USERNAME}, {"password": PASSWORD},
    {"username": "unknown-owner", "password": PASSWORD},
    {"username": USERNAME, "password": "incorrect password"},
    {"username": USERNAME, "password": ["never echo this"]},
])
def test_invalid_login_is_generic_and_never_echoes_credentials(anonymous, auth_store, payload):
    auth_store.create_owner(USERNAME, PASSWORD)
    prepare_login(anonymous)
    response = anonymous.post("/auth/login", json=payload)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid username or password."}
    assert anonymous.get("/models").status_code == 401


def test_uninitialized_installation_cannot_sign_in(anonymous):
    assert login(anonymous).status_code == 401
    assert anonymous.post("/auth/register", json={}).status_code == 401


def test_all_existing_sensitive_routes_reject_anonymous_requests(anonymous, monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Protected work must not start before authentication.")

    monkeypatch.setattr(api, "get_agent", forbidden)
    monkeypatch.setattr(api, "receive_uploaded_file", forbidden)
    public = {"/", "/auth/session", "/auth/login"}
    covered = set()
    for route in api.app.routes:
        if route.path in public:
            continue
        path = route.path.replace("{thread_id}", "legacy-thread").replace(
            "{attachment_id}", "legacy-attachment"
        )
        for method in route.methods or []:
            response = anonymous.request(method, path, follow_redirects=False)
            assert response.status_code == 401, (method, path, response.text)
            covered.add(route.path)
    assert {"/chat", "/chat/stream", "/models", "/attachments/upload", "/mcp/status"} <= covered


@pytest.mark.parametrize("token", ["tampered", "A" * 43, "x" * 1000])
def test_tampered_cookies_are_rejected(anonymous, token):
    anonymous.cookies.set("clawbit_session", token)
    assert anonymous.post("/chat", json={"message": "private"}).status_code == 401


@pytest.mark.parametrize("action", ["logout", "revoke", "expire"])
def test_invalidated_sessions_cannot_access_old_threads(owner_client, auth_store, action):
    token = owner_client.cookies["clawbit_session"]
    if action == "logout":
        response = owner_client.post("/auth/logout")
        assert response.status_code == 200
        assert "Max-Age=0" in response.headers["set-cookie"]
    elif action == "revoke":
        auth_store.revoke(token)
    else:
        with auth_store.connection() as connection:
            connection.execute("UPDATE sessions SET expires_at = ?", (time.time() - 1,))
    # Replay the old bearer value, even after logout removed the browser's cookie.
    owner_client.cookies.clear()
    owner_client.cookies.set("clawbit_session", token)
    for path in ("/chat", "/chat/stream"):
        response = owner_client.post(path, json={"message": "private", "thread_id": "old-thread"})
        assert response.status_code == 401
    assert owner_client.get("/auth/session").json()["user"] is None


def test_login_csrf_and_cross_session_csrf_are_rejected(anonymous, auth_store):
    auth_store.create_owner(USERNAME, PASSWORD)
    payload = {"username": USERNAME, "password": PASSWORD}
    assert anonymous.post("/auth/login", json=payload).status_code == 403
    prepare_login(anonymous)
    valid = anonymous.headers.pop("X-CSRF-Token")
    assert anonymous.post("/auth/login", json=payload).status_code == 403
    other_token, _ = auth_store.create_presession()
    anonymous.headers["X-CSRF-Token"] = csrf_token(other_token)
    assert anonymous.post("/auth/login", json=payload).status_code == 403
    anonymous.headers["X-CSRF-Token"] = valid
    anonymous.headers["Origin"] = "https://attacker.example"
    assert anonymous.post("/auth/login", json=payload).status_code == 403
    anonymous.headers.pop("Origin")
    assert anonymous.post("/auth/login", json=payload).status_code == 403


@pytest.mark.parametrize("path", [
    "/chat", "/chat/stream", "/attachments/upload", "/mcp/connect/github",
    "/mcp/connect/google-drive", "/mcp/connect/slack", "/auth/logout",
])
def test_authenticated_mutations_require_csrf(owner_client, path):
    owner_client.headers.pop("X-CSRF-Token")
    assert owner_client.post(path, json={}).status_code == 403


def test_login_budget_is_persistent_and_recovers(anonymous, auth_store, monkeypatch):
    auth_store.create_owner(USERNAME, PASSWORD)
    prepare_login(anonymous)
    payload = {"username": USERNAME, "password": "wrong passphrase"}
    for _ in range(5):
        assert anonymous.post("/auth/login", json=payload).status_code == 401
    monkeypatch.setattr(api.app.state, "auth_store", AuthStore(auth_store.path))
    response = anonymous.post("/auth/login", json={"username": USERNAME, "password": PASSWORD})
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
    with auth_store.connection() as connection:
        connection.execute("UPDATE login_attempts SET window_started = ?", (time.time() - 61,))
    assert login(anonymous).status_code == 200


def test_local_cookie_and_exact_cors_configuration(anonymous):
    response = prepare_login(anonymous)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    assert "Domain=" not in cookie and "Secure" not in cookie
    response = anonymous.options("/chat", headers={
        "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"
    response = anonymous.options("/chat", headers={
        "Origin": "http://localhost:9000", "Access-Control-Request-Method": "POST",
    })
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_production_cookie_uses_secure_host_prefix(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAWBIT_AUTH_MODE", "production")
    monkeypatch.setenv("CLAWBIT_ALLOWED_ORIGINS", "https://clawbit.example")
    application = FastAPI()
    install_authentication(application)
    application.state.auth_store = AuthStore(tmp_path / "secure.sqlite3")
    with TestClient(application, base_url="https://api.clawbit.example") as client:
        response = client.get("/auth/session", headers={"Origin": "https://clawbit.example"})
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("__Host-clawbit_session=")
    assert all(value in cookie for value in ("Secure", "HttpOnly", "SameSite=lax", "Path=/"))
    assert "Domain=" not in cookie


@pytest.mark.parametrize("origin", [
    "*", "https://*.example", "http://example.com", "https://a.test/path",
])
def test_production_rejects_unsafe_origins(monkeypatch, origin):
    monkeypatch.setenv("CLAWBIT_AUTH_MODE", "production")
    monkeypatch.setenv("CLAWBIT_ALLOWED_ORIGINS", origin)
    with pytest.raises(ValueError):
        AuthSettings.from_environment()


def test_production_requires_https_transport(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAWBIT_AUTH_MODE", "production")
    monkeypatch.setenv("CLAWBIT_ALLOWED_ORIGINS", "https://clawbit.example")
    application = FastAPI()
    install_authentication(application)
    application.state.auth_store = AuthStore(tmp_path / "secure.sqlite3")
    with TestClient(application, base_url="http://api.clawbit.example") as client:
        response = client.get("/auth/session")
    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_https_local_development_also_sets_secure_cookie(auth_store):
    with TestClient(api.app, base_url="https://localhost:8000") as client:
        response = client.get("/auth/session")
    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]


def test_login_rejects_malformed_and_oversized_bodies_without_echoing(anonymous):
    prepare_login(anonymous)
    for body in (b"not JSON", b"[]", b"x" * 4097):
        response = anonymous.post("/auth/login", content=body)
        assert response.status_code == 400
        assert response.json() == {"detail": "Invalid sign-in request."}
    response = anonymous.post(
        "/auth/login", content=b'{"username":"local-owner","password":"\\ud800"}'
    )
    assert response.status_code == 401


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
def test_oauth_state_is_session_bound_one_use_and_expires(monkeypatch, provider):
    monkeypatch.setattr(mcp_oauth, "_oauth_states", {})
    state = mcp_oauth._create_state(provider, "https://callback", "verifier", "session-one")
    with pytest.raises(RuntimeError):
        mcp_oauth._consume_state(state, provider, "session-two")
    with pytest.raises(RuntimeError):
        mcp_oauth._consume_state(state, provider, "session-one")
    state = mcp_oauth._create_state(provider, "https://callback", "verifier", "session-one")
    mcp_oauth._oauth_states[state]["created_at"] -= 601
    with pytest.raises(RuntimeError):
        mcp_oauth._consume_state(state, provider, "session-one")


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
def test_oauth_callbacks_accept_only_initiating_active_session(
    owner_client, auth_store, monkeypatch, provider
):
    monkeypatch.setattr(mcp_oauth, "_oauth_states", {})
    monkeypatch.setattr(mcp_oauth, "_oauth_tokens", {})
    for name in ("GOOGLE_MCP_CLIENT_ID", "GOOGLE_MCP_CLIENT_SECRET",
                 "SLACK_MCP_CLIENT_ID", "SLACK_MCP_CLIENT_SECRET"):
        monkeypatch.setenv(name, "offline-oauth-fixture")
    monkeypatch.setenv("CLAWBIT_PUBLIC_BACKEND_URL", "https://localhost:8000")
    calls = []

    async def exchange(*args, **kwargs):
        calls.append(args)
        return {"access_token": "offline-token"}

    async def refresh():
        return {}

    monkeypatch.setattr(mcp_oauth, "_post_form", exchange)
    monkeypatch.setattr(api, "refresh_mcp_tools", refresh)
    response = owner_client.post(f"/mcp/connect/{provider}")
    assert response.status_code == 200
    state = parse_qs(urlsplit(response.json()["authorization_url"]).query)["state"][0]
    response = owner_client.get(
        f"/mcp/oauth/{provider}/callback", params={"code": "offline-code", "state": state},
        follow_redirects=False,
    )
    assert "status=connected" in response.headers["location"]
    assert mcp_oauth.get_oauth_token_record(provider)["access_token"] == "offline-token"
    assert len(calls) == 1
    response = owner_client.get(
        f"/mcp/oauth/{provider}/callback", params={"code": "offline-code", "state": state},
        follow_redirects=False,
    )
    assert "status=error" in response.headers["location"] and len(calls) == 1

    complete = getattr(mcp_oauth, f"complete_{provider.replace('-', '_')}_oauth")
    state = mcp_oauth._create_state(provider, "https://callback", "verifier", "initiator")
    with pytest.raises(RuntimeError, match="session"):
        asyncio.run(complete(code="offline-code", state=state, session_id="initiator",
                             validate_session=lambda: False))


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
def test_oauth_callback_from_another_login_never_exchanges_credentials(
    owner_client, auth_store, monkeypatch, provider
):
    token = owner_client.cookies["clawbit_session"]
    state = mcp_oauth._create_state(
        provider, "https://callback", "verifier", token_digest(token),
    )

    async def forbidden(*args, **kwargs):
        pytest.fail("A different session must never exchange the authorization code.")

    monkeypatch.setattr(mcp_oauth, "_post_form", forbidden)
    with TestClient(api.app, base_url="http://localhost:8000") as another:
        another.headers["Origin"] = ORIGIN
        assert login(another, "test-owner", "Saffron rivers carry seven boats!").status_code == 200
        assert another.cookies["clawbit_session"] != token
        response = another.get(
            f"/mcp/oauth/{provider}/callback",
            params={"code": "offline-code", "state": state},
            follow_redirects=False,
        )
    assert "status=error" in response.headers["location"]
    assert "offline-code" not in response.headers["location"]
