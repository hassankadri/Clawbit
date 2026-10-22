"""Explicit model allowlist and fail-closed, server-side free-tier policy."""
import hashlib
import hmac
import json
import os
import time
from collections.abc import Iterator
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Lock
from typing import Any

import httpx
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI as _ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_google_genai.chat_models import ChatGoogleGenerativeAIError
from langchain_core.embeddings import Embeddings
from langchain_core.utils.function_calling import convert_to_openai_tool
from google.genai.types import HttpOptions, HttpRetryOptions
from google.genai.errors import APIError as GoogleAPIError
from langchain_groq import ChatGroq as _ChatGroq
from usage_limits import UsageLimitError, limited, operation_budget
from ownership import OwnershipError

ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)
POLICY_PATH = Path(__file__).resolve().parent / "free_tier_policy.json"
DEFAULT_MODEL = "gemini-3.1-flash-lite"
MODEL_TIMEOUT_SECONDS = 45.0
MODEL_RETRIES = 0
PROVIDER_KEYS = {"google": "GOOGLE_API_KEY", "groq": "GROQ_API_KEY", "openrouter": "OPENROUTER_API_KEY"}
EXISTING_MODELS = {DEFAULT_MODEL, "gemini-3.5-flash", "openai/gpt-oss-20b"}


class ChatGoogleGenerativeAI(_ChatGoogleGenerativeAI):
    def _prepare_request(self, *args, **kwargs):
        request = super()._prepare_request(*args, **kwargs)
        if self.model == "gemini-3.8-flash":
            # The installed adapter injects candidate_count=1 and sampling
            # defaults. Gemini 3.8's migration guide requires omitting these.
            # Strip at the final config boundary, including bound overrides.
            request["config"] = request["config"].model_copy(update={
                "temperature": None, "top_p": None, "top_k": None,
                "candidate_count": None,
            })
        return request

    # Sanitize SDK failures BEFORE LangChain's outer callback/error collector.
    # That collector synchronously calls aiohttp ClientResponse.json(), leaking
    # a coroutine and potentially copying sensitive provider bodies to traces.
    # The Google SDK has already awaited and parsed the error body correctly.
    @limited("inference")
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except (GoogleAPIError, ChatGoogleGenerativeAIError) as exc:
            raise provider_error(exc) from None

    @limited("inference")
    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except (GoogleAPIError, ChatGoogleGenerativeAIError) as exc:
            raise provider_error(exc) from None

    @limited("inference")
    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            yield from super()._stream(messages, stop=stop, run_manager=run_manager, **kwargs)
        except (GoogleAPIError, ChatGoogleGenerativeAIError) as exc:
            raise provider_error(exc) from None

    @limited("inference")
    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            async for chunk in super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs):
                yield chunk
        except (GoogleAPIError, ChatGoogleGenerativeAIError) as exc:
            raise provider_error(exc) from None


class ChatGroq(_ChatGroq):
    @limited("inference")
    def _generate(self, *args, **kwargs):
        return super()._generate(*args, **kwargs)

    @limited("inference")
    async def _agenerate(self, *args, **kwargs):
        return await super()._agenerate(*args, **kwargs)

    @limited("inference")
    def _stream(self, *args, **kwargs):
        yield from super()._stream(*args, **kwargs)

    @limited("inference")
    async def _astream(self, *args, **kwargs):
        async for chunk in super()._astream(*args, **kwargs):
            yield chunk

    @property
    def _default_params(self):
        params = super()._default_params
        # This SDK serializes reasoning_format=None. GPT-OSS does not support
        # the parameter at all, so omit it rather than sending JSON null.
        if self.model_name.startswith("openai/gpt-oss"):
            params.pop("reasoning_format", None)
        return params


def _entry(provider, label, description, vision=False, context=131072, structured=False):
    return {"provider": provider, "label": label, "description": description,
            "capabilities": {"text": True, "streaming": True, "tools": True,
                             "vision": vision, "structured_output": structured,
                             "coding": True, "reasoning": True}, "context_length": context}


MODEL_CONFIGS = {
    DEFAULT_MODEL: _entry("google", "Gemini 3.1 Flash-Lite", "Fast · Everyday chat", True, 1048576, True),
    "gemini-3.5-flash": _entry("google", "Gemini 3.5 Flash", "Reasoning · Research/Agents", True, 1048576, True),
    "gemini-3.8-flash": _entry("google", "Gemini 3.8 Flash", "Reasoning · Coding · Vision", True, 1048576, True),
    "gemini-3.5-flash-lite": _entry("google", "Gemini 3.5 Flash-Lite", "Fast · Summaries · Vision", True, 1048576, True),
    "openai/gpt-oss-20b": _entry("groq", "GPT-OSS 20B", "Fast · Coding · Tools", structured=True),
    "openai/gpt-oss-120b": _entry("groq", "GPT-OSS 120B", "Reasoning · Coding · Research/Agents", structured=True),
    "qwen/qwen3.8-27b": _entry("groq", "Qwen 3.8 27B", "Multilingual · Coding · Vision", True),
    "nvidia/nemotron-3-ultra-550b-a55b:free": _entry("openrouter", "Nemotron 3 Ultra", "Reasoning · Research/Agents", context=1000000),
    "nvidia/nemotron-3-super-120b-a12b:free": _entry("openrouter", "Nemotron 3 Super", "Tools · Structured output", context=262144, structured=True),
    "nvidia/nemotron-3.5-lightning:free": _entry("openrouter", "Nemotron 3.5 Lightning", "Fast · Tools", context=1000000),
    "cohere/north-mini-code:free": _entry("openrouter", "North Mini Code", "Coding · Debugging", context=256000),
    "nvidia/nemotron-3.5-super-vl:free": _entry("openrouter", "Nemotron 3.5 Super VL", "Vision · Research/Agents", True, 1000000, True),
    "minimax/minimax-m3.1-flash:free": _entry("openrouter", "MiniMax M3.1 Flash", "Coding · Vision · Research/Agents", True, 1000000),
}
for _id, _config in MODEL_CONFIGS.items():
    _config["model"] = _id
ALLOWED_MODELS = frozenset(MODEL_CONFIGS)


class ModelError(ValueError):
    """Only fixed, public messages may be supplied here."""
    def __init__(self, message, status_code=400, retry_after=None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


def normalize_model_name(model_name: str | None) -> str:
    name = (model_name or DEFAULT_MODEL).strip().lower()
    name = {"gemini-latest": DEFAULT_MODEL, "gemini 3.1 flash lite": DEFAULT_MODEL,
            "gemini 3.5 flash": "gemini-3.5-flash"}.get(name, name)
    if name not in ALLOWED_MODELS:
        raise ModelError("Unknown or unapproved model. Choose a model from the selector.")
    return name


def require_free_account(provider):
    if not os.environ.get(PROVIDER_KEYS[provider], "").strip():
        raise ModelError(f"Missing {PROVIDER_KEYS[provider]}. Configure it on the server.", 503)
    if provider in {"google", "groq"}:
        try:
            policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            policy = {}
        if not isinstance(policy, dict):
            policy = {}
        if policy.get(provider) is not True:
            raise ModelError("Free-only account status is unconfirmed. Confirm billing is disabled in the server policy.", 503)
        fingerprints = policy.get("key_fingerprints", {})
        expected = fingerprints.get(provider, "") if isinstance(fingerprints, dict) else ""
        current = hashlib.sha256(os.environ[PROVIDER_KEYS[provider]].encode()).hexdigest()
        if not isinstance(expected, str) or not hmac.compare_digest(expected, current):
            raise ModelError("Provider credentials changed. Reconfirm the free-only account policy before inference.", 503)
    if provider == "google" and os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in {"true", "1"}:
        raise ModelError("Vertex AI is disabled by the free-only policy.", 503)


def provider_error(exc, *, provider: str | None = None):
    from observability import event

    event("provider", "failed", error=exc, provider=provider, category="unavailable")
    if isinstance(exc, OwnershipError):
        return ModelError(str(exc), exc.status_code)
    if isinstance(exc, UsageLimitError):
        return ModelError(str(exc), 429, exc.retry_after)
    if isinstance(exc, ModelError):
        return exc
    # SDK wrappers retain structured HTTP errors as their cause. Never expose
    # the wrapper's raw text (which can include request data or credentials).
    cause = getattr(exc, "__cause__", None)
    if cause is not None and cause is not exc:
        return provider_error(cause, provider=provider)
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    response = getattr(exc, "response", None)
    status = status or getattr(response, "status_code", None)
    headers = getattr(response, "headers", {}) or {}
    hint = headers.get("retry-after", "")
    retry = int(hint) if str(hint).isdigit() and len(str(hint)) < 7 else None
    if provider == "openrouter" and status == 404:
        # OpenRouter also uses 404 when no endpoint satisfies the routing policy.
        # It does not establish that an allowlisted model has been removed.
        error = ModelError(
            "No eligible free OpenRouter endpoint is currently available for this model. "
            "Wait or choose another verified model.",
            503,
            retry or 30,
        )
        error.provider_error_type = type(exc).__name__
        error.provider_status_code = 404
        return error
    messages = {
        401: "The provider rejected the API key. Check the server credentials.",
        403: "The provider denied access. Check free-tier permissions; do not enable billing.",
        402: "Free access is unavailable. Paid credits and fallback are disabled.",
        404: "This model is unavailable or has been removed. Choose another verified model.",
        429: "The provider's free quota or rate limit was reached. Wait before retrying.",
        400: "The provider rejected the request. Check its context, image and tool limits.",
        413: "The request exceeds the provider's input or context limit.",
        422: "The provider rejected an unsupported request parameter.",
        503: "The AI provider is temporarily unavailable. Please try again later.",
    }
    if status in messages:
        error = ModelError(messages[status], status, retry)
    elif isinstance(exc, (TimeoutError, httpx.TimeoutException)) or "timeout" in type(exc).__name__.lower():
        error = ModelError("The AI provider took too long to respond. Please try again.", 504)
    else:
        error = ModelError("The AI provider is temporarily unavailable or returned an invalid response.", 502)
    # Safe diagnostics only: never include the raw exception/body/request URL.
    error.provider_error_type = type(exc).__name__
    return error


def _get_json(url, headers=None):
    try:
        with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise provider_error(exc) from None


def _discover(provider):
    key = os.environ[PROVIDER_KEYS[provider]]
    if provider == "google":
        data = _get_json("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {"x-goog-api-key": key})
        return {m["name"].removeprefix("models/"): m for m in data["models"]}
    if provider == "groq":
        data = _get_json("https://api.groq.com/openai/v1/models", {"Authorization": f"Bearer {key}"})
        return {m["id"]: m for m in data["data"] if m.get("active") is True}
    account = _get_json("https://openrouter.ai/api/v1/key", {"Authorization": f"Bearer {key}"})["data"]
    if not isinstance(account, dict):
        raise ModelError("OpenRouter account verification returned an invalid response.", 503)
    if account.get("is_free_tier") is not True:
        raise ModelError("OpenRouter free-account status is not verified. Paid accounts are disabled by this policy.", 503)
    quota = account.get("free_model_daily_requests")
    remaining = quota.get("remaining") if isinstance(quota, dict) else None
    if not isinstance(remaining, (int, float)) or remaining <= 0:
        raise ModelError("OpenRouter free quota is exhausted or unverified. Wait for the quota to reset.", 429)
    data = _get_json("https://openrouter.ai/api/v1/models")
    return {m["id"]: m for m in data["data"]}


_CATALOG_CACHE = {}
_CATALOG_LOCK = Lock()
_OPENROUTER_ENDPOINT_CACHE = {}
OPENROUTER_ENDPOINT_CACHE_SECONDS = 30


def _has_zero_pricing(prices: object) -> bool:
    """Require explicit zero token pricing and reject any additional paid charge."""
    try:
        return (
            isinstance(prices, dict)
            and "prompt" in prices
            and "completion" in prices
            and all(
                Decimal(str(value)).is_finite() and Decimal(str(value)) == 0
                for value in prices.values()
            )
        )
    except (InvalidOperation, TypeError, ValueError):
        return False


def _discover_openrouter_endpoints(model_name: str) -> object:
    return _get_json(
        f"https://openrouter.ai/api/v1/models/{model_name}/endpoints"
    )


def _require_openrouter_endpoint(model_name: str) -> None:
    """Catalog membership alone does not establish a model's endpoint availability."""
    with _CATALOG_LOCK:
        cached = _OPENROUTER_ENDPOINT_CACHE.get(model_name)
        if cached and cached[0] > time.monotonic():
            if isinstance(cached[1], ModelError):
                raise cached[1]
            return
        try:
            payload = _discover_openrouter_endpoints(model_name)
            data = payload.get("data") if isinstance(payload, dict) else None
            endpoints = data.get("endpoints") if isinstance(data, dict) else None
            if (
                not isinstance(data, dict)
                or data.get("id") != model_name
                or not isinstance(endpoints, list)
            ):
                raise ModelError("OpenRouter endpoint availability could not be verified.", 503)
            available = any(
                isinstance(endpoint, dict)
                and endpoint.get("model_id") == model_name
                and type(endpoint.get("status")) is int
                and endpoint["status"] == 0
                and _has_zero_pricing(endpoint.get("pricing"))
                and isinstance(endpoint.get("supported_parameters"), list)
                and "tools" in endpoint["supported_parameters"]
                for endpoint in endpoints
            )
            if not available:
                raise ModelError(
                    "This OpenRouter model has no operational zero-cost tool endpoint. "
                    "Wait or choose another verified model.",
                    503,
                    OPENROUTER_ENDPOINT_CACHE_SECONDS,
                )
        except ModelError as error:
            _OPENROUTER_ENDPOINT_CACHE[model_name] = (
                time.monotonic() + OPENROUTER_ENDPOINT_CACHE_SECONDS, error
            )
            raise
        _OPENROUTER_ENDPOINT_CACHE[model_name] = (
            time.monotonic() + OPENROUTER_ENDPOINT_CACHE_SECONDS, True
        )


def _provider_catalog(provider):
    require_free_account(provider)
    fingerprint = hashlib.sha256(os.environ[PROVIDER_KEYS[provider]].encode()).digest()
    cache_key = (provider, fingerprint)
    with _CATALOG_LOCK:
        cached = _CATALOG_CACHE.get(cache_key)
        if cached and cached[0] > time.monotonic():
            if isinstance(cached[1], ModelError):
                raise cached[1]
            return cached[1]
        try:
            data = _discover(provider)
            if not isinstance(data, dict):
                raise ModelError("Provider discovery returned an invalid response.", 503)
        except (ModelError, KeyError, TypeError, ValueError) as exc:
            error = provider_error(exc)
            _CATALOG_CACHE[cache_key] = (time.monotonic() + 30, error)
            raise error from None
        _CATALOG_CACHE[cache_key] = (time.monotonic() + 300, data)
        return data


def ensure_model_available(model_name):
    name = normalize_model_name(model_name)
    config = MODEL_CONFIGS[name]
    data = _provider_catalog(config["provider"]).get(name)
    if not isinstance(data, dict):
        raise ModelError("The selected model is absent from the provider's active catalog.", 503)
    if config["provider"] == "openrouter":
        if (
            not name.endswith(":free")
            or not _has_zero_pricing(data.get("pricing", {}))
            or data.get("expiration_date")
        ):
            raise ModelError("Zero pricing and continued free availability could not be verified.", 503)
        params = data.get("supported_parameters", [])
        architecture = data.get("architecture") or {}
        modalities = architecture.get("input_modalities", []) if isinstance(architecture, dict) else []
        if not isinstance(params, list):
            params = []
        if "tools" not in params or "text" not in modalities or (config["capabilities"]["vision"] and "image" not in modalities):
            raise ModelError("Required tool or input capabilities are no longer verified.", 503)
        _require_openrouter_endpoint(name)
    elif config["provider"] == "google" and "generateContent" not in data.get("supportedGenerationMethods", []):
        raise ModelError("This model does not support the required chat API.", 503)
    limit = data.get("context_length", data.get("context_window", data.get("inputTokenLimit")))
    provider_limit = (data.get("top_provider") or {}).get("context_length") if isinstance(data.get("top_provider"), dict) else None
    limits = [value for value in (limit, provider_limit, config["context_length"]) if type(value) is int and value > 0]
    return {**config, "context_length": min(limits)}


def model_catalog():
    result = []
    for name, config in MODEL_CONFIGS.items():
        reason = "Integrated; live inference verification pending."
        available = True
        try:
            config = ensure_model_available(name)
        except ModelError as exc:
            available, reason = False, str(exc)
        result.append({"id": name, **config, "available": available, "reason": reason,
                       "consent_required": name not in EXISTING_MODELS, "live_tested": False})
    return result


def require_consent(model_name, consent):
    name = normalize_model_name(model_name)
    if name not in EXISTING_MODELS and consent != name:
        raise ModelError("Confirm sharing this conversation, uploads and tool results with the selected free provider before sending.", 403)


def validate_model_input(model_name, messages, tools=None):
    config = ensure_model_available(model_name)
    size, image_bytes, images = 0, 0, 0
    if tools:
        size += len(json.dumps([convert_to_openai_tool(tool) for tool in tools]).encode("utf-8"))
    for message in messages:
        content = getattr(message, "content", "")
        for block in content if isinstance(content, list) else [content]:
            if isinstance(block, dict) and block.get("type") in {"image", "image_url"}:
                images += 1
                image_bytes += len(json.dumps(block))
                size += 8192
            else:
                size += len((block if isinstance(block, str) else json.dumps(block)).encode("utf-8"))
    if images and not config["capabilities"]["vision"]:
        raise ModelError("The selected model cannot read images, including images in this conversation's history. Choose a vision model.")
    if images > 4 or image_bytes > 18 * 1024 * 1024:
        raise ModelError("This request exceeds the model's inline image budget (4 images, 18 MiB encoded).")
    if size + 4096 > config["context_length"]:
        raise ModelError("The conversation exceeds this model's context budget. Use a new chat or a larger-context model.", 413)


def build_chat_model(model_name, temperature=0.3, max_tokens=None, streaming=False):
    from observability import event, identifier_tag

    name = normalize_model_name(model_name)
    config = ensure_model_available(name)
    event("provider", "complete", model_tag=identifier_tag(name), provider=config["provider"])
    if not config["capabilities"]["tools"]:
        raise ModelError("This model cannot use Clawbit's agent tools.")
    budget = min(max_tokens or 4096, 4096)
    if config["provider"] == "google":
        return ChatGoogleGenerativeAI(model=name, api_key=os.environ["GOOGLE_API_KEY"],
            temperature=temperature, streaming=streaming, max_retries=1,
            timeout=MODEL_TIMEOUT_SECONDS, max_tokens=budget, include_thoughts=False,
            vertexai=False, base_url="https://generativelanguage.googleapis.com")
    if config["provider"] == "groq":
        gpt_oss = name.startswith("openai/gpt-oss")
        return ChatGroq(model=name, api_key=os.environ["GROQ_API_KEY"],
            base_url="https://api.groq.com", temperature=temperature, streaming=streaming,
            max_retries=MODEL_RETRIES, timeout=MODEL_TIMEOUT_SECONDS, max_tokens=budget,
            reasoning_format=None if gpt_oss else "hidden", service_tier="on_demand",
            model_kwargs={"parallel_tool_calls": False, "include_reasoning": False} if gpt_oss else {})
    from openrouter_model import FreeOpenRouterChat
    return FreeOpenRouterChat(model_name=name, temperature=temperature, max_tokens=budget, streaming=streaming)


class _SingleAttemptEmbeddings(GoogleGenerativeAIEmbeddings):
    def _build_config(self, **kwargs):
        config = super()._build_config(**kwargs)
        config.http_options = HttpOptions(timeout=45000, retry_options=HttpRetryOptions(attempts=1))
        return config


class FreeGoogleEmbeddings(Embeddings):
    """Lazy credentials allow other providers to start without a Google key."""
    def __init__(self, model):
        self.model = model
        self._client = None
        self._key_fingerprint = None

    def _get_client(self):
        require_free_account("google")
        fingerprint = hashlib.sha256(os.environ["GOOGLE_API_KEY"].encode()).digest()
        if self._client is None or fingerprint != self._key_fingerprint:
            self._client = _SingleAttemptEmbeddings(model=self.model, api_key=os.environ["GOOGLE_API_KEY"],
                vertexai=False, base_url="https://generativelanguage.googleapis.com")
            self._key_fingerprint = fingerprint
        return self._client

    @staticmethod
    def _document_batches(
        texts: list[str], batch_size: int, kwargs: dict[str, Any],
    ) -> Iterator[tuple[list[str], dict[str, Any]]]:
        """Use the installed SDK's batching so each admitted batch is one request."""
        if type(batch_size) is not int or not 1 <= batch_size <= 100:
            raise ModelError("Embedding batches must contain between 1 and 100 texts.")
        offset = 0
        for batch in GoogleGenerativeAIEmbeddings._prepare_batches(texts, batch_size):
            options = dict(kwargs)
            if options.get("titles") is not None:
                options["titles"] = options["titles"][offset:offset + len(batch)]
            offset += len(batch)
            yield batch, options

    def embed_documents(
        self, texts: list[str], *, batch_size: int = 100, **kwargs: Any,
    ) -> list[list[float]]:
        result: list[list[float]] = []
        for batch, options in self._document_batches(texts, batch_size, kwargs):
            with operation_budget("embedding"):
                embeddings = self._get_client().embed_documents(
                    batch, batch_size=batch_size, **options,
                )
                result.extend(embeddings)
        return result

    @limited("embedding")
    def embed_query(self, *args, **kwargs):
        return self._get_client().embed_query(*args, **kwargs)

    async def aembed_documents(
        self, texts: list[str], *, batch_size: int = 100, **kwargs: Any,
    ) -> list[list[float]]:
        result: list[list[float]] = []
        for batch, options in self._document_batches(texts, batch_size, kwargs):
            with operation_budget("embedding"):
                embeddings = await self._get_client().aembed_documents(
                    batch, batch_size=batch_size, **options,
                )
                result.extend(embeddings)
        return result

    @limited("embedding")
    async def aembed_query(self, *args, **kwargs):
        return await self._get_client().aembed_query(*args, **kwargs)
