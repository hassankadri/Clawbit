"""PostgreSQL metadata for private Neon Object Storage uploads."""

from __future__ import annotations

import time
import time
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



def thread_for_object(object_key: str) -> str:
    """Resolve a private object key only inside the current principal's scope."""
    principal = current_owner()
    with postgres_connection() as db:
        row = db.execute(
            """
            SELECT thread_id
            FROM upload_attachments
            WHERE principal=? AND object_key=?
            """,
            (principal, object_key),
        ).fetchone()
    if row is None:
        from ownership import OwnershipError

        raise OwnershipError()
    require_thread(row["thread_id"])
    return row["thread_id"]



def create_upload_intent(
    thread_id: str,
    *,
    attachment_id: str,
    staging_key: str,
    name: str,
    suffix: str,
    mime_type: str,
    kind: str,
    expected_size: int,
    expires_at: float,
    max_attachments: int,
) -> dict:
    """Reserve one owner-scoped attachment before issuing a signed upload URL."""
    principal = current_owner()
    require_thread(thread_id)

    with postgres_connection() as db:
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
            (f"clawbit:uploads:{principal}:{thread_id}",),
        )
        committed = db.execute(
            "SELECT COUNT(*) FROM upload_attachments WHERE principal=? AND thread_id=?",
            (principal, thread_id),
        ).fetchone()[0]
        pending = db.execute(
            """
            SELECT COUNT(*) FROM upload_intents
            WHERE principal=? AND thread_id=? AND expires_at>?
            """,
            (principal, thread_id, time.time()),
        ).fetchone()[0]
        if committed + pending >= max_attachments:
            from upload_security import UploadError

            raise UploadError(
                f"A thread may contain at most {max_attachments} attachments.",
                409,
            )

        db.execute(
            """
            INSERT INTO upload_intents
                (attachment_id,principal,thread_id,staging_key,final_key,name,
                 suffix,mime_type,kind,expected_size,created_at,expires_at)
            VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?)
            """,
            (
                attachment_id,
                principal,
                thread_id,
                staging_key,
                name,
                suffix,
                mime_type,
                kind,
                expected_size,
                time.time(),
                expires_at,
            ),
        )

    return {
        "attachment_id": attachment_id,
        "thread_id": thread_id,
        "staging_key": staging_key,
        "name": name,
        "suffix": suffix,
        "mime_type": mime_type,
        "kind": kind,
        "expected_size": expected_size,
        "expires_at": expires_at,
    }


def get_upload_intent(thread_id: str, attachment_id: str) -> dict | None:
    principal = current_owner()
    require_thread(thread_id)

    with postgres_connection() as db:
        row = db.execute(
            """
            SELECT attachment_id,thread_id,staging_key,final_key,name,suffix,
                   mime_type,kind,expected_size,created_at,expires_at
            FROM upload_intents
            WHERE principal=? AND thread_id=? AND attachment_id=? AND expires_at>?
            """,
            (principal, thread_id, attachment_id, time.time()),
        ).fetchone()

    return dict(row) if row else None


def set_upload_intent_final_key(
    thread_id: str,
    attachment_id: str,
    final_key: str,
) -> None:
    principal = current_owner()
    require_thread(thread_id)

    with postgres_connection() as db:
        row = db.execute(
            """
            UPDATE upload_intents
            SET final_key=?
            WHERE principal=? AND thread_id=? AND attachment_id=? AND expires_at>?
            RETURNING attachment_id
            """,
            (final_key, principal, thread_id, attachment_id, time.time()),
        ).fetchone()

    if row is None:
        raise OwnershipError()


def commit_upload_intent(
    thread_id: str,
    attachment_id: str,
    record: dict,
) -> dict:
    """Publish the manifest row and delete its intent in one transaction."""
    principal = current_owner()
    require_thread(thread_id)
    object_key = record.get("object_key") or record.get("path")

    with postgres_connection() as db:
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
            (f"clawbit:uploads:{principal}:{thread_id}",),
        )
        existing = db.execute(
            """
            SELECT attachment_id,name,kind,mime_type,size,object_key,source,
                   preview,rag_error,created_at
            FROM upload_attachments
            WHERE principal=? AND thread_id=? AND attachment_id=?
            """,
            (principal, thread_id, attachment_id),
        ).fetchone()
        if existing is not None:
            if existing["object_key"] != object_key:
                raise OwnershipError()
            db.execute(
                """
                DELETE FROM upload_intents
                WHERE principal=? AND thread_id=? AND attachment_id=?
                """,
                (principal, thread_id, attachment_id),
            )
            return {
                **dict(existing),
                "path": existing["object_key"],
                "object_key": existing["object_key"],
                "thread_id": thread_id,
            }

        intent = db.execute(
            """
            SELECT final_key,expected_size,name,suffix,mime_type,kind
            FROM upload_intents
            WHERE principal=? AND thread_id=? AND attachment_id=? AND expires_at>?
            """,
            (principal, thread_id, attachment_id, time.time()),
        ).fetchone()
        if (
            intent is None
            or intent["final_key"] != object_key
            or int(record.get("size") or 0) != int(intent["expected_size"])
            or record.get("name") != intent["name"]
            or record.get("mime_type") != intent["mime_type"]
            or record.get("kind") != intent["kind"]
        ):
            raise OwnershipError()

        db.execute(
            """
            INSERT INTO upload_attachments
                (principal,thread_id,attachment_id,name,kind,mime_type,size,
                 object_key,source,preview,rag_error,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
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
            ),
        )
        db.execute(
            """
            DELETE FROM upload_intents
            WHERE principal=? AND thread_id=? AND attachment_id=?
            """,
            (principal, thread_id, attachment_id),
        )

    return {**record, "path": object_key, "object_key": object_key, "thread_id": thread_id}


def list_expired_upload_intents(limit: int = 100) -> list[dict]:
    principal = current_owner()
    now = time.time()
    safe_limit = max(1, min(int(limit), 100))

    with postgres_connection() as db:
        rows = db.execute(
            """
            SELECT attachment_id,thread_id,staging_key,final_key
            FROM upload_intents
            WHERE principal=? AND expires_at<=?
            ORDER BY expires_at
            LIMIT ?
            """,
            (principal, now, safe_limit),
        ).fetchall()

    return [dict(row) for row in rows]


def delete_upload_intent(
    thread_id: str,
    attachment_id: str,
    *,
    expired_only: bool = False,
) -> bool:
    principal = current_owner()
    require_thread(thread_id)

    sql = """
        DELETE FROM upload_intents
        WHERE principal=? AND thread_id=? AND attachment_id=?
    """
    params: tuple = (principal, thread_id, attachment_id)
    if expired_only:
        sql += " AND expires_at<=?"
        params += (time.time(),)

    with postgres_connection() as db:
        row = db.execute(sql + " RETURNING attachment_id", params).fetchone()

    return row is not None
