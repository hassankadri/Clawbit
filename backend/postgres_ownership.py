"""PostgreSQL ownership registry for serverless deployments."""

from contextlib import contextmanager
from typing import Iterator

from postgres_db import PostgresConnection, postgres_connection
from ownership import OwnershipError, current_owner
from upload_security import validate_thread_id


class PostgresOwnershipStore:
    """Atomic, principal-scoped ownership records in Neon Postgres."""

    def __init__(self):
        self._initialized = False

    def initialize(self) -> None:
        if self._initialized:
            return

        with postgres_connection() as connection:
            row = connection.execute("""
                SELECT
                    to_regclass('public.resources') AS resources_table,
                    to_regclass('public.claims') AS claims_table,
                    to_regclass('public.claim_resources') AS claim_resources_table,
                    to_regclass('public.rollbacks') AS rollbacks_table
            """).fetchone()

        required = (
            "resources_table",
            "claims_table",
            "claim_resources_table",
            "rollbacks_table",
        )
        missing = [name for name in required if row[name] is None]
        if missing:
            raise RuntimeError(
                "Neon ownership schema is incomplete. "
                "Run setup_postgres_schema.py before starting Clawbit."
            )

        self._initialized = True

    @contextmanager
    def connection(self, *, initialize: bool = True) -> Iterator[PostgresConnection]:
        if initialize:
            self.initialize()
        with postgres_connection() as connection:
            yield connection

    def authorize(
        self,
        kind: str,
        resource_id: str,
        *,
        create: bool = False,
        missing_ok: bool = False,
    ) -> None:
        if kind not in {"thread", "workspace"}:
            raise OwnershipError()
        validate_thread_id(resource_id)
        principal = current_owner()

        with self.connection() as connection:
            if create:
                # A concurrent first-use race is resolved by the unique key.
                # ON CONFLICT never changes the existing principal assignment.
                connection.execute(
                    """
                    INSERT INTO resources(kind, resource_id, principal_id)
                    VALUES (?, ?, ?)
                    ON CONFLICT(kind, resource_id) DO NOTHING
                    """,
                    (kind, resource_id, principal),
                )

            row = connection.execute(
                """
                SELECT principal_id
                FROM resources
                WHERE kind = ? AND resource_id = ?
                """,
                (kind, resource_id),
            ).fetchone()

            if row is None and missing_ok:
                return

            if row is None or row[0] != principal:
                raise OwnershipError()

    def owned_ids(self, kind: str) -> list[str]:
        if kind not in {"thread", "workspace"}:
            return []
        principal = current_owner()

        with self.connection() as connection:
            return [
                row[0]
                for row in connection.execute(
                    """
                    SELECT resource_id
                    FROM resources
                    WHERE kind = ? AND principal_id = ?
                    """,
                    (kind, principal),
                )
            ]
