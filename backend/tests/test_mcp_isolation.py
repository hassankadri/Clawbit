"""Principal and lifecycle isolation using mocked MCP and OAuth providers."""

import asyncio

from langchain_core.tools import ToolException, tool
import pytest

import mcp_client as mcp
import mcp_oauth as oauth
from ownership import OwnershipError, owner_context


@pytest.fixture
def fake_connector(monkeypatch):
    calls = []

    class Client:
        def __init__(self, connections):
            self.connections = connections

        async def get_tools(self):
            connections = self.connections

            @tool
            async def private_tool() -> str:
                """Return a fixture result without returning its credentials."""
                calls.append(connections)
                return "private result"

            return [private_tool]

    monkeypatch.setattr(mcp, "MultiServerMCPClient", Client)
    monkeypatch.setenv("GOOGLE_MCP_CLIENT_ID", "offline-client")
    monkeypatch.setenv("GOOGLE_MCP_CLIENT_SECRET", "offline-secret")
    monkeypatch.setenv("SLACK_MCP_CLIENT_ID", "offline-client")
    monkeypatch.setenv("SLACK_MCP_CLIENT_SECRET", "offline-secret")
    return calls


@pytest.mark.parametrize("owner,other", [("a", "b"), ("b", "a")])
@pytest.mark.parametrize("provider", ["github", "notion", "stripe", "google-drive", "slack"])
def test_connections_tools_status_and_disconnect_are_owner_scoped(fake_connector, owner, other, provider):
    async def run():
        with owner_context(owner):
            if provider in {"google-drive", "slack"}:
                oauth._save_token(provider, {"access_token": "private-token"})
            else:
                connect = getattr(mcp, f"connect_{provider}_mcp")
                assert (await connect("private-token"))["success"]
            handles = await mcp.load_mcp_tools()
            assert len(handles) == 1
            assert (await mcp.get_mcp_status())["tool_count"] == 1
        with owner_context(other):
            assert await mcp.get_mcp_connections() == {}
            assert await mcp.load_mcp_tools() == []
            assert not (await mcp.get_mcp_status())["connected"]
            assert not any(item["configured"] for item in mcp.get_mcp_catalog())
            with pytest.raises(ToolException):
                await handles[0].ainvoke({}, config={"configurable": {"principal_id": owner}})
            disconnect = getattr(mcp, f"disconnect_{provider.replace('-', '_')}_mcp")
            result = disconnect()
            if asyncio.iscoroutine(result):
                await result
        with owner_context(owner):
            assert await handles[0].ainvoke({}) == "private result"
            assert len(fake_connector) == 1
            disconnect = getattr(mcp, f"disconnect_{provider.replace('-', '_')}_mcp")
            result = disconnect()
            if asyncio.iscoroutine(result):
                await result
            with pytest.raises(ToolException):
                await handles[0].ainvoke({})
            assert mcp._state().raw_tools == {}
    asyncio.run(run())


def test_anonymous_context_cannot_create_or_read_connector(fake_connector):
    with owner_context(None), pytest.raises(OwnershipError):
        asyncio.run(mcp.connect_github_mcp("offline-token"))
    with owner_context(None), pytest.raises(OwnershipError):
        oauth._save_token("slack", {"access_token": "offline-token"})


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
def test_oauth_http_disconnect_remains_available_over_quota(
    owner_client, fake_connector, provider, monkeypatch,
):
    from dataclasses import replace
    import usage_limits

    store = usage_limits.store
    monkeypatch.setattr(store, "clock", lambda: 120.0)
    store.policies["mcp"] = replace(store.policies["mcp"], per_minute=1)
    oauth._save_token(provider, {"access_token": "offline-token"})
    handle = asyncio.run(mcp.load_mcp_tools())[0]
    assert owner_client.get("/mcp/status").status_code == 429

    response = owner_client.post(f"/mcp/disconnect/{provider}")

    assert response.status_code == 200
    assert response.json() == {"success": True, "disconnected": True}
    assert oauth.get_oauth_token_record(provider) is None
    assert mcp._state().raw_tools == {}
    with pytest.raises(ToolException):
        asyncio.run(handle.ainvoke({}))


def test_environment_tokens_never_auto_claimed_or_forwarded(fake_connector, monkeypatch):
    for name in ("GITHUB_PERSONAL_ACCESS_TOKEN", "NOTION_TOKEN", "STRIPE_SECRET_KEY"):
        monkeypatch.setenv(name, "installation-token")
    assert asyncio.run(mcp.get_mcp_connections()) == {}
    config = mcp._notion_connection("notion-owner-token")
    assert config["env"]["NOTION_TOKEN"] == "notion-owner-token"
    assert "STRIPE_SECRET_KEY" not in config["env"]
    assert "GOOGLE_API_KEY" not in config["env"]
    assert "GITHUB_PERSONAL_ACCESS_TOKEN" not in config["env"]


def test_failed_connection_and_tool_errors_never_expose_secrets(fake_connector, monkeypatch):
    async def run():
        assert (await mcp.connect_github_mcp("valid-secret"))["success"]
        handles = await mcp.load_mcp_tools()

        async def failed(*args, **kwargs):
            raise RuntimeError("Authorization: Bearer private-secret-code")

        monkeypatch.setattr(mcp, "_get_server_tools", failed)
        result = await mcp.connect_github_mcp("new-secret")
        assert result == {"success": False, "error": mcp.CONNECTION_ERROR}
        assert "valid-secret" in (await mcp.get_mcp_connections())["github"]["headers"]["Authorization"]
        selected = mcp._state().raw_tools["github"][0]
        selected.coroutine = failed
        with pytest.raises(ToolException) as error:
            await handles[0].ainvoke({})
        assert str(error.value) == mcp.CONNECTION_ERROR
        assert error.value.__cause__ is None
        assert await mcp.get_mcp_connections() == {}
    asyncio.run(run())


def test_disconnect_wins_over_inflight_connect(fake_connector, monkeypatch):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        original = mcp._inspect_server

        async def inspect(*args):
            started.set()
            await release.wait()
            return await original(*args)

        monkeypatch.setattr(mcp, "_inspect_server", inspect)
        connecting = asyncio.create_task(mcp.connect_github_mcp("offline-token"))
        await started.wait()
        await mcp.disconnect_github_mcp()
        release.set()
        assert not (await connecting)["success"]
        assert await mcp.get_mcp_connections() == {}
    asyncio.run(run())


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
@pytest.mark.parametrize("invalid", ["principal", "session", "expired", "disconnect", "provider"])
def test_oauth_invalid_state_never_exchanges_credentials(fake_connector, monkeypatch, provider, invalid):
    with owner_context("a"):
        state = oauth._create_state(provider, "https://callback", "verifier", "session-a")
        if invalid == "expired":
            oauth._oauth_states[state]["created_at"] -= 601
        if invalid == "disconnect":
            oauth.disconnect_oauth_provider(provider)
    exchanges = []

    async def exchange(*args, **kwargs):
        exchanges.append(True)
        return {"access_token": "must-not-be-saved"}

    monkeypatch.setattr(oauth, "_post_form", exchange)
    target = ("slack" if provider == "google-drive" else "google-drive") if invalid == "provider" else provider
    complete = getattr(oauth, f"complete_{target.replace('-', '_')}_oauth")
    with owner_context("b" if invalid == "principal" else "a"):
        with pytest.raises(RuntimeError):
            asyncio.run(complete(
                code="offline-code", state=state,
                session_id="session-b" if invalid == "session" else "session-a",
                validate_session=lambda: True,
            ))
    assert exchanges == []


@pytest.mark.parametrize("provider", ["google-drive", "slack"])
@pytest.mark.parametrize("race", ["session_revoked", "disconnect", "invalid_payload", "replay"])
def test_oauth_completion_rechecks_session_epoch_and_preserves_valid_token(
    fake_connector, monkeypatch, provider, race,
):
    oauth._save_token(provider, {"access_token": "existing-token"})
    state = oauth._create_state(provider, "https://callback", "verifier", "session-a")
    valid = [True]

    async def exchange(*args, **kwargs):
        if race == "session_revoked":
            valid[0] = False
        if race == "disconnect":
            oauth.disconnect_oauth_provider(provider)
        if race == "invalid_payload":
            return {"error": "private provider error"}
        return {"access_token": "replacement-token"}

    monkeypatch.setattr(oauth, "_post_form", exchange)
    complete = getattr(oauth, f"complete_{provider.replace('-', '_')}_oauth")

    async def run():
        kwargs = dict(code="offline-code", state=state, session_id="session-a",
                      validate_session=lambda: valid[0])
        if race == "replay":
            await complete(**kwargs)
        with pytest.raises(RuntimeError) as error:
            await complete(**kwargs)
        assert "private provider error" not in str(error.value)

    asyncio.run(run())
    record = oauth.get_oauth_token_record(provider)
    if race == "disconnect":
        assert record is None
    else:
        assert record["access_token"] == ("replacement-token" if race == "replay" else "existing-token")


def test_refresh_is_single_flight_owner_scoped_and_disconnect_cannot_resurrect(fake_connector, monkeypatch):
    exchanges = []

    async def exchange(url, data, **kwargs):
        exchanges.append(data["refresh_token"])
        await asyncio.sleep(0.02)
        if data["refresh_token"] == "revoke-me":
            oauth.disconnect_oauth_provider("google-drive")
        return {"access_token": "refreshed", "expires_in": 3600}

    monkeypatch.setattr(oauth, "_post_form", exchange)

    async def run():
        with owner_context("a"):
            oauth._save_token("google-drive", {
                "access_token": "expired", "refresh_token": "a-refresh", "expires_in": -1,
            })
            assert await asyncio.gather(
                oauth.get_google_drive_access_token(), oauth.get_google_drive_access_token(),
            ) == ["refreshed", "refreshed"]
        with owner_context("b"):
            assert await oauth.get_google_drive_access_token() is None
            oauth._save_token("google-drive", {
                "access_token": "expired", "refresh_token": "revoke-me", "expires_in": -1,
            })
            with pytest.raises(RuntimeError):
                await oauth.get_google_drive_access_token()
            assert oauth.get_oauth_token_record("google-drive") is None
        with owner_context("a"):
            assert await oauth.get_google_drive_access_token() == "refreshed"
    asyncio.run(run())
    assert exchanges == ["a-refresh", "revoke-me"]


def test_expired_slack_and_revoked_google_tokens_clear_only_the_owner(fake_connector, monkeypatch):
    async def denied(*args, **kwargs):
        raise RuntimeError("secret refresh token")

    monkeypatch.setattr(oauth, "_post_form", denied)
    with owner_context("a"):
        oauth._save_token("slack", {"access_token": "expired", "expires_in": -1})
        assert oauth.get_slack_access_token() is None
        oauth._save_token("google-drive", {
            "access_token": "expired", "refresh_token": "private", "expires_in": -1,
        })
        with pytest.raises(RuntimeError) as error:
            asyncio.run(oauth.get_google_drive_access_token())
        assert str(error.value) == oauth.OAUTH_ERROR
        assert oauth.get_oauth_token_record("google-drive") is None


def test_mcp_artifacts_and_schema_survive_guarded_execution(fake_connector, monkeypatch):
    @tool(response_format="content_and_artifact")
    async def result(query: str) -> tuple[str, dict]:
        """Return both public content and an artifact."""
        return query, {"offline": True}

    async def discover(*args):
        return [result]

    monkeypatch.setattr(mcp, "_get_server_tools", discover)

    async def run():
        await mcp.connect_github_mcp("offline-token")
        handle = (await mcp.load_mcp_tools())[0]
        response = await handle.ainvoke({
            "type": "tool_call", "id": "call-one", "name": "result", "args": {"query": "hello"},
        })
        assert response.content == "hello" and response.artifact == {"offline": True}
    asyncio.run(run())


def test_disconnect_cancels_active_tool_session(fake_connector, monkeypatch):
    async def run():
        started = asyncio.Event()
        closed = []

        @tool
        async def slow_tool() -> str:
            """Hold a mock connector session open."""
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                closed.append(True)

        async def discover(*args):
            return [slow_tool]

        monkeypatch.setattr(mcp, "_get_server_tools", discover)
        await mcp.connect_github_mcp("offline-token")
        handle = (await mcp.load_mcp_tools())[0]
        running = asyncio.create_task(handle.ainvoke({}))
        await asyncio.wait_for(started.wait(), 2)
        await mcp.disconnect_github_mcp()
        with pytest.raises(asyncio.CancelledError):
            await running
        assert closed == [True]
    asyncio.run(run())


def test_token_connect_rechecks_revoked_session_before_saving(fake_connector, monkeypatch):
    valid = [True]
    original = mcp._inspect_server

    async def inspect(*args):
        result = await original(*args)
        valid[0] = False
        return result

    monkeypatch.setattr(mcp, "_inspect_server", inspect)
    with owner_context("a", validate_session=lambda: valid[0]):
        with pytest.raises(OwnershipError):
            asyncio.run(mcp.connect_github_mcp("offline-token"))
    with owner_context("a"):
        assert asyncio.run(mcp.get_mcp_connections()) == {}


def test_simultaneous_principal_connections_do_not_replace_each_other(fake_connector):
    async def connect(principal):
        with owner_context(principal):
            assert (await mcp.connect_github_mcp(f"{principal}-token"))["success"]
            return await mcp.load_mcp_tools()

    async def run():
        handles_a, handles_b = await asyncio.gather(connect("a"), connect("b"))
        with owner_context("a"):
            await handles_a[0].ainvoke({})
        with owner_context("b"):
            await handles_b[0].ainvoke({})
    asyncio.run(run())
    assert [call["github"]["headers"]["Authorization"] for call in fake_connector] == [
        "Bearer a-token", "Bearer b-token",
    ]


@pytest.mark.parametrize("provider", ["github", "notion", "stripe"])
@pytest.mark.parametrize("credential", ["${GOOGLE_API_KEY}", "token\r\ninjected", "x" * 4097])
def test_credentials_cannot_expand_server_environment_or_inject_headers(fake_connector, provider, credential):
    connect = getattr(mcp, f"connect_{provider}_mcp")
    result = asyncio.run(connect(credential))
    assert result == {"success": False, "error": "Invalid connector credential format."}
    assert asyncio.run(mcp.get_mcp_connections()) == {}
    assert fake_connector == []


def test_malformed_and_oversized_http_credentials_are_not_reflected(owner_client):
    response = owner_client.post("/mcp/connect/github", json={"token": {"private": "secret-token"}})
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid connector request."}
    response = owner_client.post("/mcp/connect/github", json={"token": "secret" * 3000})
    assert response.status_code == 413
    assert "secret" not in response.text


def test_canceled_callback_consumes_state_without_corrupting_connection(owner_client):
    oauth._save_token("google-drive", {"access_token": "existing-token"})
    session_id = owner_client.get("/auth/session").json()
    assert session_id["user"]
    import app as api
    session = api.app.state.auth_store.lookup(owner_client.cookies["clawbit_session"])
    state = oauth._create_state("google-drive", "https://callback", "verifier", session.token_hash)
    response = owner_client.get("/mcp/oauth/google-drive/callback", params={
        "state": state, "error": "denied-private-error",
    }, follow_redirects=False)
    assert "status=error" in response.headers["location"]
    assert "denied-private-error" not in response.headers["location"]
    with pytest.raises(RuntimeError):
        oauth._consume_state(state, "google-drive", session.token_hash)
    assert oauth.get_oauth_token_record("google-drive")["access_token"] == "existing-token"


def test_oauth_http_errors_and_redirects_never_expose_codes(monkeypatch):
    from urllib.error import HTTPError
    from urllib.request import Request
    import io

    class Opener:
        def open(self, *args, **kwargs):
            raise HTTPError("https://provider", 400, "private-secret", {}, io.BytesIO(b"secret-code"))

    monkeypatch.setattr(oauth, "build_opener", lambda *args: Opener())
    with pytest.raises(RuntimeError) as error:
        oauth._post_form_sync(oauth.GOOGLE_TOKEN_URL, {"code": "secret-code"})
    assert str(error.value) == oauth.OAUTH_ERROR
    with pytest.raises(RuntimeError) as error:
        oauth._NoRedirects().redirect_request(
            Request(oauth.GOOGLE_TOKEN_URL), None, 302, "redirect", {}, "https://other.example",
        )
    assert str(error.value) == oauth.OAUTH_ERROR


def test_other_worker_revocation_invalidates_cached_tools_and_oauth(fake_connector):
    import usage_limits

    other_worker = usage_limits.UsageStore(usage_limits.store.path)

    async def run():
        await mcp.connect_github_mcp("offline-token")
        handle = (await mcp.load_mcp_tools())[0]
        other_worker.connector_epoch("github", advance=True)
        with pytest.raises(ToolException):
            await handle.ainvoke({})
        assert await mcp.get_mcp_connections() == {}
        oauth._save_token("slack", {"access_token": "offline-token"})
        other_worker.connector_epoch("slack", advance=True)
        assert oauth.get_oauth_token_record("slack") is None
    asyncio.run(run())


def test_stale_refresh_cannot_revoke_new_connection_in_another_worker(fake_connector, monkeypatch):
    import usage_limits

    other_worker = usage_limits.UsageStore(usage_limits.store.path)
    oauth._save_token("google-drive", {
        "access_token": "expired", "refresh_token": "private", "expires_in": -1,
    })
    replacement_epoch = []

    async def exchange(*args, **kwargs):
        replacement_epoch.append(other_worker.connector_epoch("google-drive", advance=True))
        return {"access_token": "stale-refresh-result"}

    monkeypatch.setattr(oauth, "_post_form", exchange)
    with pytest.raises(RuntimeError):
        asyncio.run(oauth.get_google_drive_access_token())
    assert other_worker.connector_epoch("google-drive") == replacement_epoch[0]
    assert oauth.get_oauth_token_record("google-drive") is None
