import base64
import asyncio
import json
from contextlib import aclosing, asynccontextmanager
from typing import Literal
from urllib.parse import urlencode
import uuid

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from pydantic import BaseModel, Field

import groq
from google.genai import errors as google_genai_errors

from agent import close_agent_resources, get_agent
from auth import install_authentication
from chat_execution import (
    ChatStreamingResponse,
    claim_thread_execution,
)
from models import (MODEL_CONFIGS, ModelError, model_catalog, normalize_model_name,
                    ensure_model_available, require_consent, provider_error)

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
    discard_oauth_state,
    get_frontend_url,
    start_google_drive_oauth,
    start_slack_oauth,
)

from rag import (
    delete_attachment,
    get_attachment_records,
    read_attachment_bytes,
    receive_uploaded_file,
)
from upload_security import UploadBodyLimitMiddleware, UploadError, validate_thread_id
from ownership import OwnershipError, bind_resources, require_thread
from usage_limits import UsageLimitError
from history_api import router as history_router
from history_store import HistoryError
from knowledge_api import router as knowledge_router
from memory_store import MemoryError
from evidence import resolve_answer, source_snapshot
from observability import RequestLoggingMiddleware, configure_logging, event


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

app.add_middleware(UploadBodyLimitMiddleware)


@app.exception_handler(RequestValidationError)
async def request_validation_handler(request: Request, exc: RequestValidationError):
    if request.url.path.startswith("/mcp/"):
        # Pydantic errors otherwise echo the rejected credential or callback input.
        return JSONResponse(status_code=422, content={"detail": "Invalid connector request."})
    return await request_validation_exception_handler(request, exc)


@app.exception_handler(ModelError)
@app.exception_handler(UsageLimitError)
async def model_error_handler(request: Request, exc: ModelError | UsageLimitError):
    event("provider", "rate_limited" if exc.status_code == 429 else "failed",
          status_code=exc.status_code, category="unavailable")
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else {}
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)}, headers=headers)


@app.get("/models")
def available_models():
    return {"models": model_catalog()}


@app.exception_handler(UploadError)
async def attachment_error_handler(request, exc: UploadError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(OwnershipError)
async def ownership_error_handler(request, exc: OwnershipError):
    event("authorization", "denied", status_code=exc.status_code, category="ownership")
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


# =========================================================
# CORS
# =========================================================

install_authentication(app)
configure_logging()
app.add_middleware(RequestLoggingMiddleware)
app.include_router(history_router)
app.include_router(knowledge_router)


@app.exception_handler(MemoryError)
@app.exception_handler(HistoryError)
async def history_error_handler(request: Request, exc: HistoryError | MemoryError):
    event("memory" if isinstance(exc, MemoryError) else "history", "failed",
          error=exc, status_code=exc.status_code, category="persistence")
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


# =========================================================
# REQUEST / RESPONSE MODELS
# =========================================================

class ChatRequest(
    BaseModel,
):
    message: str
    request_id: str | None = Field(default=None, min_length=1, max_length=128)
    user_message_id: str | None = Field(default=None, min_length=1, max_length=128)
    assistant_message_id: str | None = Field(default=None, min_length=1, max_length=128)
    expected_version: int | None = Field(default=None, ge=0)
    operation: Literal["send", "edit", "retry", "regenerate"] = "send"
    target_message_id: str | None = Field(default=None, min_length=1, max_length=128)
    checkpoint_id: str | None = Field(default=None, max_length=128)
    provider_consent: str | None = Field(default=None, max_length=160)

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

                if isinstance(text, str) and item.get("type") in {"text", "output_text"}:
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

    return ""


def _is_vision_model(
    model_name: str,
) -> bool:
    return MODEL_CONFIGS[normalize_model_name(model_name)]["capabilities"]["vision"]


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
            raise ModelError("The selected model does not support image understanding.")

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
                        read_attachment_bytes(attachment)
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
    if isinstance(exc, ModelError):
        return str(exc)
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

async def _complete_connector_oauth(
    request: Request,
    provider: str,
    code: str | None,
    state: str | None,
    error: str | None,
) -> RedirectResponse:
    """Complete a session-bound connection without reflecting provider secrets."""
    status = "error"
    frontend_url = get_frontend_url()
    token = request.cookies.get(request.app.state.auth_settings.cookie_name, "")
    complete = (
        complete_google_drive_oauth if provider == "google-drive" else complete_slack_oauth
    )
    if code and state and not error:
        try:
            result = await complete(
                code=code,
                state=state,
                session_id=request.state.auth_session.token_hash,
                validate_session=lambda: (
                    request.app.state.auth_store.lookup(token) == request.state.auth_session
                ),
            )
            frontend_url = result["frontend_url"]
            status = "connected"
            try:
                await refresh_mcp_tools()
            except Exception:
                # Credentials remain connected; the owner can retry tool discovery.
                pass
        except Exception:
            # OAuth provider errors can contain codes or credentials. Never reflect them.
            pass
    elif state:
        discard_oauth_state(state, provider, request.state.auth_session.token_hash)
    query = {"mcp": provider, "status": status}
    if status == "error":
        query["error"] = "Connection could not be completed. Start again from Clawbit."
    return RedirectResponse(f"{frontend_url}?{urlencode(query)}")


@app.post("/mcp/connect/google-drive")
def mcp_connect_google_drive(request: Request) -> dict:
    try:
        return start_google_drive_oauth(
            request.state.auth_session.token_hash,
            backend_url=str(request.base_url).rstrip("/"),
            frontend_url=request.headers["origin"],
        )
    except UsageLimitError:
        raise
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Could not start connector authorization. Check server configuration.",
        ) from None


@app.get("/mcp/oauth/google-drive/callback")
async def mcp_google_drive_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    return await _complete_connector_oauth(request, "google-drive", code, state, error)


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

@app.post("/mcp/connect/slack")
def mcp_connect_slack(request: Request) -> dict:
    try:
        return start_slack_oauth(
            request.state.auth_session.token_hash,
            backend_url=str(request.base_url).rstrip("/"),
            frontend_url=request.headers["origin"],
        )
    except UsageLimitError:
        raise
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Could not start connector authorization. Check server configuration.",
        ) from None


@app.get("/mcp/oauth/slack/callback")
async def mcp_slack_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    return await _complete_connector_oauth(request, "slack", code, state, error)


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
        ""
    ),

    file: UploadFile = File(
        ...
    ),
):
    require_thread(thread_id, create=True)
    try:
        record = await receive_uploaded_file(file, thread_id)
    except (UploadError, UsageLimitError):
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The upload could not be saved. Please retry.") from exc
    finally:
        await file.close()

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


@app.delete("/attachments/{thread_id}/{attachment_id}")
async def remove_stored_attachment(thread_id: str, attachment_id: str):
    if not delete_attachment(thread_id, attachment_id):
        raise HTTPException(status_code=404, detail="Attachment not found.")
    return {"deleted": True}


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
    if req.request_id is not None:
        from history_chat import persistent_chat
        return await persistent_chat(req, streaming=False)
    if req.operation != "send":
        raise HistoryError("Edit and retry require a persisted conversation.", 422)
    req.model = normalize_model_name(req.model)
    require_consent(req.model, req.provider_consent)
    await asyncio.to_thread(ensure_model_available, req.model)
    thread_id = validate_thread_id(req.thread_id if req.thread_id is not None else str(uuid.uuid4()))

    workspace_id = (
        req.workspace_id
        or thread_id
    )

    bind_resources(thread_id, workspace_id)
    claim_thread_execution(thread_id)

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

    event("research" if req.mode == "research" else "chat", "started", mode=req.mode)

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
        "recursion_limit": 28 if req.mode == "research" else 24,
        "configurable": {
            "provider_consent": req.provider_consent,
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
        raise provider_error(exc) from None

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

    resolve_answer(response, inspector, research=req.mode == "research")
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
    if req.request_id is not None:
        from history_chat import persistent_chat
        return await persistent_chat(req, streaming=True)
    if req.operation != "send":
        raise HistoryError("Edit and retry require a persisted conversation.", 422)
    req.model = normalize_model_name(req.model)
    require_consent(req.model, req.provider_consent)
    await asyncio.to_thread(ensure_model_available, req.model)
    thread_id = validate_thread_id(req.thread_id if req.thread_id is not None else str(uuid.uuid4()))

    workspace_id = (
        req.workspace_id
        or thread_id
    )

    bind_resources(thread_id, workspace_id)
    claim_thread_execution(thread_id)

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

        return ChatStreamingResponse(
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
        "recursion_limit": 28 if req.mode == "research" else 24,
        "configurable": {
            "provider_consent": req.provider_consent,
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
        sent_text = False
        answer_text = ""
        sent_sources = []
        final_message = None
        streamed_ids = set()
        try:
            yield _sse_event("start", {"thread_id": thread_id})
            stream = agent.astream(
                {"messages": [user_message]},
                config=config,
                stream_mode=["messages", "values"],
            )
            # Close LangGraph before releasing this request's thread/concurrency leases.
            async with aclosing(stream):
                async for stream_mode, chunk in stream:
                    sources = source_snapshot()
                    if sources != sent_sources:
                        sent_sources = sources
                        yield _sse_event("sources", {"sources": sources})
                    if stream_mode == "messages":
                        message_chunk, metadata = chunk
                        if metadata.get("langgraph_node") != "chatbot":
                            continue
                        text = extract_text_content(message_chunk)
                        if text:
                            sent_text = True
                            answer_text += text
                            if getattr(message_chunk, "id", None):
                                streamed_ids.add(message_chunk.id)
                            yield _sse_event("token", {"text": text})
                    elif stream_mode == "values" and isinstance(chunk, dict):
                        messages = chunk.get("messages", [])
                        _update_inspector_from_messages(inspector, messages)
                        if (
                            messages
                            and getattr(messages[-1], "type", None) == "ai"
                            and not getattr(messages[-1], "tool_calls", [])
                        ):
                            final_message = messages[-1]

            # Keep the existing final-only provider fallback without replaying deltas.
            if final_message is not None and (
                not sent_text
                or (final_message.id and final_message.id not in streamed_ids)
            ):
                final_text = extract_text_content(final_message)
                if final_text:
                    sent_text = True
                    answer_text += final_text
                    yield _sse_event("token", {"text": final_text})
            if not sent_text:
                raise ModelError("The provider returned no answer text. Please retry.", 502)
            resolve_answer(answer_text, inspector, research=req.mode == "research")
            yield _sse_event("done", {"thread_id": thread_id, "inspector": inspector})
        except Exception as exc:
            error = provider_error(exc)
            yield _sse_event("error", {
                "message": _provider_error_message(error),
                "status_code": error.status_code,
                "retry_after": error.retry_after,
                "thread_id": thread_id,
            })

    return ChatStreamingResponse(
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
