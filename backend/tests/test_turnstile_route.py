
"""Signup route enforcement for configured Turnstile secrets."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

import app as api
import auth as auth_routes
from auth import install_authentication
from auth_store import AuthStore


ADMIN_PASSWORD = "Saffron rivers carry seven boats!"
USER_PASSWORD = "Mango trees grow beyond seven quiet hills!"
ORIGIN = "http://localhost:3000"


def _prepare(client: TestClient) -> None:
    session = client.get("/auth/session")
    assert session.status_code == 200
    client.headers["X-CSRF-Token"] = session.json()["csrf_token"]


def test_signup_requires_successful_server_verified_turnstile(
    auth_store, monkeypatch
):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)
    monkeypatch.setenv("CLAWBIT_TURNSTILE_SECRET_KEY", "test-server-secret")

    verification = {"allow": False, "calls": 0}

    def fake_verify(token, secret, **_kwargs):
        verification["calls"] += 1
        assert token == "one-time-test-token"
        assert secret == "test-server-secret"
        return verification["allow"]

    monkeypatch.setattr(auth_routes, "verify_turnstile", fake_verify)

    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = ORIGIN
        _prepare(client)

        payload = {
            "email": "turnstile-user@example.com",
            "password": USER_PASSWORD,
        }

        missing = client.post("/auth/register", json=payload)
        assert missing.status_code == 428

        invalid = client.post(
            "/auth/register",
            json={**payload, "turnstile_token": "one-time-test-token"},
        )
        assert invalid.status_code == 422
        assert verification["calls"] == 1

        verification["allow"] = True

        valid = client.post(
            "/auth/register",
            json={**payload, "turnstile_token": "one-time-test-token"},
        )

        assert valid.status_code == 200
        assert valid.json()["user"]["role"] == "user"

    with auth_store.connection() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM users WHERE email = ?",
            ("turnstile-user@example.com",),
        ).fetchone()[0] == 1


def test_production_signup_fails_closed_without_server_secret(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CLAWBIT_AUTH_MODE", "production")
    monkeypatch.setenv(
        "CLAWBIT_ALLOWED_ORIGINS",
        "https://clawbit.example",
    )
    monkeypatch.delenv(
        "CLAWBIT_TURNSTILE_SECRET_KEY",
        raising=False,
    )

    application = FastAPI()
    install_authentication(application)

    store = AuthStore(tmp_path / "production-auth.sqlite3")
    store.create_owner("production-admin", ADMIN_PASSWORD)
    application.state.auth_store = store

    with TestClient(
        application,
        base_url="https://api.clawbit.example",
    ) as client:
        client.headers["Origin"] = "https://clawbit.example"

        session = client.get("/auth/session")
        assert session.status_code == 200

        client.headers["X-CSRF-Token"] = session.json()["csrf_token"]

        response = client.post(
            "/auth/register",
            json={
                "email": "blocked-signup@example.com",
                "password": USER_PASSWORD,
            },
        )

        assert response.status_code == 503
        assert response.json() == {
            "detail": "Account registration is temporarily unavailable."
        }

    with store.connection() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM users WHERE email = ?",
            ("blocked-signup@example.com",),
        ).fetchone()[0] == 0
