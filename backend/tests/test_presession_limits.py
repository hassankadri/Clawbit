
"""Offline regression tests for bounded anonymous session issuance."""

import time

from fastapi.testclient import TestClient
import pytest

import app as api
import auth_store as auth_module
from auth_store import (
    AuthStore,
    LoginThrottled,
    PreSessionThrottled,
    _normalize_client_address,
    token_digest,
)


ORIGIN = "http://localhost:3000"


def make_store(tmp_path):
    return AuthStore(tmp_path / "auth.sqlite3")


@pytest.mark.parametrize(
    ("client_address", "expected"),
    [
        ("198.51.100.10", "198.51.100.10"),
        ("2001:db8:1234:5678::1", "2001:db8:1234:5678::/64"),
        (
            "2001:db8:1234:5678:ffff:ffff:ffff:ffff",
            "2001:db8:1234:5678::/64",
        ),
        ("::ffff:192.0.2.128", "192.0.2.128"),
        ("fe80::1%eth0", "fe80::/64"),
        ("", "unknown"),
        ("not-an-ip-address", "unknown"),
    ],
)
def test_normalize_client_address(client_address, expected):
    assert _normalize_client_address(client_address) == expected


def test_source_limit_does_not_block_another_source(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth_module, "MAX_PRESESSION_ISSUES_PER_SOURCE", 2
    )
    store = make_store(tmp_path)

    for _ in range(2):
        token, _ = store.create_presession("198.51.100.10")
        assert store.lookup(token) is not None

    with pytest.raises(PreSessionThrottled):
        store.create_presession("198.51.100.10")

    token, _ = store.create_presession("203.0.113.20")
    assert store.lookup(token) is not None


def test_ipv6_addresses_in_same_64_share_presession_limit(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(
        auth_module, "MAX_PRESESSION_ISSUES_PER_SOURCE", 2
    )
    store = make_store(tmp_path)

    first_address = "2001:db8:1234:5678::1"
    second_address = "2001:db8:1234:5678::2"
    third_address = "2001:db8:1234:5678::abcd:1234"

    expected_bucket = "2001:db8:1234:5678::/64"

    assert _normalize_client_address(first_address) == expected_bucket
    assert _normalize_client_address(second_address) == expected_bucket
    assert _normalize_client_address(third_address) == expected_bucket

    first_token, _ = store.create_presession(first_address)
    second_token, _ = store.create_presession(second_address)

    assert store.lookup(first_token) is not None
    assert store.lookup(second_token) is not None

    with pytest.raises(PreSessionThrottled):
        store.create_presession(third_address)

    other_token, _ = store.create_presession(
        "2001:db8:1234:5679::1"
    )
    assert store.lookup(other_token) is not None


def test_global_presession_limit_is_shared_across_sources_and_stores(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(
        auth_module, "MAX_GLOBAL_PRESESSION_ISSUES_PER_WINDOW", 2
    )

    first = make_store(tmp_path)
    second = AuthStore(first.path)

    token_a, _ = first.create_presession("198.51.100.10")
    token_b, _ = second.create_presession("203.0.113.20")

    assert first.lookup(token_a) is not None
    assert second.lookup(token_b) is not None

    # The third request is from a different IPv4 source, but the instance-wide
    # budget has already been consumed.
    with pytest.raises(PreSessionThrottled):
        first.create_presession("192.0.2.30")

    with first.connection() as connection:
        row = connection.execute(
            """
            SELECT attempts
            FROM login_attempts
            WHERE scope = 'presession_global'
            """
        ).fetchone()

    assert row is not None
    assert row["attempts"] == 2


def test_global_presession_budget_recovers_after_window(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(
        auth_module, "MAX_GLOBAL_PRESESSION_ISSUES_PER_WINDOW", 1
    )
    store = make_store(tmp_path)

    store.create_presession("198.51.100.10")

    with pytest.raises(PreSessionThrottled):
        store.create_presession("203.0.113.20")

    # Simulate the end of the global issuance window.
    with store.connection() as connection:
        connection.execute(
            """
            UPDATE login_attempts
            SET window_started = ?
            WHERE scope = 'presession_global'
            """,
            (time.time() - 61,),
        )

    replacement, _ = store.create_presession("203.0.113.20")
    assert store.lookup(replacement) is not None


def test_global_active_limit_is_enforced_across_store_instances(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(auth_module, "MAX_ACTIVE_PRESESSIONS", 2)

    first = make_store(tmp_path)
    second = AuthStore(first.path)

    token_a, _ = first.create_presession("198.51.100.10")
    token_b, _ = second.create_presession("203.0.113.20")

    with pytest.raises(PreSessionThrottled):
        first.create_presession("192.0.2.30")

    assert first.lookup(token_a) is not None
    assert second.lookup(token_b) is not None

    with first.connection() as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM sessions WHERE owner_id IS NULL"
        ).fetchone()[0]

    assert count == 2


def test_source_limit_is_shared_by_store_instances(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth_module, "MAX_PRESESSION_ISSUES_PER_SOURCE", 2
    )
    first = make_store(tmp_path)
    second = AuthStore(first.path)

    first.create_presession("198.51.100.10")
    second.create_presession("198.51.100.10")

    with pytest.raises(PreSessionThrottled):
        first.create_presession("198.51.100.10")


def test_expired_anonymous_session_releases_global_capacity(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(auth_module, "MAX_ACTIVE_PRESESSIONS", 1)
    store = make_store(tmp_path)

    expired, _ = store.create_presession("198.51.100.10")

    with pytest.raises(PreSessionThrottled):
        store.create_presession("203.0.113.20")

    with store.connection() as connection:
        connection.execute(
            """
            UPDATE sessions
            SET expires_at = ?
            WHERE token_hash = ?
            """,
            (time.time() - 1, token_digest(expired)),
        )

    replacement, _ = store.create_presession("203.0.113.20")

    assert store.lookup(expired) is None
    assert store.lookup(replacement) is not None


def test_source_budget_recovers_after_window(tmp_path, monkeypatch):
    monkeypatch.setattr(
        auth_module, "MAX_PRESESSION_ISSUES_PER_SOURCE", 1
    )
    store = make_store(tmp_path)

    store.create_presession("198.51.100.10")

    with pytest.raises(PreSessionThrottled):
        store.create_presession("198.51.100.10")

    with store.connection() as connection:
        connection.execute(
            """
            UPDATE login_attempts
            SET window_started = ?
            WHERE scope = 'presession_issuance'
            """,
            (time.time() - 61,),
        )

    token, _ = store.create_presession("198.51.100.10")
    assert store.lookup(token) is not None


def test_login_source_limit_is_shared_by_ipv6_64(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(auth_module, "MAX_SOURCE_ATTEMPTS", 1)

    monkeypatch.setattr(
        auth_module, "hash_password", lambda password, salt=None: "test-hash"
    )
    monkeypatch.setattr(
        auth_module, "verify_password", lambda password, encoded: False
    )

    store = make_store(tmp_path)

    first_address = "2001:db8:abcd:1234::1"
    second_address = "2001:db8:abcd:1234::2"

    first_token, _ = store.create_presession(first_address)
    second_token, _ = store.create_presession(second_address)

    result = store.login(
        username="owner",
        password="incorrect-password",
        previous_token=first_token,
        client_address=first_address,
    )
    assert result is None

    with pytest.raises(LoginThrottled):
        store.login(
            username="owner",
            password="incorrect-password",
            previous_token=second_token,
            client_address=second_address,
        )


def test_existing_anonymous_cookie_does_not_consume_new_issue(
    auth_store, monkeypatch,
):
    monkeypatch.setattr(
        auth_module, "MAX_PRESESSION_ISSUES_PER_SOURCE", 1
    )

    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as first:
        first.headers["Origin"] = ORIGIN

        initial = first.get("/auth/session")
        assert initial.status_code == 200
        assert "set-cookie" in initial.headers

        reused = first.get("/auth/session")
        assert reused.status_code == 200
        assert "set-cookie" not in reused.headers
        assert initial.json()["csrf_token"] == reused.json()["csrf_token"]

        with TestClient(
            api.app,
            base_url="http://localhost:8000",
        ) as second:
            second.headers["Origin"] = ORIGIN
            blocked = second.get("/auth/session")

        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "60"
        assert "set-cookie" not in blocked.headers
        assert blocked.json() == {
            "detail": "Too many session requests. Try again in a minute."
        }


def test_authenticated_session_is_not_blocked_by_anonymous_cap(
    owner_client, monkeypatch,
):
    monkeypatch.setattr(auth_module, "MAX_ACTIVE_PRESESSIONS", 0)

    response = owner_client.get("/auth/session")

    assert response.status_code == 200
    assert response.json()["user"] is not None
    assert "set-cookie" not in response.headers


def test_http_issuance_ignores_untrusted_forwarded_for(
    auth_store, monkeypatch,
):
    recorded = []
    original = auth_store.create_presession

    def capture(client_address="unknown"):
        recorded.append(client_address)
        return original(client_address)

    monkeypatch.setattr(
        auth_store,
        "create_presession",
        capture,
    )

    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as client:
        client.headers["Origin"] = ORIGIN
        response = client.get(
            "/auth/session",
            headers={
                "X-Forwarded-For": "198.51.100.99",
            },
        )

    assert response.status_code == 200
    assert recorded
    assert recorded[-1] != "198.51.100.99"
