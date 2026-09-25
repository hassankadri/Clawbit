import json
import math
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from langchain_core.tools import tool
from langchain_tavily import TavilySearch
from langgraph.prebuilt import ToolRuntime

from database import save_memory, search_memory
from models import build_chat_model, normalize_model_name
from rag import retrieve_from_rag


ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)


def _get_request_context(
    runtime: ToolRuntime,
) -> tuple[str, list[str]]:
    configurable = runtime.config.get(
        "configurable",
        {},
    )

    thread_id = configurable.get(
        "thread_id",
        "default",
    )

    attachment_ids = configurable.get(
        "attachment_ids",
        [],
    )

    return thread_id, attachment_ids


web_search = TavilySearch(
    max_results=5,
    topic="general",
    search_depth="advanced",
)


def _compact_tavily_result(
    result,
    max_results: int = 3,
    max_content_chars: int = 900,
) -> str:
    """
    Convert Tavily output into a compact text format for Research Mode.

    Keeps only the most useful fields so large raw web-search payloads
    do not consume the model's token budget.
    """
    if isinstance(result, dict):
        raw_results = result.get("results")

        if isinstance(raw_results, list):
            compact_results = []

            for index, item in enumerate(raw_results[:max_results], start=1):
                if not isinstance(item, dict):
                    continue

                title = str(item.get("title") or "Untitled result")
                url = str(item.get("url") or "")
                content = str(
                    item.get("content")
                    or item.get("snippet")
                    or ""
                ).strip()

                if len(content) > max_content_chars:
                    content = content[:max_content_chars].rstrip() + "..."

                compact_results.append(
                    f"[Result {index}]\n"
                    f"Title: {title}\n"
                    f"URL: {url}\n"
                    f"Content: {content}"
                )

            if compact_results:
                return "\n\n".join(compact_results)

        # Fallback for unexpected Tavily dictionary shapes.
        return json.dumps(
            result,
            ensure_ascii=False,
            default=str,
        )[:3500]

    if isinstance(result, list):
        compact_results = []

        for index, item in enumerate(result[:max_results], start=1):
            if isinstance(item, dict):
                title = str(item.get("title") or "Untitled result")
                url = str(item.get("url") or "")
                content = str(
                    item.get("content")
                    or item.get("snippet")
                    or ""
                ).strip()

                if len(content) > max_content_chars:
                    content = content[:max_content_chars].rstrip() + "..."

                compact_results.append(
                    f"[Result {index}]\n"
                    f"Title: {title}\n"
                    f"URL: {url}\n"
                    f"Content: {content}"
                )
            else:
                compact_results.append(
                    f"[Result {index}]\n{str(item)[:max_content_chars]}"
                )

        return "\n\n".join(compact_results)

    return str(result)[:3500]


@tool
def research_web_search(query: str) -> str:
    """
    Search the web for Research Mode.

    Use this for current or external information that needs verification.
    Returns a compact set of top sources with titles, URLs, and short
    content snippets so the research agent can perform multiple searches
    without overflowing its context/token budget.
    """
    try:
        result = web_search.invoke(query)

        return _compact_tavily_result(
            result,
            max_results=3,
            max_content_chars=900,
        )

    except Exception as exc:
        return f"Web search error: {exc}"


@tool
def current_datetime() -> str:
    """
    Get the current date and time.
    Use this whenever the user asks today's date, current time, day, month, year, etc.
    """
    now = datetime.now()

    return now.strftime("%A, %d %B %Y %I:%M:%S %p")


@tool
def calculator(expression: str) -> str:
    """
    Useful for simple math calculations.
    Input should be a valid math expression.
    Example: 2 + 2, math.sqrt(16), 10 * 5
    """
    try:
        allowed = {
            "math": math,
            "abs": abs,
            "round": round,
            "min": min,
            "max": max,
            "sum": sum,
        }

        result = eval(
            expression,
            {"__builtins__": {}},
            allowed,
        )

        return str(result)

    except Exception as exc:
        return f"Calculation error: {exc}"


def _rewrite_document_query(
    query: str,
    runtime: ToolRuntime,
) -> str:
    configurable = runtime.config.get(
        "configurable",
        {},
    )

    user_query = configurable.get(
        "user_query",
        query,
    )

    model_name = normalize_model_name(
        configurable.get("model")
    )

    messages = runtime.state.get(
        "messages",
        [],
    )

    conversation_parts = []

    for message in messages[-6:]:
        message_type = getattr(
            message,
            "type",
            "",
        )

        content = getattr(
            message,
            "content",
            "",
        )

        if message_type not in {
            "human",
            "ai",
        }:
            continue

        if (
            not isinstance(content, str)
            or not content.strip()
        ):
            continue

        role = (
            "User"
            if message_type == "human"
            else "Assistant"
        )

        conversation_parts.append(
            f"{role}: {content}"
        )

    conversation = "\n".join(
        conversation_parts
    )

    prompt = f"""
Rewrite the document search query into one clear, standalone search query.

Important:
- The agent may have shortened or paraphrased the tool query.
- Preserve important details from the user's real request.
- Do not remove names, filenames, technical terms, numbers, constraints, or the subject being asked about.
- Use conversation context only when needed.
- Return only the rewritten search query.
- Do not answer the question.

User's real request:
{user_query}

Conversation:
{conversation}

Tool query:
{query}
"""

    try:
        model = build_chat_model(
            model_name,
            temperature=0.0,
        )

        response = model.invoke(prompt)

        rewritten_query = getattr(
            response,
            "content",
            "",
        )

        if (
            isinstance(rewritten_query, str)
            and rewritten_query.strip()
        ):
            return rewritten_query.strip()

    except Exception:
        pass

    return query


@tool(response_format="content_and_artifact")
def search_uploaded_documents(
    query: str,
    runtime: ToolRuntime,
) -> tuple[str, dict]:
    """
    Search uploaded documents for relevant information.
    Use this when the user asks about uploaded PDFs, DOCX, TXT, notes, files, or documents.
    """
    thread_id, attachment_ids = _get_request_context(
        runtime
    )

    rewritten_query = _rewrite_document_query(
        query,
        runtime,
    )

    inspector = {
        "rag_used": True,
        "tool_query": query,
        "rewritten_query": rewritten_query,
    }

    content = retrieve_from_rag(
        query=rewritten_query,
        thread_id=thread_id,
        attachment_ids=attachment_ids or None,
        inspector=inspector,
    )

    return content, inspector


@tool
def remember_this(
    memory: str,
    runtime: ToolRuntime,
) -> str:
    """
    Save an important user preference or fact into long-term memory.
    Use this when the user asks you to remember something.
    """
    thread_id, _ = _get_request_context(runtime)

    return save_memory(
        thread_id=thread_id,
        memory=memory,
    )


@tool
def recall_memory(
    query: str,
    runtime: ToolRuntime,
) -> str:
    """
    Recall saved long-term memories about the user or this conversation.
    """
    thread_id, _ = _get_request_context(runtime)

    return search_memory(
        thread_id=thread_id,
        query=query,
    )


@tool
def get_weather(location: str) -> str:
    """
    Get the current weather for a city or location.

    Example:
    - Mumbai
    - New York
    - London
    """
    result = web_search.invoke(
        f"Current weather in {location}. "
        "Include temperature, conditions, humidity and wind speed."
    )

    return str(result)


@tool
def get_stock_price(company: str) -> str:
    """
    Get the latest stock price of a company.

    Example:
    - Apple
    - Tesla
    - Microsoft
    - TCS
    - Reliance
    """
    result = web_search.invoke(
        f"Latest live stock price of {company}. "
        "Include current price, daily change and stock exchange."
    )

    return str(result)


@tool
def read_webpage(url: str) -> str:
    """
    Read the contents of a webpage.
    Use this when the user provides a URL and asks to summarize or explain it.
    """
    try:
        response = requests.get(
            url,
            timeout=10,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 "
                    "(compatible; Clawbit/1.0)"
                )
            },
        )
        response.raise_for_status()

        soup = BeautifulSoup(
            response.text,
            "html.parser",
        )

        text = soup.get_text(
            separator=" ",
            strip=True,
        )

        return text[:5000]

    except Exception as exc:
        return f"Error reading webpage: {exc}"


tools = [
    current_datetime,
    calculator,
    search_uploaded_documents,
    remember_this,
    recall_memory,
    get_weather,
    get_stock_price,
    read_webpage,
    web_search,
]


research_tools = [
    current_datetime,
    calculator,
    search_uploaded_documents,
    read_webpage,
    research_web_search,
]
