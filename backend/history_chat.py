"""Connect durable turn receipts to the existing graph and SSE lifecycle."""

import asyncio
import json
import time
from contextlib import aclosing
from typing import TYPE_CHECKING, AsyncIterator, Callable

from langchain_core.messages import RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

import history_store
from chat_execution import ChatStreamingResponse, claim_thread_execution
from evidence import resolve_answer, source_snapshot
from history_store import HistoryError, completed_context
from models import (
    ModelError,
    ensure_model_available,
    normalize_model_name,
    provider_error,
    require_consent,
)
from ownership import bind_resources
from rag import get_attachment_records
from observability import event as log_event, persistence_boundary

if TYPE_CHECKING:
    from app import ChatRequest, ChatResponse


class HistoryStreamingResponse(ChatStreamingResponse):
    """Finalize admission even if transport fails before the generator starts."""

    def __init__(self, content: AsyncIterator[str], finalize: Callable[[], None]):
        super().__init__(
            content, media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )
        self.finalize = finalize

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.finalize()


async def persistent_chat(
    req: "ChatRequest", *, streaming: bool,
) -> "ChatResponse | HistoryStreamingResponse":
    """Admit exactly once, then persist the result before its terminal event."""
    import app as api

    if req.checkpoint_id is not None:
        raise HistoryError("Checkpoint references are selected by the server, not the client.", 422)
    if (
        not all((req.thread_id, req.user_message_id, req.assistant_message_id))
        or req.expected_version is None
    ):
        raise HistoryError(
            "Persistent turns require thread, message IDs and a history version.", 422
        )
    if len(req.message) > 1_000_000:
        raise HistoryError("Message is too large.", 413)
    req.model = normalize_model_name(req.model)
    history = history_store.store
    saved = history.get(req.thread_id)
    workspace = saved["workspace_id"]
    if req.workspace_id is not None and req.workspace_id != workspace:
        raise HistoryError("Conversation workspace does not match.")
    bind_resources(req.thread_id, workspace)
    claim_thread_execution(req.thread_id)
    history.recover(req.thread_id)
    request = {
        "request_id": req.request_id, "version": req.expected_version,
        "operation": req.operation, "target_message_id": req.target_message_id,
        "message": req.message, "model": req.model, "mode": req.mode,
        "attachment_ids": req.attachment_ids, "user_message_id": req.user_message_id,
        "assistant_message_id": req.assistant_message_id,
    }
    receipt, duplicate = history.begin(req.thread_id, request)
    messages = json.loads(receipt["messages"])
    revision = receipt["id"]
    user = messages[-2]
    text = messages[-1]["content"] if duplicate else ""
    inspector = {"rag_used": False}
    if duplicate:
        # A repeated request replays its saved evidence without new retrieval.
        inspector["sources"] = messages[-1].get("sources", [])
        inspector["rag_used"] = any(
            source.get("kind") == "document" for source in inspector["sources"]
        )
        if messages[-1].get("research"):
            inspector["research"] = messages[-1]["research"]

    def finish(
        state: str, *, error: str | None = None, status: int | None = None,
        checkpoint_id: str | None = None,
    ) -> None:
        if duplicate:
            return
        sources = resolve_answer(text, inspector, research=req.mode == "research")
        with persistence_boundary("history"):
            history.finish(
                req.thread_id, revision, text, state, error=error, status=status,
                sources=sources, checkpoint_id=checkpoint_id, research=inspector.get("research"),
            )

    async def events() -> AsyncIterator[tuple[str, dict]]:
        nonlocal text
        log_event("research" if req.mode == "research" else "chat", "started", mode=req.mode)
        try:
            yield "start", {"thread_id": req.thread_id}
            if duplicate:
                sources = [source for source in inspector["sources"] if source.get("source_id")]
                if sources:
                    yield "sources", {"sources": sources}
                if text:
                    yield "token", {"text": text}
                if receipt["state"] == "complete":
                    yield "done", {"thread_id": req.thread_id, "inspector": inspector}
                else:
                    yield "error", {
                        "thread_id": req.thread_id,
                        "status_code": messages[-1].get("errorStatus") or 409,
                        "message": messages[-1].get("error") or (
                            "This execution has stopped. Use Retry for a new attempt."
                        ),
                    }
                return
            require_consent(req.model, req.provider_consent)
            await asyncio.to_thread(ensure_model_available, req.model)
            attachments = (
                get_attachment_records(req.thread_id, user["attachmentIds"])
                if user["attachmentIds"] else []
            )
            if (
                any(item.get("kind") == "image" for item in attachments)
                and not api._is_vision_model(req.model)
            ):
                raise ModelError(
                    "The selected model does not support image understanding.", 400
                )
            agent = await api.get_agent(req.model, req.mode, streaming=streaming)
            config = {
                "recursion_limit": 28 if req.mode == "research" else 24,
                "configurable": {
                    "thread_id": req.thread_id, "workspace_id": workspace,
                    "attachment_ids": user["attachmentIds"], "provider_consent": req.provider_consent,
                    "model": req.model, "mode": req.mode, "user_query": user["content"],
                    "history_replay": req.operation != "send",
                    **api._personalization_config(req),
                },
            }
            # This is an isolated replay of visible completed turns, not a claim
            # that deleting UI text rewinds checkpoints or external side effects.
            context = [
                {"role": item["role"], "content": item["content"], "id": item["id"]}
                for item in completed_context(messages[:-2])
            ]
            context.append({
                "role": "user", "id": user["id"],
                "content": api._build_user_message(user["content"], attachments, req.model),
            })
            graph_input = {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *context]}
            final_message = None
            streamed_ids = set()
            persisted_at = 0.0
            sent_sources = []
            stream = agent.astream(
                graph_input, config=config, stream_mode=["messages", "values"]
            )
            async with aclosing(stream):
                async for mode, chunk in stream:
                    sources = source_snapshot()
                    if sources != sent_sources:
                        sent_sources = sources
                        yield "sources", {"sources": sources}
                    delta = ""
                    if mode == "messages":
                        message, metadata = chunk
                        if metadata.get("langgraph_node") != "chatbot":
                            continue
                        delta = api.extract_text_content(message)
                        if delta and getattr(message, "id", None):
                            streamed_ids.add(message.id)
                    elif mode == "values" and isinstance(chunk, dict):
                        graph_messages = chunk.get("messages", [])
                        api._update_inspector_from_messages(inspector, graph_messages)
                        if (
                            graph_messages
                            and getattr(graph_messages[-1], "type", None) == "ai"
                            and not getattr(graph_messages[-1], "tool_calls", [])
                        ):
                            final_message = graph_messages[-1]
                    if delta:
                        text += delta
                        if time.monotonic() - persisted_at >= 0.25:
                            history.progress(req.thread_id, revision, text)
                            persisted_at = time.monotonic()
                        yield "token", {"text": delta}
            if final_message is not None and (
                not text or (final_message.id and final_message.id not in streamed_ids)
            ):
                delta = api.extract_text_content(final_message)
                if delta:
                    text += delta
                    yield "token", {"text": delta}
            if not text.strip():
                raise ModelError("The provider returned no answer text. Please retry.", 502)
            checkpoint_id = None
            if hasattr(agent, "aget_state"):
                state = await agent.aget_state(config)
                checkpoint_id = (state.config or {}).get("configurable", {}).get("checkpoint_id")
            finish("complete", checkpoint_id=checkpoint_id)
            yield "done", {"thread_id": req.thread_id, "inspector": inspector}
        except Exception as exc:
            error = provider_error(exc)
            finish("error", error=str(error), status=error.status_code)
            yield "error", {
                "thread_id": req.thread_id, "message": str(error),
                "status_code": error.status_code, "retry_after": error.retry_after,
            }
        finally:
            # Only a still-running receipt can transition; complete/error are immutable.
            finish("cancelled")

    async def sse() -> AsyncIterator[str]:
        async with aclosing(events()) as source:
            async for event, payload in source:
                yield api._sse_event(event, payload)

    if streaming:
        return HistoryStreamingResponse(sse(), lambda: finish("cancelled"))
    async with aclosing(events()) as source:
        async for event, payload in source:
            if event == "error":
                raise ModelError(payload["message"], payload["status_code"])
    return api.ChatResponse(response=text, thread_id=req.thread_id, inspector=inspector)
