import base64
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import uuid

from agent import close_agent_resources, get_agent
from rag import (
    get_attachment_records,
    read_file_text,
    save_uploaded_file,
    SUPPORTED_DOCUMENT_SUFFIXES,
    SUPPORTED_IMAGE_SUFFIXES,
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
                "text": "Use the attached files to answer the user's request.",
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
        mime_type = attachment.get("mime_type") or "image/png"

        image_blocks.append(
            {
                "type": "image",
                "base64": base64.b64encode(path.read_bytes()).decode("utf-8"),
                "mime_type": mime_type,
            }
        )

    document_context = []

    if attachments:
        document_context_text = []

        for attachment in attachments:
            if attachment.get("kind") != "document":
                continue

            path_value = attachment.get("path")
            document_text = ""

            if path_value:
                try:
                    document_text = read_file_text(path_value).strip()
                except Exception:
                    document_text = ""

            preview = document_text[:12000] or attachment.get("preview")

            if preview:
                document_context_text.append(
                    f"Document: {attachment.get('name', 'uploaded document')}\n{preview}"
                )

        if document_context_text:
            document_context.append(
                {
                    "type": "text",
                    "text": (
                        "Uploaded document context:\n"
                        + "\n\n".join(document_context_text)
                    ),
                }
            )

    if document_context:
        text_blocks.append(
            {
                "type": "text",
                "text": document_context[0]["text"],
            }
        )

    return text_blocks + image_blocks


@app.get("/")
def home():
    return {
        "status": "ok",
        "message": "Clawbit Backend Running",
    }


@app.post("/attachments/upload", response_model=UploadResponse)
async def upload_attachment(
    thread_id: str = Form(...),
    file: UploadFile = File(...),
):
    suffix = Path(file.filename or "").suffix.lower()

    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        suffix = UPLOAD_SUFFIX_BY_MIME.get(
            (file.content_type or "").lower(),
            "",
        )

    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, or images.",
        )

    upload_dir = Path(__file__).resolve().parent / "uploads" / thread_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    safe_name = Path(file.filename or "upload").name

    if (
        Path(safe_name).suffix.lower() not in SUPPORTED_UPLOAD_SUFFIXES
        and suffix
    ):
        safe_name = f"{Path(safe_name).stem}{suffix}"

    attachment_path = upload_dir / f"{uuid.uuid4().hex}_{safe_name}"

    content = await file.read()
    attachment_path.write_bytes(content)

    try:
        record = save_uploaded_file(
            str(attachment_path),
            thread_id=thread_id,
            original_name=file.filename or attachment_path.name,
        )
    except Exception as exc:
        if attachment_path.exists():
            attachment_path.unlink(missing_ok=True)

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


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    thread_id = req.thread_id or str(uuid.uuid4())
    attachment_ids = req.attachment_ids or []

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

    result = await agent.ainvoke(
        {
            "messages": [user_message],
        },
        config={
            "configurable": {
                "thread_id": thread_id,
                "attachment_ids": attachment_ids,
                "model": req.model,
                "mode": req.mode,
            }
        },
    )

    if isinstance(result, dict):
        messages = result.get("messages", [])

        if messages:
            response = extract_text_content(messages[-1])
        else:
            response = ""
    else:
        response = extract_text_content(result)

    return ChatResponse(
        response=response,
        thread_id=thread_id,
    )
