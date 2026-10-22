"""Endpoint outages must not look like removed models or bypass free-only routing."""

import json

import httpx
from langchain_core.messages import AIMessage, HumanMessage
import pytest

import app as api
import models
from openrouter_model import FreeOpenRouterChat, ZERO_PRICE_PROVIDER


SUPER = "nvidia/nemotron-3-super-120b-a12b:free"
DISCOVER_ENDPOINTS = models._discover_openrouter_endpoints


def endpoint_payload(name=SUPER, *, status=0):
    return {"data": {"id": name, "endpoints": [{
        "model_id": name,
        "status": status,
        "pricing": {"prompt": "0", "completion": "0", "discount": 0},
        "supported_parameters": ["tools", "reasoning", "max_tokens", "temperature"],
    }]}}


@pytest.mark.parametrize("patch", [
    {"status": -5}, {"status": -2}, {"status": None}, {"status": False},
    {"pricing": {"prompt": "0", "completion": "0.001"}},
    {"pricing": {"prompt": "0", "completion": "0", "request": "0.01"}},
    {"pricing": {"prompt": "0", "completion": "NaN"}},
    {"pricing": {"prompt": "0"}}, {"supported_parameters": []},
    {"model_id": "nvidia/nemotron-3-super-120b-a12b"},
])
def test_unusable_endpoints_fail_closed(patch, monkeypatch):
    payload = endpoint_payload()
    payload["data"]["endpoints"][0].update(patch)
    monkeypatch.setattr(models, "_discover_openrouter_endpoints", lambda name: payload)
    with pytest.raises(models.ModelError, match="no operational zero-cost") as error:
        models.ensure_model_available(SUPER)
    assert error.value.status_code == 503


@pytest.mark.parametrize("payload", [
    None, [], {}, {"data": {}}, {"data": {"id": SUPER, "endpoints": None}},
    {"data": {"id": "another/model:free", "endpoints": []}},
])
def test_malformed_endpoint_metadata_is_not_availability(payload, monkeypatch):
    monkeypatch.setattr(models, "_discover_openrouter_endpoints", lambda name: payload)
    with pytest.raises(models.ModelError, match="could not be verified"):
        models.ensure_model_available(SUPER)


def test_one_healthy_free_endpoint_is_enough_without_enabling_fallback(monkeypatch):
    payload = endpoint_payload(status=-5)
    payload["data"]["endpoints"].append(endpoint_payload()["data"]["endpoints"][0])
    monkeypatch.setattr(models, "_discover_openrouter_endpoints", lambda name: payload)
    assert models.ensure_model_available(SUPER)["model"] == SUPER
    wire = FreeOpenRouterChat(model_name=SUPER)._payload([HumanMessage("hello")], None, True, {})
    assert wire["model"] == SUPER
    assert wire["provider"] == ZERO_PRICE_PROVIDER
    assert wire["provider"]["allow_fallbacks"] is False
    assert wire["provider"]["require_parameters"] is True
    assert all(value == 0 for value in wire["provider"]["max_price"].values())


def test_endpoint_outage_cache_expires_and_recovers_without_restart(monkeypatch):
    now = [100.0]
    calls = []

    def discover(name):
        calls.append(name)
        return endpoint_payload(status=-5 if now[0] == 100 else 0)

    monkeypatch.setattr(models.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(models, "_discover_openrouter_endpoints", discover)
    for _ in range(2):
        with pytest.raises(models.ModelError):
            models.ensure_model_available(SUPER)
    assert calls == [SUPER]
    now[0] += models.OPENROUTER_ENDPOINT_CACHE_SECONDS + 1
    assert models.ensure_model_available(SUPER)["model"] == SUPER
    assert calls == [SUPER, SUPER]


def test_endpoint_discovery_uses_only_the_official_read_only_url(monkeypatch):
    urls = []

    def get_json(url, headers=None):
        urls.append((url, headers))
        return endpoint_payload()

    monkeypatch.setattr(models, "_get_json", get_json)
    assert DISCOVER_ENDPOINTS(SUPER) == endpoint_payload()
    assert urls == [(f"https://openrouter.ai/api/v1/models/{SUPER}/endpoints", None)]


def test_catalog_keeps_all_thirteen_models_and_distinguishes_cors_preflight(
    owner_client, monkeypatch
):
    healthy = models._discover_openrouter_endpoints
    monkeypatch.setattr(
        models, "_discover_openrouter_endpoints",
        lambda name: endpoint_payload(status=-5) if name == SUPER else healthy(name),
    )
    preflight = owner_client.options("/models", headers={
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-csrf-token",
    })
    assert preflight.status_code == 200 and preflight.content == b"OK"
    response = owner_client.get("/models")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    entries = {entry["id"]: entry for entry in response.json()["models"]}
    assert set(entries) == models.ALLOWED_MODELS and len(entries) == 13
    for name, entry in entries.items():
        assert entry["model"] == name
        assert entry["provider"] == models.MODEL_CONFIGS[name]["provider"]
    assert entries[SUPER]["available"] is False
    assert "no operational zero-cost" in entries[SUPER]["reason"]
    assert all(entry["available"] for name, entry in entries.items() if name != SUPER)
    assert response.headers["cache-control"].endswith("no-store")


@pytest.mark.parametrize("endpoint", ["/chat", "/chat/stream"])
def test_known_outage_is_rejected_before_sse_or_agent_work(owner_client, monkeypatch, endpoint):
    monkeypatch.setattr(
        models, "_discover_openrouter_endpoints", lambda name: endpoint_payload(status=-5)
    )

    async def forbidden(*args, **kwargs):
        pytest.fail("An unavailable endpoint must not start an agent or inference.")

    monkeypatch.setattr(api, "get_agent", forbidden)
    response = owner_client.post(endpoint, json={
        "message": "hello", "model": SUPER, "provider_consent": SUPER,
    })
    assert response.status_code == 503
    assert response.headers["retry-after"] == "30"
    assert "no operational zero-cost" in response.json()["detail"]
    assert "event: start" not in response.text


@pytest.mark.parametrize("upstream_failure", [False, True])
def test_authenticated_super_stream_preserves_id_and_handles_upstream_404(
    owner_client, monkeypatch, upstream_failure
):
    requests = []

    def handle(request):
        requests.append(request)
        if upstream_failure:
            return httpx.Response(404, json={"error": {
                "code": 404, "message": "No endpoints found; private provider detail",
            }})
        return httpx.Response(200, text=(
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            'data: [DONE]\n\n'
        ), headers={"Content-Type": "text/event-stream"})

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs)
    )

    class Graph:
        async def astream(self, state, config, stream_mode):
            model = models.build_chat_model(SUPER, streaming=True)
            async for chunk in model.astream(state["messages"]):
                yield "messages", (chunk, {"langgraph_node": "chatbot"})
            yield "values", {"messages": [AIMessage(content="hello")]}

    async def get_graph(*args, **kwargs):
        return Graph()

    monkeypatch.setattr(api, "get_agent", get_graph)
    response = owner_client.post("/chat/stream", json={
        "message": "hello", "model": SUPER, "provider_consent": SUPER,
    })
    assert response.status_code == 200 and "event: start" in response.text
    assert len(requests) == 1
    payload = json.loads(requests[0].content)
    assert payload["model"] == SUPER and payload["stream"] is True
    assert payload["provider"] == ZERO_PRICE_PROVIDER
    if upstream_failure:
        assert '"status_code": 503' in response.text
        assert "No eligible free OpenRouter endpoint" in response.text
        assert "removed" not in response.text and "private provider detail" not in response.text
        assert "event: token" not in response.text
    else:
        assert '"text": "hello"' in response.text and "event: done" in response.text
        assert "event: error" not in response.text


def test_provider_404_context_does_not_change_other_provider_errors():
    error = httpx.HTTPStatusError(
        "private detail", request=httpx.Request("POST", "https://openrouter.ai"),
        response=httpx.Response(404),
    )
    mapped = models.provider_error(error, provider="openrouter")
    assert mapped.status_code == 503 and mapped.provider_status_code == 404
    assert models.provider_error(error).status_code == 404
    assert "private detail" not in str(mapped)
