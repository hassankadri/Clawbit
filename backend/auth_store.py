
"""Persistent authentication for one explicitly initialized local owner."""

from contextlib import closing, contextmanager
from dataclasses import dataclass
import hashlib
import hmac
import ipaddress
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
MAX_SOURCE_ATTEMPTS = 30

PRESESSION_ISSUE_WINDOW_SECONDS = 60
MAX_PRESESSION_ISSUES_PER_SOURCE = 5
MAX_GLOBAL_PRESESSION_ISSUES_PER_WINDOW = 60
MAX_ACTIVE_PRESESSIONS = 1024

SETUP_TOKEN_SECONDS = 15 * 60
MAX_SETUP_ATTEMPTS_PER_SOURCE = 10

SIGNUP_WINDOW_SECONDS = 60 * 60
MAX_SIGNUPS_GLOBAL_PER_HOUR = 100
MAX_SIGNUPS_PER_SOURCE = 8
MAX_SIGNUP_ATTEMPTS_PER_EMAIL = 4

SCRYPT_N = 131072
SCRYPT_R = 8
SCRYPT_P = 1


class OwnerSetupError(ValueError):
    """The local owner could not be initialized or updated safely."""


class OwnerAlreadyInitialized(OwnerSetupError):
    """This installation already has its sole owner."""


class SetupTokenInvalid(OwnerSetupError):
    """The supplied setup token or anonymous setup session is invalid."""


class LoginThrottled(Exception):
    """The current login source or pre-session exceeded its budget."""


class PreSessionThrottled(Exception):
    """Anonymous pre-session issuance is temporarily unavailable."""


class SetupThrottled(Exception):
    """Too many attempts were made to redeem an owner setup token."""


class SignupThrottled(Exception):
    """Public account registration exceeded its safety budget."""


class AccountAlreadyExists(OwnerSetupError):
    """The supplied email address is already registered."""


class AdministratorNotInitialized(OwnerSetupError):
    """Public signup is unavailable until the deployment admin is initialized."""


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalize_client_address(client_address: str) -> str:
    """Normalize an IP address for stable rate-limit buckets."""
    candidate = (client_address or "").strip()
    if not candidate:
        return "unknown"

    candidate = candidate.split("%", 1)[0]

    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return "unknown"

    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network(f"{address}/64", strict=False))

    return str(address)


def csrf_token(token: str) -> str:
    """Derive a separate CSRF secret without exposing the session bearer token."""
    return hmac.new(
        token.encode("utf-8"),
        b"clawbit-csrf-v1",
        "sha256",
    ).hexdigest()


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
    return (
        f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}"
        f"${salt.hex()}${digest.hex()}"
    )


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
    except (ValueError, TypeError, UnicodeEncodeError):
        return False


def validate_owner_credentials(username: str, password: str) -> None:
    if not isinstance(username, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.-]{2,63}",
        username,
    ):
        raise OwnerSetupError(
            "Use a username of 3–64 letters, digits, dots, _ or -."
        )

    if (
        not isinstance(password, str)
        or not 15 <= len(password) <= 128
        or len(set(password)) < 8
    ):
        raise OwnerSetupError(
            "Use a unique passphrase of 15–128 characters."
        )

    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        raise OwnerSetupError("The passphrase contains invalid characters.") from None

    normalized = re.sub(r"[^a-z0-9]", "", password.lower())
    if (
        re.fullmatch(
            r"(?:password|qwerty|letmein|welcome|admin|clawbit|[0-9])+",
            normalized,
        )
        or username.lower() in password.lower()
    ):
        raise OwnerSetupError(
            "Choose a passphrase unrelated to your username."
        )


@dataclass(frozen=True)
class Session:
    token_hash: str
    username: str | None
    expires_at: float
    principal_id: str | None = None
    user_id: int | None = None
    email: str | None = None
    role: str | None = None


class AuthStore:
    """Multi-user accounts, isolated identities, sessions and abuse controls."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._initialized = False
        self._schema_lock = threading.Lock()

    def initialize(self) -> None:
        with self._schema_lock:
            if self._initialized:
                return

            self.path.parent.mkdir(parents=True, exist_ok=True)
            existed = self.path.exists()

            with closing(sqlite3.connect(self.path, timeout=10)) as connection:
                version = connection.execute(
                    "PRAGMA user_version"
                ).fetchone()[0]

                if version not in (0, 1, 2, 3, 4, 5):
                    raise RuntimeError(
                        "Unsupported authentication database version."
                    )

                if version < 5 and existed:
                    backup = self.path.with_name(
                        f"{self.path.name}.{time.time_ns()}.backup"
                    )
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
                    connection.execute(
                        """
                        CREATE TABLE IF NOT EXISTS owner_identity (
                            owner_id INTEGER PRIMARY KEY REFERENCES owner(id),
                            principal_id TEXT NOT NULL UNIQUE
                        )
                        """
                    )
                    connection.execute(
                        "INSERT OR IGNORE INTO owner_identity "
                        "SELECT id, ? FROM owner",
                        (secrets.token_hex(32),),
                    )
                    connection.execute("PRAGMA user_version = 2")
                    connection.commit()

                if version < 3:
                    connection.executescript(
                        """
                        BEGIN IMMEDIATE;

                        DROP TABLE IF EXISTS login_attempts;

                        CREATE TABLE login_attempts (
                            scope TEXT NOT NULL,
                            bucket TEXT NOT NULL,
                            window_started REAL NOT NULL,
                            attempts INTEGER NOT NULL,
                            PRIMARY KEY (scope, bucket)
                        );

                        CREATE INDEX login_attempt_expiration
                            ON login_attempts(window_started);

                        PRAGMA user_version = 3;
                        COMMIT;
                        """
                    )

                if version < 4:
                    connection.executescript(
                        """
                        BEGIN IMMEDIATE;

                        CREATE TABLE IF NOT EXISTS setup_tokens (
                            id INTEGER PRIMARY KEY CHECK (id = 1),
                            token_hash TEXT NOT NULL,
                            issued_at REAL NOT NULL,
                            expires_at REAL NOT NULL
                        );

                        PRAGMA user_version = 4;
                        COMMIT;
                        """
                    )

                if version < 5:
                    # Preserve the legacy owner and principal IDs. New accounts
                    # use users/user_identity; the existing owner becomes admin.
                    # Use execute() rather than executescript() here: sqlite3.executescript
                    # commits an active transaction before running its script.
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute("""
                        CREATE TABLE IF NOT EXISTS users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                            email TEXT COLLATE NOCASE UNIQUE,
                            password_hash TEXT NOT NULL,
                            role TEXT NOT NULL DEFAULT 'user'
                                CHECK(role IN ('admin', 'user')),
                            created_at REAL NOT NULL
                        )
                    """)
                    connection.execute("""
                        CREATE TABLE IF NOT EXISTS user_identity (
                            user_id INTEGER PRIMARY KEY REFERENCES users(id),
                            principal_id TEXT NOT NULL UNIQUE
                        )
                    """)
                    connection.execute("""
                        INSERT OR IGNORE INTO users
                            (id, username, email, password_hash, role, created_at)
                        SELECT id, username,
                               CASE WHEN instr(username, '@') > 1 THEN lower(username) ELSE NULL END,
                               password_hash, 'admin', created_at
                        FROM owner
                    """)
                    connection.execute("""
                        INSERT OR IGNORE INTO user_identity(user_id, principal_id)
                        SELECT owner_id, principal_id FROM owner_identity
                    """)
                    # Repair only missing identity rows; existing principals are
                    # retained so every legacy resource remains attached to admin.
                    for user_row in connection.execute(
                        "SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM user_identity)"
                    ).fetchall():
                        connection.execute(
                            "INSERT INTO user_identity(user_id, principal_id) VALUES (?, ?)",
                            (user_row[0], secrets.token_hex(32)),
                        )

                    # Rebuild sessions so their foreign key points at users.
                    # Keep owner_id as the column name for existing query/tests;
                    # semantically it is now the authenticated user ID.
                    connection.execute("ALTER TABLE sessions RENAME TO sessions_legacy_v4")
                    connection.execute("""
                        CREATE TABLE sessions (
                            token_hash TEXT PRIMARY KEY,
                            owner_id INTEGER REFERENCES users(id),
                            expires_at REAL NOT NULL
                        )
                    """)
                    connection.execute("""
                        INSERT INTO sessions(token_hash, owner_id, expires_at)
                        SELECT token_hash, owner_id, expires_at FROM sessions_legacy_v4
                    """)
                    connection.execute("DROP TABLE sessions_legacy_v4")
                    connection.execute("CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires_at)")
                    connection.execute("PRAGMA user_version = 5")
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
        """Create the initial administrator through the local bootstrap CLI."""
        validate_owner_credentials(username, password)
        encoded = hash_password(password)

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")

            if connection.execute("SELECT id FROM users LIMIT 1").fetchone():
                raise OwnerAlreadyInitialized(
                    "An account already exists; the initial administrator must be created before public registration."
                )

            now = time.time()
            principal = secrets.token_hex(32)
            connection.execute(
                "INSERT INTO owner VALUES (1, ?, ?, ?)",
                (username, encoded, now),
            )
            connection.execute(
                "INSERT INTO owner_identity VALUES (1, ?)",
                (principal,),
            )
            connection.execute(
                "INSERT INTO users(id, username, email, password_hash, role, created_at) "
                "VALUES (1, ?, ?, ?, 'admin', ?)",
                (username, username.lower() if "@" in username else None, encoded, now),
            )
            connection.execute(
                "INSERT INTO user_identity(user_id, principal_id) VALUES (1, ?)",
                (principal,),
            )
            connection.execute("DELETE FROM setup_tokens")

    def create_setup_token(self) -> str:
        """Issue one short-lived setup token, storing only its digest."""
        token = secrets.token_urlsafe(32)
        now = time.time()

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")

            if connection.execute("SELECT id FROM users LIMIT 1").fetchone():
                raise OwnerAlreadyInitialized(
                    "An account already exists; owner setup is no longer available."
                )

            connection.execute(
                """
                INSERT INTO setup_tokens (
                    id, token_hash, issued_at, expires_at
                )
                VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    token_hash = excluded.token_hash,
                    issued_at = excluded.issued_at,
                    expires_at = excluded.expires_at
                """,
                (
                    token_digest(token),
                    now,
                    now + SETUP_TOKEN_SECONDS,
                ),
            )

        return token

    def create_owner_with_setup_token(
        self,
        username: str,
        password: str,
        setup_token: str,
        previous_token: str,
        client_address: str = "unknown",
    ) -> tuple[str, float]:
        """
        Redeem the setup token and create the owner in one transaction.

        The browser's anonymous pre-session is consumed and replaced with an
        authenticated session. The setup token is single-use.
        """
        validate_owner_credentials(username, password)

        if not isinstance(setup_token, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}",
            setup_token,
        ):
            raise SetupTokenInvalid(
                "The setup token is invalid or expired."
            )

        if not isinstance(previous_token, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}",
            previous_token,
        ):
            raise SetupTokenInvalid(
                "Your setup session expired. Reload and try again."
            )

        normalized_address = _normalize_client_address(client_address)
        setup_bucket = token_digest(
            f"clawbit-setup-source-v1:{normalized_address}"
        )

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()

            try:
                self._charge_login_bucket(
                    connection,
                    scope="setup",
                    bucket=setup_bucket,
                    now=now,
                    maximum=MAX_SETUP_ATTEMPTS_PER_SOURCE,
                )
            except LoginThrottled:
                raise SetupThrottled from None

            if connection.execute("SELECT id FROM users LIMIT 1").fetchone():
                raise OwnerAlreadyInitialized(
                    "An account already exists; owner setup is no longer available."
                )

            stored_token = connection.execute(
                """
                SELECT token_hash, expires_at
                FROM setup_tokens
                WHERE id = 1
                """
            ).fetchone()

            token_is_valid = (
                stored_token is not None
                and stored_token["expires_at"] > now
                and hmac.compare_digest(
                    stored_token["token_hash"],
                    token_digest(setup_token),
                )
            )

            if not token_is_valid:
                # Commit the failed-attempt counter before raising.
                connection.commit()
                raise SetupTokenInvalid(
                    "The setup token is invalid or expired."
                )

            previous_session = connection.execute(
                """
                SELECT owner_id
                FROM sessions
                WHERE token_hash = ? AND expires_at > ?
                """,
                (token_digest(previous_token), now),
            ).fetchone()

            if (
                previous_session is None
                or previous_session["owner_id"] is not None
            ):
                connection.commit()
                raise SetupTokenInvalid(
                    "Your setup session expired. Reload and try again."
                )

            # Password hashing happens only after the setup token is verified.
            encoded = hash_password(password)

            principal = secrets.token_hex(32)
            connection.execute(
                "INSERT INTO owner VALUES (1, ?, ?, ?)",
                (username, encoded, now),
            )
            connection.execute(
                "INSERT INTO owner_identity VALUES (1, ?)",
                (principal,),
            )
            connection.execute(
                "INSERT INTO users(id, username, email, password_hash, role, created_at) "
                "VALUES (1, ?, ?, ?, 'admin', ?)",
                (username, username.lower() if "@" in username else None, encoded, now),
            )
            connection.execute(
                "INSERT INTO user_identity(user_id, principal_id) VALUES (1, ?)",
                (principal,),
            )

            # Consume both the setup token and the browser's pre-session.
            connection.execute("DELETE FROM setup_tokens")
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (token_digest(previous_token),),
            )
            connection.execute(
                "DELETE FROM login_attempts WHERE scope = 'setup'"
            )

            return self._insert_session(connection, 1)

    def reset_account_password(
        self,
        identifier: str,
        new_password: str,
        *,
        administrator_only: bool = False,
    ) -> None:
        """Reset one account from a trusted server-side administrative workflow."""
        validate_owner_credentials("clawbit-account", new_password)
        if not isinstance(identifier, str) or not identifier.strip():
            raise OwnerSetupError("Enter the account email or username.")
        identifier = identifier.strip().casefold()
        encoded = hash_password(new_password)

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            user = connection.execute(
                "SELECT id, role FROM users WHERE username = ? COLLATE NOCASE "
                "OR email = ? COLLATE NOCASE LIMIT 1",
                (identifier, identifier),
            ).fetchone()
            if user is None or (administrator_only and user["role"] != "admin"):
                raise OwnerSetupError("The account could not be verified.")

            connection.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (encoded, user["id"]),
            )
            if int(user["id"]) == 1:
                connection.execute(
                    "UPDATE owner SET password_hash = ? WHERE id = 1",
                    (encoded,),
                )
            # Revoke only this account's sessions. Other users stay signed in.
            connection.execute(
                "DELETE FROM sessions WHERE owner_id = ?",
                (user["id"],),
            )

    def reset_owner_password(
        self,
        username: str,
        new_password: str,
    ) -> None:
        """Compatibility wrapper for resetting the existing administrator."""
        self.reset_account_password(
            username,
            new_password,
            administrator_only=True,
        )

    def has_owner(self) -> bool:
        """Return whether an administrator account has been bootstrapped."""
        with self.connection() as connection:
            return connection.execute(
                "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
            ).fetchone() is not None

    def has_users(self) -> bool:
        with self.connection() as connection:
            return connection.execute(
                "SELECT id FROM users LIMIT 1"
            ).fetchone() is not None

    def lookup(self, token: str) -> Session | None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None

        with self.connection() as connection:
            row = connection.execute(
                """
                SELECT s.token_hash, u.username, s.expires_at,
                       i.principal_id, u.id AS user_id, u.email, u.role
                FROM sessions s
                LEFT JOIN users u ON u.id = s.owner_id
                LEFT JOIN user_identity i ON i.user_id = u.id
                WHERE s.token_hash = ? AND s.expires_at > ?
                """,
                (token_digest(token), time.time()),
            ).fetchone()

        return Session(**dict(row)) if row else None

    @staticmethod
    def _insert_session(
        connection: sqlite3.Connection,
        owner_id: int | None,
    ) -> tuple[str, float]:
        token = secrets.token_urlsafe(32)
        lifetime = SESSION_SECONDS if owner_id else PRESESSION_SECONDS
        expires_at = time.time() + lifetime

        connection.execute(
            "DELETE FROM sessions WHERE expires_at <= ?",
            (time.time(),),
        )
        connection.execute(
            "INSERT INTO sessions VALUES (?, ?, ?)",
            (token_digest(token), owner_id, expires_at),
        )
        return token, expires_at

    @staticmethod
    def _charge_login_bucket(
        connection: sqlite3.Connection,
        *,
        scope: str,
        bucket: str,
        now: float,
        maximum: int,
        window_seconds: float = LOGIN_WINDOW_SECONDS,
    ) -> None:
        """Atomically charge one fixed-window budget."""
        row = connection.execute(
            """
            SELECT window_started, attempts
            FROM login_attempts
            WHERE scope = ? AND bucket = ?
            """,
            (scope, bucket),
        ).fetchone()

        if (
            row is not None
            and now - row["window_started"] < window_seconds
        ):
            if row["attempts"] >= maximum:
                raise LoginThrottled

            connection.execute(
                """
                UPDATE login_attempts
                SET attempts = attempts + 1
                WHERE scope = ? AND bucket = ?
                """,
                (scope, bucket),
            )
        else:
            connection.execute(
                """
                INSERT INTO login_attempts (
                    scope, bucket, window_started, attempts
                )
                VALUES (?, ?, ?, 1)
                ON CONFLICT(scope, bucket)
                DO UPDATE SET
                    window_started = excluded.window_started,
                    attempts = 1
                """,
                (scope, bucket, now),
            )

    def create_presession(
        self,
        client_address: str = "unknown",
    ) -> tuple[str, float]:
        """Issue a globally and per-source bounded anonymous session."""
        normalized_address = _normalize_client_address(client_address)
        source_bucket = token_digest(
            f"clawbit-presession-source-v1:{normalized_address}"
        )
        global_bucket = token_digest("clawbit-presession-global-v1")

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()

            connection.execute(
                "DELETE FROM sessions WHERE expires_at <= ?",
                (now,),
            )

            connection.execute(
                """
                DELETE FROM login_attempts
                WHERE scope IN (
                    'presession_issuance',
                    'presession_global'
                )
                  AND window_started <= ?
                """,
                (now - PRESESSION_ISSUE_WINDOW_SECONDS,),
            )

            active = connection.execute(
                """
                SELECT COUNT(*)
                FROM sessions
                WHERE owner_id IS NULL
                """
            ).fetchone()[0]

            if active >= MAX_ACTIVE_PRESESSIONS:
                raise PreSessionThrottled

            try:
                self._charge_login_bucket(
                    connection,
                    scope="presession_global",
                    bucket=global_bucket,
                    now=now,
                    maximum=MAX_GLOBAL_PRESESSION_ISSUES_PER_WINDOW,
                    window_seconds=PRESESSION_ISSUE_WINDOW_SECONDS,
                )
                self._charge_login_bucket(
                    connection,
                    scope="presession_issuance",
                    bucket=source_bucket,
                    now=now,
                    maximum=MAX_PRESESSION_ISSUES_PER_SOURCE,
                    window_seconds=PRESESSION_ISSUE_WINDOW_SECONDS,
                )
            except LoginThrottled:
                raise PreSessionThrottled from None

            return self._insert_session(connection, None)

    def login(
        self,
        username: str,
        password: str,
        previous_token: str,
        client_address: str = "unknown",
    ) -> tuple[str, float] | None:
        """Authenticate any account while preserving source/session throttles."""
        normalized_address = _normalize_client_address(client_address)
        source_bucket = token_digest(f"clawbit-login-source-v1:{normalized_address}")
        session_bucket = token_digest(previous_token)
        identifier = username.strip().casefold()

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()
            connection.execute(
                "DELETE FROM login_attempts WHERE window_started <= ?",
                (now - LOGIN_WINDOW_SECONDS,),
            )
            self._charge_login_bucket(
                connection, scope="source", bucket=source_bucket,
                now=now, maximum=MAX_SOURCE_ATTEMPTS,
            )
            self._charge_login_bucket(
                connection, scope="presession", bucket=session_bucket,
                now=now, maximum=MAX_LOGIN_ATTEMPTS,
            )

            user = connection.execute(
                "SELECT * FROM users WHERE username = ? COLLATE NOCASE "
                "OR email = ? COLLATE NOCASE LIMIT 1",
                (identifier, identifier),
            ).fetchone()
            encoded = user["password_hash"] if user else hash_password("not an account")
            valid_password = verify_password(password, encoded)
            previous = connection.execute(
                "SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (token_digest(previous_token), now),
            ).fetchone()

            if (
                user is None
                or not valid_password
                or previous is None
                or previous["owner_id"] is not None
            ):
                return None

            connection.execute(
                "DELETE FROM login_attempts WHERE (scope = 'source' AND bucket = ?) "
                "OR (scope = 'presession' AND bucket = ?)",
                (source_bucket, session_bucket),
            )
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (token_digest(previous_token),),
            )
            return self._insert_session(connection, int(user["id"]))

    def register_user(
        self,
        email: str,
        password: str,
        previous_token: str,
        client_address: str = "unknown",
    ) -> tuple[str, float]:
        """Create a public user account and atomically rotate its pre-session."""
        if not isinstance(email, str):
            raise OwnerSetupError("Enter a valid email address.")
        email = email.strip().casefold()
        if len(email) > 254 or not re.fullmatch(
            r"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+",
            email,
            re.IGNORECASE,
        ):
            raise OwnerSetupError("Enter a valid email address.")
        if not isinstance(password, str):
            raise OwnerSetupError("Enter a valid passphrase.")
        validate_owner_credentials("clawbit-account", password)
        local_part = email.split("@", 1)[0]
        if len(local_part) >= 4 and local_part in password.casefold():
            raise OwnerSetupError("Choose a passphrase unrelated to your email address.")
        if not isinstance(previous_token, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}", previous_token
        ):
            raise SetupTokenInvalid("Your signup session expired. Reload and try again.")

        normalized_address = _normalize_client_address(client_address)
        source_bucket = token_digest(f"clawbit-signup-source-v1:{normalized_address}")
        email_bucket = token_digest(f"clawbit-signup-email-v1:{email}")

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()
            connection.execute(
                "DELETE FROM login_attempts WHERE scope IN ('signup_global','signup_source','signup_email') "
                "AND window_started <= ?",
                (now - SIGNUP_WINDOW_SECONDS,),
            )
            try:
                self._charge_login_bucket(
                    connection,
                    scope="signup_global",
                    bucket=token_digest("clawbit-signup-global-v1"),
                    now=now,
                    maximum=MAX_SIGNUPS_GLOBAL_PER_HOUR,
                    window_seconds=SIGNUP_WINDOW_SECONDS,
                )
                self._charge_login_bucket(
                    connection, scope="signup_source", bucket=source_bucket,
                    now=now, maximum=MAX_SIGNUPS_PER_SOURCE,
                    window_seconds=SIGNUP_WINDOW_SECONDS,
                )
                self._charge_login_bucket(
                    connection, scope="signup_email", bucket=email_bucket,
                    now=now, maximum=MAX_SIGNUP_ATTEMPTS_PER_EMAIL,
                    window_seconds=SIGNUP_WINDOW_SECONDS,
                )
            except LoginThrottled:
                connection.commit()
                raise SignupThrottled from None

            # The deployment administrator must be bootstrapped locally before
            # public account creation is enabled. Otherwise the first visitor
            # could claim the first account without an admin role.
            administrator = connection.execute(
                "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
            ).fetchone()
            if administrator is None:
                connection.commit()
                raise AdministratorNotInitialized(
                    "The Clawbit administrator must be initialized before public registration."
                )

            previous = connection.execute(
                "SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (token_digest(previous_token), now),
            ).fetchone()
            if previous is None or previous["owner_id"] is not None:
                connection.commit()
                raise SetupTokenInvalid("Your signup session expired. Reload and try again.")

            exists = connection.execute(
                "SELECT id FROM users WHERE email = ? COLLATE NOCASE",
                (email,),
            ).fetchone()
            if exists:
                connection.commit()
                raise AccountAlreadyExists("An account with that email already exists.")

            encoded = hash_password(password)
            cursor = connection.execute(
                "INSERT INTO users(username,email,password_hash,role,created_at) "
                "VALUES(?,?,?,'user',?)",
                (email, email, encoded, now),
            )
            user_id = int(cursor.lastrowid)
            connection.execute(
                "INSERT INTO user_identity(user_id,principal_id) VALUES(?,?)",
                (user_id, secrets.token_hex(32)),
            )
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (token_digest(previous_token),),
            )
            # Retain source/global signup counters after success; otherwise a
            # visitor could reset the IP budget by creating an account each time.
            return self._insert_session(connection, user_id)

    def revoke(self, token: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (token_digest(token),),
            )
