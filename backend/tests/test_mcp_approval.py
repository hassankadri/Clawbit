
"""Offline security regression tests for MCP action approval."""

import asyncio

import pytest
from fastapi.testclient import TestClient

import app as api
from mcp_approval import (
    ApprovalRejected,
    decide_approval,
    needs_approval,
    pending_approvals,
    require_mcp_approval,
)
from ownership import owner_context


@pytest.mark.parametrize(
    "name,metadata,expected",
    [
        ("list_issues", {"readOnlyHint": True}, False),
        ("get_file", {"readOnlyHint": True}, False),
        ("create_issue", {"readOnlyHint": True}, True),
        ("deleteRepository", {"readOnlyHint": True}, True),
        ("post_message", {}, True),
        ("unknown_tool", {}, True),
        ("update_file", {"readOnlyHint": False}, True),
    ],
)
def test_action_classification(name, metadata, expected):
    assert needs_approval(name, metadata) is expected


def test_explicit_approval_is_one_time():
    async def scenario():
        with owner_context("approval-owner"):
            task = asyncio.create_task(
                require_mcp_approval(
                    "github",
                    "create_issue",
                    {"title": "Offline verification"},
                    timeout=2,
                )
            )
            await asyncio.sleep(0)

            actions = pending_approvals()
            assert len(actions) == 1
            assert actions[0]["provider"] == "github"

            approval_id = actions[0]["id"]
            assert decide_approval(approval_id, True)
            assert not decide_approval(approval_id, True)

            await task
            assert pending_approvals() == []

    asyncio.run(scenario())


def test_denial_prevents_approval():
    async def scenario():
        with owner_context("approval-owner"):
            task = asyncio.create_task(
                require_mcp_approval(
                    "slack",
                    "post_message",
                    {"text": "Do not send"},
                    timeout=2,
                )
            )
            await asyncio.sleep(0)

            approval_id = pending_approvals()[0]["id"]
            assert decide_approval(approval_id, False)

            with pytest.raises(ApprovalRejected, match="denied"):
                await task

            assert pending_approvals() == []

    asyncio.run(scenario())


def test_expired_approval_is_denied():
    async def scenario():
        with owner_context("approval-owner"):
            with pytest.raises(ApprovalRejected, match="expired"):
                await require_mcp_approval(
                    "stripe",
                    "create_payment",
                    {"amount": 100},
                    timeout=0.01,
                )

            assert pending_approvals() == []

    asyncio.run(scenario())


def test_one_owner_cannot_approve_another_owners_action():
    async def scenario():
        with owner_context("owner-one"):
            task = asyncio.create_task(
                require_mcp_approval(
                    "github",
                    "create_issue",
                    {"title": "Restricted"},
                    timeout=2,
                )
            )
            await asyncio.sleep(0)
            approval_id = pending_approvals()[0]["id"]

        with owner_context("owner-two"):
            assert pending_approvals() == []
            assert not decide_approval(approval_id, True)

        with owner_context("owner-one"):
            assert decide_approval(approval_id, False)

            with pytest.raises(ApprovalRejected):
                await task

    asyncio.run(scenario())


def test_approval_arguments_redact_credentials():
    async def scenario():
        with owner_context("approval-owner"):
            task = asyncio.create_task(
                require_mcp_approval(
                    "github",
                    "update_secret",
                    {
                        "name": "CONFIG",
                        "api_key": "private-example-value",
                    },
                    timeout=2,
                )
            )
            await asyncio.sleep(0)

            item = pending_approvals()[0]
            assert "private-example-value" not in item["arguments"]
            assert "[REDACTED]" in item["arguments"]

            assert decide_approval(item["id"], False)

            with pytest.raises(ApprovalRejected):
                await task

    asyncio.run(scenario())


def test_anonymous_cannot_access_approval_endpoints(auth_store):
    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as client:
        client.headers["Origin"] = "http://localhost:3000"

        assert client.get("/mcp/approvals").status_code == 401
        assert (
            client.post(
                "/mcp/approvals/unknown",
                json={"approve": True},
            ).status_code
            == 401
        )


def test_authenticated_approval_endpoints(owner_client):
    response = owner_client.get("/mcp/approvals")

    assert response.status_code == 200
    assert response.json() == {"pending": []}

    response = owner_client.post(
        "/mcp/approvals/unknown",
        json={"approve": True},
    )

    assert response.status_code == 404


def test_approval_decision_requires_csrf(owner_client):
    token = owner_client.headers.pop("X-CSRF-Token")

    try:
        response = owner_client.post(
            "/mcp/approvals/unknown",
            json={"approve": True},
        )

        assert response.status_code == 403
    finally:
        owner_client.headers["X-CSRF-Token"] = token
