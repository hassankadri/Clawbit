"""Distributed usage quotas and expiring leases for Neon-backed deployments."""

import math
import secrets
import time
from collections.abc import Callable

from ownership import require_active_owner
from postgres_db import postgres_connection
from usage_limits import Policy, UsageLimitError, configured_policies


class PostgresUsageStore:
    """Atomic request budgets shared across independent Vercel invocations."""

    def __init__(
        self,
        policies: dict[str, Policy] | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.policies = policies if policies is not None else configured_policies()
        self.clock = clock
        self._ready = False

    def initialize(self) -> None:
        if self._ready:
            return

        with postgres_connection() as db:
            row = db.execute("""
                SELECT
                    to_regclass('public.usage') AS usage_table,
                    to_regclass('public.leases') AS leases_table,
                    to_regclass('public.connector_epochs') AS epochs_table
            """).fetchone()

        if any(row[key] is None for key in ("usage_table", "leases_table", "epochs_table")):
            raise RuntimeError(
                "Neon usage schema is incomplete. "
                "Run setup_postgres_schema.py before starting Clawbit."
            )

        self._ready = True

    def acquire(self, operation: str) -> str:
        self.initialize()
        principal = require_active_owner()
        policy = self.policies[operation]
        now = self.clock()
        lease = secrets.token_hex(16)

        with postgres_connection() as db:
            # Serialize quota admission for one operation across all function
            # instances. PostgreSQL releases this lock automatically on commit.
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                (f"clawbit:usage:{operation}",),
            )
            db.execute("DELETE FROM leases WHERE expires_at <= ?", (now,))

            for period, maximum, kind in (
                (60, policy.per_minute, "rate"),
                (86400, policy.per_day, "quota"),
            ):
                window = int(now // period)
                for subject, ceiling in ((principal, maximum), ("*", maximum * 4)):
                    row = db.execute(
                        "SELECT count FROM usage WHERE principal=? AND operation=? "
                        "AND period=? AND window=?",
                        (subject, operation, period, window),
                    ).fetchone()
                    if row and row[0] >= ceiling:
                        raise UsageLimitError(
                            kind,
                            math.ceil((window + 1) * period - now),
                        )

            owned, total = db.execute(
                "SELECT COUNT(*) FILTER (WHERE principal=?), COUNT(*) "
                "FROM leases WHERE operation=?",
                (principal, operation),
            ).fetchone()
            if owned >= policy.concurrent or total >= policy.global_concurrent:
                raise UsageLimitError("concurrency", 5)

            for period in (60, 86400):
                window = int(now // period)
                db.execute(
                    "DELETE FROM usage WHERE period=? AND window<?",
                    (period, window),
                )
                for subject in (principal, "*"):
                    db.execute(
                        """
                        INSERT INTO usage(principal,operation,period,window,count)
                        VALUES(?,?,?,?,1)
                        ON CONFLICT(principal,operation,period,window)
                        DO UPDATE SET count=usage.count+1
                        """,
                        (subject, operation, period, window),
                    )

            db.execute(
                "INSERT INTO leases(id,principal,operation,expires_at) VALUES(?,?,?,?)",
                (lease, principal, operation, now + 900),
            )

        return lease

    def release(self, lease: str) -> None:
        self.initialize()
        with postgres_connection() as db:
            db.execute("DELETE FROM leases WHERE id=?", (lease,))

    def acquire_thread(self, thread_id: str) -> str:
        """Exclude overlapping checkpoint writers across serverless instances."""
        self.initialize()
        principal = require_active_owner()
        operation = f"thread:{thread_id}"
        lease = secrets.token_hex(16)
        now = self.clock()

        with postgres_connection() as db:
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                (f"clawbit:{operation}",),
            )
            db.execute("DELETE FROM leases WHERE expires_at <= ?", (now,))
            existing = db.execute(
                "SELECT id FROM leases WHERE operation=? LIMIT 1",
                (operation,),
            ).fetchone()
            if existing is not None:
                raise UsageLimitError("concurrency", 5)

            db.execute(
                "INSERT INTO leases(id,principal,operation,expires_at) VALUES(?,?,?,?)",
                (lease, principal, operation, now + 300),
            )

        return lease

    def acquire_upload_thread(self, thread_id: str) -> str:
        """Serialize upload/delete operations without blocking chat generation."""
        self.initialize()
        principal = require_active_owner()
        operation = f"upload:{thread_id}"
        lease = secrets.token_hex(16)
        now = self.clock()

        with postgres_connection() as db:
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                (f"clawbit:{operation}",),
            )
            db.execute("DELETE FROM leases WHERE expires_at <= ?", (now,))
            existing = db.execute(
                "SELECT id FROM leases WHERE operation=? LIMIT 1",
                (operation,),
            ).fetchone()
            if existing is not None:
                raise UsageLimitError("concurrency", 5)

            db.execute(
                "INSERT INTO leases(id,principal,operation,expires_at) VALUES(?,?,?,?)",
                (lease, principal, operation, now + 300),
            )

        return lease

    def acquire_connector_refresh(self, provider: str, *, ttl_seconds: int = 90) -> str | None:
        """Acquire a short, distributed lease for one account's OAuth refresh.

        A competing Vercel instance returns None and waits for the first instance
        to publish its refreshed token. The lease expires if the function dies.
        """
        self.initialize()
        principal = require_active_owner()
        now = self.clock()
        lease = secrets.token_hex(16)
        operation = f"oauth-refresh:{principal}:{provider}"

        with postgres_connection() as db:
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                (f"clawbit:{operation}",),
            )
            db.execute("DELETE FROM leases WHERE expires_at <= ?", (now,))
            existing = db.execute(
                "SELECT id FROM leases WHERE principal=? AND operation=? LIMIT 1",
                (principal, operation),
            ).fetchone()
            if existing is not None:
                return None

            db.execute(
                "INSERT INTO leases(id,principal,operation,expires_at) VALUES(?,?,?,?)",
                (lease, principal, operation, now + max(15, min(ttl_seconds, 180))),
            )

        return lease

    def connector_epoch(
        self,
        provider: str,
        *,
        advance: bool = False,
        expected: int | None = None,
    ) -> int:
        """Persist connector revocation versions independently of function memory."""
        self.initialize()
        principal = require_active_owner()

        with postgres_connection() as db:
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                (f"clawbit:connector:{principal}:{provider}",),
            )
            row = db.execute(
                "SELECT generation FROM connector_epochs WHERE principal=? AND provider=?",
                (principal, provider),
            ).fetchone()
            generation = row[0] if row else 0

            if expected is not None and generation != expected:
                raise RuntimeError("Connector state changed. Reconnect and try again.")

            if advance:
                generation += 1
                db.execute(
                    """
                    INSERT INTO connector_epochs(principal,provider,generation)
                    VALUES(?,?,?)
                    ON CONFLICT(principal,provider)
                    DO UPDATE SET generation=EXCLUDED.generation
                    """,
                    (principal, provider, generation),
                )

            return generation
