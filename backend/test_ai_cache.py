"""AI result caches: hits skip the model, the per-student AI quotas and the global AI budget.

Every AI call is mocked.
"""
import json
import os
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi import HTTPException
from sqlalchemy import select, update

import ai_cache
import ai_tutor
import database
import flashcards
import main
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
