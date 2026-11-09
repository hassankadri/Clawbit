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
        content = body.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise ValueError("Stored object exceeds the configured size limit.")
        return content
    finally:
        body.close()


def delete_object(key: str) -> None:
    _client().delete_object(Bucket=_bucket(), Key=key)
