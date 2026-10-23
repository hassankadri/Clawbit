
"""Regression tests for principal-safe login throttling."""

import sqlite3
import time

from fastapi.testclient import TestClient
import pytest

import app as api
import auth_store as auth_module
from auth_store import AuthStore, LoginThrottled


USERNAME = "local-owner"
PASSWORD = "Lanterns drift beyond seven rivers!"
BAD_PASSWORD = "incorrect-passphrase"


def make_store(tmp_path):
    store = AuthStore(tmp_path / "auth.sqlite3")
    store.create_owner(USERNAME, PASSWORD)
    return store


def test_presession_limit_does_not_lock_another_presession(tmp_path):
    store = make_store(tmp_path)
    first, _ = store.create_presession()

    for _ in range(5):
        assert store.login(
            USERNAME,
            BAD_PASSWORD,
            first,
            "198.51.100.10",
        ) is None

    with pytest.raises(LoginThrottled):
        store.login(
            USERNAME,
            PASSWORD,
            first,
            "198.51.100.10",
        )

    second, _ = store.create_presession()

    assert store.login(
        USERNAME,
        PASSWORD,
        second,
        "198.51.100.10",
    ) is not None


def test_source_limit_does_not_block_different_source(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(
        auth_module,
        "MAX_SOURCE_ATTEMPTS",
        2,
    )

    store = make_store(tmp_path)

    for _ in range(2):
        token, _ = store.create_presession()

        assert store.login(
            USERNAME,
            BAD_PASSWORD,
            token,
            "198.51.100.10",
        ) is None

    blocked, _ = store.create_presession()

    with pytest.raises(LoginThrottled):
        store.login(
            USERNAME,
            PASSWORD,
            blocked,
            "198.51.100.10",
        )

    allowed, _ = store.create_presession()

    assert store.login(
        USERNAME,
        PASSWORD,
        allowed,
        "203.0.113.20",
    ) is not None


def test_source_limit_persists_across_store_instances(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(
        auth_module,
        "MAX_SOURCE_ATTEMPTS",
        2,
    )

    first_store = make_store(tmp_path)
    second_store = AuthStore(first_store.path)

    for store in (first_store, second_store):
        token, _ = store.create_presession()

        assert store.login(
            USERNAME,
            BAD_PASSWORD,
            token,
            "198.51.100.30",
        ) is None

    blocked, _ = second_store.create_presession()

    with pytest.raises(LoginThrottled):
        second_store.login(
            USERNAME,
            PASSWORD,
            blocked,
            "198.51.100.30",
        )


def test_expired_source_window_recovers(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth_module,
        "MAX_SOURCE_ATTEMPTS",
        1,
    )

    store = make_store(tmp_path)
    token, _ = store.create_presession()

    assert store.login(
        USERNAME,
        BAD_PASSWORD,
        token,
        "198.51.100.40",
    ) is None

    with pytest.raises(LoginThrottled):
        store.login(
            USERNAME,
            PASSWORD,
            token,
            "198.51.100.40",
        )

    with store.connection() as connection:
        connection.execute(
            """
            UPDATE login_attempts
            SET window_started = ?
            """,
            (time.time() - 61,),
        )

    assert store.login(
        USERNAME,
        PASSWORD,
        token,
        "198.51.100.40",
    ) is not None


def test_v2_upgrade_preserves_owner_sessions_and_creates_backup(
    tmp_path,
):
    store = make_store(tmp_path)

    token, _ = store.create_presession()
    original = store.lookup(token)

    # Reproduce the legacy v2 login budget schema without altering
    # the owner's identity or active sessions.
    with sqlite3.connect(store.path) as connection:
        connection.execute(
            "DROP TABLE login_attempts"
        )

        connection.execute(
            """
            CREATE TABLE login_attempts (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                window_started REAL NOT NULL,
                attempts INTEGER NOT NULL
            )
            """
        )

        connection.execute(
            """
            INSERT INTO login_attempts
            VALUES (1, ?, 5)
            """,
            (time.time(),),
        )

        connection.execute(
            "PRAGMA user_version = 2"
        )

    upgraded = AuthStore(store.path)
    upgraded.initialize()

    assert upgraded.lookup(token) == original
    assert upgraded.has_owner()

    with upgraded.connection() as connection:
        version = connection.execute(
            "PRAGMA user_version"
        ).fetchone()[0]

        columns = {
            row["name"]
            for row in connection.execute(
                "PRAGMA table_info(login_attempts)"
            )
        }

    assert version == 3
    assert {
        "scope",
        "bucket",
        "window_started",
        "attempts",
    } <= columns

    assert len(
        list(tmp_path.glob("auth.sqlite3.*.backup"))
    ) == 1

    # A legacy installation-wide lockout must not survive migration.
    assert upgraded.login(
        USERNAME,
        PASSWORD,
        token,
        "198.51.100.50",
    ) is not None


def test_http_login_does_not_trust_forwarded_for(
    auth_store,
    monkeypatch,
):
    auth_store.create_owner(
        USERNAME,
        PASSWORD,
    )

    captured_addresses = []
    original_login = auth_store.login

    def captured_login(*args):
        captured_addresses.append(args[3])
        return original_login(*args)

    monkeypatch.setattr(
        auth_store,
        "login",
        captured_login,
    )

    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as client:
        client.headers["Origin"] = "http://localhost:3000"

        session = client.get(
            "/auth/session"
        ).json()

        client.headers["X-CSRF-Token"] = (
            session["csrf_token"]
        )

        response = client.post(
            "/auth/login",
            headers={
                "X-Forwarded-For": "198.51.100.99",
            },
            json={
                "username": USERNAME,
                "password": BAD_PASSWORD,
            },
        )

        assert response.status_code == 401

    assert captured_addresses
    assert captured_addresses[-1] != "198.51.100.99"
