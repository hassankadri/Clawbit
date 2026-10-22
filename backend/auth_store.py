"""Persistent authentication for one explicitly initialized local owner."""

from contextlib import closing, contextmanager
from dataclasses import dataclass
import hashlib
import hmac
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from typing import Iterator


SESSION_SECONDS = 8 * 60 * 60
PRESESSION_SECONDS = 10 * 60
LOGIN_WINDOW_SECONDS = 60
MAX_LOGIN_ATTEMPTS = 5
SCRYPT_N = 131072
SCRYPT_R = 8
SCRYPT_P = 1


class OwnerSetupError(ValueError):
    """The local owner could not be initialized safely."""


class LoginThrottled(Exception):
    """The installation's short login attempt budget is exhausted."""


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def csrf_token(token: str) -> str:
    """Derive a separate CSRF secret without exposing the session bearer token."""
    return hmac.new(token.encode("utf-8"), b"clawbit-csrf-v1", "sha256").hexdigest()


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        maxmem=256 * 1024 * 1024,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt, _ = encoded.split("$")
        if (algorithm, int(n), int(r), int(p)) != (
            "scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P
        ):
            return False
        salt_bytes = bytes.fromhex(salt)
        if len(salt_bytes) != 16:
            return False
        candidate = hash_password(password, salt_bytes)
        return hmac.compare_digest(candidate, encoded)
    except (ValueError, TypeError):
        return False


def validate_owner_credentials(username: str, password: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,63}", username):
        raise OwnerSetupError("Use a username of 3–64 letters, digits, dots, _ or -.")
    if not 15 <= len(password) <= 128 or len(set(password)) < 8:
        raise OwnerSetupError("Use a unique passphrase of 15–128 characters.")
    normalized = re.sub(r"[^a-z0-9]", "", password.lower())
    if (
        re.fullmatch(r"(?:password|qwerty|letmein|welcome|admin|clawbit|[0-9])+", normalized)
        or username.lower() in password.lower()
    ):
        raise OwnerSetupError("Choose a passphrase unrelated to your username.")


@dataclass(frozen=True)
class Session:
    token_hash: str
    username: str | None
    expires_at: float
    principal_id: str | None = None


class AuthStore:
    """SQLite sessions and a singleton owner; no application data is reassigned."""

    def __init__(self, path: Path):
        self.path = path
        self._initialized = False
        self._schema_lock = threading.Lock()

    def initialize(self) -> None:
        with self._schema_lock:
            if self._initialized:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            existed = self.path.exists()
            with closing(sqlite3.connect(self.path, timeout=10)) as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1, 2):
                    raise RuntimeError("Unsupported authentication database version.")
                if version < 2 and existed:
                    backup = self.path.with_name(f"{self.path.name}.{time.time_ns()}.backup")
                    with closing(sqlite3.connect(backup)) as destination:
                        connection.backup(destination)
                if version == 0:
                    connection.executescript(
                        """
                        BEGIN IMMEDIATE;
                        CREATE TABLE IF NOT EXISTS owner (
                            id INTEGER PRIMARY KEY CHECK (id = 1),
                            username TEXT NOT NULL UNIQUE,
                            password_hash TEXT NOT NULL,
                            created_at REAL NOT NULL
                        );
                        CREATE TABLE IF NOT EXISTS sessions (
                            token_hash TEXT PRIMARY KEY,
                            owner_id INTEGER REFERENCES owner(id),
                            expires_at REAL NOT NULL
                        );
                        CREATE INDEX IF NOT EXISTS session_expiration
                            ON sessions(expires_at);
                        CREATE TABLE IF NOT EXISTS login_attempts (
                            id INTEGER PRIMARY KEY CHECK (id = 1),
                            window_started REAL NOT NULL,
                            attempts INTEGER NOT NULL
                        );
                        PRAGMA user_version = 1;
                        COMMIT;
                        """
                    )
                if version < 2:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute("""CREATE TABLE IF NOT EXISTS owner_identity (
                        owner_id INTEGER PRIMARY KEY REFERENCES owner(id),
                        principal_id TEXT NOT NULL UNIQUE
                    )""")
                    connection.execute(
                        "INSERT OR IGNORE INTO owner_identity "
                        "SELECT id, ? FROM owner", (secrets.token_hex(32),)
                    )
                    connection.execute("PRAGMA user_version = 2")
                    connection.commit()
            self._initialized = True

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        self.initialize()
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def create_owner(self, username: str, password: str) -> None:
        """Create the sole owner atomically; existing data is never modified."""
        validate_owner_credentials(username, password)
        encoded = hash_password(password)
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT id FROM owner").fetchone():
                raise OwnerSetupError("This installation already has an owner.")
            connection.execute(
                "INSERT INTO owner VALUES (1, ?, ?, ?)",
                (username, encoded, time.time()),
            )
            connection.execute(
                "INSERT INTO owner_identity VALUES (1, ?)", (secrets.token_hex(32),)
            )

    def has_owner(self) -> bool:
        with self.connection() as connection:
            return connection.execute("SELECT id FROM owner").fetchone() is not None

    def lookup(self, token: str) -> Session | None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None
        with self.connection() as connection:
            row = connection.execute(
                """SELECT s.token_hash, o.username, s.expires_at, i.principal_id
                   FROM sessions s LEFT JOIN owner o ON o.id = s.owner_id
                   LEFT JOIN owner_identity i ON i.owner_id = o.id
                   WHERE s.token_hash = ? AND s.expires_at > ?""",
                (token_digest(token), time.time()),
            ).fetchone()
        return Session(**dict(row)) if row else None

    @staticmethod
    def _insert_session(
        connection: sqlite3.Connection, owner_id: int | None
    ) -> tuple[str, float]:
        token = secrets.token_urlsafe(32)
        lifetime = SESSION_SECONDS if owner_id else PRESESSION_SECONDS
        expires_at = time.time() + lifetime
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
        connection.execute(
            "INSERT INTO sessions VALUES (?, ?, ?)",
            (token_digest(token), owner_id, expires_at),
        )
        return token, expires_at

    def create_presession(self) -> tuple[str, float]:
        with self.connection() as connection:
            return self._insert_session(connection, None)

    def login(
        self, username: str, password: str, previous_token: str
    ) -> tuple[str, float] | None:
        """Throttle across workers and rotate the validated pre-session on success."""
        with self.connection() as connection:
            # Serialize the attempt budget before running a memory-hard password check.
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()
            attempt = connection.execute("SELECT * FROM login_attempts").fetchone()
            if attempt and now - attempt["window_started"] < LOGIN_WINDOW_SECONDS:
                if attempt["attempts"] >= MAX_LOGIN_ATTEMPTS:
                    raise LoginThrottled
                connection.execute("UPDATE login_attempts SET attempts = attempts + 1")
            else:
                connection.execute(
                    "INSERT OR REPLACE INTO login_attempts VALUES (1, ?, 1)", (now,)
                )
            owner = connection.execute("SELECT * FROM owner WHERE id = 1").fetchone()
            # Unknown usernames take the same expensive verification path.
            encoded = owner["password_hash"] if owner else hash_password("not an owner")
            valid_password = verify_password(password, encoded)
            previous = connection.execute(
                "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (token_digest(previous_token), now),
            ).fetchone()
            if (
                not owner
                or not valid_password
                or username != owner["username"]
                or not previous
            ):
                return None
            connection.execute("DELETE FROM login_attempts")
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_digest(previous_token),)
            )
            return self._insert_session(connection, 1)

    def revoke(self, token: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_digest(token),)
            )
