"""Small OpenAI-compatible LangChain transport using the installed httpx client.

No SDK upgrade, implicit provider routing, retry, plugins or caller-supplied URLs.
Reasoning fields never become answer text. Connections close on cancellation.
"""
import asyncio
import json
import os

import httpx
from langchain_core.language_models.chat_models import BaseChatModel, agenerate_from_stream, generate_from_stream
from langchain_core.messages import AIMessage, AIMessageChunk, convert_to_openai_messages
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool

from models import ModelError, MODEL_CONFIGS, ensure_model_available, provider_error, validate_model_input
from usage_limits import limited

URL = "https://openrouter.ai/api/v1/chat/completions"
ZERO_PRICE_PROVIDER = {"allow_fallbacks": False, "require_parameters": True,
                       "max_price": {"prompt": 0, "completion": 0, "request": 0, "image": 0}}


class FreeOpenRouterChat(BaseChatModel):
    model_name: str
    temperature: float = 0.3
    max_tokens: int = 4096
    streaming: bool = False

    @property
    def _llm_type(self):
        return "clawbit-free-openrouter"

    @property
    def _identifying_params(self):
        return {"model_name": self.model_name}

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        if not MODEL_CONFIGS[self.model_name]["capabilities"]["tools"]:
            raise ModelError("This model does not support agent tools.")
        return self.bind(tools=[convert_to_openai_tool(tool) for tool in tools],
                         **({"tool_choice": tool_choice} if tool_choice else {}), **kwargs)

    def _payload(self, messages, stop, stream, kwargs):
        config = ensure_model_available(self.model_name)
        if config["provider"] != "openrouter":
            raise ModelError("This transport only accepts approved OpenRouter free models.")
        validate_model_input(self.model_name, messages, kwargs.get("tools"))
        if set(kwargs) - {"tools", "tool_choice", "response_format"}:
            raise ModelError("Unsupported provider option; model routing cannot be overridden.")
        if "response_format" in kwargs and not config["capabilities"]["structured_output"]:
            raise ModelError("Structured output is not verified for this model.")
        return {"model": self.model_name, "messages": convert_to_openai_messages(messages),
                "stream": stream, "max_tokens": min(self.max_tokens, 4096),
                "temperature": self.temperature, "provider": ZERO_PRICE_PROVIDER,
                "reasoning": {"exclude": True}, **({"stop": stop} if stop else {}), **kwargs}

    @staticmethod
    def _headers():
        return {"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"],
                "Content-Type": "application/json", "X-OpenRouter-Title": "Clawbit"}

    @staticmethod
    def _choice(data):
        if not isinstance(data, dict) or "error" in data:
            status = data.get("error", {}).get("code") if isinstance(data, dict) and isinstance(data.get("error"), dict) else None
            error = Exception()
            error.status_code = status
            raise provider_error(error, provider="openrouter")
        choices = data.get("choices")
        if not isinstance(choices, list):
            raise ModelError("The provider returned an invalid response.", 502)
        if not choices:  # usage-only stream frames
            return None
        choice = choices[0]
        if not isinstance(choice, dict) or choice.get("finish_reason") == "error":
            raise ModelError("The provider interrupted generation. Please retry later.", 502)
        return choice

    def _result(self, data):
        try:
            choice = self._choice(data)
            if not choice:
                raise ValueError
            message = choice["message"]
            content = message.get("content") or ""
            if not isinstance(content, str):
                raise ValueError
            calls = []
            for call in message.get("tool_calls") or []:
                args = json.loads(call["function"]["arguments"])
                if not isinstance(args, dict) or not call.get("id") or not call["function"].get("name"):
                    raise ValueError
                calls.append({"id": call["id"], "name": call["function"]["name"], "args": args})
            if len({call["id"] for call in calls}) != len(calls) or (not content and not calls):
                raise ValueError
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=content, tool_calls=calls))])
        except (KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, ModelError):
                raise
            raise ModelError("The provider returned an invalid answer or tool call.", 502) from None

    def _chunk(self, data):
        try:
            choice = self._choice(data)
            if choice is None:
                return None
            delta = choice.get("delta", {})
            content = delta.get("content") or ""
            if not isinstance(content, str):
                raise ValueError
            calls = []
            for call in delta.get("tool_calls") or []:
                function = call.get("function") or {}
                if not isinstance(call.get("index"), int):
                    raise ValueError
                calls.append({"index": call["index"], "id": call.get("id"),
                              "name": function.get("name"), "args": function.get("arguments")})
            return ChatGenerationChunk(message=AIMessageChunk(content=content, tool_call_chunks=calls))
        except (KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, ModelError):
                raise
            raise ModelError("The provider returned an invalid stream frame.", 502) from None

    @staticmethod
    def _validate_stream(message):
        # LangChain accepts partial JSON while assembling deltas. Do not accept
        # that leniency as a completed tool call at the end of a response.
        try:
            ids = set()
            for call in message.tool_call_chunks:
                if (not call.get("id") or call["id"] in ids or not call.get("name")
                        or not isinstance(json.loads(call["args"]), dict)):
                    raise ValueError
                ids.add(call["id"])
            if not message.content and not ids:
                raise ValueError
        except (TypeError, ValueError, KeyError):
            raise ModelError("The provider returned an incomplete answer or tool call.", 502) from None

    @limited("inference")
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.streaming:
            return generate_from_stream(self._stream(messages, stop, run_manager, **kwargs))
        payload = self._payload(messages, stop, False, kwargs)
        try:
            with httpx.Client(timeout=45, trust_env=False, follow_redirects=False) as client:
                response = client.post(URL, headers=self._headers(), json=payload)
                response.raise_for_status()
                return self._result(response.json())
        except (httpx.HTTPError, ValueError) as exc:
            raise provider_error(exc, provider="openrouter") from None

    @limited("inference")
    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.streaming:
            return await agenerate_from_stream(self._astream(messages, stop, run_manager, **kwargs))
        payload = await asyncio.to_thread(self._payload, messages, stop, False, kwargs)
        try:
            async with httpx.AsyncClient(timeout=45, trust_env=False, follow_redirects=False) as client:
                response = await client.post(URL, headers=self._headers(), json=payload)
                response.raise_for_status()
                return self._result(response.json())
        except (httpx.HTTPError, ValueError) as exc:
            raise provider_error(exc, provider="openrouter") from None

    @limited("inference")
    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        payload = self._payload(messages, stop, True, kwargs)
        combined = AIMessageChunk(content="")
        try:
            with httpx.Client(timeout=45, trust_env=False, follow_redirects=False) as client:
                with client.stream("POST", URL, headers=self._headers(), json=payload) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            self._validate_stream(combined)
                            return
                        chunk = self._chunk(json.loads(data))
                        if chunk is not None:
                            combined = combined + chunk.message
                            if run_manager:
                                run_manager.on_llm_new_token(chunk.text, chunk=chunk)
                            yield chunk
            raise ModelError("The provider stream ended before completion.", 502)
        except (httpx.HTTPError, ValueError) as exc:
            raise provider_error(exc, provider="openrouter") from None

    @limited("inference")
    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        payload = await asyncio.to_thread(self._payload, messages, stop, True, kwargs)
        combined = AIMessageChunk(content="")
        try:
            async with httpx.AsyncClient(timeout=45, trust_env=False, follow_redirects=False) as client:
                async with client.stream("POST", URL, headers=self._headers(), json=payload) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            self._validate_stream(combined)
                            return
                        chunk = self._chunk(json.loads(data))
                        if chunk is not None:
                            combined = combined + chunk.message
                            if run_manager:
                                await run_manager.on_llm_new_token(chunk.text, chunk=chunk)
                            yield chunk
            raise ModelError("The provider stream ended before completion.", 502)
        except (httpx.HTTPError, ValueError) as exc:
            raise provider_error(exc, provider="openrouter") from None
