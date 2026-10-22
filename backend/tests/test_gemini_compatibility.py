"""Exercise the installed Google SDK offline, including its aiohttp error path."""
import asyncio
import inspect
import json
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import httpx
import pytest
from google.genai import Client, errors
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.language_models.chat_models import _generate_response_from_error
from langchain_core.messages import AIMessage, HumanMessage

import model_smoke
import models


@pytest.fixture
def google_wire(monkeypatch):
    requests, replies, clients = [], [], []

    def handle(request):
        requests.append(request)
        return replies.pop(0)

    transport = httpx.MockTransport(handle)

    def client(**kwargs):
        options = kwargs.pop("http_options").model_copy(update={
            "httpx_client": httpx.Client(transport=transport),
            "httpx_async_client": httpx.AsyncClient(transport=transport),
        })
        result = Client(http_options=options, **kwargs)
        clients.append(result)
        return result

    monkeypatch.setattr("langchain_google_genai.chat_models.Client", client)
    yield requests, replies
    for client in clients:
        client.close()
        asyncio.run(client.aio.aclose())


def answer(stream=False):
    data = {"modelVersion": "gemini-3.8-flash", "candidates": [{
        "content": {"role": "model", "parts": [{"text": "hello"}]},
        "finishReason": "STOP",
    }]}
    return (httpx.Response(200, text="data: " + json.dumps(data) + "\n\n",
                           headers={"content-type": "text/event-stream"})
            if stream else httpx.Response(200, json=data))


@pytest.mark.parametrize("mode", ["invoke", "ainvoke", "stream", "astream"])
def test_gemini38_wire_omits_removed_parameters(google_wire, mode):
    requests, replies = google_wire
    replies.append(answer("stream" in mode))
    model = models.build_chat_model("gemini-3.8-flash", max_tokens=64, streaming="stream" in mode)
    # Even a bound/call-time override must not reintroduce unsupported fields.
    kwargs = {"temperature": 0.2, "top_p": 0.9, "top_k": 10,
              "generation_config": {"candidate_count": 1}}
    if mode == "invoke":
        model.invoke("hello", **kwargs)
    elif mode == "ainvoke":
        asyncio.run(model.ainvoke("hello", **kwargs))
    elif mode == "stream":
        list(model.stream("hello", **kwargs))
    else:
        async def collect():
            return [chunk async for chunk in model.astream("hello", **kwargs)]
        asyncio.run(collect())
    assert len(requests) == 1
    request = requests[0]
    assert request.url.host == "generativelanguage.googleapis.com"
    assert request.url.path.endswith("gemini-3.8-flash:" + (
        "streamGenerateContent" if "stream" in mode else "generateContent"))
    payload = json.loads(request.content)
    config = payload["generationConfig"]
    assert not {"temperature", "topP", "topK", "candidateCount"} & config.keys()
    assert config["maxOutputTokens"] == 64
    assert config["thinkingConfig"]["include_thoughts"] is False
    assert "thinking_budget" not in config["thinkingConfig"]
    assert payload["contents"] == [{"parts": [{"text": "hello"}], "role": "user"}]
    assert model._prepare_request([HumanMessage(content="hello")])["config"].http_options.retry_options.attempts == 1


def test_smoke_accepts_real_google_text_blocks(google_wire):
    google_wire[1].append(answer())
    rows = asyncio.run(model_smoke.smoke(["gemini-3.8-flash"], opt_in=True))
    assert rows[0]["text"] == "passed"
    assert len(google_wire[0]) == 1
    config = json.loads(google_wire[0][0].content)["generationConfig"]
    assert config["thinkingConfig"]["thinking_level"] == "LOW"
    assert config["maxOutputTokens"] == 64


def aiohttp_error(status):
    response = MagicMock(spec=aiohttp.ClientResponse)
    response.status = status
    response.headers = {"Retry-After": "12"}
    response.json = AsyncMock(return_value={"error": {
        "code": status, "status": "INVALID_ARGUMENT" if status == 400 else "UNAVAILABLE",
        "message": "secret-key and private prompt must not escape",
    }})
    return response


def test_upstream_warning_source_is_separate_from_provider_error():
    response = aiohttp_error(503)
    with pytest.raises(errors.ServerError) as raised:
        asyncio.run(errors.APIError.raise_for_async_response(response))
    original = raised.value
    assert original.code == 503
    response.json.assert_awaited_once()
    # LangChain calls the SAME json method synchronously after the SDK has
    # already parsed the failed response correctly. Close the leaked coroutine
    # here rather than deliberately emitting a warning from this regression test.
    generations = _generate_response_from_error(original)
    body = generations[0].message.response_metadata["body"]
    assert inspect.iscoroutine(body)
    body.close()
    assert response.json.call_count == 2 and response.json.await_count == 1


@pytest.mark.parametrize("status", [400, 429, 503])
@pytest.mark.parametrize("streaming", [False, True])
def test_async_sdk_errors_are_sanitized_before_langchain_callbacks(monkeypatch, status, streaming):
    model = models.build_chat_model("gemini-3.8-flash", streaming=streaming)
    response = aiohttp_error(status)
    session = MagicMock()
    session.request = AsyncMock(return_value=response)
    monkeypatch.setattr(model.client._api_client, "_get_aiohttp_session", AsyncMock(return_value=session))
    observed = []

    class Capture(AsyncCallbackHandler):
        async def on_llm_error(self, error, **kwargs):
            observed.append((error, kwargs.get("response")))

    async def run():
        try:
            with pytest.raises(models.ModelError) as raised:
                config = {"callbacks": [Capture()]}
                if streaming:
                    async for _ in model.astream("hello", config=config):
                        pass
                else:
                    await model.ainvoke("hello", config=config)
            assert raised.value.status_code == status
            assert raised.value.provider_error_type == ("ServerError" if status == 503 else "ClientError")
            assert "secret-key" not in str(raised.value)
        finally:
            await model.client.aio.aclose()
            model.client.close()

    asyncio.run(run())
    assert session.request.await_count == 1
    response.json.assert_awaited_once()
    assert len(observed) == 1
    assert isinstance(observed[0][0], models.ModelError)
    assert "secret-key" not in str(observed)


def test_smoke_reports_only_safe_failure_diagnostics(google_wire):
    google_wire[1].append(httpx.Response(400, json={"error": {
        "code": 400, "status": "INVALID_ARGUMENT", "message": "secret-key and private prompt",
    }}))
    rows = asyncio.run(model_smoke.smoke(["gemini-3.8-flash"], opt_in=True))
    assert rows[0]["text"] == "not tested"
    assert rows[0]["error_type"] == "ClientError"
    assert rows[0]["status_code"] == 400
    assert "secret-key" not in json.dumps(rows) and "private prompt" not in json.dumps(rows)
    assert len(google_wire[0]) == 1


@pytest.mark.parametrize("name", ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite"])
def test_other_gemini_request_parameters_are_preserved(google_wire, name):
    model = models.build_chat_model(name, temperature=0.7)
    request = model._prepare_request([HumanMessage(content="hello")])
    assert request["model"] == name
    assert request["config"].temperature == 0.7
    assert request["config"].candidate_count == 1
    assert request["config"].http_options.retry_options.attempts == 1
    assert request["config"].thinking_config.include_thoughts is False
    assert google_wire[0] == []


@pytest.mark.parametrize("status", [400, 429, 503])
@pytest.mark.parametrize("streaming", [False, True])
def test_sync_sdk_failures_are_safe_and_single_attempt(google_wire, status, streaming):
    google_wire[1].append(httpx.Response(status, json={"error": {
        "code": status, "message": "secret-key and private prompt",
    }}, headers={"Retry-After": "12"}))
    model = models.build_chat_model("gemini-3.8-flash", streaming=streaming)
    with pytest.raises(models.ModelError) as raised:
        if streaming:
            list(model.stream("hello"))
        else:
            model.invoke("hello")
    assert raised.value.status_code == status
    assert raised.value.retry_after == 12
    assert "secret-key" not in str(raised.value)
    assert len(google_wire[0]) == 1


def test_smoke_never_counts_reasoning_as_an_answer(monkeypatch):
    class Model:
        async def ainvoke(self, *args, **kwargs):
            return AIMessage(content=[{"type": "thinking", "thinking": "private reasoning"}])
    monkeypatch.setattr(model_smoke, "build_chat_model", lambda *args, **kwargs: Model())
    rows = asyncio.run(model_smoke.smoke(["gemini-3.8-flash"], opt_in=True))
    assert rows[0]["text"] == "not tested"
    assert rows[0]["status"] == "The provider returned no answer text."
    assert "private reasoning" not in json.dumps(rows)
