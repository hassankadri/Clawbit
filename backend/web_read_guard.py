"""Request-scoped authorization for reading public webpages."""

import re
from urllib.parse import urlsplit, urlunsplit

from evidence import current_evidence, public_source_url


_URL_PATTERN = re.compile(r"https?://[^\s<>\"'`]+", re.IGNORECASE)
_TRAILING_PUNCTUATION = ".,;:!?)]}"


def _canonical_url(value: object) -> str | None:
    """Normalize an already validated public URL for exact comparison."""
    reference = public_source_url(value)

    if reference is None:
        return None

    try:
        parsed = urlsplit(reference)
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port

        if not host:
            return None

        authority = f"[{host}]" if ":" in host else host

        if port is not None and not (
            (scheme == "http" and port == 80)
            or (scheme == "https" and port == 443)
        ):
            authority += f":{port}"

        return urlunsplit((
            scheme,
            authority,
            parsed.path or "/",
            parsed.query,
            "",
        ))
    except ValueError:
        return None


def _extract_urls(text: object) -> set[str]:
    """Extract only explicit HTTP(S) URLs from user-provided text."""
    if not isinstance(text, str):
        return set()

    authorized = set()

    for match in _URL_PATTERN.finditer(text):
        candidate = match.group(0).rstrip(_TRAILING_PUNCTUATION)
        normalized = _canonical_url(candidate)

        if normalized:
            authorized.add(normalized)

    return authorized


def _message_texts(message: object):
    """Extract text only from genuine user messages, never tool data."""
    if isinstance(message, dict):
        role = message.get("role")
        content = message.get("content")
    else:
        role = getattr(message, "type", None)
        content = getattr(message, "content", None)

    if role not in {"human", "user"}:
        return

    if isinstance(content, str):
        # Saved memories and other wrapped external data are not user consent.
        if content.lstrip().startswith('{"kind":"untrusted_tool_data"'):
            return
        yield content
        return

    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue

            value = block.get("text")

            if (
                isinstance(value, str)
                and not value.lstrip().startswith(
                    '{"kind":"untrusted_tool_data"'
                )
            ):
                yield value


def webpage_url_is_authorized(
    url: str,
    *,
    user_query: str = "",
    messages=(),
) -> bool:
    """Allow URLs supplied by the user or discovered by this chat execution.

    Exact URL matching prevents a model from appending private information
    to an otherwise approved public URL.
    """
    requested = _canonical_url(url)

    if requested is None:
        return False

    authorized = _extract_urls(user_query)

    for message in messages or ():
        for text in _message_texts(message):
            authorized.update(_extract_urls(text))

    # Web search results are registered in this execution's evidence ledger.
    ledger = current_evidence()

    if ledger is not None:
        with ledger.lock:
            for source in ledger.records.values():
                if source.get("kind") != "web":
                    continue

                normalized = _canonical_url(source.get("url"))

                if normalized:
                    authorized.add(normalized)

    return requested in authorized