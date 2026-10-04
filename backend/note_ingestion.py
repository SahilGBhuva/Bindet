from __future__ import annotations

from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from docx import Document
from pypdf import PdfReader, PdfWriter

MAX_NOTE_BYTES = 10 * 1024 * 1024
MAX_STORED_CHARS = 120_000
TEXT_EXTENSIONS = {'.txt', '.md', '.csv', '.json'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | IMAGE_EXTENSIONS | {'.pdf', '.docx'}
MAX_PDF_PAGES = 200
MAX_OCR_PDF_PAGES = 15  # scanned PDFs are OCR'd by a paid model, so only the first pages are sent
MAX_DOCX_FILES = 500
MAX_DOCX_EXPANDED_BYTES = 30 * 1024 * 1024


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


def first_pdf_pages(content: bytes, max_pages: int = MAX_OCR_PDF_PAGES) -> tuple[bytes, int]:
    """A copy of the PDF holding only its first pages, and how many pages were left out."""
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
            reader = PdfReader(BytesIO(content))
            if reader.is_encrypted:
                raise NoteIngestionError('Password-protected PDFs are not supported')
            if len(reader.pages) > MAX_PDF_PAGES:
                raise NoteIngestionError(f'PDFs must have {MAX_PDF_PAGES} pages or fewer')
            text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        elif suffix == '.docx':
            validate_docx_archive(content)
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
