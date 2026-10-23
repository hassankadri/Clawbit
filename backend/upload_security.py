"""Shared upload limits, identifier validation and filesystem/content guards."""

from contextlib import contextmanager
import io
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import warnings
import zipfile
import defusedxml.ElementTree as ET

from PIL import Image
from pypdf import PdfReader
from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024
MAX_PDF_PAGES = 200
MAX_ATTACHMENTS = 10
MAX_DOCX_EXPANDED_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_EXTRACTED_CHARS = 1_000_000
MAX_DOCUMENT_CHUNKS = 1500
SUPPORTED_DOCUMENT_SUFFIXES = {".pdf", ".docx", ".txt", ".md", ".csv"}
SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
MIME_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


class UploadError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def validate_thread_id(thread_id: str) -> str:
    if (not isinstance(thread_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", thread_id)
            or re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])", thread_id)):
        raise UploadError("Invalid thread ID.")
    return thread_id


def upload_suffix(filename: str) -> str:
    # Treat both separators as paths on every OS. Paths are never stored as names.
    if (not filename or len(filename) > 255 or PureWindowsPath(filename).name != filename
            or Path(filename).name != filename or ":" in filename
            or any(ord(char) < 32 for char in filename)):
        raise UploadError("Invalid upload filename.")
    suffix = Path(filename).suffix.lower()
    if suffix not in MIME_BY_SUFFIX:
        raise UploadError("Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, PNG, JPEG or WEBP.")
    return suffix


def guarded_path(root: Path, path: Path) -> Path:
    """Reject escapes, symlinks and Windows junctions, including existing parents."""
    root, path = root.absolute(), path.absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise UploadError("Invalid attachment path.") from exc
    if ".." in relative.parts or not path.resolve().is_relative_to(root.resolve()):
        raise UploadError("Invalid attachment path.")
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise UploadError("Linked upload paths are not allowed.")
        if candidate == root.parent:
            break
    return path


def thread_directory(root: Path, thread_id: str, *, create=False) -> Path:
    path = guarded_path(root, root / validate_thread_id(thread_id))
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        guarded_path(root, path)
    return path


@contextmanager
def safe_open(root: Path, path: Path, mode: str):
    path = guarded_path(root, path)
    flags = os.O_RDONLY if mode == "rb" else os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise UploadError("Only regular, unlinked attachment files are allowed.")
        guarded_path(root, path)
        with os.fdopen(descriptor, mode) as stream:
            descriptor = None
            yield stream
    finally:
        if descriptor is not None:
            os.close(descriptor)


def read_bounded(root: Path, path: Path, limit=MAX_UPLOAD_BYTES) -> bytes:
    with safe_open(root, path, "rb") as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            raise UploadError("File exceeds the size limit.", 413)
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise UploadError("File exceeds the size limit.", 413)
    return data


@contextmanager
def thread_lock(root: Path, thread_id: str):
    """Nonblocking OS lock: serializes uploads/deletions across worker processes."""
    directory = thread_directory(root, thread_id, create=True)
    path = guarded_path(root, directory / ".attachment.lock")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    locked = False
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise UploadError("Linked upload paths are not allowed.")
        guarded_path(root, path)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise UploadError("Another attachment operation is in progress. Please retry.", 409) from exc
        yield directory
    finally:
        if locked:
            if os.name == "nt":
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def checked_pdf(data: bytes) -> PdfReader:
    if not data.startswith(b"%PDF-"):
        raise UploadError("File content does not match the PDF extension.")
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise UploadError("Encrypted PDFs are not supported.")
    pending = [(reader.trailer["/Root"]["/Pages"], 0)]
    seen, pages = set(), 0
    while pending:
        item, depth = pending.pop()
        node = item.get_object()
        identity = id(node)
        if identity in seen or depth > 32 or len(seen) >= 1000:
            raise UploadError("PDF page tree is too complex or malformed.")
        seen.add(identity)
        if node.get("/Type") == "/Page":
            pages += 1
        elif node.get("/Type") == "/Pages":
            if node.get("/Count", 0) > MAX_PDF_PAGES:
                raise UploadError("PDFs may contain at most 200 pages.")
            children = node.get("/Kids", [])
            if len(children) > MAX_PDF_PAGES:
                raise UploadError("PDFs may contain at most 200 pages.")
            pending.extend((child, depth + 1) for child in children)
        else:
            raise UploadError("Malformed PDF page tree.")
        if pages > MAX_PDF_PAGES:
            raise UploadError("PDFs may contain at most 200 pages.")
    if not 1 <= len(reader.pages) <= MAX_PDF_PAGES:
        raise UploadError("PDFs must contain between 1 and 200 pages.")
    return reader


def _checked_xml(data):
    text = data.decode("utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    if "\x00" in text or "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        raise UploadError("DOCX XML declarations are not supported.")
    depth = count = 0
    for event, _ in ET.iterparse(io.StringIO(text), events=("start", "end")):
        depth += 1 if event == "start" else -1
        count += 1
        if depth > 64 or count > 100_000:
            raise UploadError("DOCX structure is too complex.")
    return ET.fromstring(text)


def _check_docx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = {entry.filename for entry in entries}
        if not {"[Content_Types].xml", "word/document.xml"}.issubset(names):
            raise UploadError("File content is not a DOCX document.")
        if len(entries) > 512 or len(entries) != len(names):
            raise UploadError("DOCX has too many or duplicate entries.")
        if sum(entry.file_size for entry in entries) > MAX_DOCX_EXPANDED_BYTES:
            raise UploadError("DOCX expanded content is too large.")
        for entry in entries:
            if (entry.flag_bits & 1 or ".." in Path(entry.filename).parts
                    or "\\" in entry.filename or entry.filename.startswith("/")
                    or ":" in entry.filename
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise UploadError("Unsupported DOCX archive structure.")
            if entry.filename.lower().endswith("vbaproject.bin"):
                raise UploadError("Macro-enabled documents are not supported.")
            content = archive.read(entry)  # Per-entry and total sizes checked above; CRC checked here.
            if entry.filename.endswith((".xml", ".rels")):
                root = _checked_xml(content)
                if entry.filename == "word/document.xml" and root.tag != "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}document":
                    raise UploadError("Malformed DOCX document.")
        types = _checked_xml(archive.read("[Content_Types].xml"))
        if not any(item.get("PartName") == "/word/document.xml" and item.get("ContentType") ==
                   "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
                   for item in types):
            raise UploadError("File content is not a standard DOCX document.")


def validate_file(root: Path, path: Path) -> tuple[str, str]:
    suffix = path.suffix.lower()
    if suffix not in MIME_BY_SUFFIX:
        raise UploadError("Unsupported file type.")
    data = read_bounded(root, path)
    if not data:
        raise UploadError("The uploaded file is empty.")
    try:
        if suffix == ".pdf":
            checked_pdf(data)
        elif suffix == ".docx":
            _check_docx(data)
        elif suffix in SUPPORTED_IMAGE_SUFFIXES:
            expected = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}[suffix]
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data), formats=[expected]) as image:
                    if image.width * image.height > MAX_IMAGE_PIXELS:
                        raise UploadError("Image pixel count exceeds the limit.")
                    if getattr(image, "n_frames", 1) != 1:
                        raise UploadError("Only single-frame images are supported.")
                    image.verify()
                with Image.open(io.BytesIO(data), formats=[expected]) as image:
                    image.load()  # Reject truncated/invalid compressed pixels, with dimensions bounded.
        else:
            text = data.decode("utf-8-sig")
            if any(ord(char) < 32 and char not in "\t\n\r\f" for char in text):
                raise UploadError("Text uploads must contain UTF-8 text, not binary data.")
            if data.startswith((b"%PDF-", b"PK\x03\x04", b"MZ", b"\x7fELF")):
                raise UploadError("File content does not match the text extension.")
    except UploadError:
        raise
    except Exception as exc:
        raise UploadError("The file is malformed or its content does not match its extension.") from exc
    return ("image" if suffix in SUPPORTED_IMAGE_SUFFIXES else "document"), MIME_BY_SUFFIX[suffix]


class UploadBodyLimitMiddleware:
    """Bound multipart spooling too, even with no/trustless Content-Length."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/attachments/upload":
            return await self.app(scope, receive, send)
        limit = MAX_UPLOAD_BYTES + UPLOAD_CHUNK_BYTES  # Small allowance for multipart framing.
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = 0
        if declared > limit:
            return await JSONResponse({"detail": "Upload exceeds 10 MiB."}, status_code=413)(scope, receive, send)
        received, exceeded = 0, False

        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            received += len(message.get("body", b""))
            if received > limit:
                exceeded = True
                # Starlette closes partially spooled files on MultiPartException.
                raise MultiPartException("Upload exceeds 10 MiB.")
            return message

        async def limited_send(message):
            if exceeded and message["type"] == "http.response.start":
                message = {**message, "status": 413}
            await send(message)

        await self.app(scope, limited_receive, limited_send)
