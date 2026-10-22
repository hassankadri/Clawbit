import os
import sys
import tempfile
from pathlib import Path

import pytest


# Set these before test collection imports modules that initialize persistence.
# Keep all real data and credentials outside the test process.
os.environ["CLAWBIT_RUNTIME_DIR"] = tempfile.mkdtemp(prefix="clawbit-tests-")
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
os.environ["GOOGLE_API_KEY"] = "test-google-key"
os.environ["GROQ_API_KEY"] = "test-groq-key"
os.environ["TAVILY_API_KEY"] = "test-tavily-key"
os.environ["OPENROUTER_API_KEY"] = "test-openrouter-key"
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["CLAWBIT_AUTH_MODE"] = "local"
os.environ["CLAWBIT_ALLOWED_ORIGINS"] = "http://localhost:3000,http://127.0.0.1:3000"
for key in ("GITHUB_PERSONAL_ACCESS_TOKEN", "NOTION_TOKEN", "STRIPE_SECRET_KEY",
            "GOOGLE_ACCESS_TOKEN", "SLACK_ACCESS_TOKEN"):
    os.environ.pop(key, None)

BACKEND_DIR = Path(__file__).resolve().parents[1]

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(autouse=True)
def isolated_ownership(monkeypatch, tmp_path):
    """Direct helper tests have an explicit principal; HTTP still verifies cookies."""
    import ownership

    registry = ownership.OwnershipStore(tmp_path / "runtime")
    registry.initialize()
    monkeypatch.setattr(ownership, "store", registry)
    with ownership.owner_context("offline-helper-principal"):
        yield registry


@pytest.fixture(autouse=True)
def isolated_usage_and_connectors(monkeypatch, tmp_path):
    import history_store
    import memory_store
    import mcp_client
    import mcp_oauth
    import usage_limits

    monkeypatch.setattr(memory_store, "store", memory_store.MemoryStore(tmp_path / "memory.sqlite3"))
    monkeypatch.setattr(history_store, "store", history_store.HistoryStore(tmp_path / "history.sqlite3"))

    monkeypatch.setattr(usage_limits, "store", usage_limits.UsageStore(tmp_path / "usage.sqlite3"))
    monkeypatch.setattr(mcp_client, "_states", {})
    monkeypatch.setattr(mcp_oauth, "_oauth_states", {})
    monkeypatch.setattr(mcp_oauth, "_oauth_tokens", {})
    monkeypatch.setattr(mcp_oauth, "_oauth_versions", {})
    monkeypatch.setattr(mcp_oauth, "_refresh_locks", {})
    with usage_limits.request_budget():
        yield


@pytest.fixture(autouse=True)
def no_external_services(monkeypatch):
    import socket
    import ipaddress

    def guarded(original):
        def connect(sock, address):
            # Windows asyncio implements socketpair with a loopback connection.
            try:
                local = isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback
            except ValueError:
                local = False
            if not local:
                raise AssertionError("External network access is forbidden in backend tests")
            return original(sock, address)
        return connect

    monkeypatch.setattr(socket.socket, "connect", guarded(socket.socket.connect))
    monkeypatch.setattr(socket.socket, "connect_ex", guarded(socket.socket.connect_ex))


@pytest.fixture(autouse=True)
def offline_model_catalog(monkeypatch, tmp_path):
    import models
    import json
    import hashlib

    policy = tmp_path / "free-policy.json"
    policy.write_text(json.dumps({"google": True, "groq": True, "key_fingerprints": {
        provider: hashlib.sha256(os.environ[models.PROVIDER_KEYS[provider]].encode()).hexdigest()
        for provider in ("google", "groq")
    }}), encoding="utf-8")
    monkeypatch.setattr(models, "POLICY_PATH", policy)

    def discover(provider):
        return {name: {"id": name, "active": True, "supportedGenerationMethods": ["generateContent"],
                       "pricing": {"prompt": "0", "completion": "0"},
                       "supported_parameters": ["tools", "structured_outputs"],
                       "architecture": {"input_modalities": ["text", "image"]}}
                for name, config in models.MODEL_CONFIGS.items() if config["provider"] == provider}

    monkeypatch.setattr(models, "_CATALOG_CACHE", {})
    monkeypatch.setattr(models, "_discover", discover)
    monkeypatch.setattr(models, "_OPENROUTER_ENDPOINT_CACHE", {})
    monkeypatch.setattr(models, "_discover_openrouter_endpoints", lambda name: {
        "data": {"id": name, "endpoints": [{
            "model_id": name, "status": 0,
            "pricing": {"prompt": "0", "completion": "0"},
            "supported_parameters": ["tools"],
        }]},
    })


@pytest.fixture
def auth_store(tmp_path, monkeypatch):
    """Use real auth persistence, isolated from the installation's owner and data."""
    import app as api
    from auth_store import AuthStore

    store = AuthStore(tmp_path / "auth.sqlite3")
    monkeypatch.setattr(api.app.state, "auth_store", store)
    return store


@pytest.fixture
def owner_client(auth_store):
    """Sign in through the production CSRF/login flow for existing API regressions."""
    from fastapi.testclient import TestClient
    import app as api

    auth_store.create_owner("test-owner", "Saffron rivers carry seven boats!")
    with TestClient(api.app, base_url="http://localhost:8000") as client:
        client.headers["Origin"] = "http://localhost:3000"
        session = client.get("/auth/session").json()
        client.headers["X-CSRF-Token"] = session["csrf_token"]
        response = client.post("/auth/login", json={
            "username": "test-owner", "password": "Saffron rivers carry seven boats!",
        })
        assert response.status_code == 200
        client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
        from ownership import owner_context

        session = auth_store.lookup(client.cookies["clawbit_session"])
        with owner_context(session.principal_id):
            yield client
