
"""Regression coverage for bounded chat request input."""

import json

import pytest

import app as api
from chat_execution import (
    MAX_CHAT_ATTACHMENT_REFS,
    MAX_CHAT_BODY_BYTES,
    MAX_CHAT_MESSAGE_CHARS,
)


ENDPOINTS = ("/chat", "/chat/stream")


@pytest.fixture
def no_agent(monkeypatch):
    """A rejected request must never construct an agent."""

    async def forbidden(*args, **kwargs):
        pytest.fail(
            "Rejected chat input must not start an agent."
        )

    monkeypatch.setattr(
        api,
        "get_agent",
        forbidden,
    )


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_oversized_body_is_rejected_before_graph(
    owner_client,
    no_agent,
    endpoint,
):
    response = owner_client.post(
        endpoint,
        content=b"x" * (MAX_CHAT_BODY_BYTES + 1),
        headers={
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 413
    assert response.json() == {
        "detail": "Chat request exceeds the size limit."
    }


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_oversized_message_is_rejected_before_graph(
    owner_client,
    no_agent,
    endpoint,
):
    response = owner_client.post(
        endpoint,
        json={
            "message": "x" * (
                MAX_CHAT_MESSAGE_CHARS + 1
            ),
        },
    )

    assert response.status_code == 413
    assert response.json() == {
        "detail": "Chat message exceeds the character limit."
    }


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_too_many_attachment_references_are_rejected(
    owner_client,
    no_agent,
    endpoint,
):
    response = owner_client.post(
        endpoint,
        json={
            "message": "Summarize the documents.",
            "attachment_ids": [
                f"attachment-{index}"
                for index in range(
                    MAX_CHAT_ATTACHMENT_REFS + 1
                )
            ],
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Too many attachment references."
    }


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize(
    "invalid_id",
    [
        "",
        "../private",
        "file/name",
        "a" * 129,
        {"id": "unexpected-object"},
    ],
)
def test_malformed_attachment_references_are_rejected(
    owner_client,
    no_agent,
    endpoint,
    invalid_id,
):
    response = owner_client.post(
        endpoint,
        json={
            "message": "Use this file.",
            "attachment_ids": [invalid_id],
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Invalid attachment reference."
    }


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_duplicate_attachment_references_are_rejected(
    owner_client,
    no_agent,
    endpoint,
):
    reference = "a" * 32

    response = owner_client.post(
        endpoint,
        json={
            "message": "Use this file.",
            "attachment_ids": [
                reference,
                reference,
            ],
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": (
            "Duplicate attachment references "
            "are not allowed."
        )
    }


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_invalid_input_cannot_start_streaming(
    owner_client,
    no_agent,
    endpoint,
):
    response = owner_client.post(
        endpoint,
        json={
            "message": "x" * (
                MAX_CHAT_MESSAGE_CHARS + 1
            ),
            "thread_id": "safe-thread",
        },
    )

    assert response.status_code == 413
    assert "text/event-stream" not in response.headers.get(
        "content-type",
        "",
    )
    assert "event: done" not in response.text


def test_bounded_request_chunks(
    owner_client,
    no_agent,
):
    def chunks():
        payload = json.dumps({
            "message": "x" * MAX_CHAT_BODY_BYTES,
        }).encode("utf-8")

        for index in range(0, len(payload), 8192):
            yield payload[index:index + 8192]

    response = owner_client.post(
        "/chat/stream",
        content=chunks(),
        headers={
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 413
    assert response.json() == {
        "detail": "Chat request exceeds the size limit."
    }
