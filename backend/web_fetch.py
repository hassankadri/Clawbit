"""Bounded public-web reader. No proxies, automatic redirects or second DNS lookup."""
from dataclasses import dataclass
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
import zlib

from bs4 import BeautifulSoup

MAX_BYTES = 1024 * 1024
MAX_REDIRECTS = 3
CONNECT_TIMEOUT = 5
READ_TIMEOUT = 5
BODY_TIMEOUT = 20
CHUNK_BYTES = 64 * 1024


class WebFetchError(ValueError):
    """Messages are fixed public errors, never transport exception text."""


@dataclass(frozen=True)
class Target:
    url: str
    host: str
    port: int
    tls: bool
    path: str
    family: int
    address: str


def _public_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if (not address.is_global or address.is_private or address.is_reserved
            or address.is_multicast or address.is_loopback or address.is_link_local
            or address.is_unspecified):
        return False
    # Fail closed for special/transition ranges whose classification varies with
    # Python's bundled registry, including IPv4-embedded/NAT64 destinations.
    if address.version == 4:
        return address not in ipaddress.ip_network("192.0.0.0/24")
    return (address in ipaddress.ip_network("2000::/3")
            and address not in ipaddress.ip_network("2001::/23")
            and address not in ipaddress.ip_network("2002::/16")
            and address not in ipaddress.ip_network("3fff::/20"))


def validate_target(url: str) -> Target:
    invalid = "Use a valid public HTTP or HTTPS URL without credentials."
    if (not isinstance(url, str) or not url or len(url) > 8192
            or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in url)
            or "\\" in url or re.search(r"%(?![0-9a-fA-F]{2})", url)):
        raise WebFetchError(invalid)
    try:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.netloc or "@" in parts.netloc:
            raise ValueError
        # urlsplit accepts stray text before/after a bracketed IPv6 literal.
        # Validate the entire authority instead of silently dropping that text.
        if ("[" in parts.netloc or "]" in parts.netloc) and not re.fullmatch(
                r"\[[^\[\]]+\](?::[0-9]+)?", parts.netloc):
            raise ValueError
        host = parts.hostname
        if not host or "%" in host or parts.netloc.endswith(":"):
            raise ValueError
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if parts.port == 0:
            raise ValueError
        host = host.encode("idna").decode("ascii").lower().removesuffix(".")
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
            if (len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                      for label in host.split("."))):
                raise ValueError
        if parts.netloc.startswith("[") and (literal is None or literal.version != 6):
            raise ValueError
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home.arpa", ".invalid", ".test")):
            raise WebFetchError("Only public internet destinations can be read.")
        if literal is not None:
            if not _public_address(host):
                raise WebFetchError("Only public internet destinations can be read.")
            addresses = [(socket.AF_INET if literal.version == 4 else socket.AF_INET6, str(literal))]
        else:
            answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
            if not answers or len(answers) > 32:
                raise WebFetchError("This webpage address could not be verified.")
            addresses = []
            for family, _, _, _, endpoint in answers:
                address = endpoint[0]
                if family not in (socket.AF_INET, socket.AF_INET6) or "%" in address or not _public_address(address):
                    raise WebFetchError("Only public internet destinations can be read.")
                addresses.append((family, str(ipaddress.ip_address(address))))
        authority = f"[{host}]" if ":" in host else host
        if port != (443 if parts.scheme == "https" else 80):
            authority += f":{port}"
        path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
        query = quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
        normalized = urlunsplit((parts.scheme, authority, path, query, ""))
        return Target(normalized, host, port, parts.scheme == "https", path + ("?" + query if query else ""), *addresses[0])
    except WebFetchError:
        raise
    except (ValueError, UnicodeError, OSError) as exc:
        raise WebFetchError(invalid) from exc


class _PinnedConnection(http.client.HTTPConnection):
    def __init__(self, target):
        self.default_port = 443 if target.tls else 80
        super().__init__(target.host, target.port, timeout=CONNECT_TIMEOUT)
        self.target = target

    def connect(self):
        target = self.target
        # Numeric sockaddr + explicit family: no hostname resolution at connect.
        sock = socket.socket(target.family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
        try:
            sock.settimeout(CONNECT_TIMEOUT)
            endpoint = (target.address, target.port) if target.family == socket.AF_INET else (target.address, target.port, 0, 0)
            sock.connect(endpoint)
            if target.tls:
                # Default CA validation and hostname checking stay enabled. SNI
                # is the original hostname, not the pinned address.
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=target.host)
            sock.settimeout(READ_TIMEOUT)
            self.sock = sock
        except BaseException:
            sock.close()
            raise


def _header(response, name):
    values = response.headers.get_all(name, [])
    if len(values) > 1:
        raise WebFetchError("The webpage returned an unsupported response.")
    return values[0].strip() if values else ""


def _read_body(response):
    encoding = _header(response, "Content-Encoding").lower()
    if encoding not in {"", "identity", "gzip", "deflate"}:
        raise WebFetchError("The webpage uses an unsupported content encoding.")
    transfer = _header(response, "Transfer-Encoding").lower()
    length = _header(response, "Content-Length")
    if transfer and (transfer != "chunked" or length):
        raise WebFetchError("The webpage returned an unsupported response.")
    if length and (not re.fullmatch(r"[0-9]+", length) or len(length) > 12):
        raise WebFetchError("The webpage returned an unsupported response.")
    expected = int(length) if length else None
    if expected is not None and expected > MAX_BYTES:
        raise WebFetchError("The webpage exceeds the 1 MiB reading limit.")
    decoder = zlib.decompressobj(31 if encoding == "gzip" else 15) if encoding in {"gzip", "deflate"} else None
    result = bytearray()
    downloaded = 0
    deadline = time.monotonic() + BODY_TIMEOUT
    while True:
        if time.monotonic() > deadline:
            raise WebFetchError("The webpage took too long to respond.")
        chunk = response.read1(min(CHUNK_BYTES, MAX_BYTES + 1 - downloaded))
        if not chunk:
            break
        downloaded += len(chunk)
        if downloaded > MAX_BYTES:
            raise WebFetchError("The webpage exceeds the 1 MiB reading limit.")
        if decoder:
            chunk = decoder.decompress(chunk, MAX_BYTES + 1 - len(result))
            if decoder.unused_data:
                raise WebFetchError("The webpage uses an unsupported compressed response.")
        result.extend(chunk)
        if len(result) > MAX_BYTES:
            raise WebFetchError("The webpage exceeds the 1 MiB reading limit.")
    if expected is not None and downloaded != expected:
        raise WebFetchError("The webpage response was incomplete.")
    if decoder and not decoder.eof:
        raise WebFetchError("The webpage response was incomplete.")
    return bytes(result)


def fetch_webpage(url: str) -> str:
    """Read at most 1 MiB on the wire AND after decompression; return readable text."""
    visited = set()
    try:
        for redirects in range(MAX_REDIRECTS + 1):
            target = validate_target(url)
            if target.url in visited:
                raise WebFetchError("The webpage redirected in a loop.")
            visited.add(target.url)
            connection = _PinnedConnection(target)
            try:
                connection.request("GET", target.path, headers={
                    "User-Agent": "Clawbit/1.0", "Accept": "text/html, text/plain",
                    "Accept-Encoding": "gzip, deflate", "Connection": "close",
                })
                response = connection.getresponse()
                try:
                    if response.status in {301, 302, 303, 307, 308}:
                        location = _header(response, "Location")
                        if not location or redirects == MAX_REDIRECTS:
                            raise WebFetchError("The webpage has too many or invalid redirects.")
                        url = urljoin(target.url, location)
                        continue
                    if not 200 <= response.status < 300:
                        raise WebFetchError("The webpage could not be read. Try another public page.")
                    content_type = _header(response, "Content-Type").split(";", 1)[0].lower()
                    if content_type not in {"text/html", "text/plain"}:
                        raise WebFetchError("Only HTML and plain-text webpages can be read.")
                    data = _read_body(response)
                    charset = response.headers.get_content_charset() or "utf-8"
                    try:
                        text = data.decode(charset, errors="replace")
                    except (LookupError, UnicodeError):
                        text = data.decode("utf-8", errors="replace")
                    if content_type == "text/html":
                        soup = BeautifulSoup(text, "html.parser")
                        for element in soup(["script", "style", "noscript", "template", "svg", "nav", "footer"]):
                            element.decompose()
                        text = soup.get_text(separator="\n", strip=True)
                    return f"Source: {target.url}\n\n{text[:5000]}"
                finally:
                    response.close()
            finally:
                connection.close()
    except WebFetchError:
        raise
    except (TimeoutError, socket.timeout) as exc:
        raise WebFetchError("The webpage took too long to respond.") from exc
    except (OSError, http.client.HTTPException, zlib.error) as exc:
        raise WebFetchError("The webpage could not be read securely. Try another public page.") from exc
