"""PostgreSQL implementation of Clawbit's existing authentication contract."""

from contextlib import contextmanager
from pathlib import Path
import threading
from typing import Iterator

from auth_store import AuthStore
from postgres_db import PostgresConnection, postgres_connection


class PostgresAuthStore(AuthStore):
    """Use Neon Postgres while preserving AuthStore's security behavior."""

    def __init__(self):
        self.path: Path | None = None
        self._initialized = False
        self._schema_lock = threading.Lock()

    def initialize(self) -> None:
        with self._schema_lock:
            if self._initialized:
                return

            with postgres_connection() as connection:
                row = connection.execute("""
                    SELECT
                        to_regclass('public.users') AS users_table,
                        to_regclass('public.user_identity') AS identity_table,
                        to_regclass('public.sessions') AS sessions_table,
                        to_regclass('public.login_attempts') AS attempts_table,
                        to_regclass('public.setup_tokens') AS setup_table
                """).fetchone()

            required = (
                "users_table",
                "identity_table",
                "sessions_table",
                "attempts_table",
                "setup_table",
            )
            missing = [name for name in required if row[name] is None]
            if missing:
                raise RuntimeError(
                    "Neon authentication schema is incomplete. "
                    "Run setup_postgres_schema.py before starting Clawbit."
                )

            self._initialized = True

    @contextmanager
    def connection(self) -> Iterator[PostgresConnection]:
        self.initialize()
        with postgres_connection() as connection:
            yield connection

    def _after_admin_created(self, connection: PostgresConnection) -> None:
        # The admin is inserted with explicit id=1. Advance the identity sequence
        # so the next public account receives a fresh ID rather than colliding.
        connection.execute("""
            SELECT setval(
                pg_get_serial_sequence('users', 'id'),
                GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1),
                true
            )
        """)
