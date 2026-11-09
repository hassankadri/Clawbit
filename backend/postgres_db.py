"""Small synchronous PostgreSQL adapter for request-time Clawbit stores.

Local development continues to use sqlite3. In deployed mode, request stores use
Neon's pooled PostgreSQL URL through psycopg 3. This adapter intentionally
implements only the small DB-API surface used by Clawbit's existing stores.
"""

from __future__ import annotations

from contextlib import contextmanager
from threading import RLock
from typing import Any, Iterator
import os
import re

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


_POOL: ConnectionPool | None = None
_POOL_DSN: str | None = None
_POOL_LOCK = RLock()


class HybridRow(dict):
    """Dictionary row that also supports SQLite-style positional access."""

    def __getitem__(self, key: str | int) -> Any:
        if isinstance(key, int):
            try:
                return tuple(self.values())[key]
            except IndexError:
                raise IndexError(key) from None
        return super().__getitem__(key)


class PostgresCursor:
    def __init__(self, cursor: Any):
        self._cursor = cursor

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount

    @property
    def description(self) -> Any:
        return self._cursor.description

    @property
    def lastrowid(self) -> None:
        # PostgreSQL inserts must use RETURNING explicitly.
        return None

    @staticmethod
    def _row(value: Any) -> HybridRow | None:
        if value is None:
            return None
        return HybridRow(value)

    def fetchone(self) -> HybridRow | None:
        return self._row(self._cursor.fetchone())

    def fetchall(self) -> list[HybridRow]:
        return [HybridRow(row) for row in self._cursor.fetchall()]

    def fetchmany(self, size: int | None = None) -> list[HybridRow]:
        rows = self._cursor.fetchmany(size) if size is not None else self._cursor.fetchmany()
        return [HybridRow(row) for row in rows]

    def __iter__(self):
        for row in self._cursor:
            yield HybridRow(row)


def _qmark_to_pyformat(sql: str) -> str:
    """Convert DB-API qmark parameters without touching quoted string literals."""
    result: list[str] = []
    quote: str | None = None
    index = 0

    while index < len(sql):
        char = sql[index]

        if quote:
            result.append(char)
            if char == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    result.append(sql[index + 1])
                    index += 1
                else:
                    quote = None
        elif char in {"'", '"'}:
            quote = char
            result.append(char)
        elif char == "?":
            result.append("%s")
        else:
            result.append(char)

        index += 1

    return "".join(result)


def translate_sql(sql: str) -> str:
    """Translate the small SQLite SQL subset used by request-time stores."""
    statement = sql.strip()
    statement = re.sub(r"^BEGIN IMMEDIATE$", "BEGIN", statement, flags=re.IGNORECASE)
    statement = re.sub(r"\s+COLLATE\s+NOCASE\b", "", statement, flags=re.IGNORECASE)
    statement = re.sub(
        r"\bdatetime\(\s*'now'\s*\)",
        "CURRENT_TIMESTAMP",
        statement,
        flags=re.IGNORECASE,
    )
    return _qmark_to_pyformat(statement)


class PostgresConnection:
    """Compatibility wrapper around a pooled psycopg connection."""

    def __init__(self, connection: Any):
        self._connection = connection

    @property
    def row_factory(self) -> Any:
        return dict_row

    @row_factory.setter
    def row_factory(self, value: Any) -> None:
        # Rows are always HybridRow, which supports both name and index access.
        return None

    def execute(self, sql: str, parameters: Any = ()) -> PostgresCursor:
        return PostgresCursor(self._connection.execute(translate_sql(sql), parameters))

    def executemany(self, sql: str, parameters: Any) -> PostgresCursor:
        return PostgresCursor(self._connection.executemany(translate_sql(sql), parameters))

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        # The pool owns the underlying connection and returns it on context exit.
        return None


def _get_pool() -> ConnectionPool:
    global _POOL, _POOL_DSN

    dsn = os.getenv("DATABASE_URL", "").strip()
    if not dsn:
        raise RuntimeError("DATABASE_URL is required for PostgreSQL persistence.")
    if not dsn.startswith(("postgres://", "postgresql://")):
        raise RuntimeError("DATABASE_URL must be a PostgreSQL URL.")

    with _POOL_LOCK:
        if _POOL is not None and _POOL_DSN == dsn and not _POOL.closed:
            return _POOL

        if _POOL is not None and not _POOL.closed:
            _POOL.close()

        _POOL = ConnectionPool(
            conninfo=dsn,
            min_size=1,
            max_size=3,
            open=False,
            timeout=12,
            max_idle=60,
            max_lifetime=300,
            kwargs={
                "autocommit": False,
                "prepare_threshold": None,
                "row_factory": dict_row,
            },
        )
        _POOL.open(wait=True, timeout=12)
        _POOL_DSN = dsn
        return _POOL


@contextmanager
def postgres_connection() -> Iterator[PostgresConnection]:
    """Borrow one pooled connection and commit/rollback at context exit."""
    pool = _get_pool()
    with pool.connection(timeout=12) as connection:
        yield PostgresConnection(connection)


def close_postgres_pool() -> None:
    """Best-effort pool close for local shutdown hooks and tests."""
    global _POOL, _POOL_DSN

    with _POOL_LOCK:
        if _POOL is not None and not _POOL.closed:
            _POOL.close()
        _POOL = None
        _POOL_DSN = None
