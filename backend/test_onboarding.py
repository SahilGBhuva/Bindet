import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi.testclient import TestClient
from sqlalchemy import delete, insert

import auth
import database
import flashcards
import main
import note_store
import onboarding
import practice
import practice_tests
import rate_limit
import tutor

NEW = "new-student"
OLD = "old-student"


class OnboardingTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def setUp(self):
        onboarding.init_onboarding()
        database.reset_db()
        onboarding.reset_onboarding()
        flashcards.reset_flashcards()
        tutor.reset_tutor()
        practice_tests.reset_practice()
        practice.reset_practice()
        note_store.init_notes()
        with database.engine().begin() as connection:
            connection.execute(delete(note_store.notes))
        rate_limit.limiter.reset()
        self.client = TestClient(main.app)

    def call(self, method, user=NEW, json=None):
        with patch.object(auth, "authenticated_user", return_value={"id": user}):
            return self.client.request(method, "/api/account/onboarding", json=json, headers={"Authorization": "Bearer token"})

    def test_a_brand_new_account_needs_setup_and_has_nothing_done(self):
        result = self.call("GET")
        self.assertEqual(result.status_code, 200)
        body = result.json()
        self.assertFalse(body["setup_done"])
        self.assertFalse(body["tracked"])
        self.assertFalse(body["has_profile"])
        self.assertEqual(body["steps"], {"notes": False, "flashcards": False, "quiz": False, "tutor": False})

    def test_an_older_account_with_a_profile_is_never_shown_the_setup_or_checklist(self):
        database.onboard_account(OLD, "oldie", "Old Timer", None)
        body = self.call("GET", user=OLD).json()
        self.assertTrue(body["setup_done"])
        self.assertTrue(body["has_profile"])
        self.assertFalse(body["tracked"])

    def test_finishing_or_skipping_setup_is_remembered_on_the_server(self):
        body = self.call("PUT", json={"setup_done": True}).json()
        self.assertTrue(body["setup_done"])
        self.assertTrue(body["tracked"])
        self.assertFalse(body["checklist_dismissed"])
        # Repeating it keeps the first time.
        with database.engine().connect() as connection:
            first = connection.execute(onboarding.state.select()).mappings().one()["setup_done_at"]
        self.call("PUT", json={"setup_done": True})
        with database.engine().connect() as connection:
            again = connection.execute(onboarding.state.select()).mappings().one()["setup_done_at"]
        self.assertEqual(first, again)
        self.assertTrue(self.call("GET").json()["setup_done"])

    def test_the_checklist_can_be_dismissed_and_shown_again(self):
        self.call("PUT", json={"setup_done": True})
        self.assertTrue(self.call("PUT", json={"checklist_dismissed": True}).json()["checklist_dismissed"])
        self.assertFalse(self.call("PUT", json={"checklist_dismissed": False}).json()["checklist_dismissed"])

    def test_state_is_per_account(self):
        self.call("PUT", json={"setup_done": True, "checklist_dismissed": True})
        other = self.call("GET", user="someone-else").json()
        self.assertFalse(other["setup_done"])
        self.assertFalse(other["checklist_dismissed"])

    def test_steps_tick_from_real_data(self):
        now = datetime.now(timezone.utc)
        note = note_store.save_note(NEW, "Biology", "Unit 1", "cells.txt", "text/plain", "Cells have a membrane.", 22)
        with database.engine().begin() as connection:
            connection.execute(insert(flashcards.cards).values(
                id=str(uuid.uuid4()), owner_id=NEW, note_id=note["id"], course="Biology", unit="Unit 1",
                front="What surrounds a cell?", back="A membrane", topic="cells", front_key=uuid.uuid4().hex,
                position=0, created_at=now))
        database.update_progress(NEW, "cells", True, 10)
        tutor.start_conversation(NEW, "What is a cell?")
        steps = self.call("GET").json()["steps"]
        self.assertEqual(steps, {"notes": True, "flashcards": True, "quiz": True, "tutor": True})
        # Someone else's data never ticks this account's steps.
        self.assertEqual(self.call("GET", user="someone-else").json()["steps"],
                         {"notes": False, "flashcards": False, "quiz": False, "tutor": False})

    def test_unknown_fields_and_bad_values_are_rejected(self):
        self.assertEqual(self.call("PUT", json={"setup_done": True, "admin": True}).status_code, 422)
        self.assertEqual(self.call("PUT", json={"setup_done": "maybe"}).status_code, 422)

    def test_sign_in_is_required(self):
        self.assertEqual(self.client.get("/api/account/onboarding").status_code, 401)
        self.assertEqual(self.client.put("/api/account/onboarding", json={"setup_done": True}).status_code, 401)

    def test_updates_are_rate_limited(self):
        for _ in range(30):
            self.assertEqual(self.call("PUT", json={"setup_done": True}).status_code, 200)
        self.assertEqual(self.call("PUT", json={"setup_done": True}).status_code, 429)

    def test_the_table_is_locked_down(self):
        self.assertIn("account_onboarding", database.RLS_TABLES)
        self.assertIn("account_onboarding", database.CLIENT_REVOKED_TABLES)


if __name__ == "__main__":
    unittest.main()
