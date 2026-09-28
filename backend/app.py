import base64
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode
import uuid

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

import groq
from google.genai import errors as google_genai_errors

from agent import close_agent_resources, get_agent

from mcp_client import (
    connect_github_mcp,
    connect_notion_mcp,
    connect_stripe_mcp,
    disconnect_github_mcp,
    disconnect_google_drive_mcp,
    disconnect_notion_mcp,
    disconnect_slack_mcp,
    disconnect_stripe_mcp,
    get_mcp_catalog,
    get_mcp_status,
    refresh_mcp_tools,
)

from mcp_oauth import (
    complete_google_drive_oauth,
    complete_slack_oauth,
    get_frontend_url,
    start_google_drive_oauth,
    start_slack_oauth,
)

from rag import (
    SUPPORTED_DOCUMENT_SUFFIXES,
    SUPPORTED_IMAGE_SUFFIXES,
    get_attachment_records,
    save_uploaded_file,
)


# =========================================================
# UPLOAD CONFIG
# =========================================================

SUPPORTED_UPLOAD_SUFFIXES = (
    SUPPORTED_DOCUMENT_SUFFIXES
    | SUPPORTED_IMAGE_SUFFIXES
)

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


# =========================================================
# APPLICATION LIFESPAN
# =========================================================

@asynccontextmanager
async def lifespan(
    app: FastAPI,
):
    try:
        yield

    finally:
        await close_agent_resources()


# =========================================================
# FASTAPI APP
# =========================================================

app = FastAPI(
    lifespan=lifespan,
)


# =========================================================
# CORS
# =========================================================

app.add_middleware(
    CORSMiddleware,

    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],

    allow_origin_regex=(
        r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
    ),

    allow_credentials=True,

    allow_methods=[
        "*",
    ],

    allow_headers=[
        "*",
    ],
)


# =========================================================
# REQUEST / RESPONSE MODELS
# =========================================================

class ChatRequest(
    BaseModel,
):
    message: str

    model: str = (
        "gemini-3.1-flash-lite"
    )

    thread_id: (
        str
        | None
    ) = None

    workspace_id: (
        str
        | None
    ) = None

    attachment_ids: list[str] = Field(
        default_factory=list,
    )

    mode: str = (
        "normal"
    )

    # =====================================================
    # PERSONALIZATION
    # =====================================================

    assistant_name: str = Field(
        default="Clawbit",
        max_length=80,
    )

    response_tone: Literal[
        "balanced",
        "friendly",
        "professional",
        "direct",
    ] = "balanced"

    response_length: Literal[
        "short",
        "balanced",
        "detailed",
    ] = "balanced"

    custom_instructions: str = Field(
        default="",
        max_length=4000,
    )


class UploadResponse(
    BaseModel,
):
    attachment_id: str

    name: str

    mime_type: str

    kind: str

    size: int

    preview: (
        str
        | None
    ) = None


class ChatResponse(
    BaseModel,
):
    response: str

    thread_id: str

    inspector: (
        dict
        | None
    ) = None


class GitHubMCPConnectRequest(
    BaseModel,
):
    token: str = Field(
        min_length=1,
    )


class NotionMCPConnectRequest(
    BaseModel,
):
    token: str = Field(
        min_length=1,
    )


class StripeMCPConnectRequest(
    BaseModel,
):
    secret_key: str = Field(
        min_length=1,
    )


# =========================================================
# PERSONALIZATION
# =========================================================

def _personalization_config(
    req: ChatRequest,
) -> dict:
    """
    Build request-scoped personalization settings.

    These values are passed through LangGraph's
    configurable request context.

    They are NOT placed inside the user's message.
    """

    return {
        "assistant_name": (
            req.assistant_name
            .strip()
            or "Clawbit"
        ),

        "response_tone":
            req.response_tone,

        "response_length":
            req.response_length,

        "custom_instructions": (
            req.custom_instructions
            .strip()
        ),
    }


# =========================================================
# MESSAGE HELPERS
# =========================================================

def extract_text_content(
    message,
) -> str:
    content = getattr(
        message,
        "content",
        message,
    )

    if isinstance(
        content,
        str,
    ):
        return content

    if isinstance(
        content,
        list,
    ):
        parts = []

        for item in content:
            if isinstance(
                item,
                dict,
            ):
                text = item.get(
                    "text",
                )

                if text:
                    parts.append(
                        text,
                    )

            elif isinstance(
                item,
                str,
            ):
                parts.append(
                    item,
                )

        return "".join(
            parts,
        )

    return str(
        content,
    )


def _is_vision_model(
    model_name: str,
) -> bool:
    return (
        model_name
        .lower()
        .startswith(
            "gemini",
        )
    )


def _build_user_message(
    message_text: str,

    attachments: list[dict],

    model_name: str,
):
    text_blocks: list[dict] = []

    normalized_text = (
        message_text
        .strip()
    )

    if normalized_text:
        text_blocks.append(
            {
                "type":
                    "text",

                "text":
                    normalized_text,
            }
        )

    elif attachments:
        text_blocks.append(
            {
                "type":
                    "text",

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

        for attachment
        in attachments

        if (
            attachment.get(
                "kind"
            )
            == "document"
        )
    ]

    if document_names:
        text_blocks.append(
            {
                "type":
                    "text",

                "text": (
                    "Uploaded documents are available: "
                    + ", ".join(
                        document_names
                    )
                    + ". Use the "
                    "search_uploaded_documents tool "
                    "to retrieve information from them."
                ),
            }
        )

    image_blocks = []

    for attachment in attachments:
        if (
            attachment.get(
                "kind"
            )
            != "image"
        ):
            continue

        path_value = (
            attachment.get(
                "path"
            )
        )

        if not path_value:
            continue

        if not _is_vision_model(
            model_name,
        ):
            continue

        path = Path(
            path_value,
        )

        mime_type = (
            attachment.get(
                "mime_type"
            )
            or "image/png"
        )

        image_blocks.append(
            {
                "type":
                    "image",

                "base64":
                    base64
                    .b64encode(
                        path.read_bytes()
                    )
                    .decode(
                        "utf-8"
                    ),

                "mime_type":
                    mime_type,
            }
        )

    return (
        text_blocks
        + image_blocks
    )


# =========================================================
# SSE
# =========================================================

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


# =========================================================
# RAG INSPECTOR
# =========================================================

def _update_inspector_from_messages(
    inspector: dict,

    messages: list,
) -> None:
    for message in reversed(
        messages
    ):
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
            message_type
            == "tool"

            and tool_name
            == "search_uploaded_documents"

            and isinstance(
                artifact,
                dict,
            )
        ):
            inspector.update(
                artifact,
            )

            return


# =========================================================
# PROVIDER ERROR HANDLING
# =========================================================

def _exception_chain(
    exc: Exception,
):
    current = exc

    seen = set()

    while (
        current
        is not None

        and id(
            current
        )
        not in seen
    ):
        seen.add(
            id(
                current
            )
        )

        yield current

        current = (
            current.__cause__
            or current.__context__
        )


def _provider_error_message(
    exc: Exception,
) -> str:
    for current in _exception_chain(
        exc
    ):
        message = (
            str(
                current
            )
            .lower()
        )

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
                getattr(
                    current,
                    "code",
                    None,
                )

                or getattr(
                    current,
                    "status_code",
                    None,
                )
            )

            if (
                code
                == 429

                or "429"
                in message

                or "resource_exhausted"
                in message

                or "rate limit"
                in message

                or "quota"
                in message
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
                "429"
                in message

                or "resource_exhausted"
                in message

                or "rate limit"
                in message

                or "quota"
                in message
            ):
                return (
                    "The AI provider is rate limited right now. "
                    "Please wait a moment and try again."
                )

            if (
                "timeout"
                in message

                or "timed out"
                in message
            ):
                return (
                    "The AI provider took too long to respond. "
                    "Please try again."
                )

    message = (
        str(
            exc
        )
        .lower()
    )

    if (
        "429"
        in message

        or "rate limit"
        in message

        or "resource_exhausted"
        in message

        or "quota exceeded"
        in message

        or "too many requests"
        in message
    ):
        return (
            "The AI provider is rate limited right now. "
            "Please wait a moment and try again."
        )

    if (
        "timeout"
        in message

        or "timed out"
        in message
    ):
        return (
            "The AI provider took too long to respond. "
            "Please try again."
        )

    if (
        "connection"
        in message

        or "network"
        in message
    ):
        return (
            "Clawbit could not reach the AI provider. "
            "Please check your connection and try again."
        )

    return (
        "Clawbit could not complete the request because "
        "the AI provider returned an error. Please try again."
    )


# =========================================================
# HEALTH
# =========================================================

@app.get(
    "/",
)
def home():
    return {
        "status":
            "ok",

        "message":
            "Clawbit Backend Running",
    }


# =========================================================
# MCP CATALOG
# =========================================================

@app.get(
    "/mcp/catalog",
)
def mcp_catalog():
    return {
        "connectors":
            get_mcp_catalog(),
    }


# =========================================================
# MCP STATUS
# =========================================================

@app.get(
    "/mcp/status",
)
async def mcp_status():
    return (
        await get_mcp_status()
    )


# =========================================================
# MCP REFRESH
# =========================================================

@app.post(
    "/mcp/refresh",
)
async def mcp_refresh():
    return (
        await refresh_mcp_tools()
    )


def _raise_mcp_error(
    result: dict,

    fallback: str,
) -> None:
    if result.get(
        "success"
    ):
        return

    raise HTTPException(
        status_code=400,

        detail=result.get(
            "error",
            fallback,
        ),
    )


# =========================================================
# GITHUB MCP
# =========================================================

@app.post(
    "/mcp/connect/github",
)
async def mcp_connect_github(
    request:
        GitHubMCPConnectRequest,
):
    result = await connect_github_mcp(
        request.token
    )

    _raise_mcp_error(
        result,

        "Could not connect GitHub MCP.",
    )

    return result


@app.post(
    "/mcp/disconnect/github",
)
async def mcp_disconnect_github():
    result = (
        await disconnect_github_mcp()
    )

    _raise_mcp_error(
        result,

        "Could not disconnect GitHub MCP.",
    )

    return result


# =========================================================
# NOTION MCP
# =========================================================

@app.post(
    "/mcp/connect/notion",
)
async def mcp_connect_notion(
    request:
        NotionMCPConnectRequest,
):
    result = await connect_notion_mcp(
        request.token
    )

    _raise_mcp_error(
        result,

        "Could not connect Notion MCP.",
    )

    return result


@app.post(
    "/mcp/disconnect/notion",
)
async def mcp_disconnect_notion():
    result = (
        await disconnect_notion_mcp()
    )

    _raise_mcp_error(
        result,

        "Could not disconnect Notion MCP.",
    )

    return result


# =========================================================
# STRIPE MCP
# =========================================================

@app.post(
    "/mcp/connect/stripe",
)
async def mcp_connect_stripe(
    request:
        StripeMCPConnectRequest,
):
    result = await connect_stripe_mcp(
        request.secret_key
    )

    _raise_mcp_error(
        result,

        "Could not connect Stripe MCP.",
    )

    return result


@app.post(
    "/mcp/disconnect/stripe",
)
async def mcp_disconnect_stripe():
    result = (
        await disconnect_stripe_mcp()
    )

    _raise_mcp_error(
        result,

        "Could not disconnect Stripe MCP.",
    )

    return result


# =========================================================
# GOOGLE DRIVE MCP
# =========================================================

@app.get(
    "/mcp/connect/google-drive",
)
def mcp_connect_google_drive():
    try:
        return (
            start_google_drive_oauth()
        )

    except Exception as exc:
        raise HTTPException(
            status_code=400,

            detail=str(
                exc
            ),
        ) from exc


@app.get(
    "/mcp/oauth/google-drive/callback",
)
async def mcp_google_drive_callback(
    code: str | None = None,

    state: str | None = None,

    error: str | None = None,
):
    frontend_url = (
        get_frontend_url()
    )

    if error:
        query = urlencode(
            {
                "mcp":
                    "google-drive",

                "status":
                    "error",

                "error":
                    error,
            }
        )

        return RedirectResponse(
            url=(
                f"{frontend_url}"
                f"?{query}"
            )
        )

    if (
        not code
        or not state
    ):
        query = urlencode(
            {
                "mcp":
                    "google-drive",

                "status":
                    "error",

                "error": (
                    "Google Drive OAuth callback "
                    "was missing code or state."
                ),
            }
        )

        return RedirectResponse(
            url=(
                f"{frontend_url}"
                f"?{query}"
            )
        )

    try:
        await complete_google_drive_oauth(
            code=code,

            state=state,
        )

        try:
            await refresh_mcp_tools()

        except Exception as refresh_exc:
            print(
                "Google Drive MCP refresh error: "
                f"{refresh_exc}"
            )

        query = urlencode(
            {
                "mcp":
                    "google-drive",

                "status":
                    "connected",
            }
        )

    except Exception as exc:
        query = urlencode(
            {
                "mcp":
                    "google-drive",

                "status":
                    "error",

                "error":
                    str(
                        exc
                    ),
            }
        )

    return RedirectResponse(
        url=(
            f"{frontend_url}"
            f"?{query}"
        )
    )


@app.post(
    "/mcp/disconnect/google-drive",
)
async def mcp_disconnect_google_drive():
    result = (
        await disconnect_google_drive_mcp()
    )

    _raise_mcp_error(
        result,

        "Could not disconnect Google Drive MCP.",
    )

    return result


# =========================================================
# SLACK MCP
# =========================================================

@app.get(
    "/mcp/connect/slack",
)
def mcp_connect_slack():
    try:
        return (
            start_slack_oauth()
        )

    except Exception as exc:
        raise HTTPException(
            status_code=400,

            detail=str(
                exc
            ),
        ) from exc


@app.get(
    "/mcp/oauth/slack/callback",
)
async def mcp_slack_callback(
    code: str | None = None,

    state: str | None = None,

    error: str | None = None,
):
    frontend_url = (
        get_frontend_url()
    )

    if error:
        query = urlencode(
            {
                "mcp":
                    "slack",

                "status":
                    "error",

                "error":
                    error,
            }
        )

        return RedirectResponse(
            url=(
                f"{frontend_url}"
                f"?{query}"
            )
        )

    if (
        not code
        or not state
    ):
        query = urlencode(
            {
                "mcp":
                    "slack",

                "status":
                    "error",

                "error": (
                    "Slack OAuth callback "
                    "was missing code or state."
                ),
            }
        )

        return RedirectResponse(
            url=(
                f"{frontend_url}"
                f"?{query}"
            )
        )

    try:
        await complete_slack_oauth(
            code=code,

            state=state,
        )

        try:
            await refresh_mcp_tools()

        except Exception as refresh_exc:
            print(
                "Slack MCP refresh error: "
                f"{refresh_exc}"
            )

        query = urlencode(
            {
                "mcp":
                    "slack",

                "status":
                    "connected",
            }
        )

    except Exception as exc:
        query = urlencode(
            {
                "mcp":
                    "slack",

                "status":
                    "error",

                "error":
                    str(
                        exc
                    ),
            }
        )

    return RedirectResponse(
        url=(
            f"{frontend_url}"
            f"?{query}"
        )
    )


@app.post(
    "/mcp/disconnect/slack",
)
async def mcp_disconnect_slack():
    result = (
        await disconnect_slack_mcp()
    )

    _raise_mcp_error(
        result,

        "Could not disconnect Slack MCP.",
    )

    return result


# =========================================================
# ATTACHMENT UPLOAD
# =========================================================

@app.post(
    "/attachments/upload",

    response_model=
        UploadResponse,
)
async def upload_attachment(
    thread_id: str = Form(
        ...
    ),

    file: UploadFile = File(
        ...
    ),
):
    suffix = (
        Path(
            file.filename
            or ""
        )
        .suffix
        .lower()
    )

    if (
        suffix
        not in
        SUPPORTED_UPLOAD_SUFFIXES
    ):
        suffix = (
            UPLOAD_SUFFIX_BY_MIME
            .get(
                (
                    file.content_type
                    or ""
                )
                .lower(),

                "",
            )
        )

    if (
        suffix
        not in
        SUPPORTED_UPLOAD_SUFFIXES
    ):
        raise HTTPException(
            status_code=400,

            detail=(
                "Unsupported file type. "
                "Upload PDF, DOCX, TXT, MD, CSV, or images."
            ),
        )

    upload_dir = (
        Path(
            __file__
        )
        .resolve()
        .parent

        / "uploads"

        / thread_id
    )

    upload_dir.mkdir(
        parents=True,

        exist_ok=True,
    )

    safe_name = (
        Path(
            file.filename
            or "upload"
        )
        .name
    )

    if (
        Path(
            safe_name
        )
        .suffix
        .lower()

        not in
        SUPPORTED_UPLOAD_SUFFIXES

        and suffix
    ):
        safe_name = (
            f"{Path(safe_name).stem}"
            f"{suffix}"
        )

    attachment_path = (
        upload_dir

        / (
            f"{uuid.uuid4().hex}_"
            f"{safe_name}"
        )
    )

    content = (
        await file.read()
    )

    attachment_path.write_bytes(
        content
    )

    try:
        record = save_uploaded_file(
            str(
                attachment_path
            ),

            thread_id=
                thread_id,

            original_name=(
                file.filename
                or attachment_path.name
            ),
        )

    except Exception as exc:
        if attachment_path.exists():
            attachment_path.unlink(
                missing_ok=True,
            )

        raise HTTPException(
            status_code=400,

            detail=str(
                exc
            ),
        ) from exc

    return UploadResponse(
        attachment_id=
            record[
                "attachment_id"
            ],

        name=
            record[
                "name"
            ],

        mime_type=
            record[
                "mime_type"
            ],

        kind=
            record[
                "kind"
            ],

        size=
            record[
                "size"
            ],

        preview=
            record.get(
                "preview"
            ),
    )


# =========================================================
# NORMAL CHAT
# =========================================================

@app.post(
    "/chat",

    response_model=
        ChatResponse,
)
async def chat(
    req: ChatRequest,
):
    thread_id = (
        req.thread_id
        or str(
            uuid.uuid4()
        )
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
        "rag_used":
            False,

        "user_query":
            req.message,
    }

    attachments = (
        get_attachment_records(
            thread_id,

            attachment_ids,
        )
    )

    if (
        attachments

        and any(
            attachment.get(
                "kind"
            )
            == "image"

            for attachment
            in attachments
        )

        and not
        _is_vision_model(
            req.model
        )
    ):
        return ChatResponse(
            response=(
                "The selected model does not support "
                "image understanding. "
                "Please choose a vision-capable model."
            ),

            thread_id=
                thread_id,

            inspector=
                inspector,
        )

    agent = await get_agent(
        req.model,

        req.mode,
    )

    print(
        "Agent loaded successfully"
    )

    print(
        "Calling agent.ainvoke..."
    )

    user_message = {
        "role":
            "user",

        "content":
            _build_user_message(
                req.message,

                attachments,

                req.model,
            ),
    }

    config = {
        "configurable": {
            "thread_id":
                thread_id,

            "workspace_id":
                workspace_id,

            "attachment_ids":
                attachment_ids,

            "model":
                req.model,

            "mode":
                req.mode,

            "user_query":
                req.message,

            # =========================================
            # PERSONALIZATION
            # =========================================

            **_personalization_config(
                req
            ),
        }
    }

    try:
        result = (
            await agent.ainvoke(
                {
                    "messages": [
                        user_message
                    ],
                },

                config=config,
            )
        )

    except Exception as exc:
        print(
            "Chat provider error: "
            f"{type(exc).__name__}: "
            f"{exc}"
        )

        return ChatResponse(
            response=(
                _provider_error_message(
                    exc
                )
            ),

            thread_id=
                thread_id,

            inspector=
                inspector,
        )

    if isinstance(
        result,
        dict,
    ):
        messages = result.get(
            "messages",

            [],
        )

        if messages:
            response = (
                extract_text_content(
                    messages[
                        -1
                    ]
                )
            )

        else:
            response = ""

        _update_inspector_from_messages(
            inspector,

            messages,
        )

    else:
        response = (
            extract_text_content(
                result
            )
        )

    return ChatResponse(
        response=
            response,

        thread_id=
            thread_id,

        inspector=
            inspector,
    )


# =========================================================
# STREAMING CHAT
# =========================================================

@app.post(
    "/chat/stream",
)
async def chat_stream(
    req: ChatRequest,
):
    thread_id = (
        req.thread_id
        or str(
            uuid.uuid4()
        )
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
        "rag_used":
            False,

        "user_query":
            req.message,
    }

    attachments = (
        get_attachment_records(
            thread_id,

            attachment_ids,
        )
    )

    if (
        attachments

        and any(
            attachment.get(
                "kind"
            )
            == "image"

            for attachment
            in attachments
        )

        and not
        _is_vision_model(
            req.model
        )
    ):
        async def vision_error_stream():
            yield _sse_event(
                "error",

                {
                    "message": (
                        "The selected model does not support "
                        "image understanding. "
                        "Please choose a vision-capable model."
                    ),

                    "thread_id":
                        thread_id,
                },
            )

        return StreamingResponse(
            vision_error_stream(),

            media_type=
                "text/event-stream",

            headers={
                "Cache-Control":
                    "no-cache",

                "Connection":
                    "keep-alive",

                "X-Accel-Buffering":
                    "no",
            },
        )

    agent = await get_agent(
        req.model,

        req.mode,

        streaming=True,
    )

    user_message = {
        "role":
            "user",

        "content":
            _build_user_message(
                req.message,

                attachments,

                req.model,
            ),
    }

    config = {
        "configurable": {
            "thread_id":
                thread_id,

            "workspace_id":
                workspace_id,

            "attachment_ids":
                attachment_ids,

            "model":
                req.model,

            "mode":
                req.mode,

            "user_query":
                req.message,

            # =========================================
            # PERSONALIZATION
            # =========================================

            **_personalization_config(
                req
            ),
        }
    }

    async def event_stream():
        try:
            yield _sse_event(
                "start",

                {
                    "thread_id":
                        thread_id,
                },
            )

            async for (
                stream_mode,
                chunk,
            ) in agent.astream(
                {
                    "messages": [
                        user_message
                    ],
                },

                config=
                    config,

                stream_mode=[
                    "messages",
                    "values",
                ],
            ):
                if (
                    stream_mode
                    == "messages"
                ):
                    (
                        message_chunk,
                        metadata,
                    ) = chunk

                    if (
                        metadata.get(
                            "langgraph_node"
                        )
                        != "chatbot"
                    ):
                        continue

                    text = (
                        extract_text_content(
                            message_chunk
                        )
                    )

                    if text:
                        yield _sse_event(
                            "token",

                            {
                                "text":
                                    text,
                            },
                        )

                elif (
                    stream_mode
                    == "values"
                ):
                    if not isinstance(
                        chunk,
                        dict,
                    ):
                        continue

                    messages = (
                        chunk.get(
                            "messages",

                            [],
                        )
                    )

                    _update_inspector_from_messages(
                        inspector,

                        messages,
                    )

            yield _sse_event(
                "done",

                {
                    "thread_id":
                        thread_id,

                    "inspector":
                        inspector,
                },
            )

        except Exception as exc:
            print(
                "Streaming provider error: "
                f"{type(exc).__name__}: "
                f"{exc}"
            )

            yield _sse_event(
                "error",

                {
                    "message":
                        _provider_error_message(
                            exc
                        ),

                    "thread_id":
                        thread_id,
                },
            )

    return StreamingResponse(
        event_stream(),

        media_type=
            "text/event-stream",

        headers={
            "Cache-Control":
                "no-cache",

            "Connection":
                "keep-alive",

            "X-Accel-Buffering":
                "no",
        },
    )