import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

import database
import main


class TaskTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def test_task_lifecycle_is_persistent(self):
        due = datetime(2026, 10, 10, 20, 0, tzinfo=timezone.utc)
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}):
            created = main.create_task(main.TaskCreate(title="Review cells", course="Biology", unit="Cells", due_at=due), "Bearer token")
            self.assertEqual(main.get_tasks("Bearer token")[0]["title"], "Review cells")
            updated = main.update_task(created["id"], main.TaskUpdate(status="complete", priority="high"), "Bearer token")
        self.assertEqual(updated["status"], "complete")
        self.assertEqual(updated["priority"], "high")

    def test_task_ownership_is_enforced(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}):
            created = main.create_task(main.TaskCreate(title="Private assignment"), "Bearer a")
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-b"}):
            self.assertEqual(main.get_tasks("Bearer b"), [])
            with self.assertRaises(main.HTTPException) as raised:
                main.update_task(created["id"], main.TaskUpdate(status="complete"), "Bearer b")
            self.assertEqual(raised.exception.status_code, 404)
            with self.assertRaises(main.HTTPException):
                main.delete_task(created["id"], "Bearer b")

    def test_delete_removes_owned_task(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}):
            created = main.create_task(main.TaskCreate(title="Temporary"), "Bearer a")
            self.assertEqual(main.delete_task(created["id"], "Bearer a"), {"deleted": True})
            self.assertEqual(main.get_tasks("Bearer a"), [])

    def test_due_date_can_be_cleared_and_timestamps_are_utc(self):
        due = datetime(2026, 10, 10, 20, 0, tzinfo=timezone.utc)
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}):
            created = main.create_task(main.TaskCreate(title="Essay", due_at=due), "Bearer a")
            listed = main.get_tasks("Bearer a")[0]
            self.assertEqual(listed["due_at"], due)
            self.assertIsNotNone(listed["created_at"].tzinfo)
            cleared = main.update_task(created["id"], main.TaskUpdate(due_at=None), "Bearer a")
        self.assertIsNone(cleared["due_at"])

    def test_blank_titles_are_rejected(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}):
            with self.assertRaises(main.HTTPException) as raised:
                main.create_task(main.TaskCreate(title="   "), "Bearer a")
            self.assertEqual(raised.exception.status_code, 400)
            created = main.create_task(main.TaskCreate(title="Real"), "Bearer a")
            with self.assertRaises(main.HTTPException) as raised:
                main.update_task(created["id"], main.TaskUpdate(title="  "), "Bearer a")
            self.assertEqual(raised.exception.status_code, 400)

    def test_task_creation_is_rate_limited(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "student-a"}), patch.object(main, "TASK_CREATE_LIMIT", 2):
            main.create_task(main.TaskCreate(title="One"), "Bearer a")
            main.create_task(main.TaskCreate(title="Two"), "Bearer a")
            with self.assertRaises(main.HTTPException) as raised:
                main.create_task(main.TaskCreate(title="Three"), "Bearer a")
        self.assertEqual(raised.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
