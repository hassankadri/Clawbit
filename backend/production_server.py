
"""Safe production launcher for Clawbit behind a trusted HTTPS proxy.

Local development continues using the existing uvicorn command.
This launcher requires explicit proxy configuration in production.
"""

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from auth import AuthSettings


@dataclass(frozen=True)
class ProductionConfig:
    host: str
    port: int
    trusted_proxies: str


def parse_trusted_proxies(value: str) -> str:
    """Accept explicit IP addresses or strict CIDR networks only.

    Never trust arbitrary clients to provide X-Forwarded-Proto
    or X-Forwarded-For headers.
    """
    if not value or not value.strip():
        raise ValueError(
            "Production requires CLAWBIT_TRUSTED_PROXIES."
        )

    validated = []

    for raw_entry in value.split(","):
        entry = raw_entry.strip()

        if not entry or "*" in entry:
            raise ValueError(
                "Trusted proxies must be explicit IP addresses or CIDR networks."
            )

        try:
            network = ipaddress.ip_network(
                entry,
                strict=True,
            )
        except ValueError:
            raise ValueError(
                "Invalid trusted proxy IP address or CIDR network."
            ) from None

        if (
            network.prefixlen == 0
            or network.network_address.is_unspecified
            or network.network_address.is_multicast
        ):
            raise ValueError(
                "Unrestricted or invalid proxy networks are not permitted."
            )

        canonical = (
            str(network.network_address)
            if network.prefixlen == network.max_prefixlen
            else str(network)
        )

        if canonical not in validated:
            validated.append(canonical)

    return ",".join(validated)


def production_config_from_environment() -> ProductionConfig:
    """Validate production settings before opening a listening socket."""
    if os.getenv("CLAWBIT_AUTH_MODE") != "production":
        raise ValueError(
            "production_server.py requires CLAWBIT_AUTH_MODE=production. "
            "Use the existing development command for local mode."
        )

    # Retain Clawbit's existing exact-origin HTTPS validation.
    AuthSettings.from_environment()

    trusted_proxies = parse_trusted_proxies(
        os.getenv("CLAWBIT_TRUSTED_PROXIES", "")
    )

    host = os.getenv(
        "CLAWBIT_BACKEND_BIND_HOST",
        "127.0.0.1",
    ).strip()

    try:
        ipaddress.ip_address(host)
    except ValueError:
        raise ValueError(
            "CLAWBIT_BACKEND_BIND_HOST must be an IP address."
        ) from None

    raw_port = os.getenv(
        "CLAWBIT_BACKEND_PORT",
        "8000",
    ).strip()

    try:
        port = int(raw_port)
    except ValueError:
        raise ValueError(
            "CLAWBIT_BACKEND_PORT must be an integer."
        ) from None

    if not 1 <= port <= 65535:
        raise ValueError(
            "CLAWBIT_BACKEND_PORT must be between 1 and 65535."
        )

    return ProductionConfig(
        host=host,
        port=port,
        trusted_proxies=trusted_proxies,
    )


def main() -> None:
    # Match the existing backend .env behavior. Real process
    # environment variables take precedence.
    load_dotenv(
        Path(__file__).resolve().with_name(".env"),
        override=False,
    )

    configuration = production_config_from_environment()

    import uvicorn

    uvicorn.run(
        "app:app",
        host=configuration.host,
        port=configuration.port,
        proxy_headers=True,
        forwarded_allow_ips=configuration.trusted_proxies,
        access_log=False,
        workers=1,
    )


if __name__ == "__main__":
    main()
