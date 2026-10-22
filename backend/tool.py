import json
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from typing import Callable

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import ToolException, tool
from langchain_tavily import TavilySearch
from langgraph.prebuilt import ToolRuntime

from database import search_memory
from evidence import current_evidence, evidence_note, register_web_source
from models import build_chat_model, normalize_model_name, require_consent
from ownership import require_thread, require_workspace
from rag import retrieve_from_rag
from safe_calculator import evaluate_arithmetic
from untrusted_content import EXTERNAL_DATA_POLICY, safe_tool_error, untrusted_data
from web_fetch import WebFetchError, fetch_webpage
from usage_limits import UsageLimitError, limited


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

    require_thread(thread_id)

    return thread_id, attachment_ids


def _get_workspace_id(
    runtime: ToolRuntime,
    thread_id: str,
) -> str:
    configurable = runtime.config.get(
        "configurable",
        {},
    )

    workspace_id = (
        configurable.get("workspace_id")
        or thread_id
    )
    require_workspace(workspace_id)
    return workspace_id


class _SafeTavilySearch(TavilySearch):
    """The installed client can return exception objects as successful results."""
    # Restore BaseTool's callable handler support narrowed by Tavily's field.
    handle_tool_error: bool | Callable[[ToolException], str] = safe_tool_error

    @staticmethod
    def _checked_result(result):
        if isinstance(result, dict) and "error" in result:
            raise ToolException("The web search service request failed.")
        if isinstance(result, dict) and isinstance(result.get("results"), list):
            for item in result["results"]:
                if isinstance(item, dict):
                    source = register_web_source(item.get("title"), item.get("url"), item.get("content"))
                    if source:
                        item["citation_id"] = source["source_id"]
        return result

    @limited("tool")
    def _run(self, query: str, run_manager=None, **kwargs):
        return self._checked_result(super()._run(query, run_manager=run_manager, **kwargs))

    @limited("tool")
    async def _arun(self, query: str, run_manager=None, **kwargs):
        return self._checked_result(await super()._arun(query, run_manager=run_manager, **kwargs))


web_search = _SafeTavilySearch(
    max_results=5,
    topic="general",
    search_depth="advanced",
    handle_tool_error=safe_tool_error,
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
    raw_results = result.get("results", []) if isinstance(result, dict) else result
    if not isinstance(raw_results, list):
        evidence_note("Web search failed or returned an invalid result.")
        return "Web search failed or returned an invalid result."
    parts = []
    for item in raw_results[:max_results]:
        if not isinstance(item, dict):
            continue
        content = item.get("content") or item.get("snippet") or ""
        source = register_web_source(item.get("title"), item.get("url"), content)
        if source:
            parts.append(
                f"[{source['source_id']}] {source['file']}\n"
                f"URL: {source['url']}\n{content[:max_content_chars]}"
            )
    if not parts:
        evidence_note("Web search returned no usable source records.")
    return "\n\n".join(parts) or "No usable web sources were returned."


@tool
@limited("tool")
def research_web_search(query: str) -> str:
    """
    Search the web for Research Mode.

    Use this for current or external information that needs verification.
    Returns a compact set of top sources with titles, URLs, and short
    content snippets so the research agent can perform multiple searches
    without overflowing its context/token budget.
    """
    ledger = current_evidence()
    key = " ".join(query.casefold().split())
    # Parallel tool calls share a separate lock so identical searches only run
    # once; registering their evidence remains independent of this lock.
    with ledger.search_lock if ledger else nullcontext():
        if ledger and key in ledger.searches:
            return ledger.searches[key]
        try:
            result = web_search.invoke(query)
            content = _compact_tavily_result(result, max_results=3, max_content_chars=900)
        except UsageLimitError:
            raise
        except Exception as exc:
            evidence_note("Web search failed; no evidence was obtained from that attempt.")
            content = safe_tool_error(exc)
        if ledger:
            ledger.searches[key] = content
        return content


@tool
@limited("tool")
def current_datetime() -> str:
    """
    Get the current date and time.
    Use this whenever the user asks today's date, current time, day, month, year, etc.
    """
    now = datetime.now()

    return now.strftime("%A, %d %B %Y %I:%M:%S %p")


@tool
@limited("tool")
def calculator(expression: str) -> str:
    """
    Useful for simple math calculations.
    Input should be a valid math expression.
    Example: 2 + 2, math.sqrt(16), 10 * 5
    """
    try:
        result = evaluate_arithmetic(expression)

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

    prompt = """
Rewrite the document search query into one clear, standalone search query.

Important:
- The agent may have shortened or paraphrased the tool query.
- Preserve important details from the user's real request.
- Do not remove names, filenames, technical terms, numbers, constraints, or the subject being asked about.
- Use conversation context only when needed.
- Return only the rewritten search query.
- Do not answer the question.

"""

    try:
        require_consent(model_name, configurable.get("provider_consent"))
        model = build_chat_model(
            model_name,
            temperature=0.0,
        )

        response = model.invoke([
            SystemMessage(content=prompt + "\n" + EXTERNAL_DATA_POLICY),
            HumanMessage(content=untrusted_data("document_query_context", {
                "user_request": user_query, "conversation": conversation, "tool_query": query,
            })),
        ])

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

    except UsageLimitError:
        raise
    except Exception as exc:
        # Rewriting is optional; retain the original query and record a redacted
        # failure rather than logging provider credentials or request details.
        safe_tool_error(exc)

    return query


@tool(response_format="content_and_artifact")
@limited("tool")
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
@limited("tool")
def remember_this(
    memory: str,
    runtime: ToolRuntime,
) -> str:
    """
    Explain how to save a preference through the explicit Saved memory controls.
    This tool cannot write memory or confirm a save on the user's behalf.
    """
    thread_id, _ = _get_request_context(
        runtime
    )

    _get_workspace_id(
        runtime,
        thread_id,
    )

    # Model arguments and retrieved instructions are never user confirmation.
    return "Memory was not saved. Review and save it explicitly in Saved memory."



@tool
@limited("tool")
def recall_memory(
    query: str,
    runtime: ToolRuntime,
) -> str:
    """
    Recall saved long-term memories from the current workspace.
    """
    thread_id, _ = _get_request_context(
        runtime
    )

    workspace_id = _get_workspace_id(
        runtime,
        thread_id,
    )

    return search_memory(
        thread_id=thread_id,
        workspace_id=workspace_id,
        query=query,
    )


@tool
@limited("tool")
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
@limited("tool")
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
@limited("tool")
def read_webpage(url: str) -> str:
    """
    Read the contents of a webpage.
    Use this when the user provides a URL and asks to summarize or explain it.
    """
    try:
        result = fetch_webpage(url)
        header, _, content = result.partition("\n\n")
        final_url = header.removeprefix("Source: ")
        source = register_web_source(final_url, final_url, content)
        return f"[{source['source_id']}]\n{result}" if source else result
    except WebFetchError as exc:
        return f"Could not read webpage: {exc}"


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
