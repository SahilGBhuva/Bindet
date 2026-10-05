import asyncio
import os
import tempfile
import unittest
from io import BytesIO
from unittest.mock import MagicMock, patch

from fastapi import HTTPException, UploadFile
from pypdf import PdfReader, PdfWriter

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

import database
import main
import note_ingestion
import note_store


def blank_pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def text_pdf(lines: list[str]) -> bytes:
    """A real PDF with one page of Helvetica text per entry in lines."""
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    writer = PdfWriter()
    for line in lines:
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)}),
        })
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({line}) Tj ET".encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class NoteIngestionTests(unittest.TestCase):
    def setUp(self):
        database.engine.cache_clear()
        database.init_db.cache_clear()
        note_store.init_notes.cache_clear()
        note_store.init_notes()
        with database.engine().begin() as connection:
            connection.execute(note_store.notes.delete())

    def test_text_ingestion(self):
        self.assertEqual(note_ingestion.extract_text("lesson.md", b"# Cells\nMitochondria make ATP."), "# Cells\nMitochondria make ATP.")

    def test_unsupported_type(self):
        with self.assertRaisesRegex(note_ingestion.NoteIngestionError, "Use a PDF"):
            note_ingestion.extract_text("archive.zip", b"data")

    def test_pdf_uses_text_extraction(self):
        page = MagicMock()
        page.extract_text.return_value = "Newton's first law"
        with patch.object(note_ingestion, "PDF_IN_SUBPROCESS", False), \
                patch.object(note_ingestion, "PdfReader", return_value=MagicMock(pages=[page], is_encrypted=False)):
            self.assertEqual(note_ingestion.extract_text("physics.pdf", b"fake-pdf"), "Newton's first law")

    def test_real_pdf_is_read_in_a_child_process(self):
        content = text_pdf(["Inertia keeps objects moving", "Force equals mass times acceleration"])
        with patch.object(note_ingestion, "extract_pdf_in_process", side_effect=AssertionError("ran in-process")):
            text = note_ingestion.extract_text("physics.pdf", content)
        self.assertIn("Inertia keeps objects moving", text)
        self.assertIn("Force equals mass times acceleration", text)
        with self.assertRaisesRegex(note_ingestion.NoteIngestionError, "Could not read"):
            note_ingestion.extract_text("broken.pdf", b"%PDF-1.7 garbage")

    def test_slow_pdf_extraction_is_stopped_with_a_friendly_error(self):
        import subprocess
        with patch.object(note_ingestion.subprocess, "run", side_effect=subprocess.TimeoutExpired("python", 10)):
            with self.assertRaisesRegex(note_ingestion.NoteIngestionError, "took too long"):
                note_ingestion.extract_text("slow.pdf", b"%PDF-1.7")
        # The real child is killed at the limit.
        with patch.object(note_ingestion, "PDF_TIME_LIMIT_SECONDS", 0.001):
            with self.assertRaises(note_ingestion.PdfTimeout):
                note_ingestion.extract_pdf_text(text_pdf(["slow"]))
        # In-process (no child processes on the host), the deadline is checked between pages.
        pages = [MagicMock() for _ in range(3)]
        with self.assertRaises(note_ingestion.PdfTimeout):
            note_ingestion.collect_page_text(pages, deadline=0.0)
        pages[0].extract_text.assert_not_called()

    def test_pdf_extraction_stops_after_enough_text(self):
        pages = [MagicMock() for _ in range(10)]
        for page in pages:
            page.extract_text.return_value = "x" * 50
        text = note_ingestion.collect_page_text(pages, deadline=float("inf"), max_chars=120)
        self.assertEqual(text.count("x"), 150)
        pages[3].extract_text.assert_not_called()

    def test_pypdf_limits_are_lowered(self):
        from pypdf import get_configuration
        with note_ingestion.pdf_limits():
            self.assertEqual(get_configuration().zlib_maximum_output_length, 25_000_000)
        self.assertEqual(get_configuration().zlib_maximum_output_length, 75_000_000)

    def test_note_ownership_isolated(self):
        saved = note_store.save_note("student-a", "Biology", "Cells", "cells.txt", "text/plain", "Nuclei contain DNA", 18)
        self.assertIsNotNone(note_store.get_note("student-a", saved["id"]))
        self.assertIsNone(note_store.get_note("student-b", saved["id"]))
        self.assertEqual(note_store.list_notes("student-b", "Biology", "Cells"), [])

    def test_image_upload_uses_vision_and_persists_text(self):
        upload = UploadFile(filename="cells.png", file=BytesIO(b"image"), headers={"content-type": "image/png"})
        with patch.object(main.auth, "authenticated_user", return_value={"id": "vision-student"}), patch.object(
            main.ai_tutor, "extract_image_notes", return_value="Cell membranes regulate transport."
        ) as vision:
            result = asyncio.run(main.upload_note("Biology", "Cells", upload, "Bearer test"))
        self.assertEqual(result.status, "ready")
        vision.assert_called_once_with(image_bytes=b"image", content_type="image/png")
        _, context = note_store.context_for("vision-student", "Biology", "Cells")
        self.assertIn("Cell membranes regulate transport", context)

    def test_slow_ocr_does_not_block_the_event_loop(self):
        import time

        def slow_vision(**_):
            time.sleep(0.3)
            return "Slow OCR text"

        async def scenario():
            ticks = 0

            async def ticker():
                nonlocal ticks
                while True:
                    await asyncio.sleep(0.02)
                    ticks += 1

            task = asyncio.create_task(ticker())
            upload = UploadFile(filename="slow.png", file=BytesIO(b"image"), headers={"content-type": "image/png"})
            await main.upload_note("Biology", "Cells", upload, "Bearer test")
            task.cancel()
            return ticks

        with patch.object(main.auth, "authenticated_user", return_value={"id": "loop-student"}), patch.object(
            main.ai_tutor, "extract_image_notes", side_effect=slow_vision
        ):
            ticks = asyncio.run(scenario())
        # Other requests keep being served while the OCR call waits.
        self.assertGreaterEqual(ticks, 5)

    def test_ocr_failures_are_friendly_and_retryable(self):
        def upload(name="cells.png"):
            return UploadFile(filename=name, file=BytesIO(b"image"), headers={"content-type": "image/png"})

        with patch.object(main.auth, "authenticated_user", return_value={"id": "ocr-fail"}):
            with patch.object(main.ai_tutor, "extract_image_notes", side_effect=main.ai_tutor.AITutorError("OpenRouter request failed")):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(main.upload_note("Biology", "Cells", upload(), "Bearer test"))
            self.assertEqual(caught.exception.status_code, 503)
            self.assertNotIn("OpenRouter", caught.exception.detail)
            with patch.object(main.ai_tutor, "extract_image_notes", side_effect=main.ai_tutor.AITutorError("No readable notes were found in that image")):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(main.upload_note("Biology", "Cells", upload(), "Bearer test"))
            self.assertEqual(caught.exception.status_code, 400)

    def test_image_vision_uses_fast_model_and_routing(self):
        response = {"choices": [{"message": {"content": "Fast OCR"}}]}
        with patch.object(main.ai_tutor, "_post", return_value=response) as post:
            self.assertEqual(main.ai_tutor.extract_image_notes(image_bytes=b"image", content_type="image/png"), "Fast OCR")
        payload = post.call_args.args[0]
        self.assertEqual(payload["model"], "google/gemini-3.1-flash-lite")
        self.assertEqual(payload["provider"]["sort"], "throughput")
        self.assertEqual(payload["reasoning"]["effort"], "minimal")
        self.assertEqual(post.call_args.kwargs["timeout"], 8.0)

    def test_scanned_pdf_falls_back_to_ai_ocr(self):
        scanned = blank_pdf(2)
        upload = UploadFile(filename="scan.pdf", file=BytesIO(scanned), headers={"content-type": "application/pdf"})
        with patch.object(main.auth, "authenticated_user", return_value={"id": "pdf-student"}), patch.object(
            main.note_ingestion, "extract_text", side_effect=note_ingestion.NoteIngestionError("No readable text was found in that file")
        ), patch.object(main.ai_tutor, "extract_pdf_notes", return_value="OCR text about mitosis") as ocr:
            result = asyncio.run(main.upload_note("Biology", "Mitosis", upload, "Bearer test"))
        self.assertEqual(result.status, "ready")
        ocr.assert_called_once_with(pdf_bytes=scanned)
        self.assertEqual(result.pages_skipped, 0)

    def test_scanned_pdf_ocr_only_sends_the_first_pages(self):
        scanned = blank_pdf(note_ingestion.MAX_OCR_PDF_PAGES + 4)
        upload = UploadFile(filename="scan.pdf", file=BytesIO(scanned), headers={"content-type": "application/pdf"})
        with patch.object(main.auth, "authenticated_user", return_value={"id": "pdf-student"}), patch.object(
            main.note_ingestion, "extract_text", side_effect=note_ingestion.NoteIngestionError("No readable text was found in that file")
        ), patch.object(main.ai_tutor, "extract_pdf_notes", return_value="OCR text about mitosis") as ocr:
            result = asyncio.run(main.upload_note("Biology", "Mitosis", upload, "Bearer test"))
        sent = PdfReader(BytesIO(ocr.call_args.kwargs["pdf_bytes"]))
        self.assertEqual(len(sent.pages), note_ingestion.MAX_OCR_PDF_PAGES)
        self.assertEqual(result.pages_skipped, 4)
        self.assertIn("first 15 pages", result.notice)

    def test_question_generation_uses_owned_note_excerpt(self):
        note_store.save_note("student-a", "Biology", "Cells", "cells.txt", "text/plain", "Mitochondria generate ATP.", 25)
        request = main.QuestionRequest(student_id="student-a", notes=main.NoteContext(course="Biology", unit="Cells", files=["untrusted.txt"]))
        generated = {"question": "What generates ATP?", "correct_answer": "Mitochondria", "topic": "Cells"}
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'student-a'}), patch.object(main.ai_tutor, "generate_question", return_value=generated) as ai:
            main.generate_question(request, 'Bearer test')
        kwargs = ai.call_args.kwargs
        self.assertIn("Mitochondria generate ATP", kwargs["source_text"])
        self.assertEqual(kwargs["source_labels"], ["cells.txt"])
        self.assertNotIn("untrusted.txt", kwargs["source_labels"])

    def test_note_endpoint_hides_another_students_note(self):
        saved = note_store.save_note("student-a", "History", "Rome", "rome.txt", "text/plain", "Republic", 8)
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-b"}):
            with self.assertRaises(HTTPException) as raised:
                main.get_note(saved["id"], "Bearer test")
        self.assertEqual(raised.exception.status_code, 404)

    def test_note_delete_enforces_ownership(self):
        saved = note_store.save_note("student-a", "History", "Rome", "rome.txt", "text/plain", "Republic", 8)
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-b"}):
            with self.assertRaises(HTTPException) as raised:
                main.delete_note(saved["id"], "Bearer test")
        self.assertEqual(raised.exception.status_code, 404)
        self.assertIsNotNone(note_store.get_note("student-a", saved["id"]))
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}):
            self.assertEqual(main.delete_note(saved["id"], "Bearer test"), {"deleted": True})
        self.assertIsNone(note_store.get_note("student-a", saved["id"]))


if __name__ == "__main__":
    unittest.main()
