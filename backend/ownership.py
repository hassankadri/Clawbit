"""Server-side ownership for immutable thread and workspace identifiers."""

from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
import os
import sqlite3
import threading
from typing import Callable, Iterator

from dotenv import load_dotenv

from upload_security import validate_thread_id


class OwnershipError(Exception):
    """Missing, unclaimed and foreign resources share the same public response."""

    status_code = 404

    def __init__(self, message: str = "Resource not found.") -> None:
        super().__init__(message)


class SessionExpiredError(OwnershipError):
    """A revoked session differs from a missing or foreign resource."""

    status_code = 401

    def __init__(self) -> None:
        super().__init__("Your session expired. Sign in to continue.")


_principal: ContextVar[str | None] = ContextVar("clawbit_principal", default=None)
_session_validator: ContextVar[Callable[[], bool] | None] = ContextVar(
    "clawbit_session_validator", default=None,
)


@contextmanager
def owner_context(
    principal_id: str | None, validate_session: Callable[[], bool] | None = None,
) -> Iterator[None]:
    """Bind a verified identity; only server entry points may establish context."""
    token = _principal.set(principal_id)
    validation_token = _session_validator.set(validate_session)
    try:
        yield
    finally:
        _principal.reset(token)
        _session_validator.reset(validation_token)


def current_owner() -> str:
    principal = _principal.get()
    if not principal:
        raise OwnershipError()
    return principal


def require_active_owner() -> str:
    """Recheck long-running credential operations against their initiating session."""
    from chat_execution import check_execution_active

    check_execution_active()
    principal = current_owner()
    validate = _session_validator.get()
    if validate is not None and not validate():
        raise SessionExpiredError()
    return principal


class OwnershipStore:
    """Keep ownership separate from legacy payloads, with atomic first creation."""

    def __init__(self, root: Path):
        self.root = root
        self.path = root / "data" / "ownership.sqlite3"
        self._lock = threading.Lock()
        self._initialized = False

    def initialize(self) -> None:
        with self._lock:
            if self._initialized:
                return
            from ownership_migration import inventory

            # Reserve legacy IDs before accepting any new resource claims.
            resources = inventory(self.root)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.connection(initialize=False) as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1):
                    raise RuntimeError("Unsupported ownership database version.")
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS resources (
                        kind TEXT NOT NULL CHECK(kind IN ('thread', 'workspace')),
                        resource_id TEXT NOT NULL,
                        principal_id TEXT,
                        PRIMARY KEY(kind, resource_id)
                    );
                    CREATE TABLE IF NOT EXISTS claims (
                        claim_id TEXT PRIMARY KEY,
                        principal_id TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        resource_count INTEGER NOT NULL,
                        backup_path TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS claim_resources (
                        claim_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        resource_id TEXT NOT NULL,
                        PRIMARY KEY(claim_id, kind, resource_id)
                    );
                    CREATE TABLE IF NOT EXISTS rollbacks (
                        claim_id TEXT PRIMARY KEY,
                        created_at REAL NOT NULL,
                        backup_path TEXT NOT NULL
                    );
                    PRAGMA user_version = 1;
                """)
                connection.executemany(
                    "INSERT OR IGNORE INTO resources VALUES (?, ?, NULL)",
                    sorted(resources),
                )
            self._initialized = True

    @contextmanager
    def connection(self, *, initialize: bool = True) -> Iterator[sqlite3.Connection]:
        if initialize:
            self.initialize()
        connection = sqlite3.connect(self.path, timeout=30)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def authorize(
        self, kind: str, resource_id: str, *, create: bool = False,
        missing_ok: bool = False,
    ) -> None:
        validate_thread_id(resource_id)
        principal = current_owner()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT principal_id FROM resources WHERE kind = ? AND resource_id = ?",
                (kind, resource_id),
            ).fetchone()
            if row is None and create:
                connection.execute(
                    "INSERT INTO resources VALUES (?, ?, ?)",
                    (kind, resource_id, principal),
                )
            elif row is None and missing_ok:
                return
            elif row is None or row[0] != principal:
                raise OwnershipError()

    def owned_ids(self, kind: str) -> list[str]:
        principal = current_owner()
        with self.connection() as connection:
            return [row[0] for row in connection.execute(
                "SELECT resource_id FROM resources WHERE kind = ? AND principal_id = ?",
                (kind, principal),
            )]


# This module can be imported before models/rag load the same absolute .env.
# Resolve the runtime root consistently, regardless of import order.
load_dotenv(Path(__file__).resolve().parent / ".env")
store = OwnershipStore(Path(os.getenv("CLAWBIT_RUNTIME_DIR", Path(__file__).parent)))


def require_thread(thread_id: str, *, create: bool = False, missing_ok: bool = False) -> None:
    store.authorize("thread", thread_id, create=create, missing_ok=missing_ok)


def require_workspace(workspace_id: str, *, create: bool = False) -> None:
    store.authorize("workspace", workspace_id, create=create)


def bind_resources(thread_id: str, workspace_id: str) -> None:
    """Authorize both identifiers before entering graph or memory operations."""
    require_thread(thread_id, create=True)
    require_workspace(workspace_id, create=True)
