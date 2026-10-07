"""Spaced-repetition review: scheduler math, queue, summary, ownership, cleanup and the API."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ.setdefault("POCKET_TUTOR_DB_PATH", TEST_DB.name)

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import insert, select

import account_deletion
import database
import flashcards
import main
import note_store
import rate_limit
import review

NOW = datetime(2026, 10, 7, 15, 0, tzinfo=timezone.utc)


def tearDownModule():
    if os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


def state(interval=0.0, ease=2.5, reps=0, lapses=0):
    return {"interval_days": interval, "ease": ease, "reps": reps, "lapses": lapses}


class SchedulerTests(unittest.TestCase):
    def test_new_card_grades(self):
        again = review.next_values(None, "again", "c1")
        self.assertAlmostEqual(again["interval_days"], 10 / 1440)
        self.assertEqual((again["reps"], again["lapses"]), (0, 0))  # never graduated: not a lapse
        self.assertAlmostEqual(again["ease"], 2.3)
        hard = review.next_values(None, "hard", "c1")
        self.assertEqual((hard["interval_days"], hard["reps"]), (0.5, 0))
        self.assertAlmostEqual(hard["ease"], 2.35)
        good = review.next_values(None, "good", "c1")
        self.assertEqual((good["interval_days"], good["reps"], good["ease"]), (1.0, 1, 2.5))
        easy = review.next_values(None, "easy", "c1")
        self.assertEqual((easy["interval_days"], easy["reps"]), (4.0, 1))
        self.assertAlmostEqual(easy["ease"], 2.65)

    def test_good_steps_one_then_three_then_interval_times_ease(self):
        first = review.next_values(None, "good", "card-x")
        second = review.next_values(first, "good", "card-x")
        self.assertEqual(second["interval_days"], 3.0 if 3 * review._fuzz("card-x", 1) < 3.5 else 4.0)
        third = review.next_values(state(10, 2.5, 3), "good", "card-x")
        self.assertEqual(third["interval_days"], float(round(25 * review._fuzz("card-x", 3))))
        self.assertEqual(third["reps"], 4)

    def test_hard_and_easy_on_review_cards(self):
        hard = review.next_values(state(10, 2.5, 3), "hard", "c")
        self.assertEqual(hard["interval_days"], float(round(12 * review._fuzz("c", 3))))
        self.assertAlmostEqual(hard["ease"], 2.35)
        easy = review.next_values(state(10, 2.5, 3), "easy", "c")
        self.assertEqual(easy["interval_days"], float(round(32.5 * review._fuzz("c", 3))))
        self.assertAlmostEqual(easy["ease"], 2.65)

    def test_grades_are_ordered_for_every_state(self):
        for current in (None, state(1, 2.5, 1), state(3, 1.3, 2), state(40, 2.8, 6)):
            values = review.preview(current, "order")
            self.assertLess(values["again"], values["hard"])
            self.assertLessEqual(values["hard"], values["good"])
            self.assertLessEqual(values["good"], values["easy"])

    def test_lapse_resets_and_counts(self):
        lapsed = review.next_values(state(20, 2.5, 5, 1), "again", "c")
        self.assertEqual((lapsed["reps"], lapsed["lapses"]), (0, 2))
        self.assertAlmostEqual(lapsed["interval_days"], 10 / 1440)
        self.assertAlmostEqual(lapsed["ease"], 2.3)

    def test_ease_floor(self):
        current = state(5, 1.35, 3)
        for grade in ("again", "hard"):
            self.assertEqual(review.next_values(current, grade, "c")["ease"], review.MIN_EASE)
        self.assertEqual(review.next_values(state(5, 1.3, 3), "again", "c")["ease"], 1.3)

    def test_max_interval(self):
        for grade in ("hard", "good", "easy"):
            self.assertEqual(review.next_values(state(340, 2.5, 9), grade, "c")["interval_days"], 365.0)

    def test_fuzz_is_deterministic_and_within_five_percent(self):
        factors = [review._fuzz(f"card-{index}", 4) for index in range(200)]
        self.assertTrue(all(0.95 <= factor <= 1.05 for factor in factors))
        self.assertGreater(len(set(factors)), 150)
        self.assertEqual(review._fuzz("card-7", 4), review._fuzz("card-7", 4))
        self.assertEqual(review.next_values(state(30, 2.5, 4), "good", "same"), review.next_values(state(30, 2.5, 4), "good", "same"))
        # No fuzz below three days.
        self.assertEqual(review.next_values(state(1, 1.3, 2), "hard", "any")["interval_days"], 2.0)

    def test_invalid_grade(self):
        with self.assertRaises(ValueError):
            review.next_values(None, "perfect", "c")

    def test_due_dates_follow_the_local_day(self):
        # 15:00 UTC is 08:00 in UTC-7 (tz_offset 420); tomorrow there starts at 07:00 UTC.
        due = review.due_at_for(1.0, NOW, 420)
        self.assertEqual(due, datetime(2026, 10, 8, 7, 0, tzinfo=timezone.utc))
        self.assertEqual(review.due_at_for(10 / 1440, NOW, 420), NOW + timedelta(minutes=10))
        # 23:30 UTC is already the 8th in UTC+2 (tz_offset -120).
        late = datetime(2026, 10, 7, 23, 30, tzinfo=timezone.utc)
        today, tomorrow = review.day_bounds(late, -120)
        self.assertEqual(today, datetime(2026, 10, 7, 22, 0, tzinfo=timezone.utc))
        self.assertEqual(tomorrow, datetime(2026, 10, 8, 22, 0, tzinfo=timezone.utc))
        self.assertEqual(review.clamp_offset(5000), 840)
        self.assertEqual(review.clamp_offset(-5000), -840)


class ReviewStoreTestCase(unittest.TestCase):
    def setUp(self):
        account_deletion.init_all()
        database.reset_db()
        flashcards.reset_flashcards()
        rate_limit.limiter.reset()
        with database.engine().begin() as connection:
            connection.execute(note_store.notes.delete())
        self.client = TestClient(main.app)

    def tearDown(self):
        # Leave the shared database as other test modules expect it (one process under pytest).
        flashcards.reset_flashcards()
        database.reset_db()
        rate_limit.limiter.reset()
        with database.engine().begin() as connection:
            connection.execute(note_store.notes.delete())

    def note_with_cards(self, owner="alex", count=3, course="Biology", unit="Cells", name="cells.txt", created_at=None):
        note = note_store.save_note(owner, course, unit, name, "text/plain", "Cells have parts.", 17)
        if created_at is not None:
            with database.engine().begin() as connection:
                connection.execute(note_store.notes.update().where(note_store.notes.c.id == note["id"]).values(created_at=created_at))
        ids = []
        with database.engine().begin() as connection:
            for position in range(count):
                card_id = f"{note['id'][:8]}-{position}"
                connection.execute(insert(flashcards.cards).values(
                    id=card_id, owner_id=owner, note_id=note["id"], course=course, unit=unit,
                    front=f"{name} question {position}?", back=f"Answer {position}", topic="cells",
                    front_key=f"{name}-{position}", position=position, created_at=NOW))
                ids.append(card_id)
        return note["id"], ids

    def as_user(self, student_id):
        return patch.object(main.auth, "authenticated_user", return_value={"id": student_id})

    def review_rows(self, owner=None):
        query = select(flashcards.reviews)
        if owner:
            query = query.where(flashcards.reviews.c.owner_id == owner)
        with database.engine().connect() as connection:
            return connection.execute(query).mappings().all()


class QueueTests(ReviewStoreTestCase):
    def test_new_cards_come_in_note_order_and_count_as_new_not_due(self):
        _, older = self.note_with_cards(name="old.txt", created_at=NOW - timedelta(days=2))
        _, newer = self.note_with_cards(name="new.txt", created_at=NOW - timedelta(days=1))
        result = review.queue("alex", "Biology", "Cells", now=NOW)
        self.assertEqual([card["id"] for card in result["cards"]], older + newer)
        self.assertEqual(result["cards"][0]["review"]["state"], "new")
        self.assertEqual(set(result["cards"][0]["review"]["preview"]), {"again", "hard", "good", "easy"})
        totals = review.summary("alex", now=NOW)
        self.assertEqual((totals["due"], totals["new_available"], totals["next_due_at"]), (0, 6, None))
        self.assertEqual(totals["by_unit"], [{"course": "Biology", "unit": "Cells", "due": 0, "new": 6}])

    def test_order_learning_then_reviews_oldest_first_then_new(self):
        _, ids = self.note_with_cards(count=5)
        review.grade("alex", ids[0], "good", now=NOW - timedelta(days=3))     # due 2 days ago
        review.grade("alex", ids[1], "good", now=NOW - timedelta(days=2))     # due yesterday
        review.grade("alex", ids[2], "again", now=NOW - timedelta(minutes=30))  # learning, overdue
        review.grade("alex", ids[3], "easy", now=NOW - timedelta(days=1))     # due in 3 days
        result = review.queue("alex", now=NOW)
        self.assertEqual([card["id"] for card in result["cards"]], [ids[2], ids[0], ids[1], ids[4]])
        self.assertEqual([card["review"]["state"] for card in result["cards"]], ["learning", "review", "review", "new"])
        totals = review.summary("alex", now=NOW)
        self.assertEqual(totals["due"], 3)
        self.assertEqual(totals["next_due_at"], review._iso(review.due_at_for(4.0, NOW - timedelta(days=1))))

    def test_learning_card_not_yet_due_waits(self):
        _, ids = self.note_with_cards(count=1)
        review.grade("alex", ids[0], "again", now=NOW)
        self.assertEqual(review.queue("alex", now=NOW + timedelta(minutes=5))["cards"], [])
        self.assertEqual([card["id"] for card in review.queue("alex", now=NOW + timedelta(minutes=11))["cards"]], ids)

    def test_daily_new_card_cap_and_limit(self):
        _, ids = self.note_with_cards(count=30)
        first = review.queue("alex", now=NOW, limit=100)["cards"]
        self.assertEqual(len(first), 20)
        self.assertEqual(len(review.queue("alex", now=NOW, limit=5)["cards"]), 5)
        for card_id in ids[:15]:
            review.grade("alex", card_id, "good", now=NOW)
        # 15 introduced today: 5 new left, and the graded ones are not due until tomorrow.
        left = review.queue("alex", now=NOW + timedelta(minutes=1), limit=100)["cards"]
        self.assertEqual([card["id"] for card in left], ids[15:20])
        self.assertEqual(review.summary("alex", now=NOW)["new_available"], 5)
        # Next day, a fresh allowance (only 15 unseen cards remain), plus the 15 cards now due.
        tomorrow = review.queue("alex", now=NOW + timedelta(days=1), limit=100)["cards"]
        self.assertEqual(sum(card["review"]["state"] == "review" for card in tomorrow), 15)
        self.assertEqual(sum(card["review"]["state"] == "new" for card in tomorrow), 15)

    def test_tz_offset_decides_which_day_a_review_is_due(self):
        _, ids = self.note_with_cards(count=1)
        # Graded "good" at 08:00 in UTC-7: due at local midnight, 07:00 UTC on the 8th.
        review.grade("alex", ids[0], "good", tz_offset=420, now=NOW)
        just_before = datetime(2026, 10, 8, 6, 59, tzinfo=timezone.utc)
        self.assertEqual(review.summary("alex", tz_offset=420, now=just_before)["due"], 0)
        self.assertEqual(review.summary("alex", tz_offset=420, now=just_before + timedelta(minutes=1))["due"], 1)
        # In UTC+0 the same moment is already the 8th, so the card is due "today".
        self.assertEqual(review.summary("alex", tz_offset=0, now=just_before)["due"], 1)

    def test_scope_filters_and_by_unit(self):
        self.note_with_cards(count=2, unit="Cells")
        self.note_with_cards(count=1, unit="Genes", name="genes.txt")
        self.note_with_cards(count=1, course="History", unit="Rome", name="rome.txt")
        self.assertEqual(len(review.queue("alex", "Biology", None, now=NOW)["cards"]), 3)
        self.assertEqual(len(review.queue("alex", "Biology", "Genes", now=NOW)["cards"]), 1)
        self.assertEqual([(row["course"], row["unit"], row["new"]) for row in review.summary("alex", now=NOW)["by_unit"]],
                         [("Biology", "Cells", 2), ("Biology", "Genes", 1), ("History", "Rome", 1)])

    def test_duplicate_notes_show_each_question_once(self):
        self.note_with_cards(count=2, name="same.txt")
        self.note_with_cards(count=2, name="same.txt")
        self.assertEqual(len(review.queue("alex", now=NOW)["cards"]), 2)


class GradeTests(ReviewStoreTestCase):
    def test_grade_stores_state(self):
        _, ids = self.note_with_cards(count=1)
        result = review.grade("alex", ids[0], "good", now=NOW)
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["review"]["state"], "review")
        self.assertEqual(result["review"]["interval_days"], 1.0)
        self.assertEqual(result["next_due_at"], review._iso(datetime(2026, 10, 8, tzinfo=timezone.utc)))
        row = self.review_rows("alex")[0]
        self.assertEqual((row["reps"], row["last_grade"]), (1, "good"))

    def test_double_tap_within_two_seconds_is_ignored(self):
        _, ids = self.note_with_cards(count=1)
        first = review.grade("alex", ids[0], "good", now=NOW)
        again = review.grade("alex", ids[0], "good", now=NOW + timedelta(seconds=1))
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["review"]["due_at"], first["review"]["due_at"])
        self.assertEqual(self.review_rows("alex")[0]["reps"], 1)
        later = review.grade("alex", ids[0], "good", now=NOW + timedelta(seconds=3))
        self.assertFalse(later["duplicate"])
        self.assertEqual(self.review_rows("alex")[0]["reps"], 2)

    def test_other_students_cannot_grade_or_see_cards(self):
        _, ids = self.note_with_cards(owner="alex", count=2)
        self.assertIsNone(review.grade("sam", ids[0], "good", now=NOW))
        self.assertEqual(self.review_rows(), [])
        self.assertEqual(review.queue("sam", now=NOW)["cards"], [])
        self.assertEqual(review.summary("sam", now=NOW)["new_available"], 0)
        review.grade("alex", ids[0], "good", now=NOW)
        self.assertEqual(review.summary("sam", now=NOW + timedelta(days=5))["due"], 0)

    def test_deleting_a_note_removes_review_state(self):
        note_id, ids = self.note_with_cards(count=2)
        _, kept = self.note_with_cards(count=1, name="other.txt")
        for card_id in ids + kept:
            review.grade("alex", card_id, "good", now=NOW)
        self.assertTrue(flashcards.delete_note_and_cards("alex", note_id))
        self.assertEqual([row["card_id"] for row in self.review_rows()], kept)

    def test_remaking_a_notes_cards_drops_old_review_state(self):
        note_id, ids = self.note_with_cards(count=1)
        review.grade("alex", ids[0], "good", now=NOW)
        flashcards.replace("alex", note_id, "Biology", "Cells", [{"front": "New?", "back": "Yes", "topic": "t"}], "h" * 64)
        self.assertEqual(self.review_rows(), [])

    def test_moving_notes_keeps_review_state(self):
        _, ids = self.note_with_cards(count=1)
        review.grade("alex", ids[0], "good", now=NOW)
        flashcards.move_notes("alex", "Biology", "Cells", "Biology", "Cell biology")
        self.assertEqual(len(self.review_rows()), 1)
        due = review.queue("alex", "Biology", "Cell biology", now=NOW + timedelta(days=1))["cards"]
        self.assertEqual([(card["id"], card["review"]["state"]) for card in due], [(ids[0], "review")])

    def test_account_deletion_removes_review_rows(self):
        database.onboard_account("alex", "alex", "Alex", None)
        _, ids = self.note_with_cards(owner="alex", count=1)
        _, sams = self.note_with_cards(owner="sam", count=1, name="sam.txt")
        review.grade("alex", ids[0], "good", now=NOW)
        review.grade("sam", sams[0], "good", now=NOW)
        account_deletion.delete_account_data("alex")
        self.assertEqual([row["owner_id"] for row in self.review_rows()], ["sam"])

    def test_table_is_locked_down(self):
        self.assertIn("flashcard_reviews", flashcards.FLASHCARD_TABLES)
        self.assertIn("flashcard_reviews", database.RLS_TABLES)
        self.assertIn("flashcard_reviews", database.CLIENT_REVOKED_TABLES)
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261011_flashcard_reviews.sql")
        with open(path, encoding="utf-8") as handle:
            sql = handle.read().lower()
        self.assertIn("to_regclass('public.flashcard_reviews')", sql)
        self.assertIn("enable row level security", sql)
        self.assertIn("revoke all on table public.flashcard_reviews from anon, authenticated", sql)
        code = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
        self.assertNotIn("drop ", code)
        self.assertNotIn("delete ", code)


class ReviewApiTests(ReviewStoreTestCase):
    def call(self, method, path, student="alex", **kwargs):
        with self.as_user(student):
            return self.client.request(method, path, headers={"Authorization": "Bearer t"}, **kwargs)

    def test_requires_sign_in(self):
        self.assertEqual(self.client.get("/api/review/summary").status_code, 401)
        self.assertEqual(self.client.post("/api/review/x", json={"grade": "good"}).status_code, 401)

    def test_summary_queue_and_grade(self):
        _, ids = self.note_with_cards(count=2)
        summary = self.call("GET", "/api/review/summary?tz_offset=420").json()
        self.assertEqual((summary["due"], summary["new_available"]), (0, 2))
        queue = self.call("GET", "/api/review/queue", params={"course": "Biology", "unit": "Cells", "limit": 20}).json()
        self.assertEqual([card["id"] for card in queue["cards"]], ids)
        graded = self.call("POST", f"/api/review/{ids[0]}", json={"grade": "again", "tz_offset": 420})
        self.assertEqual(graded.status_code, 200, graded.text)
        self.assertEqual(graded.json()["review"]["state"], "learning")
        self.assertEqual(set(graded.json()), {"card_id", "review", "next_due_at", "duplicate"})

    def test_validation(self):
        _, ids = self.note_with_cards(count=1)
        self.assertEqual(self.call("POST", f"/api/review/{ids[0]}", json={"grade": "perfect"}).status_code, 422)
        self.assertEqual(self.call("POST", f"/api/review/{ids[0]}", json={"grade": "good", "xp": 9}).status_code, 422)
        self.assertEqual(self.call("GET", "/api/review/queue?limit=0").status_code, 422)
        self.assertEqual(self.call("GET", "/api/review/queue?limit=101").status_code, 422)

    def test_other_students_card_is_404(self):
        _, ids = self.note_with_cards(owner="alex", count=1)
        response = self.call("POST", f"/api/review/{ids[0]}", student="sam", json={"grade": "good"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "card_not_found")
        self.assertEqual(self.call("GET", "/api/review/queue", student="sam").json(), {"cards": []})

    def test_rate_limit(self):
        _, ids = self.note_with_cards(count=1)
        with patch.object(main, "REVIEW_GRADES_PER_HOUR", 2):
            for _ in range(2):
                self.assertEqual(self.call("POST", f"/api/review/{ids[0]}", json={"grade": "good"}).status_code, 200)
            limited = self.call("POST", f"/api/review/{ids[0]}", json={"grade": "good"})
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()["detail"]["code"], "rate_limited")
        self.assertIn("Retry-After", limited.headers)

    def test_direct_call_raises_http_errors(self):
        with self.as_user("alex"), self.assertRaises(HTTPException) as caught:
            main.grade_review_card("missing", main.ReviewGradeRequest(grade="good"), "Bearer t")
        self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
