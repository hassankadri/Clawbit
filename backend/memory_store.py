"""Versioned management of existing SQLite memories and explicit user preferences."""

import hashlib
import os
import re
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Iterator

import ownership
from ownership import OwnershipError, current_owner, require_active_owner, require_workspace


class MemoryStoreError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def checked_memory(content: str) -> str:
    text = " ".join(content.split())
    if not text or len(text) > 2000:
        raise MemoryStoreError("Memory must contain between 1 and 2,000 characters.", 422)
    patterns = (
        r"(?i)\b(password|passwd|api[_ -]?key|access[_ -]?token|session[_ -]?(cookie|token)|secret)\s*[:=]",
        r"(?i)\bbearer\s+\S+", r"\b(?:sk-|gh[pousr]_|AIza)[A-Za-z0-9_-]{12,}",
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        r"-----BEGIN .*PRIVATE KEY-----", r"\b[A-Za-z0-9_+/=-]{48,}\b",
    )
    if any(re.search(pattern, text) for pattern in patterns):
        raise MemoryStoreError("Credentials and sensitive tokens cannot be saved as memory.", 422)
    return text


def user_workspace() -> str:
    return "user-memory-" + hashlib.sha256(current_owner().encode()).hexdigest()[:32]


class MemoryStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._initialized = False

    def initialize(self) -> None:
        with self._lock:
            if self._initialized:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            existed = self.path.exists()
            with closing(sqlite3.connect(self.path, timeout=30)) as db:
                schema = db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='memory_schema'"
                ).fetchone()
                if schema:
                    if db.execute("SELECT version FROM memory_schema").fetchone() != (1,):
                        raise MemoryStoreError("Unsupported memory schema.", 503)
                else:
                    if existed:
                        backup = self.path.with_name(f"{self.path.name}.memory-{time.time_ns()}.backup")
                        with closing(sqlite3.connect(backup)) as destination:
                            db.backup(destination)
                    db.executescript("""
                        BEGIN IMMEDIATE;
                        CREATE TABLE IF NOT EXISTS long_term_memory (
                            id INTEGER PRIMARY KEY, thread_id VARCHAR, memory TEXT,
                            created_at DATETIME, workspace_id VARCHAR
                        );
                        CREATE TABLE IF NOT EXISTS memory_schema(version INTEGER NOT NULL);
                        INSERT INTO memory_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM memory_schema);
                        CREATE TABLE IF NOT EXISTS memory_details (
                            memory_id INTEGER PRIMARY KEY REFERENCES long_term_memory(id),
                            scope TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
                            deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
                        );
                        CREATE TABLE IF NOT EXISTS memory_audit (
                            id INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL,
                            principal TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL
                        );
                        CREATE INDEX IF NOT EXISTS memory_workspace_lookup
                            ON long_term_memory(workspace_id, id);
                        COMMIT;
                    """)
                if db.execute("PRAGMA foreign_key_check").fetchone():
                    raise MemoryStoreError("Memory integrity check failed.", 503)
            self._initialized = True

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        self.initialize()
        with closing(sqlite3.connect(self.path, timeout=30)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            yield db

    @staticmethod
    def scope_workspace(scope: str, workspace: str | None, *, create: bool = False) -> str:
        require_active_owner()
        if scope not in {"workspace", "user"}:
            raise MemoryStoreError("Unknown memory scope.", 422)
        target = user_workspace() if scope == "user" else workspace
        if not target:
            raise MemoryStoreError("Choose a workspace for this memory.", 422)
        require_workspace(target, create=create)
        return target

    @staticmethod
    def _rows(db: sqlite3.Connection, workspace: str) -> list[sqlite3.Row]:
        return db.execute(
            "SELECT m.*,COALESCE(d.scope,'workspace') AS scope,"
            "COALESCE(d.version,0) AS version FROM long_term_memory m "
            "LEFT JOIN memory_details d ON d.memory_id=m.id "
            "WHERE m.workspace_id=? AND COALESCE(d.deleted,0)=0 ORDER BY m.id DESC",
            (workspace,),
        ).fetchall()

    def list(self, scope: str, workspace: str | None) -> list[dict]:
        require_active_owner()
        target = user_workspace() if scope == "user" else workspace
        if scope not in {"workspace", "user"} or not target:
            raise MemoryStoreError("Choose a valid memory scope.", 422)
        ownership.store.authorize("workspace", target, missing_ok=True)
        if target not in ownership.store.owned_ids("workspace"):
            return []
        with self.connection() as db:
            return [
                {"id": row["id"], "content": row["memory"], "scope": row["scope"],
                 "workspace_id": target, "version": row["version"]}
                for row in self._rows(db, target)
                if isinstance(row["memory"], str) and row["scope"] == scope
            ]

    def save(
        self, content: str, scope: str, workspace: str | None,
        thread: str | None = None,
    ) -> tuple[dict, bool]:
        """Create one explicit memory, deduplicating within the owned workspace."""
        content = checked_memory(content)
        target = self.scope_workspace(scope, workspace, create=True)
        now = int(time.time() * 1000)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in self._rows(db, target):
                if (isinstance(row["memory"], str)
                        and " ".join(row["memory"].split()).casefold() == content.casefold()):
                    return {"id": row["id"], "version": row["version"]}, True
            cursor = db.execute(
                "INSERT INTO long_term_memory(thread_id,workspace_id,memory,created_at) "
                "VALUES(?,?,?,datetime('now'))", (thread, target, content),
            )
            memory_id = cursor.lastrowid
            db.execute("INSERT INTO memory_details VALUES(?,?,0,0,?)", (memory_id, scope, now))
            db.execute(
                "INSERT INTO memory_audit(memory_id,principal,action,created_at) VALUES(?,?,?,?)",
                (memory_id, current_owner(), "create", now),
            )
            return {"id": memory_id, "version": 0}, False

    def change(
        self, memory_id: int, version: int, scope: str,
        workspace: str | None, content: str | None,
    ) -> dict:
        """Update or tombstone a memory only if its saved version still matches."""
        target = self.scope_workspace(scope, workspace)
        value = checked_memory(content) if content is not None else None
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = self._rows(db, target)
            row = next((item for item in rows if item["id"] == memory_id and item["scope"] == scope), None)
            if row is None:
                raise OwnershipError()
            if row["version"] != version:
                raise MemoryStoreError("Memory changed. Reload before updating it.")
            if value is not None and any(
                item["id"] != memory_id and isinstance(item["memory"], str)
                and " ".join(item["memory"].split()).casefold() == value.casefold() for item in rows
            ):
                raise MemoryStoreError("That memory is already saved.")
            now = int(time.time() * 1000)
            db.execute(
                "INSERT INTO memory_details VALUES(?,?,?,?,?) ON CONFLICT(memory_id) "
                "DO UPDATE SET version=excluded.version,deleted=excluded.deleted,updated_at=excluded.updated_at",
                (memory_id, scope, version + 1, int(value is None), now),
            )
            if value is not None:
                db.execute("UPDATE long_term_memory SET memory=? WHERE id=?", (value, memory_id))
            db.execute(
                "INSERT INTO memory_audit(memory_id,principal,action,created_at) VALUES(?,?,?,?)",
                (memory_id, current_owner(), "delete" if value is None else "update", now),
            )
            return {"id": memory_id, "version": version + 1, "deleted": value is None}

    def context(self, query: str, workspace: str) -> str:
        """Select at most five relevant memories; never fall back to all memories."""
        tokens = set(re.findall(r"[\w]+", query.casefold())) - {
            "the", "a", "an", "is", "are", "and", "or", "to", "of", "in", "my", "me", "i", "what",
        }
        candidates = self.list("workspace", workspace) + self.list("user", None)
        scored = []
        for item in candidates:
            try:
                content = checked_memory(item["content"])
            except MemoryStoreError:
                continue
            score = len(tokens & set(re.findall(r"[\w]+", content.casefold())))
            if score:
                scored.append((score, item["id"], content))
        scored.sort(reverse=True)
        return "\n".join(f"- {item[2]}" for item in scored[:5])[:4000]


store = MemoryStore(
    Path(os.getenv("CLAWBIT_RUNTIME_DIR", Path(__file__).parent)) / "data" / "chatbot_memory.db"
)
