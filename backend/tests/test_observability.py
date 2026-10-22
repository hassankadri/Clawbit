"""Privacy, correlation, stream outcomes and diagnostics must survive adversarial data."""

import asyncio
from dataclasses import replace
from io import StringIO
import json
import logging

import pytest

import observability as logs
import usage_limits


@pytest.fixture
def captured_logs():
    output = StringIO()
    handler = logging.StreamHandler(output)
    previous = logs.logger.level
    logs.logger.addHandler(handler)
    logs.logger.setLevel(logging.DEBUG)
    try:
        yield output
    finally:
        logs.logger.removeHandler(handler)
        logs.logger.setLevel(previous)


def records(output):
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_nested_redaction_and_provider_exception_never_format_private_data(captured_logs):
    class PrivateFailure(Exception):
        def __str__(self):
            raise AssertionError("Exception text must not be formatted")

    try:
        raise PrivateFailure({"password": "secret", "response": {"Authorization": "Bearer private"}})
    except PrivateFailure as exc:
        logs.event("provider", "failed", error=exc, details={
            "status_code": 503, "nested-secret-key": "private prompt",
            "details": [{"access_token": "private", "details": {"cookie": "private"}}],
        }, password="secret", model="private prompt", provider="private")
    text = captured_logs.getvalue()
    assert all(value not in text for value in (
        "secret", "private", "password", "cookie", "Bearer", "Authorization",
    ))
    row = records(captured_logs)[0]
    assert row["details"]["status_code"] == 503
    assert row["frames"] and row["frames"][0]["module"] == "test_observability.py"
    assert "D:" not in text and "locals" not in text
    assert len(json.dumps(logs.redact({"details": ["x" * 100000] * 1000}))) < 1000


def test_logging_configuration_is_idempotent(monkeypatch):
    monkeypatch.setenv("CLAWBIT_LOG_LEVEL", "WARNING")
    logs.configure_logging()
    logs.configure_logging()
    assert sum(bool(getattr(item, "clawbit_handler", False)) for item in logs.logger.handlers) == 1
    assert logs.logger.level == logging.WARNING
    monkeypatch.setenv("CLAWBIT_LOG_LEVEL", "INFO")
    logs.configure_logging()


@pytest.mark.parametrize("terminal,expected", [
    ("done", "complete"), ("error", "failed"), (None, "cancelled"),
])
def test_sse_outcome_has_one_terminal_log_and_no_token_text(captured_logs, terminal, expected):
    async def application(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"text/event-stream")]})
        for _ in range(5):
            await send({"type": "http.response.body", "body": b'event: token\ndata: {"text":"private"}\n\n'})
        if terminal:
            await send({"type": "http.response.body", "body": f"event: {terminal}\ndata: {{}}\n\n".encode()})

    async def run():
        async def send(message):
            pass

        await logs.RequestLoggingMiddleware(application)({"type": "http", "method": "POST"}, None, send)
        assert logs.request_id.get() is None

    asyncio.run(run())
    rows = records(captured_logs)
    assert len(rows) == 3
    assert rows[-1]["status"] == expected
    assert len({row["request_id"] for row in rows}) == 1
    assert "private" not in captured_logs.getvalue()


def test_concurrent_request_context_reaches_workers_without_crossing_requests(captured_logs):
    identifiers = []

    async def application(scope, receive, send):
        before = logs.request_id.get()
        await asyncio.sleep(0)
        await asyncio.to_thread(logs.event, "tool", "complete")
        assert logs.request_id.get() == before
        identifiers.append(before)
        await send({"type": "http.response.start", "status": 200, "headers": []})

    async def run():
        async def send(message):
            pass

        middleware = logs.RequestLoggingMiddleware(application)
        await asyncio.gather(*[middleware({"type": "http", "method": "GET"}, None, send) for _ in range(2)])
        assert logs.request_id.get() is None

    asyncio.run(run())
    assert len(set(identifiers)) == 2
    for identifier in identifiers:
        assert len([row for row in records(captured_logs) if row["request_id"] == identifier]) == 3


def test_authenticated_request_and_quota_share_server_correlation(owner_client, captured_logs, monkeypatch):
    captured_logs.truncate(0)
    captured_logs.seek(0)
    monkeypatch.setitem(usage_limits.store.policies, "tool", replace(
        usage_limits.store.policies["tool"], per_minute=1,
    ))
    response = owner_client.get("/memories?scope=user", headers={"X-Request-ID": "forged-private"})
    assert response.status_code == 200
    identifier = response.headers["x-request-id"]
    assert len(identifier) == 32 and identifier != "forged-private"
    assert {row["request_id"] for row in records(captured_logs)} == {identifier}
    rejected = owner_client.get("/memories?scope=user")
    assert rejected.status_code == 429
    assert any(row["status"] == "rate_limited" for row in records(captured_logs))
    assert "forged-private" not in captured_logs.getvalue()


def test_operation_error_keeps_failure_category_and_releases_lease(captured_logs):
    with pytest.raises(RuntimeError):
        with usage_limits.operation_budget("tool"):
            raise RuntimeError("private upstream body")
    rows = records(captured_logs)
    assert [row["status"] for row in rows] == ["started", "failed"]
    assert "private" not in captured_logs.getvalue()
    with usage_limits.operation_budget("tool"):
        pass


def test_checkpoint_failure_preserves_exception_without_logging_payload(monkeypatch, captured_logs):
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    from owned_checkpoints import OwnedSqliteSaver

    failure = RuntimeError("private checkpoint contents")

    async def broken_read(self, config):
        raise failure

    monkeypatch.setattr(AsyncSqliteSaver, "aget_tuple", broken_read)

    async def run():
        saver = OwnedSqliteSaver(None)
        with pytest.raises(RuntimeError) as caught:
            await saver.aget_tuple({"configurable": {"thread_id": "logging-checkpoint"}})
        assert caught.value is failure

    asyncio.run(run())
    assert records(captured_logs)[-1]["operation"] == "checkpoint"
    assert "private" not in captured_logs.getvalue()
