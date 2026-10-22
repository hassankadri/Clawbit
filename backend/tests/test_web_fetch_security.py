from email.message import Message
import gzip
import io
import socket
import ssl
import zlib

import pytest

import web_fetch as web
from tool import read_webpage


PUBLIC = "93.184.216.34"


def answer(address):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443)


@pytest.fixture(autouse=True)
def offline_dns(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [answer(PUBLIC)])


class Response:
    def __init__(self, body=b"Readable page.", status=200, headers=None):
        self.status = status
        self.headers = Message()
        for name, value in (headers or {"Content-Type": "text/plain"}).items():
            self.headers[name] = value
        self.body = io.BytesIO(body)
        self.closed = False
        self.reads = []

    def read1(self, size):
        assert 0 < size <= web.CHUNK_BYTES
        self.reads.append(size)
        return self.body.read(size)

    def close(self):
        self.closed = True


@pytest.fixture
def transport(monkeypatch):
    responses, targets, connections = [], [], []

    class Connection:
        def __init__(self, target):
            targets.append(target)
            self.closed = False
            connections.append(self)

        def request(self, method, path, headers):
            assert method == "GET"
            assert headers["Connection"] == "close"

        def getresponse(self):
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response

        def close(self):
            self.closed = True

    monkeypatch.setattr(web, "_PinnedConnection", Connection)
    return responses, targets, connections


@pytest.mark.parametrize("url", [
    "http://localhost", "http://LOCALHOST.", "http://a.localhost", "http://metadata.google.internal",
    "http://127.0.0.1", "http://127.42.1.2", "http://10.1.2.3", "http://172.16.0.1",
    "http://192.168.1.1", "http://169.254.169.254", "http://100.64.0.1", "http://0.0.0.0",
    "http://224.0.0.1", "http://240.0.0.1", "http://255.255.255.255", "http://192.0.0.8",
    "http://192.0.2.1", "http://198.18.0.1", "http://198.51.100.1", "http://203.0.113.1",
    "http://[::1]", "http://[::]", "http://[fc00::1]", "http://[fd00::1]", "http://[fe80::1]",
    "http://[ff02::1]", "http://[fec0::1]", "http://[2001:db8::1]", "http://[3fff::1]",
    "http://[::ffff:127.0.0.1]", "http://[::ffff:169.254.169.254]",
    "http://[64:ff9b::a9fe:a9fe]", "http://[2002:7f00:1::]", "http://[2001::1]",
])
def test_nonpublic_destinations_never_reach_transport(url, transport):
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage(url)
    assert transport[1] == []


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://example.org", "gopher://example.org", "data:text/plain,hello",
    "https://user:password@example.org", "http://user@example.org", "https://example.org@127.0.0.1",
    "https://example.org:0", "http://example.org:65536", "http://example.org:-1",
    "https://example.org:", "https://example.org:abc", "http://", "example.org", "//example.org",
    " http://example.org", "http://example.org\n", "http://example.org\r\nHost:localhost",
    "http://example.org\\@localhost", "http://[::1", "http://[fe80::1%25eth0]",
    "http://%31%32%37.0.0.1", "http://example..org", "http://-bad.example", "http://exa mple.org",
    "http://example.org..", "http://[v1.example]", "http://example.org/%zz",
    "http://[2606:4700:4700::1111]unexpected/path",
    "http://[2606:4700:4700::1111]unexpected:80/path",
    "http://prefix[2606:4700:4700::1111]/path",
    "http://[2606:4700:4700::1111][ignored]/path",
])
def test_malformed_urls_rejected(url, transport):
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage(url)
    assert transport[1] == []


@pytest.mark.parametrize("addresses", [["10.0.0.1"], [PUBLIC, "10.0.0.1"], ["::1", PUBLIC], [PUBLIC, "169.254.169.254"], []])
def test_all_dns_answers_must_be_public(monkeypatch, transport, addresses):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [answer(ip) for ip in addresses])
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example")
    assert transport[1] == []


@pytest.mark.parametrize("host", ["2130706433", "127.1", "0177.0.0.1", "0x7f000001", "0x7f.0.0.1"])
def test_alternate_ip_encodings_cannot_bypass_dns_policy(monkeypatch, transport, host):
    def resolve(name, *args, **kwargs):
        assert name == host
        return [answer("127.0.0.1")]
    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("http://" + host)
    assert transport[1] == []


@pytest.mark.parametrize("location", ["http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data", "http://[::1]", "file:///private", "https://name:secret@example.org"])
def test_redirect_destinations_revalidated(transport, location):
    redirect = Response(status=302, headers={"Location": location})
    transport[0].append(redirect)
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example")
    assert len(transport[1]) == 1 and redirect.closed
    assert all(connection.closed for connection in transport[2])


def test_redirect_to_hostname_with_private_dns(monkeypatch, transport):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, *a, **k: [answer(PUBLIC if host == "public.example" else "10.0.0.1")])
    transport[0].append(Response(status=302, headers={"Location": "https://rebound.example"}))
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example")
    assert len(transport[1]) == 1


def test_redirect_loop_stops(transport):
    transport[0].append(Response(status=302, headers={"Location": "/"}))
    with pytest.raises(web.WebFetchError, match="loop"):
        web.fetch_webpage("https://public.example")
    assert len(transport[1]) == 1


@pytest.mark.parametrize("count,success", [(3, True), (4, False)])
def test_redirect_count_limit(transport, count, success):
    transport[0].extend(Response(status=302, headers={"Location": f"/{index}"}) for index in range(count))
    transport[0].append(Response())
    if success:
        assert "Readable page" in web.fetch_webpage("https://public.example/start")
    else:
        with pytest.raises(web.WebFetchError, match="redirects"):
            web.fetch_webpage("https://public.example/start")
    assert len(transport[1]) == 4


@pytest.mark.parametrize("content_type,body,expected", [
    ("text/html; charset=utf-8", b'<html><head><style>hidden CSS</style></head><body><h1>Heading</h1><p>Price &amp; value: <b>42</b>.</p><script>stealSecrets()</script><nav>menu</nav><!--comment--></body></html>', "Heading\nPrice & value:"),
    ("text/plain", b"Line one\n  indentation & punctuation < >", "Line one\n  indentation & punctuation < >"),
    ("text/plain; charset=iso-8859-1", b"caf\xe9", "café"),
])
def test_readable_html_and_text(transport, content_type, body, expected):
    response = Response(body, headers={"Content-Type": content_type})
    transport[0].append(response)
    result = web.fetch_webpage("https://public.example/article")
    assert expected in result
    assert "Source: https://public.example/article" in result
    assert "stealSecrets" not in result and "hidden CSS" not in result and "menu" not in result
    assert response.closed and transport[2][0].closed


@pytest.mark.parametrize("content_type", ["application/json", "application/pdf", "image/png", "application/octet-stream", ""])
def test_nontext_rejected_before_read(transport, content_type):
    response = Response(headers={"Content-Type": content_type})
    transport[0].append(response)
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example")
    assert response.reads == [] and response.closed


@pytest.mark.parametrize("declared", [False, True])
def test_wire_limit(transport, declared):
    headers = {"Content-Type": "text/plain"}
    if declared:
        headers["Content-Length"] = str(web.MAX_BYTES + 1)
    response = Response(b"x" * (web.MAX_BYTES + 1), headers=headers)
    transport[0].append(response)
    with pytest.raises(web.WebFetchError, match="1 MiB"):
        web.fetch_webpage("https://public.example")
    assert response.closed and transport[2][0].closed
    assert response.body.tell() <= web.MAX_BYTES + 1


@pytest.mark.parametrize("encoding,compress", [("gzip", gzip.compress), ("deflate", zlib.compress)])
@pytest.mark.parametrize("size,allowed", [(30, True), (web.MAX_BYTES, True), (web.MAX_BYTES + 1, False)])
def test_compressed_content_is_bounded(transport, encoding, compress, size, allowed):
    data = compress(b"x" * size)
    response = Response(data, headers={"Content-Type": "text/plain", "Content-Encoding": encoding, "Content-Length": str(len(data))})
    transport[0].append(response)
    if allowed:
        assert "x" * min(size, 5000) in web.fetch_webpage("https://public.example")
    else:
        with pytest.raises(web.WebFetchError, match="1 MiB"):
            web.fetch_webpage("https://public.example")
    assert response.closed


@pytest.mark.parametrize("encoding,data", [("gzip", b"bad gzip"), ("gzip", gzip.compress(b"hello")[:-3]),
                                         ("gzip", gzip.compress(b"a") + gzip.compress(b"b")), ("br", b"unsupported")])
def test_malformed_or_unsupported_compression_fails_closed(transport, encoding, data):
    transport[0].append(Response(data, headers={"Content-Type": "text/plain", "Content-Encoding": encoding}))
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example")


@pytest.mark.parametrize("failure", [TimeoutError("internal.private secret-token"), OSError("10.1.1.1 Authorization: secret-token"), ssl.SSLCertVerificationError("private cert")])
def test_network_failures_return_safe_errors(transport, failure):
    transport[0].append(failure)
    result = read_webpage.invoke({"url": "https://public.example"})
    assert result.startswith("Could not read webpage:")
    assert "secret-token" not in result and "10.1.1.1" not in result and "private" not in result
    assert transport[2][0].closed


@pytest.mark.parametrize("tls", [False, True])
def test_pinned_socket_prevents_rebinding_and_ignores_proxies(monkeypatch, tls):
    dns, sockets, tls_names = [], [], []
    def resolve(host, *args, **kwargs):
        dns.append(host)
        return [answer(PUBLIC if len(dns) == 1 else "127.0.0.1")]
    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:8888")

    class Socket:
        def __init__(self, family, kind, proto):
            assert family == socket.AF_INET
            self.timeouts, self.sent = [], b""
            self.closed = False
            sockets.append(self)
        def settimeout(self, value):
            self.timeouts.append(value)
        def connect(self, endpoint):
            self.endpoint = endpoint
        def sendall(self, value):
            self.sent += value
        def makefile(self, *args):
            return io.BytesIO(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello")
        def close(self):
            self.closed = True

    context = ssl.create_default_context()
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    def wrap(sock, server_hostname):
        assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
        tls_names.append(server_hostname)
        return sock
    monkeypatch.setattr(context, "wrap_socket", wrap)
    monkeypatch.setattr(ssl, "create_default_context", lambda: context)
    monkeypatch.setattr(socket, "socket", Socket)
    scheme = "https" if tls else "http"
    assert "hello" in web.fetch_webpage(f"{scheme}://public.example/path?q=value")
    assert dns == ["public.example"]
    assert sockets[0].endpoint == (PUBLIC, 443 if tls else 80)
    assert b"Host: public.example\r\n" in sockets[0].sent
    assert b"GET /path?q=value HTTP/1.1" in sockets[0].sent
    assert b"Proxy-Authorization" not in sockets[0].sent
    assert sockets[0].timeouts == [web.CONNECT_TIMEOUT, web.READ_TIMEOUT]
    assert sockets[0].closed
    assert tls_names == (["public.example"] if tls else [])


def test_ipv6_connection_uses_validated_numeric_sockaddr(monkeypatch):
    address = "2606:4700:4700::1111"
    target = web.validate_target(f"http://[{address}]:8080/path")
    connected = []
    class Socket:
        def __init__(self, family, *args):
            assert family == socket.AF_INET6
        def settimeout(self, value):
            pass
        def connect(self, endpoint):
            connected.append(endpoint)
        def close(self):
            pass
    monkeypatch.setattr(socket, "socket", Socket)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: pytest.fail("Second DNS lookup"))
    connection = web._PinnedConnection(target)
    connection.connect()
    connection.close()
    assert connected == [(address, 8080, 0, 0)]


def test_tls_certificate_failure_closes_socket_without_retry(monkeypatch):
    closed, connected = [], []
    class Socket:
        def __init__(self, *args):
            pass
        def settimeout(self, value):
            pass
        def connect(self, endpoint):
            connected.append(endpoint)
        def close(self):
            closed.append(True)
    context = ssl.create_default_context()
    def reject(sock, server_hostname):
        assert server_hostname == "public.example"
        assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
        raise ssl.SSLCertVerificationError("certificate for internal-host secret")
    monkeypatch.setattr(context, "wrap_socket", reject)
    monkeypatch.setattr(ssl, "create_default_context", lambda: context)
    monkeypatch.setattr(socket, "socket", Socket)
    result = read_webpage.invoke({"url": "https://public.example"})
    assert "could not be read securely" in result
    assert "internal-host" not in result and "secret" not in result
    assert connected == [(PUBLIC, 443)] and closed == [True]


def test_body_deadline_closes_resources(monkeypatch, transport):
    response = Response(b"hello")
    transport[0].append(response)
    times = iter([0, web.BODY_TIMEOUT + 1])
    monkeypatch.setattr(web.time, "monotonic", lambda: next(times))
    with pytest.raises(web.WebFetchError, match="too long"):
        web.fetch_webpage("https://public.example")
    assert response.closed and transport[2][0].closed


def test_partial_body_read_error_closes_resources(transport, monkeypatch):
    response = Response(b"hello")
    transport[0].append(response)
    def fail(size):
        raise OSError("private upstream address and token")
    monkeypatch.setattr(response, "read1", fail)
    result = read_webpage.invoke({"url": "https://public.example"})
    assert "could not be read securely" in result
    assert "private" not in result and "token" not in result
    assert response.closed and transport[2][0].closed


@pytest.mark.parametrize("headers,body", [
    ({"Content-Length": "20"}, b"short"),
    ({"Content-Length": "-1"}, b""),
    ({"Transfer-Encoding": "gzip"}, b""),
    ({"Transfer-Encoding": "chunked", "Content-Length": "0"}, b""),
])
def test_ambiguous_or_truncated_responses_are_rejected(transport, headers, body):
    transport[0].append(Response(body, headers={"Content-Type": "text/plain", **headers}))
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example")


def test_redirect_revalidates_even_the_same_hostname(monkeypatch, transport):
    resolutions = iter([PUBLIC, "127.0.0.1"])
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [answer(next(resolutions))])
    transport[0].append(Response(status=302, headers={"Location": "/second"}))
    with pytest.raises(web.WebFetchError):
        web.fetch_webpage("https://public.example/first")
    assert len(transport[1]) == 1
