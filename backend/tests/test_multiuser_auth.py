
"""Public multi-user registration and principal isolation regression tests."""

from fastapi.testclient import TestClient
import pytest
import secrets
import sqlite3
import time

import app as api
import auth_store as auth_module
from auth_store import (
    AdministratorNotInitialized,
    AuthStore,
    SignupThrottled,
    hash_password,
    token_digest,
)
from ownership import (
    OwnershipError,
    bind_resources,
    owner_context,
    require_thread,
    require_workspace,
)

ADMIN_PASSWORD = "Saffron rivers carry seven boats!"
USER_PASSWORD = "Mango trees grow beyond seven quiet hills!"
ORIGIN = "http://localhost:3000"


@pytest.fixture
def register_client():
    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = ORIGIN
        yield client


def _prepare(client):
    response = client.get("/auth/session")
    assert response.status_code == 200
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]


def _register(client, email):
    _prepare(client)
    # The caller cannot choose their own privilege level.
    return client.post("/auth/register", json={
        "email": email,
        "password": USER_PASSWORD,
        "role": "admin",
    })


def test_public_registration_requires_admin_bootstrap(register_client, auth_store):
    response = _register(register_client, "first-visitor@example.com")
    assert response.status_code == 503
    assert "administrator setup" in response.json()["detail"].lower()
    assert not auth_store.has_users()


def test_registration_store_rejects_without_bootstrapped_admin(tmp_path):
    store = AuthStore(tmp_path / "auth.sqlite3")
    anonymous, _ = store.create_presession("127.0.0.1")

    with pytest.raises(AdministratorNotInitialized):
        store.register_user(
            "visitor@example.com",
            USER_PASSWORD,
            anonymous,
            "127.0.0.1",
        )

    assert not store.has_users()


def test_public_registration_creates_normal_user_and_rotates_session(auth_store):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)

    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = ORIGIN
        registered = _register(client, "new-user@example.com")

        assert registered.status_code == 200

        payload = registered.json()
        assert payload["user"]["email"] == "new-user@example.com"
        assert payload["user"]["username"] == "new-user@example.com"
        assert payload["user"]["role"] == "user"
        assert payload["user"]["principal_id"]
        assert payload["setup_required"] is False

        session = auth_store.lookup(client.cookies["clawbit_session"])
        assert session is not None
        assert session.role == "user"


def test_registration_requires_anonymous_presession_and_csrf(auth_store):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)

    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = ORIGIN

        response = client.post("/auth/register", json={
            "email": "new-user@example.com",
            "password": USER_PASSWORD,
        })
        assert response.status_code == 401

        _prepare(client)
        client.headers.pop("X-CSRF-Token")

        response = client.post("/auth/register", json={
            "email": "new-user@example.com",
            "password": USER_PASSWORD,
        })
        assert response.status_code == 403

        with auth_store.connection() as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM users"
            ).fetchone()[0] == 1


def test_duplicate_email_is_rejected_without_account_enumeration(auth_store):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)

    with TestClient(api.app, base_url="http://localhost:8000") as first:
        first.headers["Origin"] = ORIGIN
        assert _register(first, "same@example.com").status_code == 200

    with TestClient(api.app, base_url="http://localhost:8000") as second:
        second.headers["Origin"] = ORIGIN
        response = _register(second, "SAME@example.com")

        assert response.status_code == 400
        assert response.json() == {
            "detail": (
                "Unable to create an account with those details. "
                "Check your information or try signing in."
            )
        }


def test_login_accepts_registered_email_and_returns_same_principal(auth_store):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)

    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = ORIGIN

        registered = _register(client, "member@example.com")
        assert registered.status_code == 200
        principal = registered.json()["user"]["principal_id"]

        client.headers["X-CSRF-Token"] = registered.json()["csrf_token"]
        assert client.post("/auth/logout").status_code == 200

        _prepare(client)

        response = client.post("/auth/login", json={
            "username": "MEMBER@example.com",
            "password": USER_PASSWORD,
        })

        assert response.status_code == 200
        assert response.json()["user"]["principal_id"] == principal
        assert response.json()["user"]["role"] == "user"


def test_each_account_receives_distinct_principal_and_resource_namespace(auth_store):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)

    admin_pre, _ = auth_store.create_presession("127.0.0.1")
    admin_login = auth_store.login(
        "legacy-admin", ADMIN_PASSWORD, admin_pre, "127.0.0.1"
    )
    assert admin_login is not None
    admin = auth_store.lookup(admin_login[0])

    user_pre, _ = auth_store.create_presession("127.0.0.1")
    user_token, _ = auth_store.register_user(
        "another@example.com",
        USER_PASSWORD,
        user_pre,
        "127.0.0.1",
    )
    user = auth_store.lookup(user_token)

    assert admin is not None
    assert user is not None
    assert admin.principal_id != user.principal_id
    assert admin.role == "admin"
    assert user.role == "user"

    with owner_context(admin.principal_id):
        bind_resources(
            "admin-thread-multiuser",
            "admin-workspace-multiuser",
        )

    with owner_context(user.principal_id):
        with pytest.raises(OwnershipError):
            require_thread("admin-thread-multiuser")

        with pytest.raises(OwnershipError):
            require_workspace("admin-workspace-multiuser")

        bind_resources(
            "user-thread-multiuser",
            "user-workspace-multiuser",
        )

    with owner_context(admin.principal_id):
        with pytest.raises(OwnershipError):
            require_thread("user-thread-multiuser")


def test_registration_requires_strong_password_and_preserves_presession(auth_store):
    auth_store.create_owner("legacy-admin", ADMIN_PASSWORD)
    previous, _ = auth_store.create_presession("127.0.0.1")

    with pytest.raises(ValueError):
        auth_store.register_user(
            "weak@example.com",
            "short",
            previous,
            "127.0.0.1",
        )

    with auth_store.connection() as connection:
        row = connection.execute(
            "SELECT owner_id FROM sessions WHERE token_hash = ?",
            (token_digest(previous),),
        ).fetchone()

    assert row is not None
    assert row["owner_id"] is None


def test_successful_signups_do_not_reset_the_source_rate_limit(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(auth_module, "MAX_SIGNUPS_PER_SOURCE", 1)

    store = AuthStore(tmp_path / "auth.sqlite3")
    store.create_owner("legacy-admin", ADMIN_PASSWORD)

    first_pre, _ = store.create_presession("127.0.0.10")
    first, _ = store.register_user(
        "one@example.com",
        USER_PASSWORD,
        first_pre,
        "127.0.0.10",
    )
    assert store.lookup(first) is not None

    second_pre, _ = store.create_presession("127.0.0.10")

    with pytest.raises(SignupThrottled):
        store.register_user(
            "two@example.com",
            USER_PASSWORD,
            second_pre,
            "127.0.0.10",
        )


def test_existing_owner_principal_and_active_session_survive_v4_migration(tmp_path):
    path = tmp_path / "auth.sqlite3"
    principal_before = "a" * 64
    session_token = secrets.token_urlsafe(32)
    now = time.time()

    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE owner (
                id INTEGER PRIMARY KEY CHECK(id=1),
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE owner_identity (
                owner_id INTEGER PRIMARY KEY REFERENCES owner(id),
                principal_id TEXT NOT NULL UNIQUE
            );
            CREATE TABLE sessions (
                token_hash TEXT PRIMARY KEY,
                owner_id INTEGER REFERENCES owner(id),
                expires_at REAL NOT NULL
            );
            CREATE INDEX session_expiration ON sessions(expires_at);
            CREATE TABLE login_attempts (
                scope TEXT NOT NULL,
                bucket TEXT NOT NULL,
                window_started REAL NOT NULL,
                attempts INTEGER NOT NULL,
                PRIMARY KEY(scope,bucket)
            );
            CREATE TABLE setup_tokens (
                id INTEGER PRIMARY KEY CHECK(id=1),
                token_hash TEXT NOT NULL,
                issued_at REAL NOT NULL,
                expires_at REAL NOT NULL
            );
        """)

        connection.execute(
            "INSERT INTO owner VALUES (1, ?, ?, ?)",
            (
                "legacy-admin@example.com",
                hash_password(ADMIN_PASSWORD),
                now,
            ),
        )
        connection.execute(
            "INSERT INTO owner_identity VALUES (1, ?)",
            (principal_before,),
        )
        connection.execute(
            "INSERT INTO sessions VALUES (?, 1, ?)",
            (token_digest(session_token), now + 3600),
        )
        connection.execute("PRAGMA user_version=4")

    migrated = AuthStore(path)
    migrated.initialize()

    session = migrated.lookup(session_token)
    assert session is not None
    assert session.username == "legacy-admin@example.com"
    assert session.email == "legacy-admin@example.com"
    assert session.role == "admin"
    assert session.principal_id == principal_before

    with migrated.connection() as connection:
        assert connection.execute(
            "PRAGMA user_version"
        ).fetchone()[0] == 5
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_password_reset_revokes_only_the_target_user_sessions(tmp_path):
    store = AuthStore(tmp_path / "auth.sqlite3")
    store.create_owner("legacy-admin", ADMIN_PASSWORD)

    admin_pre, _ = store.create_presession("127.0.0.1")
    admin_token, _ = store.login(
        "legacy-admin",
        ADMIN_PASSWORD,
        admin_pre,
        "127.0.0.1",
    )

    user_pre, _ = store.create_presession("127.0.0.2")
    user_token, _ = store.register_user(
        "member@example.com",
        USER_PASSWORD,
        user_pre,
        "127.0.0.2",
    )

    store.reset_account_password(
        "member@example.com",
        "Copper valleys hold nine quiet rivers!",
    )

    assert store.lookup(user_token) is None
    assert store.lookup(admin_token) is not None

    next_pre, _ = store.create_presession("127.0.0.3")
    result = store.login(
        "MEMBER@example.com",
        "Copper valleys hold nine quiet rivers!",
        next_pre,
        "127.0.0.3",
    )
    assert result is not None
