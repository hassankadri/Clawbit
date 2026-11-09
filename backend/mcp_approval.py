"""One-time, owner-scoped confirmation for MCP actions.

Approvals are deliberately process-local. Clawbit currently runs
one backend worker. Pending requests are never persisted, and
restart, cancellation, expiry or denial cannot grant approval.
"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from ownership import current_owner, require_active_owner


APPROVAL_TIMEOUT_SECONDS = 60
MAX_PENDING_APPROVALS = 8
MAX_ARGUMENT_BYTES = 8192


def _postgres_enabled() -> bool:
    import os

    return os.getenv("CLAWBIT_PERSISTENCE_BACKEND", "sqlite").strip().lower() == "postgres"

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
    """Require owner confirmation for every MCP connector operation.

    A read-only tool can still expose private connector data to the model.
    Provider-supplied readOnlyHint metadata is descriptive, not user consent.
    """
    return True


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

    if _postgres_enabled():
        return await _require_postgres_approval(
            owner, provider, tool, preview, timeout=timeout
        )

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
            await asyncio.wait_for(
                approval.event.wait(),
                timeout=timeout,
            )

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


async def _require_postgres_approval(
    owner: str,
    provider: str,
    tool: str,
    preview: str,
    *,
    timeout: float,
) -> None:
    """Wait for a durable decision that can be posted by another function instance."""
    import asyncio
    from postgres_db import postgres_connection

    now = time.time()
    approval_id = uuid.uuid4().hex
    expires_at = now + timeout

    try:
        with postgres_connection() as db:
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                (f"clawbit:approval:{owner}",),
            )
            db.execute(
                "DELETE FROM pending_approvals WHERE expires_at <= ?",
                (now,),
            )
            pending = db.execute(
                """
                SELECT COUNT(*)
                FROM pending_approvals
                WHERE owner=? AND decision IS NULL AND expires_at>?
                """,
                (owner, now),
            ).fetchone()[0]
            if pending >= MAX_PENDING_APPROVALS:
                raise ApprovalRejected(
                    "Too many pending MCP approvals. Try again later."
                )
            db.execute(
                """
                INSERT INTO pending_approvals
                    (id,owner,provider,tool,arguments,created_at,expires_at,decision,decided_at)
                VALUES(?,?,?,?,?,?,?,NULL,NULL)
                """,
                (approval_id, owner, provider, tool, preview, now, expires_at),
            )
    except ApprovalRejected:
        raise
    except Exception:
        raise ApprovalRejected(
            "MCP approval storage is temporarily unavailable. No external action was performed."
        ) from None

    try:
        while True:
            require_active_owner()
            try:
                with postgres_connection() as db:
                    row = db.execute(
                        """
                        SELECT decision, expires_at
                        FROM pending_approvals
                        WHERE id=? AND owner=?
                        """,
                        (approval_id, owner),
                    ).fetchone()
            except Exception:
                raise ApprovalRejected(
                    "MCP approval status is unavailable. No external action was performed."
                ) from None

            if row is None:
                raise ApprovalRejected(
                    "MCP action approval was canceled. No external action was performed."
                )
            if row["decision"] is True:
                require_active_owner()
                return
            if row["decision"] is False:
                raise ApprovalRejected(
                    "MCP action was denied. No external action was performed."
                )
            if row["expires_at"] <= time.time():
                raise ApprovalRejected(
                    "MCP action approval expired. No external action was performed."
                )

            await asyncio.sleep(0.5)
    finally:
        try:
            with postgres_connection() as db:
                db.execute(
                    "DELETE FROM pending_approvals WHERE id=? AND owner=?",
                    (approval_id, owner),
                )
        except Exception:
            # A stale pending row expires and is deleted by the next admission.
            pass


def pending_approvals() -> list[dict[str, Any]]:
    owner = require_active_owner()
    if _postgres_enabled():
        from postgres_db import postgres_connection

        now = time.time()
        with postgres_connection() as db:
            rows = db.execute(
                """
                SELECT id,provider,tool,arguments,expires_at
                FROM pending_approvals
                WHERE owner=? AND decision IS NULL AND expires_at>?
                ORDER BY created_at
                """,
                (owner, now),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "provider": row["provider"],
                "tool": row["tool"],
                "arguments": row["arguments"],
                "expires_in": max(0, int(row["expires_at"] - now)),
            }
            for row in rows
        ]

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
    if _postgres_enabled():
        if type(approve) is not bool:
            return False
        from postgres_db import postgres_connection

        now = time.time()
        with postgres_connection() as db:
            row = db.execute(
                """
                UPDATE pending_approvals
                SET decision=?, decided_at=?
                WHERE id=? AND owner=? AND decision IS NULL AND expires_at>?
                RETURNING id
                """,
                (approve, now, approval_id, owner, now),
            ).fetchone()
        return row is not None

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


def cancel_pending_approvals(
    provider: str | None = None,
) -> None:
    """Revoke pending actions during connector changes or logout."""
    owner = current_owner()
    if _postgres_enabled():
        from postgres_db import postgres_connection

        with postgres_connection() as db:
            if provider is None:
                db.execute(
                    """
                    UPDATE pending_approvals
                    SET decision=FALSE, decided_at=?
                    WHERE owner=? AND decision IS NULL
                    """,
                    (time.time(), owner),
                )
            else:
                db.execute(
                    """
                    UPDATE pending_approvals
                    SET decision=FALSE, decided_at=?
                    WHERE owner=? AND provider=? AND decision IS NULL
                    """,
                    (time.time(), owner, provider),
                )
        return

    for item in list(_pending.values()):
        if (
            item.owner == owner
            and item.decision is None
            and (provider is None or item.provider == provider)
        ):
            item.decision = False
            item.event.set()