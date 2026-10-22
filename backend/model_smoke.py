"""Opt-in, one-request-per-model smoke check. Never imported by the application."""
import argparse
import asyncio
import json
from contextlib import contextmanager
from collections.abc import Iterator
import getpass
import sys
import warnings

from langchain_core.messages import HumanMessage
from auth import auth_database_path
from auth_store import AuthStore
from models import (
    ModelError,
    build_chat_model,
    ensure_model_available,
    normalize_model_name,
    provider_error,
)
from ownership import owner_context


@contextmanager
def authenticated_smoke(username: str, password: str) -> Iterator[None]:
    """Charge an explicitly requested local smoke test to a verified owner session."""
    path = auth_database_path()
    if not path.is_file():
        raise RuntimeError("Initialize the owner before running a smoke test.")
    store = AuthStore(path)
    previous, _ = store.create_presession()
    token = None
    try:
        result = store.login(username, password, previous)
        if result is None:
            raise RuntimeError("Invalid username or passphrase.")
        token = result[0]
        session = store.lookup(token)
        if session is None or session.principal_id is None:
            raise RuntimeError("The owner session could not be verified.")
        with owner_context(
            session.principal_id,
            validate_session=lambda: store.lookup(token) == session,
        ):
            yield
    finally:
        store.revoke(previous)
        if token:
            store.revoke(token)


async def smoke(model_ids, *, opt_in=False):
    if not opt_in:
        raise ValueError("Live inference requires explicit --allow-free-inference opt-in.")
    rows = []
    for model_id in dict.fromkeys(model_ids):
        row = {"model": model_id, "text": "not tested", "streaming": "not tested",
               "tools": "not tested", "vision": "not tested"}
        try:
            name = normalize_model_name(model_id)
            ensure_model_available(name)
            model = build_chat_model(name, max_tokens=64)
            options = {"thinking_level": "low"} if name == "gemini-3.8-flash" else {}
            result = await model.ainvoke([HumanMessage(content="Reply with the single word hello.")], **options)
            text = result.content if isinstance(result.content, str) else "".join(
                block if isinstance(block, str) else block.get("text", "")
                for block in result.content
                if isinstance(block, str) or (isinstance(block, dict) and block.get("type") == "text"
                                               and isinstance(block.get("text"), str))
            )
            if not text.strip():
                raise ModelError("The provider returned no answer text.", 502)
            row["text"] = "passed"
            row["status"] = "Live text tested; other capabilities pending."
        except Exception as exc:
            error = provider_error(exc)
            row["status"] = str(error)
            row["status_code"] = error.status_code
            row["error_type"] = getattr(error, "provider_error_type", type(exc).__name__)
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="+")
    parser.add_argument("--allow-free-inference", action="store_true")
    args = parser.parse_args()
    if not args.allow_free_inference:
        parser.error("Explicit --allow-free-inference is required. Catalog checks are not inference consent.")
    if not sys.stdin.isatty():
        parser.error("Run interactively to verify the existing owner before inference.")
    username = input("Owner username: ").strip()
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        password = getpass.getpass("Owner passphrase: ")
    with authenticated_smoke(username, password):
        print(json.dumps(asyncio.run(smoke(args.models, opt_in=True)), indent=2))


if __name__ == "__main__":
    main()
