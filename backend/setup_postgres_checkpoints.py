"""Run the one-time LangGraph PostgreSQL checkpoint migrations.

Use DATABASE_DIRECT_URL for the Neon direct endpoint. Runtime requests should
use DATABASE_URL with Neon connection pooling enabled.
"""

import asyncio
import os
import sys

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from owned_postgres_checkpoints import OwnedPostgresSaver


def _required_dsn() -> str:
    dsn = os.getenv("DATABASE_DIRECT_URL", "").strip()

    if not dsn:
        raise RuntimeError(
            "Set DATABASE_DIRECT_URL to the direct Neon PostgreSQL connection "
            "string before running checkpoint setup."
        )

    if not dsn.startswith(("postgres://", "postgresql://")):
        raise RuntimeError("DATABASE_DIRECT_URL must be a PostgreSQL URL.")

    return dsn


async def setup() -> None:
    dsn = _required_dsn()

    # The official checkpointer requires autocommit and dict rows for setup
    # and normal operations. prepare_threshold=0 matches its documented setup.
    connection = await AsyncConnection.connect(
        dsn,
        autocommit=True,
        prepare_threshold=0,
        row_factory=dict_row,
    )

    try:
        saver = OwnedPostgresSaver(connection)
        await saver.setup()
    finally:
        await connection.close()


def main() -> int:
    try:
        asyncio.run(setup())
    except Exception as exc:
        # Avoid logging a connection URL or credentials from driver exceptions.
        print(f"PostgreSQL checkpoint setup failed: {type(exc).__name__}", file=sys.stderr)
        return 1

    print("PostgreSQL checkpoint schema is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
