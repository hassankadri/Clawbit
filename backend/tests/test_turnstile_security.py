"""Offline tests for the server-side signup bot challenge."""

import json
from urllib.parse import parse_qs

import turnstile_security


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        return self.payload[:limit]


def test_turnstile_accepts_only_successful_signup_for_allowed_hostname(
    monkeypatch,
):
    seen = {}

    def fake_urlopen(request, timeout):
        seen["url"] = request.full_url
        seen["body"] = parse_qs(request.data.decode("ascii"))
        seen["timeout"] = timeout

        return FakeResponse({
            "success": True,
            "hostname": "clawbit.example",
            "action": "signup",
        })

    monkeypatch.setattr(
        turnstile_security,
        "urlopen",
        fake_urlopen,
    )

    assert turnstile_security.verify_turnstile(
        "one-time-token",
        "server-secret",
        expected_hostnames={"clawbit.example"},
        expected_action="signup",
        remote_ip="203.0.113.10",
    ) is True

    assert seen["url"] == turnstile_security.SITEVERIFY_URL

    assert seen["body"] == {
        "secret": ["server-secret"],
        "response": ["one-time-token"],
        "remoteip": ["203.0.113.10"],
    }

    assert seen["timeout"] == turnstile_security.VERIFY_TIMEOUT_SECONDS


def test_turnstile_rejects_failed_action_and_untrusted_hostname(
    monkeypatch,
):
    payload = {
        "success": True,
        "hostname": "clawbit.example",
        "action": "login",
    }

    monkeypatch.setattr(
        turnstile_security,
        "urlopen",
        lambda *_args, **_kwargs: FakeResponse(payload),
    )

    assert not turnstile_security.verify_turnstile(
        "token",
        "secret",
        expected_hostnames={"clawbit.example"},
        expected_action="signup",
    )

    payload["action"] = "signup"
    payload["hostname"] = "attacker.example"

    assert not turnstile_security.verify_turnstile(
        "token",
        "secret",
        expected_hostnames={"clawbit.example"},
        expected_action="signup",
    )

    payload["success"] = False
    payload["hostname"] = "clawbit.example"

    assert not turnstile_security.verify_turnstile(
        "token",
        "secret",
        expected_hostnames={"clawbit.example"},
        expected_action="signup",
    )


def test_turnstile_rejects_missing_oversized_tokens_without_network(
    monkeypatch,
):
    calls = []

    monkeypatch.setattr(
        turnstile_security,
        "urlopen",
        lambda *_args, **_kwargs: calls.append(True),
    )

    for token in (
        "",
        None,
        "x" * (turnstile_security.MAX_TOKEN_LENGTH + 1),
    ):
        assert not turnstile_security.verify_turnstile(
            token,
            "secret",
            expected_hostnames={"clawbit.example"},
            expected_action="signup",
        )

    assert calls == []


def test_turnstile_fails_closed_when_siteverify_is_unavailable(
    monkeypatch,
):
    def unavailable(*_args, **_kwargs):
        raise TimeoutError("offline")

    monkeypatch.setattr(
        turnstile_security,
        "urlopen",
        unavailable,
    )

    assert not turnstile_security.verify_turnstile(
        "token",
        "secret",
        expected_hostnames={"clawbit.example"},
        expected_action="signup",
    )