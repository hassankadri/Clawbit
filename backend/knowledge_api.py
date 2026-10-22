"""Authenticated source opening and explicit memory management."""

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

import memory_store
from evidence import source_title
from ownership import OwnershipError, require_thread
from rag import get_attachment_records, read_source_bytes
from usage_limits import limited


router = APIRouter()


class MemoryWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=2000)
    scope: Literal["workspace", "user"] = "workspace"
    workspace_id: str | None = Field(default=None, max_length=128)
    confirmed: Literal[True]


class MemoryUpdate(MemoryWrite):
    version: int = Field(ge=0)


@router.get("/memories")
@limited("tool")
def list_memories(scope: Literal["workspace", "user"], workspace_id: str | None = None):
    return {"memories": memory_store.store.list(scope, workspace_id)}


@router.post("/memories")
@limited("tool")
def create_memory(request: MemoryWrite):
    saved, duplicate = memory_store.store.save(request.content, request.scope, request.workspace_id)
    return {**saved, "duplicate": duplicate}


@router.patch("/memories/{memory_id}")
@limited("tool")
def update_memory(memory_id: int, request: MemoryUpdate):
    return memory_store.store.change(
        memory_id, request.version, request.scope, request.workspace_id, request.content,
    )


@router.delete("/memories/{memory_id}")
@limited("tool")
def delete_memory(
    memory_id: int, version: int, scope: Literal["workspace", "user"],
    workspace_id: str | None = None,
):
    return memory_store.store.change(memory_id, version, scope, workspace_id, None)


@router.get("/sources/{thread_id}/{attachment_id}")
def source_reference(thread_id: str, attachment_id: str):
    require_thread(thread_id)
    records = get_attachment_records(thread_id, [attachment_id])
    if not records:
        raise OwnershipError("Source is unavailable.")
    record = records[0]
    # Guarded bounded read also detects removed files and unsafe path replacements.
    read_source_bytes(thread_id, attachment_id)
    return {"title": source_title(record.get("name")), "preview": record.get("preview", "")[:5000]}


@router.get("/sources/{thread_id}/{attachment_id}/content")
def source_content(thread_id: str, attachment_id: str):
    require_thread(thread_id)
    records = get_attachment_records(thread_id, [attachment_id])
    if not records:
        raise OwnershipError("Source is unavailable.")
    return Response(
        content=read_source_bytes(thread_id, attachment_id), media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment", "Content-Security-Policy": "sandbox"},
    )
