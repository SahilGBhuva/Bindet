"""Instant Study: key points (one small grounded model call, cached per owner and note text in
ai_cache, limits and budget) and revealing a quiz answer (closes the question, no XP).
Every AI call is mocked at ai_tutor._post, so the operation registry checks still run."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ.setdefault("POCKET_TUTOR_DB_PATH", TEST_DB.name)

from fastapi.testclient import TestClient
from sqlalchemy import delete

import ai_cache
import ai_tutor
import database
import main
import note_store
import questions
import rate_limit
import study_guides

NOTE_TEXT = (
    "Photosynthesis happens in the chloroplasts of plant cells. Chlorophyll absorbs light energy, mostly red and blue light. "
    "The light-dependent reactions take place in the thylakoid membranes and split water, releasing oxygen as a by-product. "
    "They produce ATP and NADPH, which carry energy to the Calvin cycle. The Calvin cycle happens in the stroma and uses "
    "carbon dioxide to build glucose. The enzyme rubisco fixes carbon dioxide in the first step of the Calvin cycle. "
    "Limiting factors for photosynthesis include light intensity, carbon dioxide concentration and temperature."
)
POINTS = [
    "Photosynthesis happens in the chloroplasts of plant cells.",
    "Chlorophyll absorbs light energy, mostly red and blue light.",
    "The light-dependent reactions split water in the thylakoid membranes and release oxygen.",
    "ATP and NADPH carry energy to the Calvin cycle.",
    "The Calvin cycle happens in the stroma and uses carbon dioxide to build glucose.",
    "Rubisco fixes carbon dioxide in the first step of the Calvin cycle.",
    "Limiting factors include light intensity, carbon dioxide concentration and temperature.",
]


def model_reply(content: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(content)}}]}


class FakeModel:
    def __init__(self, bullets=None):
        self.bullets = POINTS if bullets is None else bullets
        self.calls: list[dict] = []

    def __call__(self, payload, timeout=None):
        self.calls.append(payload)
        schema = payload["response_format"]["json_schema"]["name"]
        if schema == "key_points":
            return model_reply({"sections": [{"heading": "Key points", "bullets": self.bullets, "terms": [], "items": []}]})
        raise AssertionError(f"unexpected call {schema}")


def tearDownModule():
    if os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


class InstantTestCase(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        note_store.init_notes()
        study_guides.reset_guides()
        questions.reset_questions()
        ai_cache.reset_caches()
        rate_limit.limiter.reset()
        with database.engine().begin() as connection:
            connection.execute(delete(note_store.notes))
        self.client = TestClient(main.app)
        self.model = FakeModel()
        self.model_patch = patch.object(ai_tutor, "_post", side_effect=self.model)
        self.model_patch.start()
        self.addCleanup(self.model_patch.stop)
        self.note_id = self.note("alex")["id"]

    def note(self, student="alex", text=NOTE_TEXT, course="Biology", unit="Photosynthesis", name="photo.txt"):
        return note_store.save_note(student, course, unit, name, "text/plain", text, len(text))

    def call(self, method, path, student="alex", **kwargs):
        with patch.object(main.auth, "authenticated_user", return_value={"id": student, "email_confirmed_at": "2026-01-01T00:00:00Z"}):
            return self.client.request(method, path, headers={"Authorization": f"Bearer token-{student}"}, **kwargs)

    def key_points(self, student="alex", course="Biology", unit="Photosynthesis"):
        return self.call("POST", "/api/instant-study/key-points", student, json={"course": course, "unit": unit})


class KeyPointsTests(InstantTestCase):
    def test_writes_four_to_six_grounded_points_once_then_serves_the_cache(self):
        first = self.key_points()
        self.assertEqual(first.status_code, 200, first.text)
        body = first.json()
        self.assertEqual(body["source"], "generated")
        self.assertEqual(body["points"], POINTS[:study_guides.KEY_POINTS_MAX])
        self.assertEqual(len(self.model.calls), 1)
        payload = self.model.calls[0]
        self.assertEqual(payload["max_tokens"], study_guides.KEY_POINTS_TOKENS)
        self.assertIn("Key points", payload["messages"][1]["content"])
        self.assertIn("chloroplasts", payload["messages"][1]["content"])  # grounded in the notes sent

        again = self.key_points()
        self.assertEqual(again.json()["source"], "cached")
        self.assertEqual(again.json()["points"], body["points"])
        self.assertEqual(len(self.model.calls), 1)  # a repeat session costs no AI

    def test_drops_points_that_are_not_in_the_notes(self):
        self.model.bullets = [*POINTS[:4], "The French Revolution began in 1789 with the storming of the Bastille in Paris."]
        body = self.key_points().json()
        self.assertEqual(body["points"], POINTS[:4])

    def test_changed_notes_get_new_points(self):
        self.key_points()
        self.note(text="Guard cells open and close the stomata on leaves to control carbon dioxide intake and water loss "
                       "during photosynthesis in plant cells.", name="stomata.txt")
        self.model.bullets = [*POINTS[:3], "Guard cells open and close the stomata to control water loss."]
        body = self.key_points().json()
        self.assertEqual(body["source"], "generated")
        self.assertEqual(len(self.model.calls), 2)

    def test_cache_is_per_student(self):
        self.note("sam")
        self.key_points("alex")
        self.assertEqual(self.key_points("sam").json()["source"], "generated")
        self.assertEqual(len(self.model.calls), 2)

    def test_does_not_save_a_study_guide(self):
        self.key_points()
        self.assertEqual(study_guides.list_guides("alex", "Biology", "Photosynthesis"), [])

    def test_hidden_kind_leaves_saved_guide_keys_alone(self):
        self.assertNotIn("key_points", study_guides.KINDS)
        self.assertNotIn("key_points", main.GuideKind.__args__)
        bad = self.call("POST", "/api/study-guides", json={"course": "Biology", "unit": "Photosynthesis", "kind": "key_points"})
        self.assertEqual(bad.status_code, 422)
        self.assertNotEqual(ai_cache.key_points_version(), ai_cache.guide_version())

    def test_no_notes_is_a_friendly_400(self):
        response = self.key_points(unit="Cells")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "no_notes")
        self.assertEqual(self.model.calls, [])

    def test_daily_limit_counts_only_model_calls(self):
        self.note(unit="Respiration", text=NOTE_TEXT.replace("Photosynthesis", "Respiration and photosynthesis"))
        with patch.object(main, "INSTANT_KEY_POINTS_PER_DAY", 1):
            self.assertEqual(self.key_points().status_code, 200)
            self.assertEqual(self.key_points().json()["source"], "cached")  # cache hits are free
            limited = self.key_points(unit="Respiration")
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()["detail"]["code"], "rate_limited")
        self.assertEqual(len(self.model.calls), 1)

    def test_global_budget_used_up_skips_the_model(self):
        with patch.object(main, "global_ai_available", return_value=False):
            response = self.key_points()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "ai_daily_limit")
        self.assertEqual(self.model.calls, [])

    def test_account_share_used_up_is_a_429(self):
        with patch.object(main, "account_ai_share_available", return_value=False):
            response = self.key_points()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["detail"]["code"], "ai_daily_limit")
        self.assertEqual(self.model.calls, [])

    def test_model_failure_is_a_503_and_nothing_is_cached(self):
        self.model.bullets = ["The French Revolution began in 1789 with the storming of the Bastille in Paris."]
        response = self.key_points()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "ai_bad_output")
        self.model.bullets = POINTS
        self.assertEqual(self.key_points().json()["source"], "generated")

    def test_deleting_a_note_drops_the_cached_points(self):
        self.key_points()
        text, _ = main.guide_source("alex", "Biology", "Photosynthesis", "key_points")
        key = ai_cache.key_points_key(owner_id="alex", course="Biology", unit="Photosynthesis", source_text=text)
        self.assertIsNotNone(ai_cache.cached_guide(key, "alex"))
        self.assertEqual(self.call("DELETE", f"/api/notes/{self.note_id}").status_code, 200)
        self.assertIsNone(ai_cache.cached_guide(key, "alex"))

    def test_requires_sign_in(self):
        response = self.client.post("/api/instant-study/key-points", json={"course": "Biology", "unit": "Photosynthesis"})
        self.assertEqual(response.status_code, 401)


class RevealTests(InstantTestCase):
    def question(self, student="alex"):
        return questions.save_question(student, "Where does the Calvin cycle happen?", "stroma", "Photosynthesis", 1)

    def test_reveal_shows_the_answer_and_closes_the_question_without_xp(self):
        question_id = self.question()
        response = self.call("POST", f"/api/questions/{question_id}/reveal")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["correct_answer"], "stroma")
        self.assertEqual(questions.get_question("alex", question_id)["completed"], questions.COMPLETED)
        answer = self.call("POST", "/api/analyze-answer", json={"question_id": question_id, "student_answer": "stroma", "student_id": "alex"})
        self.assertEqual(answer.status_code, 409)
        progress = database.get_progress("alex")
        self.assertEqual(progress["total_xp"] if progress else 0, 0)

    def test_reveal_after_a_correct_answer_still_works(self):
        question_id = self.question()
        answered = self.call("POST", "/api/analyze-answer", json={"question_id": question_id, "student_answer": "stroma", "student_id": "alex"})
        self.assertEqual(answered.status_code, 200)
        self.assertTrue(answered.json()["correct"])
        self.assertEqual(self.call("POST", f"/api/questions/{question_id}/reveal").json()["correct_answer"], "stroma")

    def test_another_students_question_is_not_found(self):
        question_id = self.question("sam")
        self.assertEqual(self.call("POST", f"/api/questions/{question_id}/reveal").status_code, 404)
        self.assertEqual(questions.get_question("sam", question_id)["completed"], questions.OPEN)


if __name__ == "__main__":
    unittest.main()
