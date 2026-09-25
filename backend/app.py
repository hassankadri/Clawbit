import base64
import json
from contextlib import asynccontextmanager
from pathlib import Path
import uuid

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import groq
from google.genai import errors as google_genai_errors

from agent import close_agent_resources, get_agent
from rag import (
    SUPPORTED_DOCUMENT_SUFFIXES,
    SUPPORTED_IMAGE_SUFFIXES,
    get_attachment_records,
    save_uploaded_file,
)


SUPPORTED_UPLOAD_SUFFIXES = SUPPORTED_DOCUMENT_SUFFIXES | SUPPORTED_IMAGE_SUFFIXES

UPLOAD_SUFFIX_BY_MIME = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        yield
    finally:
        await close_agent_resources()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    model: str = "gemini-3.1-flash-lite"
    thread_id: str | None = None
    workspace_id: str | None = None
    attachment_ids: list[str] = Field(default_factory=list)
    mode: str = "normal"


class UploadResponse(BaseModel):
    attachment_id: str
    name: str
    mime_type: str
    kind: str
    size: int
    preview: str | None = None


class ChatResponse(BaseModel):
    response: str
    thread_id: str
    inspector: dict | None = None


def extract_text_content(message) -> str:
    content = getattr(message, "content", message)

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []

        for item in content:
            if isinstance(item, dict):
                text = item.get("text")

                if text:
                    parts.append(text)

            elif isinstance(item, str):
                parts.append(item)

        return "".join(parts)

    return str(content)


def _is_vision_model(model_name: str) -> bool:
    return model_name.lower().startswith("gemini")


def _build_user_message(
    message_text: str,
    attachments: list[dict],
    model_name: str,
):
    text_blocks: list[dict] = []
    normalized_text = message_text.strip()

    if normalized_text:
        text_blocks.append(
            {
                "type": "text",
                "text": normalized_text,
            }
        )

    elif attachments:
        text_blocks.append(
            {
                "type": "text",
                "text": (
                    "Use the attached files to answer "
                    "the user's request."
                ),
            }
        )

    document_names = [
        attachment.get(
            "name",
            "uploaded document",
        )
        for attachment in attachments
        if attachment.get("kind") == "document"
    ]

    if document_names:
        text_blocks.append(
            {
                "type": "text",
                "text": (
                    "Uploaded documents are available: "
                    + ", ".join(document_names)
                    + ". Use the "
                    "search_uploaded_documents tool "
                    "to retrieve information from them."
                ),
            }
        )

    image_blocks = []

    for attachment in attachments:
        if attachment.get("kind") != "image":
            continue

        path_value = attachment.get("path")

        if not path_value:
            continue

        if not _is_vision_model(model_name):
            continue

        path = Path(path_value)

        mime_type = (
            attachment.get("mime_type")
            or "image/png"
        )

        image_blocks.append(
            {
                "type": "image",
                "base64": base64.b64encode(
                    path.read_bytes()
                ).decode("utf-8"),
                "mime_type": mime_type,
            }
        )

    return text_blocks + image_blocks


def _sse_event(
    event: str,
    data: dict,
) -> str:
    payload = json.dumps(
        data,
        ensure_ascii=False,
        default=str,
    )

    return (
        f"event: {event}\n"
        f"data: {payload}\n\n"
    )


def _update_inspector_from_messages(
    inspector: dict,
    messages: list,
) -> None:
    for message in reversed(messages):
        message_type = getattr(
            message,
            "type",
            "",
        )

        tool_name = getattr(
            message,
            "name",
            "",
        )

        artifact = getattr(
            message,
            "artifact",
            None,
        )

        if (
            message_type == "tool"
            and tool_name
            == "search_uploaded_documents"
            and isinstance(artifact, dict)
        ):
            inspector.update(artifact)
            return


def _exception_chain(exc: Exception):
    current = exc
    seen = set()

    while (
        current is not None
        and id(current) not in seen
    ):
        seen.add(id(current))
        yield current

        current = (
            current.__cause__
            or current.__context__
        )


def _provider_error_message(
    exc: Exception,
) -> str:
    for current in _exception_chain(exc):
        message = str(current).lower()

        if isinstance(
            current,
            groq.RateLimitError,
        ):
            return (
                "The AI provider is rate limited right now. "
                "Please wait a moment and try again."
            )

        if isinstance(
            current,
            groq.APITimeoutError,
        ):
            return (
                "The AI provider took too long to respond. "
                "Please try again."
            )

        if isinstance(
            current,
            groq.APIConnectionError,
        ):
            return (
                "Clawbit could not reach the AI provider. "
                "Please check your connection and try again."
            )

        if isinstance(
            current,
            google_genai_errors.ClientError,
        ):
            code = (
                getattr(current, "code", None)
                or getattr(
                    current,
                    "status_code",
                    None,
                )
            )

            if (
                code == 429
                or "429" in message
                or "resource_exhausted" in message
                or "rate limit" in message
                or "quota" in message
            ):
                return (
                    "The AI provider is rate limited right now. "
                    "Please wait a moment and try again."
                )

            return (
                "The AI provider rejected the request. "
                "Please adjust the request and try again."
            )

        if isinstance(
            current,
            google_genai_errors.ServerError,
        ):
            return (
                "The AI provider is temporarily unavailable. "
                "Please try again shortly."
            )

        if isinstance(
            current,
            google_genai_errors.APIError,
        ):
            if (
                "429" in message
                or "resource_exhausted" in message
                or "rate limit" in message
                or "quota" in message
            ):
                return (
                    "The AI provider is rate limited right now. "
                    "Please wait a moment and try again."
                )

            if (
                "timeout" in message
                or "timed out" in message
            ):
                return (
                    "The AI provider took too long to respond. "
                    "Please try again."
                )

    message = str(exc).lower()

    if (
        "429" in message
        or "rate limit" in message
        or "resource_exhausted" in message
        or "quota exceeded" in message
        or "too many requests" in message
    ):
        return (
            "The AI provider is rate limited right now. "
            "Please wait a moment and try again."
        )

    if (
        "timeout" in message
        or "timed out" in message
    ):
        return (
            "The AI provider took too long to respond. "
            "Please try again."
        )

    if (
        "connection" in message
        or "network" in message
    ):
        return (
            "Clawbit could not reach the AI provider. "
            "Please check your connection and try again."
        )

    return (
        "Clawbit could not complete the request because "
        "the AI provider returned an error. Please try again."
    )


@app.get("/")
def home():
    return {
        "status": "ok",
        "message": "Clawbit Backend Running",
    }


@app.post(
    "/attachments/upload",
    response_model=UploadResponse,
)
async def upload_attachment(
    thread_id: str = Form(...),
    file: UploadFile = File(...),
):
    suffix = Path(
        file.filename or ""
    ).suffix.lower()

    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        suffix = UPLOAD_SUFFIX_BY_MIME.get(
            (file.content_type or "").lower(),
            "",
        )

    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported file type. "
                "Upload PDF, DOCX, TXT, MD, CSV, or images."
            ),
        )

    upload_dir = (
        Path(__file__).resolve().parent
        / "uploads"
        / thread_id
    )

    upload_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    safe_name = Path(
        file.filename or "upload"
    ).name

    if (
        Path(safe_name).suffix.lower()
        not in SUPPORTED_UPLOAD_SUFFIXES
        and suffix
    ):
        safe_name = (
            f"{Path(safe_name).stem}{suffix}"
        )

    attachment_path = (
        upload_dir
        / f"{uuid.uuid4().hex}_{safe_name}"
    )

    content = await file.read()
    attachment_path.write_bytes(content)

    try:
        record = save_uploaded_file(
            str(attachment_path),
            thread_id=thread_id,
            original_name=(
                file.filename
                or attachment_path.name
            ),
        )

    except Exception as exc:
        if attachment_path.exists():
            attachment_path.unlink(
                missing_ok=True
            )

        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    return UploadResponse(
        attachment_id=record["attachment_id"],
        name=record["name"],
        mime_type=record["mime_type"],
        kind=record["kind"],
        size=record["size"],
        preview=record.get("preview"),
    )


@app.post(
    "/chat",
    response_model=ChatResponse,
)
async def chat(req: ChatRequest):
    thread_id = (
        req.thread_id
        or str(uuid.uuid4())
    )

    workspace_id = (
        req.workspace_id
        or thread_id
    )

    attachment_ids = (
        req.attachment_ids
        or []
    )

    inspector = {
        "rag_used": False,
        "user_query": req.message,
    }

    attachments = get_attachment_records(
        thread_id,
        attachment_ids,
    )

    if attachments and any(
        attachment.get("kind") == "image"
        for attachment in attachments
    ) and not _is_vision_model(req.model):
        return ChatResponse(
            response=(
                "The selected model does not support image understanding. "
                "Please choose a vision-capable model."
            ),
            thread_id=thread_id,
            inspector=inspector,
        )

    agent = await get_agent(
        req.model,
        req.mode,
    )

    print("Agent loaded successfully")
    print("Calling agent.ainvoke...")

    user_message = {
        "role": "user",
        "content": _build_user_message(
            req.message,
            attachments,
            req.model,
        ),
    }

    try:
        result = await agent.ainvoke(
            {
                "messages": [user_message],
            },
            config={
                "configurable": {
                    "thread_id": thread_id,
                    "workspace_id": workspace_id,
                    "attachment_ids": attachment_ids,
                    "model": req.model,
                    "mode": req.mode,
                    "user_query": req.message,
                }
            },
        )

    except Exception as exc:
        print(
            "Chat provider error: "
            f"{type(exc).__name__}: {exc}"
        )

        return ChatResponse(
            response=_provider_error_message(
                exc
            ),
            thread_id=thread_id,
            inspector=inspector,
        )

    if isinstance(result, dict):
        messages = result.get(
            "messages",
            [],
        )

        if messages:
            response = extract_text_content(
                messages[-1]
            )
        else:
            response = ""

        _update_inspector_from_messages(
            inspector,
            messages,
        )

    else:
        response = extract_text_content(
            result
        )

    return ChatResponse(
        response=response,
        thread_id=thread_id,
        inspector=inspector,
    )


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    thread_id = (
        req.thread_id
        or str(uuid.uuid4())
    )

    workspace_id = (
        req.workspace_id
        or thread_id
    )

    attachment_ids = (
        req.attachment_ids
        or []
    )

    inspector = {
        "rag_used": False,
        "user_query": req.message,
    }

    attachments = get_attachment_records(
        thread_id,
        attachment_ids,
    )

    if attachments and any(
        attachment.get("kind") == "image"
        for attachment in attachments
    ) and not _is_vision_model(req.model):
        async def vision_error_stream():
            yield _sse_event(
                "error",
                {
                    "message": (
                        "The selected model does not support "
                        "image understanding. Please choose a "
                        "vision-capable model."
                    ),
                    "thread_id": thread_id,
                },
            )

        return StreamingResponse(
            vision_error_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    agent = await get_agent(
        req.model,
        req.mode,
        streaming=True,
    )

    user_message = {
        "role": "user",
        "content": _build_user_message(
            req.message,
            attachments,
            req.model,
        ),
    }

    config = {
        "configurable": {
            "thread_id": thread_id,
            "workspace_id": workspace_id,
            "attachment_ids": attachment_ids,
            "model": req.model,
            "mode": req.mode,
            "user_query": req.message,
        }
    }

    async def event_stream():
        try:
            yield _sse_event(
                "start",
                {
                    "thread_id": thread_id,
                },
            )

            async for stream_mode, chunk in agent.astream(
                {
                    "messages": [user_message],
                },
                config=config,
                stream_mode=[
                    "messages",
                    "values",
                ],
            ):
                if stream_mode == "messages":
                    message_chunk, metadata = chunk

                    if (
                        metadata.get("langgraph_node")
                        != "chatbot"
                    ):
                        continue

                    text = extract_text_content(
                        message_chunk
                    )

                    if text:
                        yield _sse_event(
                            "token",
                            {
                                "text": text,
                            },
                        )

                elif stream_mode == "values":
                    if not isinstance(
                        chunk,
                        dict,
                    ):
                        continue

                    messages = chunk.get(
                        "messages",
                        [],
                    )

                    _update_inspector_from_messages(
                        inspector,
                        messages,
                    )

            yield _sse_event(
                "done",
                {
                    "thread_id": thread_id,
                    "inspector": inspector,
                },
            )

        except Exception as exc:
            print(
                "Streaming provider error: "
                f"{type(exc).__name__}: {exc}"
            )

            yield _sse_event(
                "error",
                {
                    "message": _provider_error_message(
                        exc
                    ),
                    "thread_id": thread_id,
                },
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
