import asyncio
import copy
import json
from types import SimpleNamespace

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

import agent
import app as api
import models
import model_smoke
from openrouter_model import FreeOpenRouterChat, ZERO_PRICE_PROVIDER

TARGETS = {
    "openai/gpt-oss-20b": "groq", "openai/gpt-oss-120b": "groq", "qwen/qwen3.8-27b": "groq",
    "gemini-3.8-flash": "google", "gemini-3.5-flash-lite": "google",
    "nvidia/nemotron-3-ultra-550b-a55b:free": "openrouter",
    "nvidia/nemotron-3-super-120b-a12b:free": "openrouter",
    "nvidia/nemotron-3.5-lightning:free": "openrouter",
    "cohere/north-mini-code:free": "openrouter",
    "nvidia/nemotron-3.5-super-vl:free": "openrouter",
    "minimax/minimax-m3.1-flash:free": "openrouter",
}
OR_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
DISCOVER = models._discover


@pytest.mark.parametrize("name,provider", TARGETS.items())
def test_target_resolution_and_factory(name, provider, monkeypatch):
    calls = []
    monkeypatch.setattr(models, "ChatGoogleGenerativeAI", lambda **kw: calls.append(kw) or SimpleNamespace(**kw))
    monkeypatch.setattr(models, "ChatGroq", lambda **kw: calls.append(kw) or SimpleNamespace(**kw))
    assert models.ensure_model_available(name)["provider"] == provider
    result = models.build_chat_model(name, streaming=True)
    if provider == "openrouter":
        assert isinstance(result, FreeOpenRouterChat) and result.model_name == name
    else:
        assert calls[0]["model"] == name and calls[0]["streaming"] is True
        # Google counts total attempts; Groq counts retries after the first.
        assert calls[0]["max_retries"] == (1 if provider == "google" else 0)
        assert "fallback" not in calls[0]


def test_catalog_and_defaults_have_no_duplicates(owner_client):
    entries = owner_client.get("/models").json()["models"]
    assert len(entries) == len({entry["id"] for entry in entries}) == 13
    assert models.DEFAULT_MODEL == "gemini-3.1-flash-lite"
    assert models.EXISTING_MODELS <= {entry["id"] for entry in entries if entry["available"]}
    assert all(not entry["live_tested"] for entry in entries)


@pytest.mark.parametrize("name", ["unknown", "openrouter/auto", "openrouter/free", OR_MODEL.removesuffix(":free"), "gpt-4o"])
@pytest.mark.parametrize("endpoint", ["/chat", "/chat/stream"])
def test_unknown_paid_and_auto_models_never_reach_agent(owner_client, name, endpoint, monkeypatch):
    async def forbidden(*a, **k):
        pytest.fail("Agent must not load")
    monkeypatch.setattr(api, "get_agent", forbidden)
    response = owner_client.post(endpoint, json={"message": "hi", "model": name})
    assert response.status_code == 400 and "unapproved" in response.json()["detail"]


@pytest.mark.parametrize("provider", ["google", "groq", "openrouter"])
def test_missing_key_disables_only_that_provider(provider, monkeypatch):
    monkeypatch.delenv(models.PROVIDER_KEYS[provider])
    entries = models.model_catalog()
    assert all(not entry["available"] and "Missing" in entry["reason"] for entry in entries if entry["provider"] == provider)
    assert all(entry["available"] for entry in entries if entry["provider"] != provider)


@pytest.mark.parametrize("patch", [
    {"pricing": {"prompt": "0.01", "completion": "0"}},
    {"pricing": {"prompt": "0", "completion": "0", "image": "0.01"}},
    {"pricing": {"prompt": "0", "completion": "0", "request": "NaN"}},
    {"pricing": {"prompt": "0"}}, {"expiration_date": "2026-10-20"},
    {"supported_parameters": []}, {"architecture": {"input_modalities": ["audio"]}},
])
def test_unverified_openrouter_catalog_fails_closed(patch, monkeypatch):
    data = copy.deepcopy(models._discover("openrouter"))
    data[OR_MODEL].update(patch)
    monkeypatch.setattr(models, "_discover", lambda provider: data)
    with pytest.raises(models.ModelError):
        models.build_chat_model(OR_MODEL)


def test_removed_model_and_discovery_outage_fail_closed(monkeypatch):
    monkeypatch.setattr(models, "_discover", lambda provider: {})
    with pytest.raises(models.ModelError, match="absent"):
        models.build_chat_model(OR_MODEL)
    models._CATALOG_CACHE.clear()
    def failed(provider):
        raise models.ModelError("Provider unavailable.", 503)
    monkeypatch.setattr(models, "_discover", failed)
    assert all(not item["available"] for item in models.model_catalog())


def test_account_policy_also_guards_embeddings(tmp_path, monkeypatch):
    policy = tmp_path / "policy.json"
    policy.write_text('{"google":false,"groq":false}')
    monkeypatch.setattr(models, "POLICY_PATH", policy)
    with pytest.raises(models.ModelError, match="unconfirmed"):
        models.build_chat_model(models.DEFAULT_MODEL)
    embed = models.FreeGoogleEmbeddings(model="gemini-embedding-001")
    with pytest.raises(models.ModelError, match="unconfirmed"):
        embed.embed_query("private document")


@pytest.mark.parametrize("endpoint", ["/chat", "/chat/stream"])
def test_private_content_requires_model_specific_consent(owner_client, endpoint, monkeypatch):
    async def forbidden(*a, **k):
        pytest.fail("No tools/history should be loaded without consent")
    monkeypatch.setattr(api, "get_agent", forbidden)
    for consent in [None, "gemini-3.8-flash"]:
        response = owner_client.post(endpoint, json={"message": "private", "model": OR_MODEL, "provider_consent": consent})
        assert response.status_code == 403 and "sharing" in response.text


@pytest.mark.parametrize("name", list(models.MODEL_CONFIGS))
def test_image_capability_enforced_for_current_and_historical_messages(name):
    messages = [HumanMessage(content=[{"type": "image", "base64": "aGVsbG8=", "mime_type": "image/png"}])]
    if models.MODEL_CONFIGS[name]["capabilities"]["vision"]:
        models.validate_model_input(name, messages)
    else:
        with pytest.raises(models.ModelError, match="cannot read images"):
            models.validate_model_input(name, messages)


def test_context_and_image_budgets():
    with pytest.raises(models.ModelError, match="context budget"):
        models.validate_model_input("openai/gpt-oss-20b", [HumanMessage(content="x" * 131072)])
    with pytest.raises(models.ModelError, match="image budget"):
        models.validate_model_input("qwen/qwen3.8-27b", [HumanMessage(content=[{"type": "image", "base64": "aA=="}] * 5)])


@pytest.fixture
def mock_http(monkeypatch):
    sync, asynchronous = httpx.Client, httpx.AsyncClient
    handlers, requests = [], []
    def handle(request):
        requests.append(request)
        result = handlers.pop(0)
        if isinstance(result, Exception):
            raise result
        return result
    transport = httpx.MockTransport(handle)
    class Client(sync):
        def __init__(self, **kwargs):
            super().__init__(transport=transport, **kwargs)
    class AsyncClient(asynchronous):
        def __init__(self, **kwargs):
            super().__init__(transport=transport, **kwargs)
    monkeypatch.setattr(httpx, "Client", Client)
    monkeypatch.setattr(httpx, "AsyncClient", AsyncClient)
    return handlers, requests


def completion(content="hello", calls=None):
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content, "reasoning": "PRIVATE REASONING", "tool_calls": calls or []}, "finish_reason": "stop"}]})


@pytest.mark.parametrize("asynchronous", [False, True])
def test_openrouter_payload_tools_vision_and_response(mock_http, asynchronous):
    handlers, requests = mock_http
    handlers.append(completion())
    name = "nvidia/nemotron-3.5-super-vl:free"
    model = models.build_chat_model(name).bind_tools([{"name": "lookup", "description": "lookup", "parameters": {"type": "object", "properties": {}}}])
    messages = [HumanMessage(content=[{"type": "text", "text": "Explain"}, {"type": "image", "base64": "aA==", "mime_type": "image/png"}])]
    result = asyncio.run(model.ainvoke(messages)) if asynchronous else model.invoke(messages)
    assert result.content == "hello" and "PRIVATE" not in str(result)
    payload = json.loads(requests[0].content)
    assert str(requests[0].url) == "https://openrouter.ai/api/v1/chat/completions"
    assert payload["provider"] == ZERO_PRICE_PROVIDER and payload["model"] == name
    assert "models" not in payload and "plugins" not in payload
    assert payload["messages"][0]["content"][1] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,aA=="}}
    assert payload["tools"][0]["function"]["name"] == "lookup"


def sse(deltas, done=True):
    data = "".join("data: " + json.dumps({"choices": [{"delta": delta}]}) + "\n\n" for delta in deltas)
    return httpx.Response(200, text=data + ("data: [DONE]\n\n" if done else ""))


@pytest.mark.parametrize("asynchronous", [False, True])
def test_streaming_answer_and_parallel_tool_fragments(mock_http, asynchronous):
    mock_http[0].append(sse([
        {"reasoning": "PRIVATE REASONING"}, {"content": "hel"}, {"content": "lo"},
        {"tool_calls": [{"index": 0, "id": "one", "function": {"name": "lookup", "arguments": '{"x":'}},
                        {"index": 1, "id": "two", "function": {"name": "lookup", "arguments": '{"x":2}'}}]},
        {"tool_calls": [{"index": 0, "function": {"arguments": '1}'}}]},
    ]))
    model = models.build_chat_model(OR_MODEL, streaming=True)
    result = asyncio.run(model.ainvoke("hi")) if asynchronous else model.invoke("hi")
    assert result.content == "hello"
    assert [(c["id"], c["args"]) for c in result.tool_calls] == [("one", {"x": 1}), ("two", {"x": 2})]
    assert "PRIVATE" not in str(result)


@pytest.mark.parametrize("response", [
    sse([{"content": "partial"}], done=False),
    sse([{"tool_calls": [{"index": 0, "id": "one", "function": {"name": "lookup", "arguments": '{"x":1'}}]}]),
    httpx.Response(200, text='data: {"error":{"code":429,"message":"secret-token"}}\n\n'),
    httpx.Response(200, text='data: not-json\n\n'),
])
def test_broken_streams_are_errors_not_success(mock_http, response):
    mock_http[0].append(response)
    with pytest.raises(models.ModelError) as error:
        models.build_chat_model(OR_MODEL, streaming=True).invoke("hi")
    assert "secret-token" not in str(error.value) and len(mock_http[1]) == 1


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 413, 422, 429, 500, 503])
def test_provider_errors_are_redacted_without_retries(mock_http, status):
    mock_http[0].append(httpx.Response(status, text="Authorization: secret-token", headers={"Retry-After": "12"}))
    with pytest.raises(models.ModelError) as error:
        models.build_chat_model(OR_MODEL).invoke("hi")
    assert "secret-token" not in str(error.value) and len(mock_http[1]) == 1
    if status == 429:
        assert error.value.retry_after == 12 and error.value.status_code == 429


def test_timeout_is_safe(mock_http):
    mock_http[0].append(httpx.ReadTimeout("secret-token"))
    with pytest.raises(models.ModelError, match="too long"):
        models.build_chat_model(OR_MODEL).invoke("hi")


@pytest.mark.parametrize("name", list(models.MODEL_CONFIGS))
def test_real_agent_tool_loop_checkpoints_and_model_switch(name, tmp_path, monkeypatch):
    executions, calls = [], []
    @tool
    def github_read_fixture(number: int) -> str:
        """Read fixture data; never contact GitHub."""
        executions.append(number)
        return f"document {number} [guide.pdf, page 7]"

    class Model:
        def bind_tools(self, tools):
            assert "github_read_fixture" in [t.name for t in tools]
            return self
        async def ainvoke(self, messages, config):
            calls.append(messages)
            results = [m for m in messages if isinstance(m, ToolMessage)]
            if not results:
                return AIMessage(content="", tool_calls=[{"id": str(i), "name": "github_read_fixture", "args": {"number": i}} for i in [1, 2]])
            assert {r.tool_call_id for r in results} == {"1", "2"}
            assert all("guide.pdf" in json.loads(r.content)["data"] for r in results)
            return AIMessage(content="Answer [guide.pdf, page 7]")

    monkeypatch.setattr(agent, "build_chat_model", lambda *a, **k: Model())
    monkeypatch.setattr(agent, "CHECKPOINT_DB_PATH", tmp_path / "checkpoints.sqlite")
    monkeypatch.setattr(agent, "_CHECKPOINT_CONNECTIONS", [])
    async def run():
        first = await agent.build_agent(name, mode="research", mcp_tools=[github_read_fixture])
        config = {"configurable": {"thread_id": "same-thread", "provider_consent": name}}
        try:
            result = await first.ainvoke({"messages": [HumanMessage(content="Read both documents")]}, config)
            assert "guide.pdf" in result["messages"][-1].content
            second = await agent.build_agent(models.DEFAULT_MODEL, mcp_tools=[github_read_fixture])
            result = await second.ainvoke({"messages": [HumanMessage(content="Continue")]}, config)
            assert any(m.content == "Read both documents" for m in result["messages"])
            assert executions == [1, 2]
        finally:
            await agent.close_agent_resources()
    asyncio.run(run())


@pytest.mark.parametrize("endpoint", ["/chat", "/chat/stream"])
def test_api_success_and_sse_contract(owner_client, endpoint, monkeypatch):
    from langchain_core.messages import AIMessageChunk
    configs = []
    class Graph:
        async def ainvoke(self, state, config):
            configs.append(config)
            return {"messages": [AIMessage(content="hello")]}
        async def astream(self, state, config, stream_mode):
            configs.append(config)
            yield "messages", (AIMessageChunk(content=[{"type": "reasoning", "text": "PRIVATE"}]), {"langgraph_node": "chatbot"})
            for text in ["hel", "lo"]:
                yield "messages", (AIMessageChunk(content=text), {"langgraph_node": "chatbot"})
            yield "values", {"messages": [AIMessage(content="hello")]}
    async def get(*a, **k):
        return Graph()
    monkeypatch.setattr(api, "get_agent", get)
    response = owner_client.post(endpoint, json={"model": OR_MODEL, "provider_consent": OR_MODEL, "message": "hi", "thread_id": "same-thread"})
    assert response.status_code == 200 and "PRIVATE" not in response.text
    assert configs[0]["configurable"]["model"] == OR_MODEL
    assert configs[0]["configurable"]["provider_consent"] == OR_MODEL
    if endpoint.endswith("stream"):
        assert response.text.count("event: done") == 1
        assert '"text": "hel"' in response.text and '"text": "lo"' in response.text
        assert response.text.count("event: token") == 2
    else:
        assert response.json()["response"] == "hello"


def test_smoke_requires_opt_in_and_deduplicates(monkeypatch):
    calls = []
    class Model:
        async def ainvoke(self, messages):
            calls.append(messages)
            return AIMessage(content="hello")
    monkeypatch.setattr(model_smoke, "build_chat_model", lambda *a, **k: Model())
    with pytest.raises(ValueError, match="opt-in"):
        asyncio.run(model_smoke.smoke([OR_MODEL]))
    assert calls == []
    result = asyncio.run(model_smoke.smoke([OR_MODEL, OR_MODEL], opt_in=True))
    assert len(calls) == 1 and len(result) == 1 and result[0]["text"] == "passed"
    assert result[0]["tools"] == "not tested"


@pytest.mark.parametrize("provider", ["google", "groq", "openrouter"])
def test_discovery_uses_only_official_get_endpoints(provider, mock_http):
    handlers, requests = mock_http
    if provider == "google":
        handlers.append(httpx.Response(200, json={"models": [{"name": "models/gemini-3.8-flash"}]}))
    elif provider == "groq":
        handlers.append(httpx.Response(200, json={"data": [{"id": "openai/gpt-oss-120b", "active": True}]}))
    else:
        handlers.extend([httpx.Response(200, json={"data": {"is_free_tier": True, "free_model_daily_requests": {"remaining": 50}}}),
                         httpx.Response(200, json={"data": [{"id": OR_MODEL}]})])
    assert DISCOVER(provider)
    assert all(request.method == "GET" and "test-" not in str(request.url) for request in requests)
    if provider == "openrouter":
        assert "authorization" not in requests[1].headers


@pytest.mark.parametrize("account", [{}, {"is_free_tier": False}, {"is_free_tier": True},
    {"is_free_tier": True, "free_model_daily_requests": {"remaining": 0}}])
def test_unverified_or_exhausted_openrouter_account_blocks_catalog(account, mock_http):
    mock_http[0].append(httpx.Response(200, json={"data": account}))
    with pytest.raises(models.ModelError):
        DISCOVER("openrouter")
    assert len(mock_http[1]) == 1


@pytest.mark.parametrize("name", ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"])
def test_real_groq_sdk_request_configuration(name, mock_http, monkeypatch):
    actual = models.ChatGroq
    monkeypatch.setattr(models, "ChatGroq", lambda **kw: actual(http_client=httpx.Client(), http_async_client=httpx.AsyncClient(), **kw))
    mock_http[0].append(completion())
    model = models.build_chat_model(name)
    assert model.invoke("hello").content == "hello"
    request = mock_http[1][0]
    assert str(request.url) == "https://api.groq.com/openai/v1/chat/completions"
    payload = json.loads(request.content)
    assert payload["model"] == name and model.max_retries == 0
    if name.startswith("openai/"):
        assert "reasoning_format" not in payload
        assert payload["include_reasoning"] is False and payload["parallel_tool_calls"] is False
    else:
        assert payload["reasoning_format"] == "hidden"


@pytest.mark.parametrize("name", ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"])
def test_real_google_sdk_configuration_without_inference(name):
    model = models.build_chat_model(name)
    assert model.model == name
    assert model.max_retries == 1 and model.timeout == 45
    assert model.include_thoughts is False and model.vertexai is False
    request = model._prepare_request([HumanMessage(content="hello")])
    assert request["config"].http_options.retry_options.attempts == 1
    assert request["config"].http_options.timeout == 45000


def test_embeddings_lazy_initialization_and_single_attempt(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY")
    embed = models.FreeGoogleEmbeddings(model="gemini-embedding-001")
    assert embed._client is None
    with pytest.raises(models.ModelError, match="Missing"):
        embed.embed_query("private text")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-google-key")
    assert embed._get_client()._build_config().http_options.retry_options.attempts == 1


def test_stream_cancel_closes_transport(monkeypatch):
    async def run():
        started = asyncio.Event()
        closed = []
        class SlowStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
                started.set()
                await asyncio.Event().wait()
            async def aclose(self):
                closed.append(True)
        original = httpx.AsyncClient
        transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=SlowStream()))
        monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=transport, **kw))
        async def collect():
            async for _ in models.build_chat_model(OR_MODEL).astream("hello"):
                pass
        task = asyncio.create_task(collect())
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed == [True]
    asyncio.run(run())


def test_api_final_answer_without_tokens_and_retry_after(owner_client, monkeypatch):
    class Graph:
        async def astream(self, *args, **kwargs):
            yield "values", {"messages": [AIMessage(content="final answer", id="final")]}
        async def ainvoke(self, *args, **kwargs):
            raise models.ModelError("Wait for free quota.", 429, 12)
    async def get(*args, **kwargs):
        return Graph()
    monkeypatch.setattr(api, "get_agent", get)
    client = owner_client
    request = {"message": "hi", "model": models.DEFAULT_MODEL}
    response = client.post("/chat/stream", json=request)
    assert response.text.count("final answer") == 1 and response.text.count("event: done") == 1
    response = client.post("/chat", json=request)
    assert response.status_code == 429 and response.headers["retry-after"] == "12"


def test_changed_key_does_not_inherit_account_attestation(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-different-account")
    with pytest.raises(models.ModelError, match="credentials changed"):
        models.build_chat_model("openai/gpt-oss-120b")


def test_lower_catalog_context_and_tool_schema_budget_are_enforced(monkeypatch):
    data = models._discover("openrouter")
    data[OR_MODEL]["context_length"] = 4200
    monkeypatch.setattr(models, "_discover", lambda provider: data)
    schema = {"name": "lookup", "description": "x" * 1000, "parameters": {"type": "object", "properties": {}}}
    with pytest.raises(models.ModelError, match="context budget"):
        models.validate_model_input(OR_MODEL, [HumanMessage(content="hi")], [schema])
