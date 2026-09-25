import asyncio

from app import ChatRequest, _provider_error_message
from models import DEFAULT_MODEL, normalize_model_name


def test_chat_request_defaults():
    request = ChatRequest(
        message="hello"
    )

    assert request.model == DEFAULT_MODEL
    assert request.mode == "normal"
    assert request.thread_id is None
    assert request.workspace_id is None
    assert request.attachment_ids == []


def test_model_normalization_and_aliases():
    assert normalize_model_name(None) == DEFAULT_MODEL
    assert normalize_model_name(
        "gemini-latest"
    ) == "gemini-3.1-flash-lite"
    assert normalize_model_name(
        "Gemini 3.5 Flash"
    ) == "gemini-3.5-flash"
    assert normalize_model_name(
        "not-a-real-model"
    ) == DEFAULT_MODEL


def test_rate_limit_error_is_user_friendly():
    message = _provider_error_message(
        Exception("429 Too Many Requests")
    )

    assert "rate limited" in message.lower()
    assert "traceback" not in message.lower()


def test_timeout_error_is_user_friendly():
    message = _provider_error_message(
        Exception("Request timed out")
    )

    assert "too long" in message.lower()
    assert "traceback" not in message.lower()
