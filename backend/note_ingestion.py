from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from pypdf import PdfReader, PdfWriter, apply_configuration

MAX_NOTE_BYTES = 10 * 1024 * 1024
MAX_STORED_CHARS = 120_000
TEXT_EXTENSIONS = {'.txt', '.md', '.csv', '.json'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | IMAGE_EXTENSIONS | {'.pdf', '.docx'}
MAX_PDF_PAGES = 200
MAX_OCR_PDF_PAGES = 15  # scanned PDFs are OCR'd by a paid model, so only the first pages are sent
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
# Tighter than pypdf's 75 MB defaults: a 10 MB note never needs more than this.
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


def _pdf_worker() -> None:
    """Child process entry point: PDF bytes on stdin, one JSON object on stdout."""
    content = sys.stdin.buffer.read()
    try:
        result = {'ok': True, 'text': extract_pdf_in_process(content, time.monotonic() + PDF_TIME_LIMIT_SECONDS)}
    except NoteIngestionError as exc:
        result = {'ok': False, 'error': str(exc)}
    except Exception:  # noqa: BLE001 - any parser failure is "unreadable"
        result = {'ok': False, 'error': PDF_UNREADABLE}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


def extract_pdf_text(content: bytes, time_limit: float | None = None) -> str:
    """Extract a PDF's text with a hard wall-clock limit (see PDF_TIME_LIMIT_SECONDS)."""
    limit = PDF_TIME_LIMIT_SECONDS if time_limit is None else time_limit
    if not PDF_IN_SUBPROCESS:
        return extract_pdf_in_process(content, time.monotonic() + limit)
    started = time.monotonic()
    # The child must find the same packages; some hosts add them to sys.path at runtime.
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join(path for path in sys.path if path and os.path.isdir(path))}
    try:
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), '--pdf-worker'],
            input=content, capture_output=True, timeout=limit, check=False,
            cwd=str(Path(__file__).resolve().parent), env=env,
        )
    except subprocess.TimeoutExpired as exc:  # the child has been killed
        raise PdfTimeout(PDF_TOO_SLOW) from exc
    except OSError:
        # No child process on this host: same limits, deadline checked between pages.
        return extract_pdf_in_process(content, started + limit)
    try:
        result = json.loads(completed.stdout.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        if b'ModuleNotFoundError' in completed.stderr or b'ImportError' in completed.stderr:
            # The child could not even start the parser: an environment problem, not the PDF.
            return extract_pdf_in_process(content, started + limit)
        # The child died (out of memory, a crash) without answering.
        raise NoteIngestionError(PDF_UNREADABLE) from exc
    if not isinstance(result, dict):
        raise NoteIngestionError(PDF_UNREADABLE)
    if not result.get('ok'):
        raise NoteIngestionError(str(result.get('error') or PDF_UNREADABLE))
    return str(result.get('text') or '')


def first_pdf_pages(content: bytes, max_pages: int = MAX_OCR_PDF_PAGES) -> tuple[bytes, int]:
    """A copy of the PDF holding only its first pages, and how many pages were left out."""
    with pdf_limits():
        return _first_pdf_pages(content, max_pages)


def _first_pdf_pages(content: bytes, max_pages: int) -> tuple[bytes, int]:
    try:
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise NoteIngestionError('Password-protected PDFs are not supported')
        total = len(reader.pages)
        if total <= max_pages:
            return content, 0
        writer = PdfWriter()
        for page in reader.pages[:max_pages]:
            writer.add_page(page)
        output = BytesIO()
        writer.write(output)
    except NoteIngestionError:
        raise
    except Exception as exc:
        raise NoteIngestionError('Could not read that file. Try exporting it again.') from exc
    return output.getvalue(), total - max_pages


def extract_text(filename: str, content: bytes) -> str:
    if not content:
        raise NoteIngestionError('The uploaded file is empty')
    if len(content) > MAX_NOTE_BYTES:
        raise NoteIngestionError('Notes must be 10 MB or smaller')
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise NoteIngestionError('Use a PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG, JPEG, or WEBP file')
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
