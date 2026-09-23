import math
from dotenv import load_dotenv
from langchain_core.tools import tool
from langchain_tavily import TavilySearch
from database import save_memory, search_memory
from rag import retrieve_from_rag
from datetime import datetime
import requests
from bs4 import BeautifulSoup

load_dotenv()

CURRENT_THREAD_ID = "default"
CURRENT_ATTACHMENT_IDS: list[str] = []

def set_current_request_context(thread_id: str, attachment_ids: list[str] | None = None):
    global CURRENT_THREAD_ID
    global CURRENT_ATTACHMENT_IDS
    CURRENT_THREAD_ID = thread_id
    CURRENT_ATTACHMENT_IDS = attachment_ids or []


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
def search_uploaded_documents(query: str) -> str:
    """
    Search uploaded documents for relevant information.
    Use this when the user asks about uploaded PDFs, DOCX, TXT, notes, files, or documents.
    """

    return retrieve_from_rag(
        query=query,
        thread_id=CURRENT_THREAD_ID,
        attachment_ids=CURRENT_ATTACHMENT_IDS or None
    )


@tool
def remember_this(memory: str) -> str:
    """
    Save an important user preference or fact into long-term memory.
    Use this when the user asks you to remember something.
    """

    return save_memory(
        thread_id=CURRENT_THREAD_ID,
        memory=memory
    )



@tool
def recall_memory(query: str) -> str:
    """
    Recall saved long-term memories about the user or this conversation.
    """

    return search_memory(
        thread_id=CURRENT_THREAD_ID,
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
