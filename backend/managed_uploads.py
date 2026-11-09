"""PostgreSQL metadata for private Neon Object Storage uploads."""

from __future__ import annotations

from ownership import current_owner, require_thread
from postgres_db import postgres_connection


def load_manifest(thread_id: str) -> list[dict]:
    principal = current_owner()
    require_thread(thread_id, missing_ok=True)

    with postgres_connection() as db:
        rows = db.execute(
            """
            SELECT attachment_id,name,kind,mime_type,size,object_key,source,
                   preview,rag_error,created_at
            FROM upload_attachments
            WHERE principal=? AND thread_id=?
            ORDER BY created_at,attachment_id
            """,
            (principal, thread_id),
        ).fetchall()

    records = []
    for row in rows:
        object_key = row["object_key"]
        records.append({
            "attachment_id": row["attachment_id"],
            "name": row["name"],
            "kind": row["kind"],
            "mime_type": row["mime_type"],
            "size": row["size"],
            # Preserve the legacy path field for response compatibility.
            # Its value is an opaque object key, never a filesystem path.
            "path": object_key,
            "object_key": object_key,
            "source": row["source"],
            "preview": row["preview"],
            "rag_error": row["rag_error"],
            "thread_id": thread_id,
            "created_at": row["created_at"],
        })
    return records


def save_manifest(thread_id: str, records: list[dict]) -> None:
    """Replace one owner's thread manifest inside a single DB transaction."""
    principal = current_owner()
    require_thread(thread_id)

    rows = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Invalid attachment record.")
        attachment_id = record.get("attachment_id")
        object_key = record.get("object_key") or record.get("path")
        if not isinstance(attachment_id, str) or not isinstance(object_key, str):
            raise ValueError("Attachment metadata is incomplete.")
        rows.append((
            principal,
            thread_id,
            attachment_id,
            str(record.get("name") or "uploaded file"),
            str(record.get("kind") or "file"),
            str(record.get("mime_type") or "application/octet-stream"),
            int(record.get("size") or 0),
            object_key,
            str(record.get("source") or ""),
            record.get("preview"),
            record.get("rag_error"),
            float(record.get("created_at") or 0),
        ))

    with postgres_connection() as db:
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
            (f"clawbit:uploads:{principal}:{thread_id}",),
        )
        db.execute(
            "DELETE FROM upload_attachments WHERE principal=? AND thread_id=?",
            (principal, thread_id),
        )
        if rows:
            db.executemany(
                """
                INSERT INTO upload_attachments
                    (principal,thread_id,attachment_id,name,kind,mime_type,size,
                     object_key,source,preview,rag_error,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                rows,
            )


def delete_attachment_record(thread_id: str, attachment_id: str) -> dict | None:
    principal = current_owner()
    require_thread(thread_id)

    with postgres_connection() as db:
        row = db.execute(
            """
            DELETE FROM upload_attachments
            WHERE principal=? AND thread_id=? AND attachment_id=?
            RETURNING object_key
            """,
            (principal, thread_id, attachment_id),
        ).fetchone()

    return {"object_key": row["object_key"]} if row else None
