
"""Regression tests for browser CORS preflight requests."""

import pytest
from fastapi.testclient import TestClient

import app as api


FRONTEND_ORIGIN = "http://localhost:3000"


@pytest.mark.parametrize(
    "path",
    [
        "/history/example-thread",
        "/memories/example-memory",
    ],
)
@pytest.mark.parametrize(
    "method",
    ["GET", "POST", "PATCH", "DELETE"],
)
def test_frontend_methods_allow_cors_preflight(
    auth_store,
    path,
    method,
):
    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as client:
        response = client.options(
            path,
            headers={
                "Origin": FRONTEND_ORIGIN,
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers":
                    "content-type,x-csrf-token",
            },
        )

    assert response.status_code == 200
    assert (
        response.headers["access-control-allow-origin"]
        == FRONTEND_ORIGIN
    )
    assert (
        response.headers["access-control-allow-credentials"]
        == "true"
    )


@pytest.mark.parametrize(
    "path",
    [
        "/history/example-thread",
        "/memories/example-memory",
    ],
)
def test_unknown_origin_is_rejected(
    auth_store,
    path,
):
    with TestClient(
        api.app,
        base_url="http://localhost:8000",
    ) as client:
        response = client.options(
            path,
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "PATCH",
            },
        )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
