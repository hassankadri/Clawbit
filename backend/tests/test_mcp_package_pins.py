
"""Regression tests for version-pinned MCP process startup."""

import pytest

import mcp_client as mcp


@pytest.mark.parametrize(
    "factory,expected_package,environment_variable",
    [
        (
            mcp._notion_connection,
            "@notionhq/notion-mcp-server@2.5.2",
            "NOTION_TOKEN",
        ),
        (
            mcp._stripe_connection,
            "@stripe/mcp@0.3.3",
            "STRIPE_SECRET_KEY",
        ),
    ],
)
def test_mcp_server_uses_exact_published_version(
    monkeypatch,
    factory,
    expected_package,
    environment_variable,
):
    monkeypatch.setattr(
        mcp.shutil,
        "which",
        lambda name: None,
    )

    configuration = factory("offline-token")

    assert configuration == {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", expected_package],
        "env": {
            environment_variable: "offline-token",
        },
    }

    assert "latest" not in expected_package
    assert "^" not in expected_package
    assert "~" not in expected_package


def test_only_reviewed_packages_can_be_started():
    assert set(mcp.MCP_PACKAGE_PINS) == {
        "notion",
        "stripe",
    }

    with pytest.raises(KeyError):
        mcp._stdio_connection(
            "unreviewed",
            "UNTRUSTED_TOKEN",
            "offline-token",
        )


@pytest.mark.parametrize(
    "factory",
    [
        mcp._notion_connection,
        mcp._stripe_connection,
    ],
)
def test_package_builder_rejects_unsafe_credentials(factory):
    with pytest.raises(ValueError):
        factory("${UNTRUSTED_VARIABLE}")

    with pytest.raises(ValueError):
        factory("token\r\nINJECTED=value")
