"""Bounded structured diagnostics without request bodies or exception messages."""

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import hashlib
from itertools import islice
import json
import logging
import math
import os
from pathlib import Path
import re
import time
import traceback
import uuid
from typing import Iterator

from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id: ContextVar[str | None] = ContextVar("log_request_id", default=None)
logger = logging.getLogger("clawbit")
_NUMERIC = {"status_code", "duration_ms", "count", "retrieved", "unknown", "retry_after"}
_LABELS = {
    "status": {"started", "complete", "failed", "cancelled", "denied", "rate_limited", "partial"},
    "operation": {"http", "auth", "authorization", "chat", "inference", "embedding", "upload",
                  "ingestion", "retrieval", "reranking", "mcp", "mcp_execution", "tool",
                  "research", "citations", "memory", "history", "provider", "checkpoint"},
    "provider": {"google", "groq", "openrouter"},
    "mode": {"normal", "research"},
    "method": {"GET", "POST", "PATCH", "DELETE", "OPTIONS", "HEAD", "PUT"},
    "category": {"authentication", "csrf", "origin", "transport", "session", "unavailable",
                 "invalid", "quota", "concurrency", "rate", "tools", "persistence", "ownership"},
    "action": {"connect", "disconnect", "discover", "create", "read", "update", "delete"},
}


def identifier_tag(value: str) -> str:
    """Bound untrusted tool/model labels without copying their text into logs."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def redact(value: object, *, depth: int = 0) -> object:
    """Keep only known fields and bounded primitives; unknown text is discarded.

    This deliberately avoids heuristic replacement of secrets in arbitrary prose.
    It is a logging boundary, not a general-purpose data anonymizer.
    """
    if depth > 3:
        return "[redacted]"
    if isinstance(value, dict):
        result = {}
        for key, item in islice(value.items(), 24):
            if key in _LABELS and isinstance(item, str) and item in _LABELS[key]:
                result[key] = item
            elif key in _NUMERIC and (
                type(item) is int or (type(item) is float and math.isfinite(item))
            ):
                result[key] = max(-1e12, min(item, 1e12))
            elif (
                key in {"tool_tag", "model_tag"}
                and isinstance(item, str)
                and re.fullmatch(r"[0-9a-f]{16}", item)
            ):
                result[key] = item
            elif key == "details":
                result[key] = redact(item, depth=depth + 1)
            else:
                # Even unknown keys may contain private text, so don't retain them.
                result["redacted_fields"] = result.get("redacted_fields", 0) + 1
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item, depth=depth + 1) for item in value[:8]]
    return "[redacted]"


def failure_category(exc: BaseException) -> str:
    if isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
        return "cancelled"
    return "rate_limited" if getattr(exc, "status_code", None) == 429 else "failed"


def response_outcome(status_code: int, streaming: bool, terminal: str | None) -> str:
    if terminal is not None:
        return terminal
    if streaming:
        return "cancelled"
    if status_code == 429:
        return "rate_limited"
    if status_code >= 500:
        return "failed"
    return "denied" if status_code >= 400 else "complete"


def event(operation: str, status: str, *, error: BaseException | None = None, **fields) -> None:
    """Emit safe metadata. Exception text, causes, locals and payloads are omitted."""
    data = redact({"operation": operation, "status": status, **fields})
    data["timestamp"] = datetime.now(timezone.utc).isoformat()
    data["request_id"] = request_id.get()
    data["severity"] = "WARNING" if status in {"failed", "denied", "rate_limited"} else "INFO"
    if error is not None and logger.isEnabledFor(logging.DEBUG):
        # Frame locations are useful during development without formatting the
        # exception, source line, locals or its possibly credential-bearing cause.
        data["frames"] = [
            {"module": Path(frame.filename).name, "line": frame.lineno}
            for frame in traceback.extract_tb(error.__traceback__)[-8:]
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\.py", Path(frame.filename).name)
        ]
    logger.log(logging.WARNING if data["severity"] == "WARNING" else logging.INFO,
               json.dumps(data, separators=(",", ":"), allow_nan=False))


def configure_logging() -> None:
    """Configure only the application logger, leaving third-party logs separate."""
    level = os.getenv("CLAWBIT_LOG_LEVEL", "INFO").upper()
    logger.setLevel(level if level in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"} else "INFO")
    if not any(getattr(handler, "clawbit_handler", False) for handler in logger.handlers):
        handler = logging.StreamHandler()
        handler.clawbit_handler = True
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.propagate = False


@contextmanager
def persistence_boundary(operation: str) -> Iterator[None]:
    """Report storage failures without changing exceptions or cancellation."""
    try:
        yield
    except Exception as exc:
        event(operation, "failed", error=exc, category="persistence")
        raise


class RequestLoggingMiddleware:
    """Correlate complete ASGI lifetimes, including authentication and SSE cleanup."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        token = request_id.set(uuid.uuid4().hex)
        started = time.perf_counter()
        status_code = 500
        streaming = False
        terminal = None
        failure = None

        async def traced_send(message: Message) -> None:
            nonlocal status_code, streaming, terminal
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = list(message.get("headers", []))
                streaming = any(key.lower() == b"content-type" and b"text/event-stream" in value
                                for key, value in headers)
                headers.append((b"x-request-id", request_id.get().encode("ascii")))
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body" and streaming:
                # Inspect only the fixed protocol prefix; never decode token text.
                prefix = message.get("body", b"")[:14]
                if prefix.startswith(b"event: error\n"):
                    terminal = "failed"
                elif prefix.startswith(b"event: done\n"):
                    terminal = "complete"
            await send(message)

        event("http", "started", method=scope.get("method"))
        try:
            await self.app(scope, receive, traced_send)
        except BaseException as exc:
            failure = exc
            raise
        finally:
            status = failure_category(failure) if failure else response_outcome(
                status_code, streaming, terminal,
            )
            try:
                event("http", status, error=failure, status_code=status_code,
                      duration_ms=round((time.perf_counter() - started) * 1000, 3))
                if streaming:
                    event("chat", status)
            finally:
                request_id.reset(token)
