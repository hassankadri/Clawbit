"""Offline, auditable legacy ownership claims. Dry runs never initialize stores."""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time
from uuid import uuid4


DATABASES = (
    "data/auth.sqlite3", "data/chatbot_memory.db",
    "data/langgraph_checkpoints.sqlite", "data/ownership.sqlite3",
    "chroma_db/chroma.sqlite3",
)


def _read_database(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def inventory(root: Path) -> set[tuple[str, str]]:
    """Read identifiers only; do not deserialize checkpoints or load providers."""
    resources: set[tuple[str, str]] = set()
    for relative in DATABASES:
        path = root / relative
        if not path.exists() or relative in ("data/auth.sqlite3", "data/ownership.sqlite3"):
            continue
        with closing(_read_database(path)) as connection:
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )}
            for table in ("conversations", "chat_messages", "long_term_memory",
                          "workspaces", "checkpoints", "writes"):
                if table not in tables:
                    continue
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
                fields = [("thread", "thread_id"), ("workspace", "workspace_id")]
                if table == "workspaces":
                    fields = [("workspace", "id")]
                for kind, column in fields:
                    if column in columns:
                        query = (
                            f'SELECT DISTINCT "{column}" FROM "{table}" '
                            f"WHERE \"{column}\" IS NOT NULL AND \"{column}\" != ''"
                        )
                        resources.update(
                            (kind, row[0]) for row in connection.execute(query)
                        )
            if "embedding_metadata" in tables:
                resources.update(("thread", row[0]) for row in connection.execute(
                    "SELECT DISTINCT string_value FROM embedding_metadata "
                    "WHERE key = 'thread_id' AND string_value IS NOT NULL"
                ))
    uploads = root / "uploads"
    if uploads.exists():
        for directory in uploads.iterdir():
            if directory.is_symlink() or directory.is_junction():
                raise RuntimeError("Resolve upload directory links before migration.")
            if directory.is_dir():
                resources.add(("thread", directory.name))
    return resources


def backup_runtime(root: Path) -> Path:
    """Back up SQLite through its API (including WAL), plus upload metadata."""
    destination = root / "data" / "ownership-backups" / uuid4().hex
    destination.mkdir(parents=True)
    for relative in DATABASES:
        source = root / relative
        if source.exists():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with closing(_read_database(source)) as database:
                with closing(sqlite3.connect(target)) as backup:
                    database.backup(backup)
    uploads = root / "uploads"
    if uploads.exists():
        for directory in uploads.iterdir():
            if directory.is_symlink() or directory.is_junction():
                raise RuntimeError("Resolve upload directory links before migration.")
            if not directory.is_dir():
                continue
            for name in ("manifest.json", ".pending.json"):
                source = directory / name
                if source.is_symlink():
                    raise RuntimeError("Resolve metadata links before migration.")
                if source.exists():
                    target = destination / source.relative_to(root)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
    return destination


def claim_legacy(root: Path, username: str) -> dict:
    """Claim only unassigned resources for the explicitly named initialized owner."""
    from auth_store import AuthStore
    from ownership import OwnershipStore

    # Validate the target without touching a schema or revealing credentials.
    with closing(_read_database(root / "data" / "auth.sqlite3")) as connection:
        row = connection.execute("SELECT username FROM owner WHERE id = 1").fetchone()
    if row is None or row[0] != username:
        raise ValueError("The target must be the initialized local owner.")
    backup = backup_runtime(root)
    auth = AuthStore(root / "data" / "auth.sqlite3")
    with auth.connection() as connection:
        principal = connection.execute(
            "SELECT principal_id FROM owner_identity WHERE owner_id = 1"
        ).fetchone()[0]
    registry = OwnershipStore(root)
    with registry.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        count = connection.execute(
            "SELECT COUNT(*) FROM resources WHERE principal_id IS NULL"
        ).fetchone()[0]
        claim_id = uuid4().hex
        connection.execute(
            "INSERT INTO claim_resources SELECT ?, kind, resource_id FROM resources "
            "WHERE principal_id IS NULL", (claim_id,)
        )
        connection.execute(
            "UPDATE resources SET principal_id = ? WHERE principal_id IS NULL", (principal,)
        )
        connection.execute(
            "INSERT INTO claims VALUES (?, ?, ?, ?, ?)",
            (claim_id, principal, time.time(), count, str(backup)),
        )
    result = {"claim_id": claim_id, "resource_count": count, "backup": str(backup)}
    (backup / "claim.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def rollback_claim(root: Path, claim_id: str) -> dict:
    """Re-quarantine one claim without deleting payloads or unrelated ownership."""
    from ownership import OwnershipStore

    registry = OwnershipStore(root)
    backup = backup_runtime(root)
    with registry.connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT principal_id FROM claims WHERE claim_id = ?", (claim_id,)
        ).fetchone()
        if row is None:
            raise ValueError("Unknown ownership claim.")
        if connection.execute(
            "SELECT 1 FROM rollbacks WHERE claim_id = ?", (claim_id,)
        ).fetchone():
            return {"rolled_back": 0, "backup": str(backup)}
        count = connection.execute(
            "UPDATE resources SET principal_id = NULL WHERE principal_id = ? "
            "AND (kind, resource_id) IN "
            "(SELECT kind, resource_id FROM claim_resources WHERE claim_id = ?)",
            (row[0], claim_id),
        ).rowcount
        connection.execute(
            "INSERT INTO rollbacks VALUES (?, ?, ?)", (claim_id, time.time(), str(backup))
        )
    return {"rolled_back": count, "backup": str(backup)}


def main() -> None:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path,
        default=Path(os.getenv("CLAWBIT_RUNTIME_DIR", Path(__file__).resolve().parent)),
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--claim-owner", help="Explicit initialized username; default is dry run")
    action.add_argument("--rollback-claim", help="Audited claim ID to return to unclaimed state")
    arguments = parser.parse_args()
    root = arguments.root.resolve()
    if arguments.claim_owner:
        print("Stop all backend workers before claiming legacy data.")
        expected = f"CLAIM {arguments.claim_owner}"
        if input(f"Type {expected} to confirm: ") != expected:
            raise SystemExit("Claim cancelled.")
        print(json.dumps(claim_legacy(root, arguments.claim_owner), indent=2))
    elif arguments.rollback_claim:
        print("Stop all backend workers before rolling back ownership.")
        if input("Type ROLLBACK to confirm: ") != "ROLLBACK":
            raise SystemExit("Rollback cancelled.")
        print(json.dumps(rollback_claim(root, arguments.rollback_claim), indent=2))
    else:
        resources = inventory(root)
        print(json.dumps({
            "dry_run": True,
            "threads": sum(kind == "thread" for kind, _ in resources),
            "workspaces": sum(kind == "workspace" for kind, _ in resources),
            "data_modified": False,
        }, indent=2))


if __name__ == "__main__":
    main()
