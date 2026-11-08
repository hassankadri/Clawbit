
"""Tests for first-owner signup and local password recovery."""

import time

from fastapi.testclient import TestClient
import pytest

import app as api
from auth_store import AuthStore, OwnerSetupError, token_digest


USERNAME = "clawbit-owner"
PASSWORD = "Lantern paths cross seven distant rivers!"
NEW_PASSWORD = "Copper valleys hold nine quiet rivers!"
ORIGIN = "http://localhost:3000"


@pytest.fixture
def setup_client(auth_store):
    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as client:
        client.headers["Origin"] = ORIGIN
        yield client


def prepare_setup(client):
    response = client.get("/auth/session")
    assert response.status_code == 200

    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response


def submit_setup(client, setup_token):
    return client.post(
        "/auth/setup",
        json={
            "username": USERNAME,
            "password": PASSWORD,
            "setup_token": setup_token,
        },
    )


def test_setup_status_is_returned_without_exposing_owner_data(
    setup_client,
):
    response = setup_client.get("/auth/session")

    assert response.status_code == 200
    assert response.json()["setup_required"] is True
    assert response.json()["user"] is None


def test_setup_token_is_hashed_and_expires(auth_store):
    token = auth_store.create_setup_token()

    assert len(token) == 43

    with auth_store.connection() as connection:
        row = connection.execute(
            "SELECT token_hash, issued_at, expires_at FROM setup_tokens"
        ).fetchone()

    assert row is not None
    assert row["token_hash"] == token_digest(token)
    assert token not in row["token_hash"]
    assert row["expires_at"] - row["issued_at"] == pytest.approx(900)
    assert not auth_store.has_owner()


def test_setup_token_can_be_issued_only_before_first_owner(auth_store):
    auth_store.create_owner(USERNAME, PASSWORD)

    with pytest.raises(OwnerSetupError):
        auth_store.create_setup_token()


def test_signup_requires_a_valid_anonymous_session(setup_client):
    response = submit_setup(setup_client, "A" * 43)

    assert response.status_code == 401


def test_signup_requires_csrf(setup_client, auth_store):
    token = auth_store.create_setup_token()
    prepare_setup(setup_client)

    setup_client.headers.pop("X-CSRF-Token")

    response = submit_setup(setup_client, token)

    assert response.status_code == 403
    assert not auth_store.has_owner()


def test_signup_creates_owner_and_signs_in_automatically(
    setup_client,
    auth_store,
):
    setup_token = auth_store.create_setup_token()
    initial = prepare_setup(setup_client)

    response = submit_setup(setup_client, setup_token)

    assert response.status_code == 200
    assert response.json()["setup_required"] is False
    assert response.json()["user"]["username"] == USERNAME
    assert response.json()["user"]["principal_id"]

    new_cookie = setup_client.cookies.get("clawbit_session")
    assert new_cookie

    authenticated = auth_store.lookup(new_cookie)
    assert authenticated is not None
    assert authenticated.username == USERNAME
    assert authenticated.principal_id == (
        response.json()["user"]["principal_id"]
    )

    assert response.json()["csrf_token"] != initial.json()["csrf_token"]
    assert auth_store.has_owner()

    restored = setup_client.get("/auth/session")
    assert restored.status_code == 200
    assert restored.json()["setup_required"] is False
    assert restored.json()["user"]["username"] == USERNAME


def test_setup_token_cannot_be_reused(setup_client, auth_store):
    token = auth_store.create_setup_token()
    prepare_setup(setup_client)

    first = submit_setup(setup_client, token)
    assert first.status_code == 200

    # The server must consume the one-time setup token.
    with auth_store.connection() as connection:
        remaining = connection.execute(
            "SELECT token_hash FROM setup_tokens WHERE id = 1"
        ).fetchone()

    assert remaining is None

    # Signup rotates the anonymous session into an authenticated session.
    # Use the new CSRF token for the next authenticated request.
    setup_client.headers["X-CSRF-Token"] = first.json()["csrf_token"]

    second = setup_client.post(
        "/auth/setup",
        json={
            "username": "another-owner",
            "password": NEW_PASSWORD,
            "setup_token": token,
        },
    )

    assert second.status_code == 409
    assert auth_store.has_owner()


def test_invalid_setup_token_does_not_create_owner(
    setup_client,
    auth_store,
):
    prepare_setup(setup_client)

    response = submit_setup(setup_client, "A" * 43)

    assert response.status_code == 400
    assert "invalid or expired" in response.json()["detail"]
    assert not auth_store.has_owner()


def test_expired_setup_token_is_rejected(
    setup_client,
    auth_store,
):
    token = auth_store.create_setup_token()
    prepare_setup(setup_client)

    with auth_store.connection() as connection:
        connection.execute(
            "UPDATE setup_tokens SET expires_at = ? WHERE id = 1",
            (time.time() - 1,),
        )

    response = submit_setup(setup_client, token)

    assert response.status_code == 400
    assert not auth_store.has_owner()


def test_invalid_signup_password_does_not_consume_setup_token(
    setup_client,
    auth_store,
):
    token = auth_store.create_setup_token()
    prepare_setup(setup_client)

    response = setup_client.post(
        "/auth/setup",
        json={
            "username": USERNAME,
            "password": "short",
            "setup_token": token,
        },
    )

    assert response.status_code == 400
    assert not auth_store.has_owner()

    with auth_store.connection() as connection:
        row = connection.execute(
            "SELECT token_hash FROM setup_tokens WHERE id = 1"
        ).fetchone()

    assert row is not None
    assert row["token_hash"] == token_digest(token)


def test_password_reset_revokes_sessions_and_preserves_owner_identity(
    auth_store,
):
    auth_store.create_owner(USERNAME, PASSWORD)

    first_presession, _ = auth_store.create_presession("127.0.0.1")
    first_login = auth_store.login(
        USERNAME,
        PASSWORD,
        first_presession,
        "127.0.0.1",
    )

    assert first_login is not None
    old_token, _ = first_login

    old_session = auth_store.lookup(old_token)
    assert old_session is not None

    auth_store.reset_owner_password(USERNAME, NEW_PASSWORD)

    assert auth_store.lookup(old_token) is None

    second_presession, _ = auth_store.create_presession("127.0.0.1")

    old_login = auth_store.login(
        USERNAME,
        PASSWORD,
        second_presession,
        "127.0.0.1",
    )
    assert old_login is None

    third_presession, _ = auth_store.create_presession("127.0.0.1")
    new_login = auth_store.login(
        USERNAME,
        NEW_PASSWORD,
        third_presession,
        "127.0.0.1",
    )

    assert new_login is not None

    new_session = auth_store.lookup(new_login[0])
    assert new_session is not None
    assert new_session.username == USERNAME

    # Existing conversations and private data remain attached to this identity.
    assert new_session.principal_id == old_session.principal_id


def test_password_reset_rejects_wrong_owner_username(auth_store):
    auth_store.create_owner(USERNAME, PASSWORD)

    with pytest.raises(OwnerSetupError):
        auth_store.reset_owner_password(
            "someone-else",
            NEW_PASSWORD,
        )

    assert auth_store.has_owner()
