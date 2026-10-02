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


if __name__ == "__main__":
    unittest.main()
