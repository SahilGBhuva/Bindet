import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

import database
from sqlalchemy import select, update


class XpLockTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()

    def locks_taken(self, call):
        keys = []
        real = database._advisory_lock
        with mock.patch.object(database, "_advisory_lock", side_effect=lambda conn, key: (keys.append(key), real(conn, key))):
            call()
        return keys

    def test_answers_and_practice_rounds_take_the_xp_lock(self):
        student = "xp-lock-student"
        self.assertIn(f"xp:{student}", self.locks_taken(lambda: database.update_progress(student, "t", True, 5)))

        def round_xp():
            with database.engine().begin() as connection:
                database.award_xp_in(connection, student, 3, active=True)
        self.assertIn(f"xp:{student}", self.locks_taken(round_xp))

    def test_creating_the_first_progress_row_twice_does_not_fail(self):
        student = "xp-first-row"
        now = datetime.now(timezone.utc)
        with database.engine().begin() as connection:
            database._progress_row(connection, student, now)
            row = database._progress_row(connection, student, now)
        self.assertEqual(row["total_xp"], 0)

    def test_counters_are_relative_to_the_stored_value(self):
        student = "xp-relative"
        database.update_progress(student, "t", True, 5)
        # Another writer adds XP after this request read the row: it must not be overwritten.
        real_row = database._progress_row

        def stale_then_bump(connection, student_id, now):
            row = real_row(connection, student_id, now)
            connection.execute(update(database.student_progress).where(
                database.student_progress.c.student_id == student_id,
            ).values(total_xp=database.student_progress.c.total_xp + 100,
                     attempts=database.student_progress.c.attempts + 1))
            return row
        with mock.patch.object(database, "_progress_row", side_effect=stale_then_bump):
            result = database.update_progress(student, "t", False, 0)
        self.assertEqual(result["total_xp"], 105)
        self.assertEqual(result["attempts"], 3)

        with mock.patch.object(database, "_progress_row", side_effect=stale_then_bump):
            with database.engine().begin() as connection:
                awarded = database.award_xp_in(connection, student, 2, active=True)
        self.assertEqual(awarded["total_xp"], 207)


if __name__ == "__main__":
    unittest.main()
