"""Transactional visible history; resource ownership stays in the existing registry."""

import hashlib
import json
import os
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

import ownership
from evidence import ResearchReport, SourceRecord, source_title
from ownership import OwnershipError, bind_resources, require_thread, require_workspace


class HistoryError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


Citation = SourceRecord


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=1_000_000)
    status: str = Field(default="complete", pattern="^(complete|streaming|error|cancelled)$")
    createdAt: int = Field(default_factory=lambda: int(time.time() * 1000), ge=0)
    attachmentIds: list[str] = Field(default_factory=list, max_length=10)
    sources: list[Citation] = Field(default_factory=list, max_length=100)
    error: str | None = Field(default=None, max_length=1000)
    errorStatus: int | None = None
    research: ResearchReport | None = None


def encode(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: object) -> str:
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


def completed_context(messages: list[dict]) -> list[dict]:
    """Exclude unsuccessful turns and partial answers from future model context."""
    result = []
    for index, message in enumerate(messages):
        if message["role"] != "user":
            continue
        following = messages[index + 1] if index + 1 < len(messages) else None
        if (
            message["status"] == "complete"
            and following
            and following["role"] == "assistant"
            and following["status"] == "complete"
        ):
            result.extend((message, following))
    return result


class HistoryStore:
    """Keep revisions and request receipts in one SQLite transaction boundary."""

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
                has_schema = db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='history_schema'"
                ).fetchone()
                if has_schema:
                    if db.execute("SELECT version FROM history_schema").fetchone() != (1,):
                        raise RuntimeError("Unsupported conversation history schema.")
                else:
                    # Use SQLite backup so committed WAL contents are included.
                    if existed:
                        backup = self.path.with_name(
                            f"{self.path.name}.history-{time.time_ns()}.backup"
                        )
                        with closing(sqlite3.connect(backup)) as destination:
                            db.backup(destination)
                    db.executescript("""
                        BEGIN IMMEDIATE;
                        CREATE TABLE IF NOT EXISTS history_schema (version INTEGER NOT NULL);
                        INSERT INTO history_schema SELECT 1
                            WHERE NOT EXISTS (SELECT 1 FROM history_schema);
                        CREATE TABLE IF NOT EXISTS history_conversations (
                            thread_id TEXT PRIMARY KEY,
                            workspace_id TEXT NOT NULL,
                            display_id TEXT NOT NULL,
                            title TEXT NOT NULL,
                            pinned INTEGER NOT NULL DEFAULT 0,
                            model TEXT NOT NULL,
                            mode TEXT NOT NULL,
                            created_at INTEGER NOT NULL,
                            updated_at INTEGER NOT NULL,
                            version INTEGER NOT NULL DEFAULT 0,
                            deleted INTEGER NOT NULL DEFAULT 0,
                            active_revision TEXT
                        );
                        CREATE INDEX IF NOT EXISTS history_updated
                            ON history_conversations(updated_at DESC, thread_id);
                        CREATE INDEX IF NOT EXISTS history_workspace
                            ON history_conversations(workspace_id, updated_at DESC);
                        CREATE TABLE IF NOT EXISTS history_revisions (
                            id TEXT PRIMARY KEY,
                            thread_id TEXT NOT NULL REFERENCES history_conversations(thread_id),
                            parent_id TEXT REFERENCES history_revisions(id),
                            request_id TEXT NOT NULL,
                            fingerprint TEXT NOT NULL,
                            operation TEXT NOT NULL,
                            state TEXT NOT NULL,
                            messages TEXT NOT NULL,
                            created_at INTEGER NOT NULL,
                            checkpoint_id TEXT,
                            UNIQUE(thread_id, request_id)
                        );
                        CREATE INDEX IF NOT EXISTS history_revision_thread
                            ON history_revisions(thread_id, created_at DESC);
                        COMMIT;
                    """)
                if db.execute("PRAGMA foreign_key_check").fetchone():
                    raise RuntimeError("Conversation history integrity check failed.")
            self._initialized = True

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        self.initialize()
        with closing(sqlite3.connect(self.path, timeout=30)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db

    @staticmethod
    def _row(db: sqlite3.Connection, thread_id: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT * FROM history_conversations WHERE thread_id=? AND deleted=0", (thread_id,)
        ).fetchone()
        if row is None:
            raise OwnershipError()
        return row

    @staticmethod
    def _decode_messages(payload: str) -> list[dict]:
        try:
            return [
                HistoryMessage.model_validate(item).model_dump()
                for item in json.loads(payload)
            ]
        except (TypeError, ValueError) as exc:
            raise HistoryError(
                "Saved history could not be read safely. Original records are retained.",
                503,
            ) from exc

    @classmethod
    def _messages(cls, db: sqlite3.Connection, revision: str | None) -> list[dict]:
        if revision is None:
            return []
        row = db.execute("SELECT messages FROM history_revisions WHERE id=?", (revision,)).fetchone()
        return cls._decode_messages(row[0] if row else None)

    def _view(self, db: sqlite3.Connection, row: sqlite3.Row, *, messages: bool = True) -> dict:
        result = {
            "thread_id": row["thread_id"], "workspace_id": row["workspace_id"],
            "id": row["display_id"], "title": row["title"], "pinned": bool(row["pinned"]),
            "model": row["model"], "mode": row["mode"], "createdAt": row["created_at"],
            "updatedAt": row["updated_at"], "version": row["version"],
            "revision_id": row["active_revision"],
        }
        if messages:
            result["messages"] = self._messages(db, row["active_revision"])
            result["preview"] = result["messages"][-1]["content"][:200] if result["messages"] else ""
            result["running"] = db.execute(
                "SELECT 1 FROM history_revisions WHERE thread_id=? AND state='streaming' LIMIT 1",
                (row["thread_id"],),
            ).fetchone() is not None
        elif "preview" in row.keys():
            result["preview"] = row["preview"] or ""
        return result

    def get(self, thread_id: str) -> dict:
        require_thread(thread_id)
        with self.connection() as db:
            row = self._row(db, thread_id)
            require_workspace(row["workspace_id"])
            return self._view(db, row)

    def list_conversations(self) -> list[dict]:
        owned = set(ownership.store.owned_ids("thread"))
        with self.connection() as db:
            # One ordered query, no per-conversation message queries.
            rows = db.execute("""SELECT c.*, CASE WHEN json_valid(r.messages)
                THEN substr(json_extract(r.messages, '$[#-1].content'), 1, 200) ELSE '' END AS preview
                FROM history_conversations c LEFT JOIN history_revisions r ON r.id=c.active_revision
                WHERE c.deleted=0 ORDER BY c.pinned DESC, c.updated_at DESC, c.thread_id""")
            return [
                self._view(db, row, messages=False)
                for row in rows if row["thread_id"] in owned
            ]

    def deleted_threads(self) -> list[str]:
        owned = set(ownership.store.owned_ids("thread"))
        with self.connection() as db:
            rows = db.execute(
                "SELECT thread_id FROM history_conversations WHERE deleted=1"
            )
            return [row[0] for row in rows if row[0] in owned]

    def create(
        self, thread_id: str, workspace_id: str, display_id: str, model: str,
        mode: str, title: str = "New Chat",
    ) -> dict:
        bind_resources(thread_id, workspace_id)
        owned = set(ownership.store.owned_ids("thread"))
        now = int(time.time() * 1000)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM history_conversations WHERE thread_id=?", (thread_id,)
            ).fetchone()
            aliases = db.execute(
                "SELECT thread_id FROM history_conversations WHERE display_id=? AND thread_id!=?",
                (display_id, thread_id),
            )
            if any(row[0] in owned for row in aliases):
                raise HistoryError(
                    "This display identifier belongs to another saved conversation. "
                    "Original history is retained."
                )
            if existing:
                if (
                    existing["deleted"]
                    or existing["workspace_id"] != workspace_id
                    or existing["display_id"] != display_id
                ):
                    raise HistoryError(
                        "This conversation already exists with different metadata."
                    )
            else:
                db.execute(
                    "INSERT INTO history_conversations "
                    "(thread_id,workspace_id,display_id,title,model,mode,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (thread_id, workspace_id, display_id, title, model, mode, now, now),
                )
            return self._view(db, self._row(db, thread_id))

    def mutate(
        self, thread_id: str, version: int, *, title: str | None = None,
        pinned: bool | None = None, deleted: bool = False,
        workspace_id: str | None = None,
    ) -> dict:
        require_thread(thread_id)
        if workspace_id is not None:
            require_workspace(workspace_id, create=True)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, thread_id)
            if row["version"] != version:
                raise HistoryError("History changed. Reload the conversation and try again.")
            db.execute(
                "UPDATE history_conversations SET title=?,pinned=?,deleted=?,"
                "version=version+1,updated_at=? WHERE thread_id=?",
                (
                    title if title is not None else row["title"],
                    pinned if pinned is not None else row["pinned"],
                    deleted, int(time.time() * 1000), thread_id,
                ),
            )
            if workspace_id is not None:
                db.execute(
                    "UPDATE history_conversations SET workspace_id=? WHERE thread_id=?",
                    (workspace_id, thread_id),
                )
            return {"deleted": True} if deleted else self._view(db, self._row(db, thread_id))

    def remove_message(self, thread_id: str, message_id: str, version: int) -> dict:
        """Retain the old revision and remove this message and its dependent suffix."""
        require_thread(thread_id)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, thread_id)
            if row["version"] != version:
                raise HistoryError("History changed. Reload before removing messages.")
            messages = self._messages(db, row["active_revision"])
            index = next((i for i, item in enumerate(messages) if item["id"] == message_id), -1)
            if index < 0:
                raise OwnershipError()
            revision = uuid4().hex
            now = int(time.time() * 1000)
            db.execute(
                "INSERT INTO history_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    revision, thread_id, row["active_revision"], revision,
                    fingerprint(messages[:index]), "remove", "complete",
                    encode(messages[:index]), now, None,
                ),
            )
            db.execute(
                "UPDATE history_conversations SET active_revision=?,"
                "version=version+1,updated_at=? WHERE thread_id=?",
                (revision, now, thread_id),
            )
            return self._view(db, self._row(db, thread_id))

    def import_history(
        self, thread_id: str, version: int, messages: list[dict],
        import_id: str, updated_at: int,
    ) -> dict:
        require_thread(thread_id)
        messages = [HistoryMessage.model_validate(item).model_dump() for item in messages]
        if len({item["id"] for item in messages}) != len(messages):
            raise HistoryError("Imported message IDs must be unique.", 422)
        for item in messages:
            if item["status"] == "streaming":
                item["status"] = "cancelled"
            # Browser imports have no server execution provenance. Keep legacy
            # labels readable without promoting client data to verified sources.
            item["sources"] = [
                {"file": source_title(source["file"]), "page": source.get("page")}
                for source in item["sources"]
            ]
            item["research"] = None
        digest = fingerprint(messages)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, thread_id)
            receipt = db.execute(
                "SELECT fingerprint FROM history_revisions WHERE thread_id=? AND request_id=?",
                (thread_id, import_id),
            ).fetchone()
            if receipt and receipt[0] == digest:
                return self._view(db, row)
            if receipt or row["active_revision"] or row["version"] != version:
                raise HistoryError("Import conflicts with saved server history. Both copies are retained.")
            revision = uuid4().hex
            db.execute(
                "INSERT INTO history_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    revision, thread_id, None, import_id, digest, "import", "complete",
                    encode(messages), updated_at, None,
                ),
            )
            db.execute(
                "UPDATE history_conversations SET active_revision=?,"
                "version=version+1,updated_at=? WHERE thread_id=?",
                (revision, updated_at, thread_id),
            )
            return self._view(db, self._row(db, thread_id))

    def begin(self, thread_id: str, request: dict) -> tuple[dict, bool]:
        """Reserve one execution; exact repeats return its durable receipt."""
        require_thread(thread_id)
        digest = fingerprint(request)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, thread_id)
            prior = db.execute(
                "SELECT * FROM history_revisions WHERE thread_id=? AND request_id=?",
                (thread_id, request["request_id"]),
            ).fetchone()
            if prior:
                if prior["fingerprint"] != digest:
                    raise HistoryError("This request ID has already been used for different input.")
                return dict(prior), True
            if row["version"] != request["version"]:
                raise HistoryError("History changed. Reload the conversation and try again.")
            if row["active_revision"] is None and self._has_legacy_payload(db, thread_id):
                raise HistoryError(
                    "This thread has legacy history. "
                    "Explicitly import its browser history before continuing."
                )
            messages = self._messages(db, row["active_revision"])
            operation = request["operation"]
            target_id = request.get("target_message_id")
            if operation != "send":
                index = next((i for i, item in enumerate(messages) if item["id"] == target_id), -1)
                if index < 0:
                    raise OwnershipError()
                target = messages[index]
                if operation == "edit":
                    if target["role"] != "user":
                        raise HistoryError("Only user messages can be edited.", 422)
                    user = {**target, "content": request["message"]}
                else:
                    if (
                        index == 0 or target["role"] != "assistant"
                        or messages[index - 1]["role"] != "user"
                    ):
                        raise HistoryError("This response has no preceding user message.", 422)
                    if operation == "retry" and target["status"] == "complete":
                        raise HistoryError("Use regenerate for a completed response.", 422)
                    index -= 1
                    user = messages[index]
                messages = messages[:index]
            else:
                user = HistoryMessage(
                    id=request["user_message_id"], role="user", content=request["message"],
                    attachmentIds=request["attachment_ids"],
                ).model_dump()
            assistant = HistoryMessage(
                id=request["assistant_message_id"], role="assistant",
                content="", status="streaming",
            ).model_dump()
            existing_ids = {item["id"] for item in messages}
            if user["id"] in existing_ids or assistant["id"] in existing_ids | {user["id"]}:
                raise HistoryError("Message IDs must be unique.")
            messages = messages + [user, assistant]
            if len(messages) > 2000 or sum(len(item["content"]) for item in messages) > 3_000_000:
                raise HistoryError(
                    "This conversation has reached its history limit. Start a new conversation.",
                    413,
                )
            revision = uuid4().hex
            now = int(time.time() * 1000)
            db.execute(
                "INSERT INTO history_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    revision, thread_id, row["active_revision"], request["request_id"],
                    digest, operation, "streaming", encode(messages), now, None,
                ),
            )
            active_revision = revision if operation == "send" else row["active_revision"]
            db.execute(
                "UPDATE history_conversations SET version=version+1,updated_at=?,"
                "model=?,mode=?,active_revision=? WHERE thread_id=?",
                (now, request["model"], request["mode"], active_revision, thread_id),
            )
            receipt = db.execute(
                "SELECT * FROM history_revisions WHERE id=?", (revision,)
            ).fetchone()
            return dict(receipt), False

    def _has_legacy_payload(self, db: sqlite3.Connection, thread_id: str) -> bool:
        """Do not replace an owned legacy checkpoint merely because its UI is empty."""
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "chat_messages" in tables and db.execute(
            "SELECT 1 FROM chat_messages WHERE thread_id=? LIMIT 1", (thread_id,)
        ).fetchone():
            return True
        checkpoint_path = self.path.parent / "langgraph_checkpoints.sqlite"
        if not checkpoint_path.exists():
            return False
        uri = checkpoint_path.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as checkpoints:
            exists = checkpoints.execute(
                "SELECT 1 FROM sqlite_master WHERE name='checkpoints'"
            ).fetchone()
            if not exists:
                return False
            return checkpoints.execute(
                "SELECT 1 FROM checkpoints WHERE thread_id=? LIMIT 1", (thread_id,)
            ).fetchone() is not None

    def progress(self, thread_id: str, revision: str, content: str) -> None:
        require_thread(thread_id)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT state FROM history_revisions WHERE id=? AND thread_id=?",
                (revision, thread_id),
            ).fetchone()
            if row is None or row[0] != "streaming":
                return
            messages = self._messages(db, revision)
            messages[-1]["content"] = content
            db.execute("UPDATE history_revisions SET messages=? WHERE id=?", (encode(messages), revision))

    def finish(
        self, thread_id: str, revision: str, content: str, state: str,
        *, error: str | None = None, status: int | None = None,
        sources: list[dict] | None = None, checkpoint_id: str | None = None,
        research: dict | None = None,
    ) -> None:
        require_thread(thread_id)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT state FROM history_revisions WHERE id=? AND thread_id=?",
                (revision, thread_id),
            ).fetchone()
            if row is None or row[0] != "streaming":
                return
            messages = self._messages(db, revision)
            messages[-1].update(
                content=content, status=state, error=error, errorStatus=status, research=research,
                sources=[Citation.model_validate(item).model_dump(exclude_none=True) for item in sources or []],
            )
            db.execute(
                "UPDATE history_revisions SET messages=?,state=?,checkpoint_id=? WHERE id=?",
                (encode(messages), state, checkpoint_id, revision),
            )
            db.execute(
                "UPDATE history_conversations SET version=version+1,updated_at=?,"
                "active_revision=CASE WHEN ?='complete' THEN ? ELSE active_revision END "
                "WHERE thread_id=?",
                (int(time.time() * 1000), state, revision, thread_id),
            )

    def recover(self, thread_id: str) -> None:
        """Called only while holding the thread lease; never resume tool execution."""
        require_thread(thread_id)
        with self.connection() as db:
            rows = db.execute(
                "SELECT id FROM history_revisions WHERE thread_id=? AND state='streaming'",
                (thread_id,),
            ).fetchall()
        for row in rows:
            with self.connection() as db:
                messages = self._messages(db, row[0])
            self.finish(
                thread_id, row[0], messages[-1]["content"], "cancelled",
                error="The previous execution was interrupted. No actions were replayed.",
            )

    def revisions(self, thread_id: str) -> list[dict]:
        self.get(thread_id)
        with self.connection() as db:
            rows = db.execute(
                "SELECT id,operation,state,created_at FROM history_revisions "
                "WHERE thread_id=? ORDER BY created_at,id", (thread_id,),
            ).fetchall()
            return [
                {"id": row["id"], "operation": row["operation"], "state": row["state"],
                 "createdAt": row["created_at"]}
                for row in rows
            ]

    def revision(self, thread_id: str, revision_id: str) -> dict:
        self.get(thread_id)
        with self.connection() as db:
            row = db.execute(
                "SELECT * FROM history_revisions WHERE thread_id=? AND id=?",
                (thread_id, revision_id),
            ).fetchone()
            if row is None:
                raise OwnershipError()
            return {
                "id": row["id"], "state": row["state"],
                "messages": self._decode_messages(row["messages"]),
            }


store = HistoryStore(
    Path(os.getenv("CLAWBIT_RUNTIME_DIR", Path(__file__).parent)) / "data" / "chatbot_memory.db"
)
