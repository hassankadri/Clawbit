"""Own chat cancellation and thread leases for the complete ASGI request."""

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field

from starlette.responses import StreamingResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ownership import require_thread
import usage_limits


@dataclass
class ChatExecution:
    disconnected: bool = False
    leases: list[tuple[usage_limits.UsageStore, str]] = field(default_factory=list)


_execution: ContextVar[ChatExecution | None] = ContextVar("chat_execution", default=None)


class ChatStreamingResponse(StreamingResponse):
    """Use the request's disconnect watcher so graph cleanup gets edge cancellation."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await self.stream_response(send)
        finally:
            await self.body_iterator.aclose()
        if self.background is not None:
            await self.background()


def claim_thread_execution(thread_id: str) -> None:
    """Claim after authorization; release only when the complete request settles."""
    require_thread(thread_id)
    execution = _execution.get()
    if execution is None:
        raise RuntimeError("Chat execution requires an authenticated request scope.")
    check_execution_active()
    from evidence import begin_evidence
    begin_evidence(thread_id)
    store = usage_limits.store
    execution.leases.append((store, store.acquire_thread(thread_id)))


def check_execution_active() -> None:
    """Prevent continued work in inherited worker contexts after disconnect."""
    execution = _execution.get()
    if execution is not None and execution.disconnected:
        raise asyncio.CancelledError


async def run_chat_request(
    app: ASGIApp, scope: Scope, receive: Receive, send: Send,
) -> None:
    """Watch disconnect during preparation as well as after streaming headers."""
    execution = ChatExecution()
    token = _execution.set(execution)
    incoming: asyncio.Queue[Message] = asyncio.Queue(maxsize=1)
    application = asyncio.create_task(app(scope, incoming.get, send))

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
            (application, watcher), return_when=asyncio.FIRST_COMPLETED,
        )
        if watcher in done:
            # Propagate receive failures; a normal disconnect is cooperative stop.
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
        await asyncio.gather(application, watcher, return_exceptions=True)
        try:
            for store, lease in execution.leases:
                store.release(lease)
        finally:
            _execution.reset(token)
