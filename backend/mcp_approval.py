
"""One-time, owner-scoped confirmation for MCP actions.

Approvals are deliberately process-local. Clawbit currently runs
one backend worker. Pending requests are never persisted, and
restart, cancellation, expiry or denial cannot grant approval.
"""

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from ownership import current_owner, require_active_owner


APPROVAL_TIMEOUT_SECONDS = 60
MAX_PENDING_APPROVALS = 8
MAX_ARGUMENT_BYTES = 8192

SENSITIVE_KEYS = (
    "password",
    "secret",
    "token",
    "credential",
    "authorization",
    "api_key",
    "apikey",
    "private_key",
)

WRITE_VERBS = frozenset({
    "add", "archive", "cancel", "change", "close",
    "commit", "create", "delete", "edit", "execute",
    "invite", "merge", "modify", "move", "post",
    "publish", "react", "refund", "remove", "rename",
    "reply", "send", "set", "submit", "transfer",
    "update", "upload", "write",
})


class ApprovalRejected(Exception):
    """The action cannot execute without explicit confirmation."""


@dataclass
class PendingApproval:
    id: str
    owner: str
    provider: str
    tool: str
    arguments: str
    created_at: float
    expires_at: float
    event: asyncio.Event = field(default_factory=asyncio.Event)
    decision: bool | None = None


_pending: dict[str, PendingApproval] = {}


def needs_approval(
    name: str,
    metadata: dict[str, Any] | None,
) -> bool:
    """Treat missing read-only annotations as requiring approval.

    A write-like tool name also requires approval even if the
    provider incorrectly marks it read-only.
    """
    words = re.findall(
        r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+",
        name.replace("-", "_"),
    )
    parts = {
        word.lower()
        for segment in name.split("_")
        for word in (
            re.findall(
                r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+",
                segment,
            ) or [segment]
        )
    }
    parts.update(word.lower() for word in words)

    if parts & WRITE_VERBS:
        return True

    return not (
        isinstance(metadata, dict)
        and metadata.get("readOnlyHint") is True
    )


def _masked(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): (
                "[REDACTED]"
                if any(term in str(key).lower() for term in SENSITIVE_KEYS)
                else _masked(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_masked(item) for item in value]
    return value


async def require_mcp_approval(
    provider: str,
    tool: str,
    arguments: dict[str, Any],
    *,
    timeout: float = APPROVAL_TIMEOUT_SECONDS,
) -> None:
    """Suspend this tool call until the authenticated owner decides."""
    owner = require_active_owner()

    try:
        serialized = json.dumps(
            arguments,
            ensure_ascii=False,
            sort_keys=True,
            allow_nan=False,
        )
        if len(serialized.encode("utf-8")) > MAX_ARGUMENT_BYTES:
            raise ApprovalRejected(
                "MCP action arguments exceed the approval display limit."
            )
        preview = json.dumps(
            _masked(arguments),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError, OverflowError) as exc:
        raise ApprovalRejected(
            "MCP action arguments cannot be reviewed safely."
        ) from exc

    if len(_pending) >= MAX_PENDING_APPROVALS:
        raise ApprovalRejected(
            "Too many pending MCP approvals. Try again later."
        )

    now = time.monotonic()
    approval = PendingApproval(
        id=uuid.uuid4().hex,
        owner=owner,
        provider=provider,
        tool=tool,
        arguments=preview,
        created_at=now,
        expires_at=now + timeout,
    )
    _pending[approval.id] = approval

    try:
        try:
            await asyncio.wait_for(approval.event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            raise ApprovalRejected(
                "MCP action approval expired. No external action was performed."
            ) from None

        require_active_owner()

        if approval.decision is not True:
            raise ApprovalRejected(
                "MCP action was denied. No external action was performed."
            )
    finally:
        _pending.pop(approval.id, None)


def pending_approvals() -> list[dict[str, Any]]:
    owner = require_active_owner()
    now = time.monotonic()

    return [
        {
            "id": item.id,
            "provider": item.provider,
            "tool": item.tool,
            "arguments": item.arguments,
            "expires_in": max(0, int(item.expires_at - now)),
        }
        for item in _pending.values()
        if (
            item.owner == owner
            and item.decision is None
            and item.expires_at > now
        )
    ]


def decide_approval(
    approval_id: str,
    approve: bool,
) -> bool:
    owner = require_active_owner()
    item = _pending.get(approval_id)

    if (
        item is None
        or item.owner != owner
        or item.decision is not None
        or item.expires_at <= time.monotonic()
        or type(approve) is not bool
    ):
        return False

    item.decision = approve
    item.event.set()
    return True


def cancel_pending_approvals(provider: str | None = None) -> None:
    """Revoke pending actions during connector changes or logout."""
    owner = current_owner()

    for item in list(_pending.values()):
        if (
            item.owner == owner
            and item.decision is None
            and (provider is None or item.provider == provider)
        ):
            item.decision = False
            item.event.set()
