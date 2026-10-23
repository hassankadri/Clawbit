
"""Own chat cancellation, request limits and thread leases."""

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field
import json
import re

from starlette.responses import JSONResponse, StreamingResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ownership import require_thread
import usage_limits


MAX_CHAT_BODY_BYTES = 512 * 1024
MAX_CHAT_MESSAGE_CHARS = 65_536
MAX_CHAT_ATTACHMENT_REFS = 10
MAX_CHAT_ATTACHMENT_ID_CHARS = 128

_ATTACHMENT_ID_PATTERN = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z"
)


@dataclass
class ChatExecution:
    disconnected: bool = False
    leases: list[tuple[usage_limits.UsageStore, str]] = field(
        default_factory=list
    )


_execution: ContextVar[ChatExecution | None] = ContextVar(
    "chat_execution",
    default=None,
)


class ChatStreamingResponse(StreamingResponse):
    """Use the request's disconnect watcher for graph cancellation."""

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        try:
            await self.stream_response(send)
        finally:
            await self.body_iterator.aclose()

        if self.background is not None:
            await self.background()


def claim_thread_execution(thread_id: str) -> None:
    """Claim after authorization and release when the request settles."""
    require_thread(thread_id)

    execution = _execution.get()
    if execution is None:
        raise RuntimeError(
            "Chat execution requires an authenticated request scope."
        )

    check_execution_active()

    from evidence import begin_evidence

    begin_evidence(thread_id)

    store = usage_limits.store
    execution.leases.append(
        (store, store.acquire_thread(thread_id))
    )


def check_execution_active() -> None:
    """Prevent inherited worker contexts from continuing after disconnect."""
    execution = _execution.get()

    if execution is not None and execution.disconnected:
        raise asyncio.CancelledError


def _validate_chat_body(body: bytes) -> tuple[int, str] | None:
    """Validate resource limits without echoing untrusted input.

    FastAPI/Pydantic remains responsible for normal schema validation.
    This layer specifically prevents excessive input reaching the graph.
    """
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None

    if not isinstance(payload, dict):
        return None

    message = payload.get("message")

    if (
        isinstance(message, str)
        and len(message) > MAX_CHAT_MESSAGE_CHARS
    ):
        return (
            413,
            "Chat message exceeds the character limit.",
        )

    references = payload.get("attachment_ids", [])

    if references is None:
        # Leave schema validation to FastAPI.
        return None

    if not isinstance(references, list):
        return None

    if len(references) > MAX_CHAT_ATTACHMENT_REFS:
        return (
            422,
            "Too many attachment references.",
        )

    if any(
        not isinstance(reference, str)
        or len(reference) > MAX_CHAT_ATTACHMENT_ID_CHARS
        or _ATTACHMENT_ID_PATTERN.fullmatch(reference) is None
        for reference in references
    ):
        return (
            422,
            "Invalid attachment reference.",
        )

    if len(set(references)) != len(references):
        return (
            422,
            "Duplicate attachment references are not allowed.",
        )

    return None


async def _read_chat_body(
    receive: Receive,
) -> tuple[bytes | None, tuple[int, str] | None]:
    """Read the bounded JSON body before allocating a graph or thread lease.

    The size limit is checked before appending each incoming chunk.
    A disconnected client does not start application work.
    """
    body = bytearray()

    while True:
        message = await receive()

        if message["type"] == "http.disconnect":
            return None, None

        if message["type"] != "http.request":
            continue

        chunk = message.get("body", b"")

        if len(body) + len(chunk) > MAX_CHAT_BODY_BYTES:
            return None, (
                413,
                "Chat request exceeds the size limit.",
            )

        body.extend(chunk)

        if not message.get("more_body", False):
            break

    content = bytes(body)
    return content, _validate_chat_body(content)


async def run_chat_request(
    app: ASGIApp,
    scope: Scope,
    receive: Receive,
    send: Send,
) -> None:
    """Bound input, then watch disconnect throughout generation and streaming."""

    body, rejected = await _read_chat_body(receive)

    if rejected is not None:
        status, detail = rejected
        response = JSONResponse(
            {"detail": detail},
            status_code=status,
        )
        await response(scope, receive, send)
        return

    if body is None:
        # The client disconnected while sending the request body.
        return

    execution = ChatExecution()
    token = _execution.set(execution)

    # Replay the validated body to FastAPI, without reading it again
    # from the network. The watcher consumes only later ASGI events.
    incoming: asyncio.Queue[Message] = asyncio.Queue(maxsize=1)

    incoming.put_nowait({
        "type": "http.request",
        "body": body,
        "more_body": False,
    })

    application = asyncio.create_task(
        app(scope, incoming.get, send)
    )

    async def watch_disconnect() -> None:
        while True:
            message = await receive()

            if message["type"] == "http.disconnect":
                execution.disconnected = True
                application.cancel()
                return

            await incoming.put(message)

    watcher = asyncio.create_task(watch_disconnect())

    try:
        done, _ = await asyncio.wait(
            (application, watcher),
            return_when=asyncio.FIRST_COMPLETED,
        )

        if watcher in done:
            # Propagate receive errors. A disconnect is cooperative.
            await watcher

        await application

    except asyncio.CancelledError:
        if not execution.disconnected:
            execution.disconnected = True
            raise

    finally:
        execution.disconnected = True
        application.cancel()
        watcher.cancel()

        await asyncio.gather(
            application,
            watcher,
            return_exceptions=True,
        )

        try:
            for store, lease in execution.leases:
                store.release(lease)
        finally:
            _execution.reset(token)
