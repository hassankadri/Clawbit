
"""Encrypted, principal-scoped persistence for MCP credentials.

Windows uses the current Windows user's DPAPI protection.
Other platforms require an explicitly configured Fernet key.
Never store bearer tokens, OAuth tokens or API keys as plaintext.
"""

import json
import os
from pathlib import Path
import sqlite3
from threading import RLock

from cryptography.fernet import Fernet, InvalidToken

from ownership import require_active_owner
import usage_limits


PROVIDERS = frozenset({
    "github",
    "notion",
    "stripe",
    "google-drive",
    "slack",
})

_STORE_LOCK = RLock()


class CredentialStoreError(RuntimeError):
    """Encrypted MCP credential storage is unavailable or invalid."""


def database_path() -> Path:
    # Follow the active usage store so isolated test installations
    # never share the user's real credentials.
    return Path(usage_limits.store.path).parent / "mcp_credentials.sqlite3"


def _encrypt(payload: bytes) -> bytes:
    try:
        if os.name == "nt":
            import win32crypt

            encrypted = win32crypt.CryptProtectData(
                payload,
                "Clawbit MCP credentials",
                None,
                None,
                None,
                0,
            )
            return b"DPAPI1:" + encrypted

        key = os.environ.get("CLAWBIT_MCP_STATE_KEY", "")
        if not key:
            raise CredentialStoreError(
                "Encrypted MCP persistence requires CLAWBIT_MCP_STATE_KEY."
            )

        encrypted = Fernet(key.encode("ascii")).encrypt(payload)
        return b"FERNET1:" + encrypted

    except CredentialStoreError:
        raise
    except Exception:
        raise CredentialStoreError(
            "Unable to encrypt connector credentials."
        ) from None


def _decrypt(payload: bytes) -> bytes:
    try:
        if payload.startswith(b"DPAPI1:") and os.name == "nt":
            import win32crypt

            _, result = win32crypt.CryptUnprotectData(
                payload[len(b"DPAPI1:"):],
                None,
                None,
                None,
                0,
            )
            return result

        if payload.startswith(b"FERNET1:") and os.name != "nt":
            key = os.environ.get("CLAWBIT_MCP_STATE_KEY", "")
            if not key:
                raise CredentialStoreError(
                    "Encrypted MCP persistence key is unavailable."
                )
            return Fernet(key.encode("ascii")).decrypt(
                payload[len(b"FERNET1:"):]
            )

    except CredentialStoreError:
        raise
    except (InvalidToken, Exception):
        raise CredentialStoreError(
            "Unable to decrypt connector credentials."
        ) from None

    raise CredentialStoreError(
        "Unsupported connector credential encryption format."
    )


def _open(create: bool = False) -> sqlite3.Connection | None:
    path = database_path()

    if not create and not path.exists():
        return None

    if create:
        path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(path, timeout=10)

    try:
        if create:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS credentials (
                    principal TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    epoch INTEGER NOT NULL,
                    ciphertext BLOB NOT NULL,
                    PRIMARY KEY (principal, provider)
                )
                """
            )
            connection.commit()

            if os.name != "nt":
                os.chmod(path, 0o600)

        return connection

    except Exception:
        connection.close()
        raise CredentialStoreError(
            "Unable to initialize connector credential storage."
        ) from None


def save_record(
    provider: str,
    kind: str,
    value: dict,
    epoch: int,
) -> None:
    """Persist only validated, currently authorized credentials."""
    principal = require_active_owner()

    if provider not in PROVIDERS:
        raise CredentialStoreError("Unsupported connector provider.")

    if kind not in {"token", "oauth"} or not isinstance(value, dict):
        raise CredentialStoreError("Unsupported connector credential record.")

    if kind == "token" and provider not in {
        "github", "notion", "stripe"
    }:
        raise CredentialStoreError("Unsupported token connector.")

    if kind == "oauth" and provider not in {
        "google-drive", "slack"
    }:
        raise CredentialStoreError("Unsupported OAuth connector.")

    try:
        if usage_limits.store.connector_epoch(provider) != epoch:
            raise CredentialStoreError(
                "The connector was revoked during persistence."
            )

        plaintext = json.dumps(
            {"kind": kind, "value": value},
            separators=(",", ":"),
        ).encode("utf-8")

        ciphertext = _encrypt(plaintext)

        with _STORE_LOCK:
            connection = _open(create=True)
            assert connection is not None

            try:
                with connection:
                    connection.execute("BEGIN IMMEDIATE")

                    if usage_limits.store.connector_epoch(provider) != epoch:
                        raise CredentialStoreError(
                            "The connector was revoked during persistence."
                        )

                    connection.execute(
                        """
                        INSERT INTO credentials
                            (principal, provider, epoch, ciphertext)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(principal, provider)
                        DO UPDATE SET
                            epoch = excluded.epoch,
                            ciphertext = excluded.ciphertext
                        """,
                        (principal, provider, epoch, ciphertext),
                    )
            finally:
                connection.close()

    except CredentialStoreError:
        raise
    except Exception:
        raise CredentialStoreError(
            "Unable to save connector credentials."
        ) from None


def load_record(provider: str) -> dict | None:
    """Restore only records matching the current principal and epoch."""
    principal = require_active_owner()

    if provider not in PROVIDERS:
        return None

    with _STORE_LOCK:
        try:
            connection = _open()
        except Exception:
            raise CredentialStoreError(
                "Unable to read connector credential storage."
            ) from None

        if connection is None:
            return None

        try:
            row = connection.execute(
                """
                SELECT epoch, ciphertext
                FROM credentials
                WHERE principal = ? AND provider = ?
                """,
                (principal, provider),
            ).fetchone()
        except Exception:
            raise CredentialStoreError(
                "Unable to read connector credentials."
            ) from None
        finally:
            connection.close()

    if row is None:
        return None

    epoch, ciphertext = row

    if usage_limits.store.connector_epoch(provider) != epoch:
        return None

    try:
        payload = json.loads(_decrypt(ciphertext))
    except CredentialStoreError:
        raise
    except Exception:
        raise CredentialStoreError(
            "Invalid encrypted connector record."
        ) from None

    if (
        not isinstance(payload, dict)
        or payload.get("kind") not in {"token", "oauth"}
        or not isinstance(payload.get("value"), dict)
    ):
        raise CredentialStoreError(
            "Invalid encrypted connector record."
        )

    # A disconnect or reconnect during decryption must win.
    if usage_limits.store.connector_epoch(provider) != epoch:
        return None

    return {
        "kind": payload["kind"],
        "value": payload["value"],
        "epoch": epoch,
    }


def invalidate_record(provider: str) -> None:
    """Delete records from earlier connector epochs.

    A new connection created after a disconnect is not deleted
    by a late cleanup operation.
    """
    principal = require_active_owner()

    if provider not in PROVIDERS:
        return

    current_epoch = usage_limits.store.connector_epoch(provider)

    with _STORE_LOCK:
        connection = _open()

        if connection is None:
            return

        try:
            with connection:
                connection.execute(
                    """
                    DELETE FROM credentials
                    WHERE principal = ?
                      AND provider = ?
                      AND epoch < ?
                    """,
                    (principal, provider, current_epoch),
                )
        finally:
            connection.close()
