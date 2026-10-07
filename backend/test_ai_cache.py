"""AI result caches: hits skip the model, the per-student AI quotas and the global AI budget.

Every AI call is mocked.
"""
import asyncio
import json
import os
import tempfile
import unittest
from datetime import timedelta
from io import BytesIO
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi import HTTPException, UploadFile
from pypdf import PdfWriter
from sqlalchemy import select, update

import ai_cache
import ai_tutor
import database
import flashcards
import main
import note_ingestion
import note_store
import questions
import rate_limit
import tutor

NOTE_TEXT = (
    "Photosynthesis happens in the chloroplasts of plant cells. Chlorophyll absorbs light energy, mostly red and blue light. "
    "The light-dependent reactions take place in the thylakoid membranes and split water, releasing oxygen as a by-product. "
    "They produce ATP and NADPH, which carry energy to the Calvin cycle. The Calvin cycle happens in the stroma and uses "
    "carbon dioxide to build glucose. The enzyme rubisco fixes carbon dioxide in the first step of the Calvin cycle. "
    "Limiting factors for photosynthesis include light intensity, carbon dioxide concentration and temperature. "
    "Very high temperatures denature enzymes such as rubisco, so the rate falls sharply."
)
GOOD_CARDS = [
    {"front": "Where does photosynthesis happen in plant cells?", "back": "In the chloroplasts.", "topic": "Photosynthesis"},
    {"front": "What does chlorophyll absorb?", "back": "Light energy, mostly red and blue light.", "topic": "Pigments"},
    {"front": "Which enzyme fixes carbon dioxide in the Calvin cycle?", "back": "Rubisco fixes carbon dioxide in the first step.", "topic": "Calvin cycle"},
]


def tearDownModule():
    if os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


class CacheTestCase(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        flashcards.reset_flashcards()
        questions.reset_questions()
        tutor.reset_tutor()
        ai_cache.reset_caches()
        rate_limit.limiter.reset()
        main.tutor_streams.reset()
        with database.engine().begin() as connection:
            connection.execute(note_store.notes.delete())

    def as_user(self, student_id):
        return patch.object(main.auth, "authenticated_user", return_value={"id": student_id})

    def no_quota_or_budget(self):
        """Patches that fail the test if any per-student limit or the global budget is charged."""
        return (
            patch.object(main.database, "check_social_rate_limit", side_effect=AssertionError("a quota was charged")),
            patch.object(main, "global_ai_available", side_effect=AssertionError("the global AI budget was charged")),
        )

    def rows(self, name):
        with database.engine().connect() as connection:
            return [dict(row) for row in connection.execute(select(database.metadata.tables[name])).mappings().all()]


class FlashcardCacheTests(CacheTestCase):
    def note(self, student_id, text=NOTE_TEXT, course="Biology", unit="Photosynthesis", name="handout.txt"):
        return note_store.save_note(student_id, course, unit, name, "text/plain", text, len(text))["id"]

    def generate(self, note_id, student_id, retry=False):
        with self.as_user(student_id):
            return main.make_note_flashcards(note_id, None, retry, "Bearer t")

    def test_identical_handout_reuses_cards_without_ai_quota_or_budget(self):
        alex_note, sam_note = self.note("alex"), self.note("sam")
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}) as chat:
            first = self.generate(alex_note, "alex")
        self.assertEqual(chat.call_count, 1)
        quota, budget = self.no_quota_or_budget()
        with patch.object(ai_tutor, "_chat_json") as chat, quota, budget, self.assertLogs("bindit.ai", "INFO") as logs:
            second = self.generate(sam_note, "sam")
        chat.assert_not_called()
        self.assertTrue(any('"outcome":"cache_hit"' in line for line in logs.output))
        self.assertEqual(second["status"], "ready")
        self.assertEqual([card["front"] for card in second["cards"]], [card["front"] for card in first["cards"]])
        # Copies for Sam's own note: new ids, his note, and Alex's cards untouched.
        self.assertTrue({card["id"] for card in second["cards"]}.isdisjoint({card["id"] for card in first["cards"]}))
        self.assertEqual({card["note_id"] for card in second["cards"]}, {sam_note})
        self.assertEqual(flashcards.job_state("sam", sam_note)["status"], "ready")
        self.assertEqual(len(flashcards.note_cards("alex", alex_note)), 3)
        self.assertEqual(self.rows("flashcard_cache")[0]["hits"], 1)

    def test_the_cache_stores_a_hash_and_the_cards_never_the_note(self):
        note_id = self.note("alex")
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}):
            self.generate(note_id, "alex")
        [row] = self.rows("flashcard_cache")
        self.assertRegex(row["key"], r"^[0-9a-f]{64}$")
        self.assertEqual(row["card_count"], 3)
        self.assertNotIn("Calvin cycle happens in the stroma", json.dumps(row, default=str))

    def test_different_text_course_unit_or_file_name_is_a_miss(self):
        self.note("alex")
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}):
            self.generate(self.note("alex"), "alex")
        variants = [
            {"text": NOTE_TEXT + " Glucose is stored as starch."},
            {"course": "Chemistry"},
            {"unit": "Plants"},
            {"name": "other.txt"},
        ]
        for variant in variants:
            with self.subTest(**{key: value[:20] for key, value in variant.items()}):
                note_id = self.note("sam", **variant)
                with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}) as chat:
                    self.generate(note_id, "sam")
                chat.assert_called_once()

    def test_failures_and_empty_results_are_never_cached(self):
        note_id = self.note("alex")
        with patch.object(ai_tutor, "_post", side_effect=ai_tutor.AITutorError("down")), self.assertRaises(HTTPException):
            self.generate(note_id, "alex")
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": []}), self.assertRaises(HTTPException):
            self.generate(note_id, "alex", retry=True)
        self.assertEqual(self.rows("flashcard_cache"), [])
        # A later success is stored, and a retry of another note then hits it.
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}):
            self.generate(note_id, "alex", retry=True)
        self.assertEqual(len(self.rows("flashcard_cache")), 1)

    def test_a_failed_note_retried_after_a_classmate_succeeded_uses_the_cache(self):
        sam_note = self.note("sam")
        with patch.object(ai_tutor, "_post", side_effect=ai_tutor.AITutorError("down")), self.assertRaises(HTTPException):
            self.generate(sam_note, "sam")
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}):
            self.generate(self.note("alex"), "alex")
        with patch.object(ai_tutor, "_chat_json") as chat:
            result = self.generate(sam_note, "sam", retry=True)
        chat.assert_not_called()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(result["cards"]), 3)

    def test_cached_cards_go_through_validation_again(self):
        note_id = self.note("alex")
        key = ai_cache.flashcard_key(course="Biology", unit="Photosynthesis", file_name="handout.txt", source_text=ai_tutor.flashcard_source_text(NOTE_TEXT))
        bad = {"front": "Visit http://example.com", "back": "Click the link", "topic": "x"}
        ai_cache.store_flashcards(key, [bad, GOOD_CARDS[0], GOOD_CARDS[0]])
        with patch.object(ai_tutor, "_chat_json") as chat:
            result = self.generate(note_id, "alex")
        chat.assert_not_called()
        self.assertEqual([card["front"] for card in result["cards"]], [GOOD_CARDS[0]["front"]])

    def test_a_prompt_or_model_change_invalidates_entries(self):
        key = ai_cache.flashcard_key(course="B", unit="P", file_name="f", source_text="t")
        with patch.object(ai_tutor, "FLASHCARD_PROMPT", ai_tutor.FLASHCARD_PROMPT + " Be brief."):
            self.assertNotEqual(ai_cache.flashcard_key(course="B", unit="P", file_name="f", source_text="t"), key)
        with patch.object(ai_tutor, "OPENROUTER_MODEL", "other/model"):
            self.assertNotEqual(ai_cache.flashcard_key(course="B", unit="P", file_name="f", source_text="t"), key)

    def test_expired_entries_are_ignored_and_pruned(self):
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}):
            self.generate(self.note("alex"), "alex")
        with database.engine().begin() as connection:
            connection.execute(update(database.flashcard_cache).values(created_at=ai_cache._now() - timedelta(days=31)))
        with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}) as chat:
            self.generate(self.note("sam"), "sam")
        chat.assert_called_once()
        with database.engine().begin() as connection:
            connection.execute(update(database.flashcard_cache).values(created_at=ai_cache._now() - timedelta(days=31)))
        with patch.object(ai_cache, "_last_prune", float("-inf")):
            self.assertTrue(ai_cache.prune_if_due())
            self.assertFalse(ai_cache.prune_if_due())  # at most once per PRUNE_SECONDS
        self.assertEqual(self.rows("flashcard_cache"), [])

    def test_ai_cache_enabled_off_always_calls_the_model(self):
        with patch.dict(os.environ, {"AI_CACHE_ENABLED": "0"}):
            with patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}) as chat:
                self.generate(self.note("alex"), "alex")
                self.generate(self.note("sam"), "sam")
            self.assertEqual(chat.call_count, 2)
        self.assertEqual(self.rows("flashcard_cache"), [])

    def test_a_broken_cache_is_a_miss_not_an_error(self):
        note_id = self.note("alex")
        with patch.object(ai_cache, "_table", side_effect=RuntimeError("db down")), \
                patch.object(ai_tutor, "_chat_json", return_value={"cards": GOOD_CARDS}) as chat:
            result = self.generate(note_id, "alex")
        chat.assert_called_once()
        self.assertEqual(result["status"], "ready")


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def blank_pdf(pages):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


class ExtractionCacheTests(CacheTestCase):
    def upload(self, student_id, raw=PNG_BYTES, name="handout.png", content_type="image/png", unit="Cells"):
        upload = UploadFile(filename=name, file=BytesIO(raw), headers={"content-type": content_type})
        with self.as_user(student_id):
            return asyncio.run(main.upload_note("Biology", unit, upload, "Bearer t"))

    def test_reuploading_the_same_image_skips_ocr_quota_and_budget(self):
        with patch.object(ai_tutor, "extract_image_notes", return_value="Cell membranes regulate transport.") as vision:
            first = self.upload("alex")
        vision.assert_called_once()
        # Only the upload limit may be checked on a hit: no ai_ocr quota and no global budget.
        with patch.object(ai_tutor, "extract_image_notes") as vision, \
                patch.object(main, "limit_action") as limits, \
                patch.object(main, "global_ai_available", side_effect=AssertionError("budget charged")), \
                self.assertLogs("bindit.ai", "INFO") as logs:
            again = self.upload("alex", unit="Membranes")
            classmate = self.upload("sam")
        vision.assert_not_called()
        self.assertEqual({call.args[1] for call in limits.call_args_list}, {"note_upload"})
        self.assertTrue(any('"outcome":"cache_hit"' in line for line in logs.output))
        self.assertEqual(again.text_preview, first.text_preview)
        self.assertEqual(classmate.text_preview, "Cell membranes regulate transport.")
        # Each upload is still its own note, owned by its uploader.
        self.assertEqual(len(note_store.list_notes("sam", "Biology", "Cells")), 1)
        self.assertEqual(self.rows("extraction_cache")[0]["hits"], 2)

    def test_the_cache_holds_a_hash_not_the_file(self):
        with patch.object(ai_tutor, "extract_image_notes", return_value="Cell membranes regulate transport."):
            self.upload("alex")
        [row] = self.rows("extraction_cache")
        self.assertEqual(set(row), {"key", "text", "created_at", "hits"})
        self.assertRegex(row["key"], r"^[0-9a-f]{64}$")

    def test_different_bytes_are_a_miss(self):
        with patch.object(ai_tutor, "extract_image_notes", return_value="Text one.") as vision:
            self.upload("alex")
            self.upload("sam", raw=PNG_BYTES + b"1")
        self.assertEqual(vision.call_count, 2)

    def test_ocr_failures_are_not_cached(self):
        for error in ("OpenRouter request failed", "No readable notes were found in that image"):
            with patch.object(ai_tutor, "extract_image_notes", side_effect=ai_tutor.AITutorError(error)), self.assertRaises(HTTPException):
                self.upload("alex")
        with patch.object(ai_tutor, "extract_image_notes", return_value="   "), self.assertRaises(HTTPException):
            self.upload("alex")
        self.assertEqual(self.rows("extraction_cache"), [])

    def test_scanned_pdfs_are_cached_with_their_skipped_page_notice(self):
        scanned = blank_pdf(note_ingestion.MAX_OCR_PDF_PAGES + 2)
        no_text = patch.object(main.note_ingestion, "extract_text", side_effect=note_ingestion.NoteIngestionError("No readable text was found in that file"))
        with no_text, patch.object(ai_tutor, "extract_pdf_notes", return_value="OCR text about mitosis") as ocr:
            first = self.upload("alex", raw=scanned, name="scan.pdf", content_type="application/pdf")
        ocr.assert_called_once()
        quota, budget = self.no_quota_or_budget()
        with no_text, quota, budget, patch.object(main, "limit_action"), patch.object(ai_tutor, "extract_pdf_notes") as ocr:
            second = self.upload("sam", raw=scanned, name="copy.pdf", content_type="application/pdf")
        ocr.assert_not_called()
        self.assertEqual(second.text_preview, "OCR text about mitosis")
        self.assertEqual(second.pages_skipped, first.pages_skipped)
        self.assertEqual(second.pages_skipped, 2)

    def test_stored_text_is_capped(self):
        key = ai_cache.extraction_key(b"x", "image/png")
        ai_cache.store_extraction(key, "a" * (note_ingestion.MAX_STORED_CHARS + 50))
        self.assertEqual(len(ai_cache.cached_extraction(key)), note_ingestion.MAX_STORED_CHARS)

    def test_the_key_depends_on_content_type_and_version(self):
        key = ai_cache.extraction_key(PNG_BYTES, "image/png")
        self.assertNotEqual(ai_cache.extraction_key(PNG_BYTES, "image/jpeg"), key)
        with patch.object(ai_tutor, "OCR_IMAGE_PROMPT", "changed"):
            self.assertNotEqual(ai_cache.extraction_key(PNG_BYTES, "image/png"), key)


GRADE = {"correct": True, "score": 90, "mistake_type": None, "misconception": None, "explanation": "Yes: ATP is made there.", "hint": None}


class GradingCacheTests(CacheTestCase):
    def ask(self, student_id, question="Which organelle makes most of a cell's ATP?", reference="Mitochondria", topic="Cells", difficulty=2):
        return questions.save_question(student_id, question, reference, topic, difficulty)

    def answer(self, student_id, question_id, text="the powerhouse of the cell"):
        with self.as_user(student_id):
            return main.analyze_answer(main.AnswerRequest(question_id=question_id, student_answer=text), "Bearer t")

    def test_the_same_answer_is_graded_once(self):
        with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)) as grader:
            first = self.answer("alex", self.ask("alex"))
        grader.assert_called_once()
        _, budget = self.no_quota_or_budget()
        with patch.object(ai_tutor, "grade_answer") as grader, patch.object(main.database, "check_social_rate_limit") as limits, budget, \
                self.assertLogs("bindit.ai", "INFO") as logs:
            second = self.answer("sam", self.ask("sam"), "  the  powerhouse of the cell ")
        grader.assert_not_called()
        limits.assert_not_called()  # no ai_grading quota on a hit
        self.assertTrue(any('"op":"grade_answer","outcome":"cache_hit"' in line for line in logs.output))
        for field in ("correct", "score", "explanation", "grading_source"):
            self.assertEqual(getattr(second, field), getattr(first, field))
        self.assertEqual(second.grading_source, "ai")

    def test_xp_and_attempts_are_unchanged_by_a_hit(self):
        wrong = dict(GRADE, correct=False, score=20, mistake_type="concept", explanation="Not the nucleus.", hint="Think energy.")
        question_id = self.ask("alex")
        with patch.object(ai_tutor, "grade_answer", return_value=wrong):
            self.answer("alex", question_id, "the nucleus")
        with patch.object(ai_tutor, "grade_answer") as grader:
            retried = self.answer("alex", question_id, "the nucleus")  # retrying the same wrong answer
        grader.assert_not_called()
        self.assertFalse(retried.correct)
        self.assertEqual(retried.xp_earned, 0)
        self.assertEqual(questions.get_question("alex", question_id)["completed"], questions.MISSED)
        self.assertEqual(database.get_progress("alex")["attempts"], 2)
        with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)):
            right = self.answer("alex", question_id)
        self.assertEqual(right.xp_earned, main.RETRY_XP)
        with patch.object(ai_tutor, "grade_answer") as grader, self.assertRaises(HTTPException) as caught:
            self.answer("alex", question_id)  # a cached grade never reopens a completed question
        self.assertEqual(caught.exception.status_code, 409)
        grader.assert_not_called()

    def test_any_change_to_question_reference_answer_topic_or_difficulty_is_a_miss(self):
        with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)):
            self.answer("alex", self.ask("alex"))
        variants = [
            {"question": "Which organelle makes ATP in plants?"},
            {"reference": "The mitochondrion"},
            {"topic": "Respiration"},
            {"difficulty": 3},
        ]
        for variant in variants:
            with self.subTest(**variant):
                with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)) as grader:
                    self.answer("sam", self.ask("sam", **variant))
                grader.assert_called_once()
        with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)) as grader:
            self.answer("sam", self.ask("sam"), "The powerhouse of the cell")  # case is kept
        grader.assert_called_once()

    def test_failed_grading_is_not_cached(self):
        question_id = self.ask("alex")
        with patch.object(ai_tutor, "grade_answer", side_effect=ai_tutor.AITutorError("down")), self.assertRaises(HTTPException):
            self.answer("alex", question_id)
        self.assertEqual(self.rows("grading_cache"), [])

    def test_guests_never_use_the_cache(self):
        with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)):
            self.answer("alex", self.ask("alex"))
        question_id = self.ask(main.guest_student_id("guest-1"))
        result = main.analyze_answer(main.AnswerRequest(question_id=question_id, student_answer="the powerhouse of the cell", student_id="guest-1"))
        self.assertEqual(result.grading_source, "fallback")

    def test_the_cache_stores_a_hash_and_the_grade_only(self):
        with patch.object(ai_tutor, "grade_answer", return_value=dict(GRADE)):
            self.answer("alex", self.ask("alex"), "a distinctive answer about mitochondria")
        [row] = self.rows("grading_cache")
        self.assertRegex(row["key"], r"^[0-9a-f]{64}$")
        self.assertNotIn("distinctive", json.dumps(row, default=str))


class CacheLockdownTests(unittest.TestCase):
    def test_cache_tables_are_backend_only(self):
        for name in ai_cache.RETENTION:
            self.assertIn(name, database.RLS_TABLES)
            self.assertIn(name, database.CLIENT_REVOKED_TABLES)
            self.assertIn(name, database.metadata.tables)

    def test_migration_locks_down_every_cache_table(self):
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261007_ai_cache.sql")
        with open(path) as handle:
            sql = handle.read()
        for name in ai_cache.RETENTION:
            self.assertIn(f"'{name}'", sql)
        self.assertIn("to_regclass", sql)
        self.assertIn("enable row level security", sql)
        self.assertIn("revoke all", sql)


if __name__ == "__main__":
    unittest.main()
