"""Server-side Cloudflare Turnstile verification for public signup."""

import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
MAX_TOKEN_LENGTH = 2048
VERIFY_TIMEOUT_SECONDS = 5
MAX_RESPONSE_BYTES = 16 * 1024


def verify_turnstile(
    token: str,
    secret: str,
    *,
    expected_hostnames: set[str],
    expected_action: str,
    remote_ip: str | None = None,
) -> bool:
    """Return True only for a successful, single-use token for this site/action."""
    if (
        not isinstance(token, str)
        or not token
        or len(token) > MAX_TOKEN_LENGTH
        or not isinstance(secret, str)
        or not secret.strip()
        or not expected_hostnames
        or not expected_action
    ):
        return False

    fields = {
        "secret": secret,
        "response": token,
    }

    if isinstance(remote_ip, str) and remote_ip.strip():
        fields["remoteip"] = remote_ip.strip()

    request = Request(
        SITEVERIFY_URL,
        data=urlencode(fields).encode("ascii"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=VERIFY_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return False

            raw = response.read(MAX_RESPONSE_BYTES + 1)

            if len(raw) > MAX_RESPONSE_BYTES:
                return False

        result = json.loads(raw.decode("utf-8"))

    except (OSError, TimeoutError, ValueError, UnicodeDecodeError):
        # Fail closed if Cloudflare is unavailable or its response is malformed.
        return False

    return (
        isinstance(result, dict)
        and result.get("success") is True
        and result.get("action") == expected_action
        and result.get("hostname") in expected_hostnames
    )