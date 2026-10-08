import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

import database


class StreakDayTests(unittest.TestCase):
    def setUp(self):
        database.init_db()
        self.token = database.client_tz_offset.set(420)  # California in summer (UTC-7)
        self.addCleanup(database.client_tz_offset.reset, self.token)

    def test_local_today_follows_the_students_time_zone(self):
        tuesday_evening_utc = datetime(2026, 10, 7, 1, 0, tzinfo=timezone.utc)  # Tue 6pm in California
        self.assertEqual(database.local_today(tuesday_evening_utc), date(2026, 10, 6))
        token = database.client_tz_offset.set(0)
        self.assertEqual(database.local_today(tuesday_evening_utc), date(2026, 10, 7))
        database.client_tz_offset.reset(token)

    def test_consecutive_local_days_keep_the_streak_across_the_utc_midnight(self):
        monday = database.local_today(datetime(2026, 10, 5, 16, 0, tzinfo=timezone.utc))   # Mon 9am local
        tuesday = database.local_today(datetime(2026, 10, 7, 1, 0, tzinfo=timezone.utc))   # Tue 6pm local
        self.assertEqual(database._next_streak(5, monday, True, tuesday), 6)

    def test_a_broken_streak_shows_zero(self):
        today = date(2026, 10, 7)
        self.assertEqual(database.live_streak(5, today, today), 5)
        self.assertEqual(database.live_streak(5, today - timedelta(days=1), today), 5)
        self.assertEqual(database.live_streak(5, today - timedelta(days=2), today), 0)
        self.assertEqual(database.live_streak(0, None, today), 0)

    def test_header_offsets_are_clamped(self):
        self.assertEqual(database.clamp_tz_offset("420"), 420)
        self.assertEqual(database.clamp_tz_offset("99999"), 840)
        self.assertEqual(database.clamp_tz_offset("nonsense"), 0)

    def test_a_study_day_from_reviews_starts_and_keeps_a_streak(self):
        student = "streak-review-student"
        self.assertEqual(database.mark_study_day(student), 1)
        self.assertEqual(database.mark_study_day(student), 1)  # same day: unchanged
        self.assertEqual(database.get_progress(student)["streak"], 1)

    def test_finishing_a_practice_test_counts_as_a_study_day(self):
        student = "streak-test-student"
        self.assertEqual(database.award_xp(student, 4)["streak"], 1)
        self.assertEqual(database.get_progress(student)["streak"], 1)


if __name__ == "__main__":
    unittest.main()
