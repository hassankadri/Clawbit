import math
from dotenv import load_dotenv
from langchain_core.tools import tool
from langchain_tavily import TavilySearch
from langgraph.prebuilt import ToolRuntime
from database import save_memory, search_memory
from rag import retrieve_from_rag
from datetime import datetime
import requests
from bs4 import BeautifulSoup

load_dotenv()

def _get_request_context(runtime: ToolRuntime) -> tuple[str, list[str]]:
    configurable = runtime.config.get("configurable", {})

    thread_id = configurable.get("thread_id", "default")
    attachment_ids = configurable.get("attachment_ids", [])

    return thread_id, attachment_ids

web_search = TavilySearch(
    max_results=5,
    topic="general",
    search_depth="advanced"
)



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
            "sum": sum
        }

        result = eval(expression, {"__builtins__": {}}, allowed)
        return str(result)

    except Exception as e:
        return f"Calculation error: {str(e)}"


@tool
def search_uploaded_documents(query: str, runtime: ToolRuntime) -> str:
    """
    Search uploaded documents for relevant information.
    Use this when the user asks about uploaded PDFs, DOCX, TXT, notes, files, or documents.
    """
    thread_id, attachment_ids = _get_request_context(runtime)

    return retrieve_from_rag(
        query=query,
        thread_id=thread_id,
        attachment_ids=attachment_ids or None
    )


@tool
def remember_this(memory: str, runtime: ToolRuntime) -> str:
    """
    Save an important user preference or fact into long-term memory.
    Use this when the user asks you to remember something.
    """
    thread_id, _ = _get_request_context(runtime)

    return save_memory(
        thread_id=thread_id,
        memory=memory
    )



@tool
def recall_memory(query: str, runtime: ToolRuntime) -> str:
    """
    Recall saved long-term memories about the user or this conversation.
    """
    thread_id, _ = _get_request_context(runtime)

    return search_memory(
        thread_id=thread_id,
        query=query
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
        f"Current weather in {location}. Include temperature, conditions, humidity and wind speed."
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
        f"Latest live stock price of {company}. Include current price, daily change and stock exchange."
    )

    return str(result)



@tool
def read_webpage(url: str) -> str:
    """
    Read the contents of a webpage.
    Use this when the user provides a URL and asks to summarize or explain it.
    """

    try:
        response = requests.get(url, timeout=10)
        soup = BeautifulSoup(response.text, "html.parser")

        text = soup.get_text(separator=" ", strip=True)

        return text[:5000]

    except Exception as e:
        return f"Error reading webpage: {e}"



tools = [
    current_datetime,
    calculator,
    search_uploaded_documents,
    remember_this,
    recall_memory,
    get_weather,
    get_stock_price,
    read_webpage,
    web_search
]
