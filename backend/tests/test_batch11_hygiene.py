
"""Offline regression checks for Batch 11 security hygiene."""

import builtins
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest

import app
import database
from memory_store import MemoryStoreError, checked_memory
from upload_security import UploadError, _checked_xml


ROOT = Path(__file__).resolve().parents[1]


def test_memory_exception_does_not_shadow_builtin():
    assert MemoryStoreError is app.MemoryStoreError
    assert MemoryStoreError is not builtins.MemoryError

    assert checked_memory("Ordinary memory") == "Ordinary memory"

    with pytest.raises(MemoryStoreError):
        checked_memory("password: do not store")


def test_docx_xml_uses_defused_parser():
    from defusedxml import ElementTree as safe_xml

    assert _checked_xml(
        b"<root><item /></root>"
    ).tag == "root"

    assert safe_xml.fromstring(
        b"<root />"
    ).tag == "root"

    with pytest.raises(UploadError):
        _checked_xml(
            b'<!DOCTYPE root [<!ENTITY x "test">]><root>&x;</root>'
        )


def test_sqlite_clock_preserves_utc_naive_values():
    current = database._utc_now_naive()

    assert isinstance(current, datetime)
    assert current.tzinfo is None

    as_utc = current.replace(tzinfo=timezone.utc)
    delta = abs(
        (as_utc - datetime.now(timezone.utc)).total_seconds()
    )

    assert delta < 10


def test_oauth_failures_emit_safe_diagnostic_events():
    source = (
        ROOT / "app.py"
    ).read_text(encoding="utf-8")

    oauth = source.split(
        "async def _complete_connector_oauth(",
        1,
    )[1].split(
        '@app.post("/mcp/connect/google-drive")',
        1,
    )[0]

    assert (
        'event("mcp", "failed", category="oauth_tool_discovery")'
        in oauth
    )
    assert (
        'event("mcp", "failed", category="oauth_callback")'
        in oauth
    )


def test_streaming_uses_chunk_accumulation():
    source = (
        ROOT / "app.py"
    ).read_text(encoding="utf-8")

    # Start at the chat streaming endpoint.
    streaming_endpoint = source.split(
        "async def chat_stream(",
        1,
    )[1]

    # The endpoint has an earlier response for unsupported
    # image models. Inspect the actual event generator instead.
    section = streaming_endpoint.split(
        "    async def event_stream():",
        1,
    )[1].split(
        "    return ChatStreamingResponse(",
        1,
    )[0]

    assert "answer_parts.append(text)" in section
    assert "answer_parts.append(final_text)" in section
    assert '"".join(answer_parts)' in section

    assert (
        'if stream_mode == "values":\n'
        '                        sources = source_snapshot()'
    ) in section


def test_shadcn_is_development_only():
    package = json.loads(
        (
            ROOT.parent / "frontend" / "package.json"
        ).read_text(encoding="utf-8")
    )

    lock = json.loads(
        (
            ROOT.parent / "frontend" / "package-lock.json"
        ).read_text(encoding="utf-8")
    )

    assert "shadcn" not in package["dependencies"]
    assert "shadcn" in package["devDependencies"]

    lock_root = lock["packages"][""]

    assert "shadcn" not in lock_root["dependencies"]
    assert (
        lock_root["devDependencies"]["shadcn"]
        == package["devDependencies"]["shadcn"]
    )
