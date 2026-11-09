"""Provision the initial Clawbit auth and ownership schema in Neon.

Run once with DATABASE_DIRECT_URL before enabling PostgreSQL persistence.
This command creates missing tables and indexes; it does not truncate data.
"""

import os
import sys

import psycopg

from postgres_schema import SCHEMA_STATEMENTS


def main() -> int:
    dsn = os.getenv("DATABASE_DIRECT_URL", "").strip()
    if not dsn or not dsn.startswith(("postgres://", "postgresql://")):
        print("Set DATABASE_DIRECT_URL to a direct Neon PostgreSQL URL.", file=sys.stderr)
        return 1

    try:
        with psycopg.connect(
            dsn,
            autocommit=True,
            prepare_threshold=None,
        ) as connection:
            for statement in SCHEMA_STATEMENTS:
                connection.execute(statement)
    except Exception as exc:
        # Never log a DSN or a database error that might contain connection details.
        print(f"PostgreSQL schema setup failed: {type(exc).__name__}", file=sys.stderr)
        return 1

    print("Clawbit auth and ownership tables are ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
