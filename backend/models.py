from pathlib import Path

from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_groq import ChatGroq


ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)


DEFAULT_MODEL = "gemini-3.1-flash-lite"

MODEL_CONFIGS = {
    "gemini-3.1-flash-lite": {
        "provider": "google",
        "model": "gemini-3.1-flash-lite",
    },
    "gemini-3.5-flash": {
        "provider": "google",
        "model": "gemini-3.5-flash",
    },
    "openai/gpt-oss-20b": {
        "provider": "groq",
        "model": "openai/gpt-oss-20b",
    },
}

ALLOWED_MODELS = set(MODEL_CONFIGS)


def normalize_model_name(model_name: str | None) -> str:
    if not model_name:
        return DEFAULT_MODEL

    model_name = model_name.strip().lower()

    aliases = {
        "gemini-latest": "gemini-3.1-flash-lite",
        "gemini 3.1 flash lite": "gemini-3.1-flash-lite",
        "gemini 3.5 flash": "gemini-3.5-flash",
    }

    model_name = aliases.get(model_name, model_name)

    if model_name not in ALLOWED_MODELS:
        return DEFAULT_MODEL

    return model_name


def build_chat_model(
    model_name: str,
    temperature: float = 0.3,
):
    config = MODEL_CONFIGS[model_name]

    if config["provider"] == "google":
        return ChatGoogleGenerativeAI(
            model=config["model"],
            temperature=temperature,
            streaming=False,
        )

    if config["provider"] == "groq":
        return ChatGroq(
            model=config["model"],
            temperature=temperature,
            streaming=False,
        )

    raise ValueError(
        f"Unsupported model provider: {config['provider']}"
    )