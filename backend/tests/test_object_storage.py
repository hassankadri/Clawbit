""""Offline tests for private S3-compatible object storage."""

import io

import pytest

import object_storage


class FakeS3:
    def __init__(self, payload=b"stored-bytes"):
        self.payload = payload
        self.puts = []
        self.deletes = []
        self.gets = []
        self.presigned = []
        self.cors = []

    def generate_presigned_url(self, operation, **kwargs):
        self.presigned.append((operation, kwargs))
        return "https://storage.example.invalid/signed-upload"

    def put_bucket_cors(self, **kwargs):
        self.cors.append(kwargs)

    def head_object(self, **kwargs):
        return {"ContentLength": 15, "ContentType": "application/pdf", "ETag": '"test"'}

    def put_object(self, **kwargs):
        kwargs["Body"] = kwargs["Body"].read()
        self.puts.append(kwargs)
    def get_object(self, **kwargs):
        self.gets.append(kwargs)
        return {"Body": io.BytesIO(self.payload), "ContentLength": len(self.payload)}

    def delete_object(self, **kwargs):
        self.deletes.append(kwargs)


def configure(monkeypatch, tmp_path):
    monkeypatch.setenv("AWS_ENDPOINT_URL_S3", "https://storage.example.invalid")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test-access-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test-secret-key")
    monkeypatch.setenv("AWS_REGION", "ap-southeast-1")
    monkeypatch.setenv("NEON_OBJECT_STORAGE_BUCKET", "clawbit-private")
    client = FakeS3()
    options = {}

    def factory(*args, **kwargs):
        options.update(kwargs)
        return client

    monkeypatch.setattr(object_storage.boto3, "client", factory)
    object_storage._client.cache_clear()
    return client, options


def test_private_client_uses_neon_endpoint_and_path_style(monkeypatch, tmp_path):
    _, options = configure(monkeypatch, tmp_path)
    client = object_storage._client()

    assert client is not None
    assert options["endpoint_url"] == "https://storage.example.invalid"
    assert options["region_name"] == "ap-southeast-1"
    assert options["config"].s3["addressing_style"] == "path"


def test_put_file_sends_private_bucket_key_and_content_type(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf-data")

    object_storage.put_file("uploads/random-key.pdf", source, "application/pdf")

    request = client.puts[0]
    assert request["Bucket"] == "clawbit-private"
    assert request["Key"] == "uploads/random-key.pdf"
    assert request["ContentType"] == "application/pdf"
    assert request["Body"] == b"pdf-data"


def test_get_bytes_enforces_declared_and_actual_limits(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)
    assert object_storage.get_bytes("uploads/object", max_bytes=100) == b"stored-bytes"

    with pytest.raises(ValueError, match="size limit"):
        object_storage.get_bytes("uploads/object", max_bytes=3)

    assert all(call["Bucket"] == "clawbit-private" for call in client.gets)


def test_delete_object_never_returns_a_public_url(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)
    result = object_storage.delete_object("uploads/delete-me")

    assert result is None
    assert client.deletes == [{
        "Bucket": "clawbit-private",
        "Key": "uploads/delete-me",
    }]


def test_missing_object_storage_configuration_fails_closed(monkeypatch):
    monkeypatch.delenv("AWS_ENDPOINT_URL_S3", raising=False)
    object_storage._client.cache_clear()

    with pytest.raises(object_storage.ObjectStorageConfigurationError):
        object_storage._client()



def test_presigned_put_is_bound_to_one_object_and_content_type(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)

    url = object_storage.presign_put(
        "pending-uploads/random.pdf",
        content_type="application/pdf",
        expires_in=300,
    )

    assert url.startswith("https://")
    operation, kwargs = client.presigned[0]
    assert operation == "put_object"
    assert kwargs["Params"] == {
        "Bucket": "clawbit-private",
        "Key": "pending-uploads/random.pdf",
        "ContentType": "application/pdf",
    }
    assert kwargs["ExpiresIn"] == 300
    assert kwargs["HttpMethod"] == "PUT"


def test_presigned_put_expiry_is_clamped(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)
    object_storage.presign_put(
        "pending-uploads/key.bin",
        content_type="application/octet-stream",
        expires_in=999999,
    )
    assert client.presigned[0][1]["ExpiresIn"] == 600


def test_head_object_returns_only_bounded_metadata(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)
    info = object_storage.head_object("pending-uploads/key.pdf")
    assert info == {
        "size": 15,
        "content_type": "application/pdf",
        "etag": '"test"',
    }
    assert client.gets == []


def test_bucket_cors_allows_only_exact_https_frontend_origin(monkeypatch, tmp_path):
    client, _ = configure(monkeypatch, tmp_path)
    object_storage.configure_bucket_cors("https://clawbit.example")

    rule = client.cors[0]["CORSConfiguration"]["CORSRules"][0]
    assert rule["AllowedOrigins"] == ["https://clawbit.example"]
    assert rule["AllowedMethods"] == ["PUT", "HEAD"]
    assert rule["AllowedHeaders"] == ["content-type", "x-amz-*"]
    assert rule["MaxAgeSeconds"] == 300


@pytest.mark.parametrize(
    "origin",
    [
        "http://clawbit.example",
        "https://clawbit.example/path",
        "https://clawbit.example?x=1",
        "https://user:pass@clawbit.example",
        "*",
    ],
)
def test_bucket_cors_rejects_untrusted_origin(monkeypatch, tmp_path, origin):
    client, _ = configure(monkeypatch, tmp_path)
    with pytest.raises(object_storage.ObjectStorageConfigurationError):
        object_storage.configure_bucket_cors(origin)
    assert client.cors == []
