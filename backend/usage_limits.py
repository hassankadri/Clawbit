"""Atomic local usage budgets; identities come only from verified owner context."""

from contextlib import aclosing, closing, contextmanager
from collections.abc import Callable, Iterator
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
import inspect
import math
import os
from pathlib import Path
import secrets
import sqlite3
from threading import Lock
import time

from ownership import require_active_owner


class UsageLimitError(Exception):
    """A public, credential-free rejection understood by HTTP and SSE handlers."""

    status_code = 429

    def __init__(self, kind: str, retry_after: int):
        self.retry_after = max(1, retry_after)
        self.kind = kind
        messages = {
            "rate": "Too many requests.",
            "quota": "The local daily usage quota has been reached.",
            "concurrency": "Too many operations are already running.",
            "tools": "This response reached its tool-call budget.",
        }
        super().__init__(f"{messages[kind]} Try again in {self.retry_after} seconds.")


@dataclass(frozen=True)
class Policy:
    per_minute: int
    per_day: int
    concurrent: int
    global_concurrent: int


DEFAULTS = {
    "chat": Policy(20, 500, 2, 4),
    "inference": Policy(40, 1000, 2, 4),
    "embedding": Policy(60, 2000, 2, 4),
    "upload": Policy(10, 100, 2, 4),
    "ingestion": Policy(10, 100, 1, 2),
    "retrieval": Policy(60, 2000, 2, 4),
    "mcp": Policy(30, 500, 2, 4),
    "mcp_execution": Policy(60, 1000, 4, 8),
    "tool": Policy(60, 2000, 4, 8),
}


def _positive_setting(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < 1:
        raise ValueError(f"{name} must be a positive integer.")
    return value


def configured_policies() -> dict[str, Policy]:
    return {
        name: Policy(**{
            field_name: _positive_setting(
                f"CLAWBIT_LIMIT_{name.upper()}_{field_name.upper()}",
                getattr(policy, field_name),
            )
            for field_name in Policy.__dataclass_fields__
        })
        for name, policy in DEFAULTS.items()
    }


def _process_stamp(pid: int) -> str | None:
    """Distinguish dead workers and reused PIDs without expiring active leases."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [
            ctypes.POINTER(wintypes.FILETIME)
        ] * 4
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            # Access denied is not evidence that a worker has exited.
            return "unknown" if ctypes.get_last_error() == 5 else None
        try:
            times = [wintypes.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
                return "unknown"
            return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
        finally:
            kernel.CloseHandle(handle)
    try:
        # Linux start ticks follow the parenthesized command (which may contain spaces).
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except FileNotFoundError:
        return None
    except OSError:
        return "unknown"


class UsageStore:
    """Use BEGIN IMMEDIATE to admit all counters and leases in one transaction."""

    def __init__(
        self, path: Path, policies: dict[str, Policy] | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.path = path
        self.policies = policies if policies is not None else configured_policies()
        self.clock = clock
        self._ready = False
        self._lock = Lock()

    def _connect(self) -> sqlite3.Connection:
        with self._lock:
            if not self._ready:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with closing(sqlite3.connect(self.path, timeout=10)) as db, db:
                    db.executescript("""
                        CREATE TABLE IF NOT EXISTS usage (
                            principal TEXT NOT NULL, operation TEXT NOT NULL,
                            period INTEGER NOT NULL, window INTEGER NOT NULL,
                            count INTEGER NOT NULL,
                            PRIMARY KEY (principal, operation, period, window)
                        );
                        CREATE TABLE IF NOT EXISTS leases (
                            id TEXT PRIMARY KEY, principal TEXT NOT NULL,
                            operation TEXT NOT NULL, pid INTEGER NOT NULL,
                            process_stamp TEXT NOT NULL
                        );
                        CREATE TABLE IF NOT EXISTS connector_epochs (
                            principal TEXT NOT NULL, provider TEXT NOT NULL,
                            generation INTEGER NOT NULL,
                            PRIMARY KEY (principal, provider)
                        );
                    """)
                self._ready = True
        return sqlite3.connect(self.path, timeout=10)

    def acquire(self, operation: str) -> str:
        principal = require_active_owner()
        policy = self.policies[operation]
        now = self.clock()
        lease = secrets.token_hex(16)
        pid = os.getpid()
        stamp = _process_stamp(pid)
        if stamp is None or stamp == "unknown":
            raise RuntimeError("Cannot establish local worker identity.")
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            for old_pid, old_stamp in db.execute(
                "SELECT DISTINCT pid, process_stamp FROM leases"
            ).fetchall():
                observed = _process_stamp(old_pid)
                if observed is None or (observed != "unknown" and observed != old_stamp):
                    db.execute(
                        "DELETE FROM leases WHERE pid=? AND process_stamp=?",
                        (old_pid, old_stamp),
                    )
            # A fixed UTC minute/day is predictable across workers and restarts.
            for period, maximum, kind in (
                (60, policy.per_minute, "rate"), (86400, policy.per_day, "quota")
            ):
                window = int(now // period)
                for subject, ceiling in ((principal, maximum), ("*", maximum * 4)):
                    row = db.execute(
                        "SELECT count FROM usage WHERE principal=? AND operation=? "
                        "AND period=? AND window=?",
                        (subject, operation, period, window),
                    ).fetchone()
                    if row and row[0] >= ceiling:
                        raise UsageLimitError(kind, math.ceil((window + 1) * period - now))
            owned, total = db.execute(
                "SELECT COALESCE(SUM(principal=?),0), COUNT(*) FROM leases "
                "WHERE operation=?", (principal, operation),
            ).fetchone()
            if owned >= policy.concurrent or total >= policy.global_concurrent:
                raise UsageLimitError("concurrency", 5)
            for period in (60, 86400):
                window = int(now // period)
                db.execute("DELETE FROM usage WHERE period=? AND window<?", (period, window))
                for subject in (principal, "*"):
                    db.execute(
                        "INSERT INTO usage VALUES(?,?,?,?,1) ON CONFLICT "
                        "(principal,operation,period,window) DO UPDATE SET count=count+1",
                        (subject, operation, period, window),
                    )
            db.execute(
                "INSERT INTO leases VALUES(?,?,?,?,?)",
                (lease, principal, operation, pid, stamp),
            )
        return lease

    def release(self, lease: str) -> None:
        with closing(self._connect()) as db, db:
            db.execute("DELETE FROM leases WHERE id=?", (lease,))

    def acquire_thread(self, thread_id: str) -> str:
        """Exclude overlapping checkpoint writers, including other local workers."""
        principal = require_active_owner()
        operation = f"thread:{thread_id}"
        pid = os.getpid()
        stamp = _process_stamp(pid)
        if stamp is None or stamp == "unknown":
            raise RuntimeError("Cannot establish local worker identity.")
        lease = secrets.token_hex(16)
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            for existing, old_pid, old_stamp in db.execute(
                "SELECT id,pid,process_stamp FROM leases WHERE operation=?",
                (operation,),
            ).fetchall():
                observed = _process_stamp(old_pid)
                if observed is None or (observed != "unknown" and observed != old_stamp):
                    db.execute("DELETE FROM leases WHERE id=?", (existing,))
                else:
                    raise UsageLimitError("concurrency", 5)
            db.execute(
                "INSERT INTO leases VALUES(?,?,?,?,?)",
                (lease, principal, operation, pid, stamp),
            )
        return lease

    def connector_epoch(
        self, provider: str, *, advance: bool = False, expected: int | None = None,
    ) -> int:
        """Persist revocation versions, never credentials, across local workers."""
        principal = require_active_owner()
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
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
                    "INSERT INTO connector_epochs VALUES(?,?,?) "
                    "ON CONFLICT(principal,provider) DO UPDATE SET generation=excluded.generation",
                    (principal, provider, generation),
                )
            return generation


store = UsageStore(
    Path(os.getenv("CLAWBIT_RUNTIME_DIR", Path(__file__).resolve().parent))
    / "data" / "usage.sqlite3"
)
_active: ContextVar[frozenset[tuple[str, str]]] = ContextVar("active_usage", default=frozenset())


@contextmanager
def operation_budget(operation: str, *, label: str | None = None) -> Iterator[None]:
    """Charge once across nested SDK generate/stream methods, not per token."""
    active = _active.get()
    key = (require_active_owner(), operation)
    if key in active:
        yield
        return
    usage_store = store
    from observability import event, failure_category, identifier_tag

    started = time.perf_counter()
    metadata = {"tool_tag": identifier_tag(label)} if label else {}
    try:
        lease = usage_store.acquire(operation)
    except UsageLimitError as exc:
        event(operation, "rate_limited", retry_after=exc.retry_after, category=exc.kind, **metadata)
        raise
    token = _active.set(active | {key})
    event(operation, "started", **metadata)
    try:
        yield
    except BaseException as exc:
        event(operation, failure_category(exc), error=exc, **metadata)
        raise
    else:
        event(operation, "complete", duration_ms=round((time.perf_counter() - started) * 1000, 3), **metadata)
    finally:
        _active.reset(token)
        usage_store.release(lease)


def limited(operation: str):
    """Apply the same admission/finally boundary to sync, async and streaming work."""
    def decorate(function):
        if inspect.isasyncgenfunction(function):
            @wraps(function)
            async def async_stream(*args, **kwargs):
                with operation_budget(operation, label=function.__name__):
                    async with aclosing(function(*args, **kwargs)) as source:
                        async for item in source:
                            yield item
            return async_stream
        if inspect.iscoroutinefunction(function):
            @wraps(function)
            async def asynchronous(*args, **kwargs):
                with operation_budget(operation, label=function.__name__):
                    return await function(*args, **kwargs)
            return asynchronous
        if inspect.isgeneratorfunction(function):
            @wraps(function)
            def stream(*args, **kwargs):
                with operation_budget(operation, label=function.__name__):
                    yield from function(*args, **kwargs)
            return stream
        @wraps(function)
        def synchronous(*args, **kwargs):
            with operation_budget(operation, label=function.__name__):
                return function(*args, **kwargs)
        return synchronous
    return decorate


@dataclass
class ToolBudget:
    maximum: int
    used: int = 0
    lock: Lock = field(default_factory=Lock)

    def reserve(self, count: int) -> None:
        with self.lock:
            if self.used + count > self.maximum:
                raise UsageLimitError("tools", 60)
            self.used += count


_tools: ContextVar[ToolBudget | None] = ContextVar("tool_budget", default=None)


@contextmanager
def request_budget() -> Iterator[None]:
    """Share one atomic tool-call budget across all tasks serving a response."""
    token = _tools.set(ToolBudget(_positive_setting("CLAWBIT_TOOL_CALLS_PER_RESPONSE", 12)))
    try:
        yield
    finally:
        _tools.reset(token)


def reserve_tool_calls(count: int) -> None:
    budget = _tools.get()
    if budget is None:
        # Direct graph callers also receive a server-created budget.
        budget = ToolBudget(_positive_setting("CLAWBIT_TOOL_CALLS_PER_RESPONSE", 12))
        _tools.set(budget)
    budget.reserve(count)
