
"""Offline tests for production HTTPS and trusted reverse proxies."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from auth import install_authentication
from auth_store import AuthStore
import production_server


FRONTEND_ORIGIN = "https://clawbit.example"
API_ORIGIN = "http://api.clawbit.example"


@pytest.fixture
def production_settings(monkeypatch):
    monkeypatch.setenv(
        "CLAWBIT_AUTH_MODE",
        "production",
    )
    monkeypatch.setenv(
        "CLAWBIT_ALLOWED_ORIGINS",
        FRONTEND_ORIGIN,
    )
    monkeypatch.setenv(
        "CLAWBIT_TRUSTED_PROXIES",
        "127.0.0.1",
    )
    monkeypatch.delenv(
        "CLAWBIT_BACKEND_BIND_HOST",
        raising=False,
    )
    monkeypatch.delenv(
        "CLAWBIT_BACKEND_PORT",
        raising=False,
    )


def create_production_application(tmp_path):
    application = FastAPI()
    install_authentication(application)

    application.state.auth_store = AuthStore(
        tmp_path / "proxy-auth.sqlite3"
    )

    return ProxyHeadersMiddleware(
        application,
        trusted_hosts="127.0.0.1",
    )


def request_session(
    application,
    *,
    peer,
    headers=None,
    base_url=API_ORIGIN,
):
    with TestClient(
        application,
        base_url=base_url,
        client=(peer, 50000),
    ) as client:
        return client.get(
            "/auth/session",
            headers={
                "Origin": FRONTEND_ORIGIN,
                **(headers or {}),
            },
        )


def test_trusted_proxy_can_forward_real_https(
    tmp_path,
    production_settings,
):
    application = create_production_application(tmp_path)

    response = request_session(
        application,
        peer="127.0.0.1",
        headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "198.51.100.42",
        },
    )

    assert response.status_code == 200

    cookie = response.headers["set-cookie"]

    assert cookie.startswith(
        "__Host-clawbit_session="
    )
    assert "Secure" in cookie
    assert "HttpOnly" in cookie


@pytest.mark.parametrize(
    "peer",
    [
        "203.0.113.10",
        "192.0.2.44",
    ],
)
def test_untrusted_client_cannot_spoof_https(
    tmp_path,
    production_settings,
    peer,
):
    application = create_production_application(tmp_path)

    response = request_session(
        application,
        peer=peer,
        headers={
            "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "127.0.0.1",
        },
    )

    assert response.status_code == 403
    assert response.json() == {
        "detail": "HTTPS is required."
    }
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Forwarded-Proto": "http"},
        {"X-Forwarded-Proto": "invalid"},
    ],
)
def test_trusted_proxy_does_not_bypass_http_denial(
    tmp_path,
    production_settings,
    headers,
):
    application = create_production_application(tmp_path)

    response = request_session(
        application,
        peer="127.0.0.1",
        headers=headers,
    )

    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_direct_https_remains_valid(
    tmp_path,
    production_settings,
):
    application = create_production_application(tmp_path)

    response = request_session(
        application,
        peer="203.0.113.10",
        base_url="https://api.clawbit.example",
    )

    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]


@pytest.mark.parametrize(
    "value",
    [
        "",
        " ",
        "*",
        "0.0.0.0/0",
        "::/0",
        "0.0.0.0",
        "localhost",
        "127.0.0.1,",
        ",127.0.0.1",
        "192.0.2.15/24",
        "127.0.0.1;203.0.113.5",
        "not-an-ip",
    ],
)
def test_invalid_proxy_configuration_is_rejected(value):
    with pytest.raises(ValueError):
        production_server.parse_trusted_proxies(
            value
        )


def test_valid_proxy_addresses_and_networks():
    assert production_server.parse_trusted_proxies(
        "127.0.0.1,10.20.30.0/24,::1"
    ) == "127.0.0.1,10.20.30.0/24,::1"


def test_duplicate_trusted_proxy_is_removed():
    assert production_server.parse_trusted_proxies(
        "127.0.0.1,127.0.0.1"
    ) == "127.0.0.1"


def test_local_auth_mode_is_rejected(
    monkeypatch,
):
    monkeypatch.setenv(
        "CLAWBIT_AUTH_MODE",
        "local",
    )

    with pytest.raises(
        ValueError,
        match="requires CLAWBIT_AUTH_MODE=production",
    ):
        production_server.production_config_from_environment()


def test_production_requires_explicit_proxies(
    production_settings,
    monkeypatch,
):
    monkeypatch.delenv(
        "CLAWBIT_TRUSTED_PROXIES",
    )

    with pytest.raises(
        ValueError,
        match="CLAWBIT_TRUSTED_PROXIES",
    ):
        production_server.production_config_from_environment()


def test_production_requires_https_origins(
    production_settings,
    monkeypatch,
):
    monkeypatch.setenv(
        "CLAWBIT_ALLOWED_ORIGINS",
        "http://clawbit.example",
    )

    with pytest.raises(ValueError):
        production_server.production_config_from_environment()


def test_production_configuration_defaults_to_loopback(
    production_settings,
):
    config = production_server.production_config_from_environment()

    assert config.host == "127.0.0.1"
    assert config.port == 8000
    assert config.trusted_proxies == "127.0.0.1"


@pytest.mark.parametrize(
    "port",
    ["0", "65536", "not-a-port"],
)
def test_invalid_port_is_rejected(
    production_settings,
    monkeypatch,
    port,
):
    monkeypatch.setenv(
        "CLAWBIT_BACKEND_PORT",
        port,
    )

    with pytest.raises(ValueError):
        production_server.production_config_from_environment()


def test_production_launcher_passes_explicit_proxy_settings(
    production_settings,
    monkeypatch,
):
    import uvicorn

    calls = []

    monkeypatch.setattr(
        production_server,
        "load_dotenv",
        lambda *args, **kwargs: None,
    )

    monkeypatch.setattr(
        uvicorn,
        "run",
        lambda *args, **kwargs: calls.append(
            (args, kwargs)
        ),
    )

    production_server.main()

    assert len(calls) == 1

    args, kwargs = calls[0]

    assert args == ("app:app",)
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 8000
    assert kwargs["proxy_headers"] is True
    assert kwargs["forwarded_allow_ips"] == "127.0.0.1"
    assert kwargs["workers"] == 1
    assert kwargs["access_log"] is False
