from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from pypdf import PdfReader, PdfWriter, apply_configuration

# Vercel refuses request bodies over about 4.5 MB before they reach the app, so a note
# file is capped at 4 MB (leaving room for the multipart form around it).
MAX_NOTE_BYTES = 4 * 1024 * 1024
NOTE_TOO_LARGE = 'Notes must be 4 MB or smaller. Try a smaller file or a photo.'
MAX_STORED_CHARS = 120_000
TEXT_EXTENSIONS = {'.txt', '.md', '.csv', '.json'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif'}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | IMAGE_EXTENSIONS | {'.pdf', '.docx'}
MAX_PDF_PAGES = 200
# Scanned PDFs: the first pages' scans go to the vision model in one request. Groq counts each
# image as 2,048 tokens against an 8,000-tokens-a-minute limit, so three pages is the most that fits.
MAX_OCR_PDF_PAGES = 3
OCR_PAGE_MAX_EDGE = 1600   # pixels; the scans are re-encoded as JPEG, metadata-free
OCR_PAGE_JPEG_QUALITY = 82
OCR_PAGE_MAX_PIXELS = 24_000_000  # a page scan larger than this is skipped, never decoded
MAX_DOCX_FILES = 500
MAX_DOCX_EXPANDED_BYTES = 30 * 1024 * 1024

# PDF text extraction is CPU-bound and a crafted PDF can make it run for minutes, so it
# runs in a separate Python process that is killed after PDF_TIME_LIMIT_SECONDS. A
# child started with subprocess only needs pipes, which works on Vercel/AWS Lambda,
# where multiprocessing's semaphores (/dev/shm) are unavailable. If a child can't be
# started at all, extraction runs in-process with the same deadline checked between pages.
PDF_TIME_LIMIT_SECONDS = 10.0
PDF_IN_SUBPROCESS = True
PDF_TOO_SLOW = 'That PDF took too long to read. Try exporting it again, or upload a smaller file or a DOCX.'
PDF_UNREADABLE = 'Could not read that file. Try exporting it again.'
# Tighter than pypdf's 75 MB defaults: a 4 MB note never needs more than this.
PDF_LIMITS = {
    'maximum_declared_stream_length': 25_000_000,
    'array_based_stream_maximum_output_length': 25_000_000,
    'jbig2_maximum_output_length': 25_000_000,
    'lzw_maximum_output_length': 25_000_000,
    'run_length_maximum_output_length': 25_000_000,
    'zlib_maximum_output_length': 25_000_000,
    'zlib_maximum_recovery_input_length': 2_000_000,
    'image_maximum_buffer_size': 25_000_000,
    'xmp_maximum_input_length': 1_000_000,
    'xmp_maximum_element_count': 10_000,
    'outline_maximum_entries': 10_000,
    'page_tree_maximum_entries': 10_000,
    'xform_maximum_invocations_per_extraction': 500,
}


class NoteIngestionError(ValueError):
    pass


def clean_text(value: str) -> str:
    lines = [' '.join(line.split()) for line in value.replace('\x00', ' ').splitlines()]
    return '\n'.join(line for line in lines if line).strip()[:MAX_STORED_CHARS]


def validate_docx_archive(content: bytes) -> None:
    try:
        with ZipFile(BytesIO(content)) as archive:
            members = archive.infolist()
            expanded = sum(member.file_size for member in members)
            if len(members) > MAX_DOCX_FILES or expanded > MAX_DOCX_EXPANDED_BYTES:
                raise NoteIngestionError('That DOCX is too complex to process safely')
            if any(member.file_size > 0 and member.compress_size > 0 and member.file_size / member.compress_size > 200 for member in members):
                raise NoteIngestionError('That DOCX is too compressed to process safely')
    except BadZipFile as exc:
        raise NoteIngestionError('Could not read that DOCX file') from exc


class PdfTimeout(NoteIngestionError):
    pass


def pdf_limits():
    """Context manager applying PDF_LIMITS to pypdf for the current context."""
    return apply_configuration(**PDF_LIMITS)


def collect_page_text(pages, deadline: float, max_chars: int = MAX_STORED_CHARS) -> str:
    """Text of each page in order, stopping once max_chars are collected.

    The deadline (time.monotonic) is checked before every page.
    """
    parts: list[str] = []
    collected = 0
    for page in pages:
        if time.monotonic() > deadline:
            raise PdfTimeout(PDF_TOO_SLOW)
        text = (page.extract_text() or '')[:max_chars]
        parts.append(text)
        collected += len(text)
        if collected >= max_chars:
            break
    return '\n'.join(parts)


def extract_pdf_in_process(content: bytes, deadline: float) -> str:
    with pdf_limits():
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise NoteIngestionError('Password-protected PDFs are not supported')
        if len(reader.pages) > MAX_PDF_PAGES:
            raise NoteIngestionError(f'PDFs must have {MAX_PDF_PAGES} pages or fewer')
        return collect_page_text(reader.pages, deadline)


def _pdf_worker(mode: str = 'text', max_pages: int = MAX_OCR_PDF_PAGES) -> None:
    """Child process entry point: PDF bytes on stdin, one JSON object on stdout.
    mode 'text' extracts the text; mode 'trim' returns the first max_pages pages as a PDF;
    mode 'images' returns the scans of the first max_pages pages as JPEGs."""
    content = sys.stdin.buffer.read()
    deadline = time.monotonic() + PDF_TIME_LIMIT_SECONDS
    try:
        if mode == 'trim':
            trimmed, omitted = first_pdf_pages_in_process(content, max_pages, deadline)
            result = {'ok': True, 'pdf': base64.b64encode(trimmed).decode('ascii'), 'omitted': omitted}
        elif mode == 'images':
            pages, omitted = pdf_page_images_in_process(content, max_pages, deadline)
            result = {'ok': True, 'images': [base64.b64encode(page).decode('ascii') for page in pages], 'omitted': omitted}
        else:
            result = {'ok': True, 'text': extract_pdf_in_process(content, deadline)}
    except NoteIngestionError as exc:
        result = {'ok': False, 'error': str(exc)}
    except Exception:  # noqa: BLE001 - any parser failure is "unreadable"
        result = {'ok': False, 'error': PDF_UNREADABLE}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


def _run_pdf_child(args: list[str], content: bytes, limit: float, in_process):
    """Run this file as a PDF child process (see PDF_TIME_LIMIT_SECONDS) and return its JSON
    result, killing it after `limit` seconds. Falls back to in_process(deadline) when no child
    can be started on this host."""
    started = time.monotonic()
    # The child must find the same packages; some hosts add them to sys.path at runtime.
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join(path for path in sys.path if path and os.path.isdir(path))}
    try:
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), *args],
            input=content, capture_output=True, timeout=limit, check=False,
            cwd=str(Path(__file__).resolve().parent), env=env,
        )
    except subprocess.TimeoutExpired as exc:  # the child has been killed
        raise PdfTimeout(PDF_TOO_SLOW) from exc
    except OSError:
        # No child process on this host: same limits, deadline checked between pages.
        return in_process(started + limit)
    try:
        result = json.loads(completed.stdout.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        if b'ModuleNotFoundError' in completed.stderr or b'ImportError' in completed.stderr:
            # The child could not even start the parser: an environment problem, not the PDF.
            return in_process(started + limit)
        # The child died (out of memory, a crash) without answering.
        raise NoteIngestionError(PDF_UNREADABLE) from exc
    if not isinstance(result, dict):
        raise NoteIngestionError(PDF_UNREADABLE)
    if not result.get('ok'):
        raise NoteIngestionError(str(result.get('error') or PDF_UNREADABLE))
    return result


def extract_pdf_text(content: bytes, time_limit: float | None = None) -> str:
    """Extract a PDF's text with a hard wall-clock limit (see PDF_TIME_LIMIT_SECONDS)."""
    limit = PDF_TIME_LIMIT_SECONDS if time_limit is None else time_limit
    if not PDF_IN_SUBPROCESS:
        return extract_pdf_in_process(content, time.monotonic() + limit)
    result = _run_pdf_child(['--pdf-worker'], content, limit,
                            lambda deadline: {'text': extract_pdf_in_process(content, deadline)})
    return str(result.get('text') or '')


def first_pdf_pages(content: bytes, max_pages: int = MAX_OCR_PDF_PAGES, time_limit: float | None = None) -> tuple[bytes, int]:
    """A copy of the PDF holding only its first pages, and how many pages were left out.
    Runs in the same timed child process as text extraction (a crafted PDF can make pypdf
    run for minutes)."""
    limit = PDF_TIME_LIMIT_SECONDS if time_limit is None else time_limit
    if not PDF_IN_SUBPROCESS:
        return first_pdf_pages_in_process(content, max_pages, time.monotonic() + limit)

    def in_process(deadline: float) -> dict:
        trimmed, omitted = first_pdf_pages_in_process(content, max_pages, deadline)
        return {'pdf': base64.b64encode(trimmed).decode('ascii'), 'omitted': omitted}

    result = _run_pdf_child(['--pdf-trim', str(int(max_pages))], content, limit, in_process)
    try:
        return base64.b64decode(str(result.get('pdf') or ''), validate=True), int(result.get('omitted') or 0)
    except (ValueError, TypeError) as exc:
        raise NoteIngestionError(PDF_UNREADABLE) from exc


def first_pdf_pages_in_process(content: bytes, max_pages: int, deadline: float = float('inf')) -> tuple[bytes, int]:
    with pdf_limits():
        return _first_pdf_pages(content, max_pages, deadline)


def _first_pdf_pages(content: bytes, max_pages: int, deadline: float = float('inf')) -> tuple[bytes, int]:
    try:
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise NoteIngestionError('Password-protected PDFs are not supported')
        total = len(reader.pages)
        if total <= max_pages:
            return content, 0
        writer = PdfWriter()
        for page in reader.pages[:max_pages]:
            if time.monotonic() > deadline:
                raise PdfTimeout(PDF_TOO_SLOW)
            writer.add_page(page)
        output = BytesIO()
        writer.write(output)
    except NoteIngestionError:
        raise
    except Exception as exc:
        raise NoteIngestionError(PDF_UNREADABLE) from exc
    return output.getvalue(), total - max_pages


def pdf_page_images(content: bytes, max_pages: int = MAX_OCR_PDF_PAGES, time_limit: float | None = None) -> tuple[list[bytes], int]:
    """The scans of a scanned PDF's first pages, as JPEG bytes (one per page that has one), and
    how many pages were left out. Runs in the same timed child process as text extraction."""
    limit = PDF_TIME_LIMIT_SECONDS if time_limit is None else time_limit
    if not PDF_IN_SUBPROCESS:
        return pdf_page_images_in_process(content, max_pages, time.monotonic() + limit)

    def in_process(deadline: float) -> dict:
        pages, omitted = pdf_page_images_in_process(content, max_pages, deadline)
        return {'images': [base64.b64encode(page).decode('ascii') for page in pages], 'omitted': omitted}

    result = _run_pdf_child(['--pdf-images', str(int(max_pages))], content, limit, in_process)
    try:
        images = [base64.b64decode(str(item), validate=True) for item in result.get('images') or []]
        return images, int(result.get('omitted') or 0)
    except (ValueError, TypeError) as exc:
        raise NoteIngestionError(PDF_UNREADABLE) from exc


def pdf_page_images_in_process(content: bytes, max_pages: int, deadline: float = float('inf')) -> tuple[list[bytes], int]:
    with pdf_limits():
        return _pdf_page_images(content, max_pages, deadline)


def _page_scan_jpeg(page) -> bytes | None:
    """The page's largest embedded image (the scan), downsized and re-encoded as a plain JPEG."""
    from PIL import Image  # only the PDF child and this path need Pillow

    Image.MAX_IMAGE_PIXELS = OCR_PAGE_MAX_PIXELS
    best = None
    for embedded in page.images:
        try:
            picture = embedded.image
        except Exception:  # noqa: BLE001 - an image pypdf can't decode is skipped
            continue
        if picture is None or picture.width * picture.height > OCR_PAGE_MAX_PIXELS:
            continue
        if best is None or picture.width * picture.height > best.width * best.height:
            best = picture
    if best is None:
        return None
    best = best.convert('RGB')
    best.thumbnail((OCR_PAGE_MAX_EDGE, OCR_PAGE_MAX_EDGE))
    output = BytesIO()
    best.save(output, format='JPEG', quality=OCR_PAGE_JPEG_QUALITY, optimize=True)
    return output.getvalue()


def _pdf_page_images(content: bytes, max_pages: int, deadline: float = float('inf')) -> tuple[list[bytes], int]:
    try:
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise NoteIngestionError('Password-protected PDFs are not supported')
        total = len(reader.pages)
        if total > MAX_PDF_PAGES:
            raise NoteIngestionError(f'PDFs must have {MAX_PDF_PAGES} pages or fewer')
        scans: list[bytes] = []
        for page in reader.pages[:max_pages]:
            if time.monotonic() > deadline:
                raise PdfTimeout(PDF_TOO_SLOW)
            scan = _page_scan_jpeg(page)
            if scan:
                scans.append(scan)
    except NoteIngestionError:
        raise
    except Exception as exc:
        raise NoteIngestionError(PDF_UNREADABLE) from exc
    return scans, max(0, total - max_pages)


def extract_text(filename: str, content: bytes) -> str:
    if not content:
        raise NoteIngestionError('The uploaded file is empty')
    if len(content) > MAX_NOTE_BYTES:
        raise NoteIngestionError(NOTE_TOO_LARGE)
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise NoteIngestionError('Use a PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG, JPEG, WEBP, or HEIC file')
    try:
        if suffix in TEXT_EXTENSIONS:
            text = content.decode('utf-8-sig', errors='replace')
        elif suffix == '.pdf':
            text = extract_pdf_text(content)
        elif suffix == '.docx':
            validate_docx_archive(content)
            # Imported here, not at the top: the PDF worker child runs this file too and
            # never needs python-docx, so it starts faster without it.
            from docx import Document
            document = Document(BytesIO(content))
            text = '\n'.join(paragraph.text for paragraph in document.paragraphs)
        else:
            raise NoteIngestionError('image_requires_vision')
    except NoteIngestionError:
        raise
    except Exception as exc:
        raise NoteIngestionError('Could not read that file. Try exporting it again.') from exc
    text = clean_text(text)
    if not text:
        raise NoteIngestionError('No readable text was found in that file')
    return text


if __name__ == '__main__' and sys.argv[1:] == ['--pdf-worker']:
    _pdf_worker()
elif __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--pdf-trim' and sys.argv[2].isdigit():
    _pdf_worker('trim', int(sys.argv[2]))
elif __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--pdf-images' and sys.argv[2].isdigit():
    _pdf_worker('images', int(sys.argv[2]))
