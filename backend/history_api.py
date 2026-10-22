"""Authenticated history endpoints; no history read dispatches a model."""

from contextlib import contextmanager
from typing import Iterator, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

import history_store
import usage_limits
from history_store import HistoryError, HistoryMessage
from models import normalize_model_name
from ownership import OwnershipError, current_owner, require_thread
from rag import get_attachment_records


router = APIRouter(prefix="/history")


class CreateConversation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    thread_id: str = Field(min_length=1, max_length=128)
    workspace_id: str = Field(min_length=1, max_length=128)
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(default="New Chat", min_length=1, max_length=200)
    model: str = "gemini-3.1-flash-lite"
    mode: Literal["normal", "research"] = "normal"


class UpdateConversation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None
    workspace_id: str | None = Field(default=None, min_length=1, max_length=128)


class ImportHistory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    import_id: str = Field(min_length=1, max_length=128)
    confirmed_principal: str
    messages: list[HistoryMessage] = Field(max_length=2000)
    updatedAt: int = Field(ge=0)


@contextmanager
def history_lock(thread_id: str) -> Iterator[None]:
    require_thread(thread_id)
    lease = usage_limits.store.acquire_thread(thread_id)
    try:
        history_store.store.recover(thread_id)
        yield
    finally:
        usage_limits.store.release(lease)


@router.get("")
def list_history() -> dict:
    return {
        "conversations": history_store.store.list_conversations(),
        "deleted_threads": history_store.store.deleted_threads(),
    }


@router.post("")
def create_history(request: CreateConversation) -> dict:
    model = normalize_model_name(request.model)
    return history_store.store.create(
        request.thread_id, request.workspace_id, request.id, model, request.mode, request.title,
    )


@router.get("/{thread_id}")
def load_history(thread_id: str) -> dict:
    try:
        with history_lock(thread_id):
            return history_store.store.get(thread_id)
    except usage_limits.UsageLimitError:
        # An active stream owns the lease; show its last persisted progress.
        return history_store.store.get(thread_id)


@router.patch("/{thread_id}")
def update_history(thread_id: str, request: UpdateConversation) -> dict:
    with history_lock(thread_id):
        return history_store.store.mutate(
            thread_id, request.version, title=request.title, pinned=request.pinned,
            workspace_id=request.workspace_id,
        )


@router.delete("/{thread_id}")
def delete_history(thread_id: str, version: int) -> dict:
    with history_lock(thread_id):
        # A tombstone hides the conversation without deleting payloads/checkpoints.
        return history_store.store.mutate(thread_id, version, deleted=True)


@router.get("/{thread_id}/revisions")
def history_revisions(thread_id: str) -> dict:
    return {"revisions": history_store.store.revisions(thread_id)}


@router.get("/{thread_id}/revisions/{revision_id}")
def load_revision(thread_id: str, revision_id: str) -> dict:
    return history_store.store.revision(thread_id, revision_id)


@router.delete("/{thread_id}/messages/{message_id}")
def remove_message(thread_id: str, message_id: str, version: int) -> dict:
    with history_lock(thread_id):
        return history_store.store.remove_message(thread_id, message_id, version)


@router.post("/{thread_id}/import")
def import_history(thread_id: str, request: ImportHistory) -> dict:
    if request.confirmed_principal != current_owner():
        raise OwnershipError()
    with history_lock(thread_id):
        for message in request.messages:
            if message.attachmentIds:
                get_attachment_records(thread_id, message.attachmentIds)
        if sum(len(message.content) for message in request.messages) > 3_000_000:
            raise HistoryError("Import is too large. Original browser history is unchanged.", 413)
        return history_store.store.import_history(
            thread_id, request.version, [message.model_dump() for message in request.messages],
            request.import_id, request.updatedAt,
        )
