"""Private Neon Object Storage client using its S3-compatible API."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import os

import boto3
from botocore.config import Config


class ObjectStorageConfigurationError(RuntimeError):
    pass


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ObjectStorageConfigurationError(f"{name} is not configured.")
    return value


@lru_cache(maxsize=1)
def _client():
    endpoint = _required("AWS_ENDPOINT_URL_S3")
    access_key = _required("AWS_ACCESS_KEY_ID")
    secret_key = _required("AWS_SECRET_ACCESS_KEY")
    region = os.getenv("AWS_REGION", "ap-southeast-1").strip() or "ap-southeast-1"

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=5,
            read_timeout=20,
        ),
    )


def _bucket() -> str:
    return _required("NEON_OBJECT_STORAGE_BUCKET")


def put_file(key: str, path: Path, content_type: str) -> None:
    """Upload one private object; bucket visibility is configured in Neon."""
    with path.open("rb") as source:
        _client().put_object(
            Bucket=_bucket(),
            Key=key,
            Body=source,
            ContentType=content_type,
        )


def get_bytes(key: str, *, max_bytes: int) -> bytes:
    """Download a bounded private object without returning a bucket URL."""
    response = _client().get_object(Bucket=_bucket(), Key=key)
    body = response["Body"]
    try:
        declared = response.get("ContentLength")
        if isinstance(declared, int) and declared > max_bytes:
            raise ValueError("Stored object exceeds the configured size limit.")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = body.read(min(64 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("Stored object exceeds the configured size limit.")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        body.close()


def delete_object(key: str) -> None:
    _client().delete_object(Bucket=_bucket(), Key=key)



def presign_put(
    key: str,
    *,
    content_type: str,
    expires_in: int = 300,
) -> str:
    """Create a short-lived browser PUT URL; it grants access to one object key."""
    ttl = max(60, min(int(expires_in), 600))
    return _client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": _bucket(),
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=ttl,
        HttpMethod="PUT",
    )


def head_object(key: str) -> dict:
    """Read only object metadata; never return storage credentials or URLs."""
    response = _client().head_object(Bucket=_bucket(), Key=key)
    return {
        "size": response.get("ContentLength"),
        "content_type": response.get("ContentType"),
        "etag": response.get("ETag"),
    }


def put_bytes(key: str, content: bytes, content_type: str) -> None:
    """Save validated bytes under a new immutable object key."""
    _client().put_object(
        Bucket=_bucket(),
        Key=key,
        Body=content,
        ContentLength=len(content),
        ContentType=content_type,
    )


def configure_bucket_cors(frontend_origin: str) -> None:
    """Restrict signed browser PUT/HEAD requests to the exact frontend origin."""
    from urllib.parse import urlsplit

    parsed = urlsplit(frontend_origin)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ObjectStorageConfigurationError(
            "CLAWBIT_FRONTEND_URL must be an exact HTTPS origin for bucket CORS."
        )

    _client().put_bucket_cors(
        Bucket=_bucket(),
        CORSConfiguration={
            "CORSRules": [
                {
                    "AllowedOrigins": [frontend_origin.rstrip("/")],
                    "AllowedMethods": ["PUT", "HEAD"],
                    "AllowedHeaders": ["content-type", "x-amz-*"],
                    "ExposeHeaders": ["ETag"],
                    "MaxAgeSeconds": 300,
                }
            ]
        },
    )
