import base64
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import String, Text, delete, insert, select

import account_deletion
import ai_cache
import auth
import database
import feedback
import flashcards
import help_bot
import main
import note_store
import onboarding
import otto
import practice
import practice_tests
import questions
import rate_limit
import tasks
import tutor

ALEX = "a1e5c0de-0000-4000-8000-00000000a1e5"  # the account being deleted
SAM = "5a3c0de0-0000-4000-8000-0000000005a3"
EVE = "e5ec0de0-0000-4000-8000-000000000e5e"
PEOPLE = {ALEX: "alex", SAM: "sam", EVE: "eve"}
ENV = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_ANON_KEY": "anon-key",
    "SUPABASE_SERVICE_ROLE_KEY": "service-secret",
}
CONFIRM = {"confirm": "DELETE MY ACCOUNT"}

# Every table an account's data can live in. Keep in sync with the modules that define
# tables; test_every_locked_table_is_checked fails when a new table is not listed.
ALL_METADATA = (
    database.metadata, note_store.note_metadata, flashcards.flashcard_metadata,
    questions.metadata, tutor.tutor_metadata, tasks.task_metadata, practice_tests.practice_metadata,
    practice.practice_metadata, feedback.feedback_metadata, onboarding.onboarding_metadata, help_bot.help_metadata,
    otto.otto_metadata,
)


def token(**claims) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return f"Bearer {part({'alg': 'HS256'})}.{part(claims)}.signature"


def fresh_token(student_id: str = ALEX) -> str:
    now = int(time.time())
    return token(sub=student_id, iat=now, exp=now + 3600, amr=[{"method": "password", "timestamp": now - 60}])


def response(status: int, body=None):
    mocked = MagicMock()
    mocked.status_code = status
    mocked.json.return_value = body if body is not None else {}
    return mocked


class FakeSupabase:
    """Stands in for the Storage and Auth admin APIs (httpx.post / request / delete)."""

    def __init__(self, objects: dict[str, list[str]] | None = None, auth_status: int = 200):
        self.objects = {bucket: set(paths) for bucket, paths in (objects or {}).items()}
        self.auth_status = auth_status
        self.auth_deletes: list[str] = []
        self.headers_seen: list[dict] = []

    def post(self, url, headers=None, json=None, **_):
        self.headers_seen.append(headers or {})
        bucket = url.rsplit("/", 1)[1]
        prefix = json["prefix"].rstrip("/") + "/"
        names = {}
        for path in self.objects.get(bucket, ()):
            if path.startswith(prefix):
                rest = path[len(prefix):]
                head, _, tail = rest.partition("/")
                names[head] = None if tail else "object-id"
        return response(200, [{"name": name, "id": object_id} for name, object_id in sorted(names.items())])

    def request(self, method, url, headers=None, json=None, **_):
        self.headers_seen.append(headers or {})
        bucket = url.rsplit("/", 1)[1]
        self.objects.setdefault(bucket, set()).difference_update(json["prefixes"])
        return response(200, [])

    def delete(self, url, headers=None, **_):
        self.headers_seen.append(headers or {})
        self.auth_deletes.append(url.rsplit("/", 1)[1])
        return response(self.auth_status)

    def patches(self):
        return (patch("httpx.post", side_effect=self.post), patch("httpx.request", side_effect=self.request),
                patch("httpx.delete", side_effect=self.delete))


class AccountDeletionTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def setUp(self):
        account_deletion.init_all()
        database.reset_db()
        tasks.reset_tasks()
        flashcards.reset_flashcards()
        tutor.reset_tutor()
        questions.reset_questions()
        ai_cache.reset_caches()
        practice_tests.reset_practice()
        practice.reset_practice()
        feedback.reset_feedback()
        onboarding.reset_onboarding()
        otto.reset_otto()
        with database.engine().begin() as connection:
            connection.execute(delete(note_store.notes))
        rate_limit.limiter.reset()
        auth.reset_cache()
        self.client = TestClient(main.app)
        self.seed()

    # --- seeding --------------------------------------------------------------------

    def seed(self):
        for person, name in PEOPLE.items():
            database.onboard_account(person, name, name.title(), None)
        now = datetime.now(timezone.utc)
        # Progress, XP and logins.
        database.update_progress(ALEX, "addition", True, 10)
        database.update_progress(SAM, "addition", True, 10)
        database.record_daily_login(ALEX)
        # Friends, quests, reactions, blocks, reports, notifications, rate-limit events.
        sam_code = database.get_profile(SAM)["friend_code"]
        request = database.send_friend_request(ALEX, sam_code)
        database.respond_to_friend_request(request["request_id"], SAM, True)
        database.create_friend_quest(ALEX, SAM, 100)
        # Friend-streak notices sent both ways (study_days rows come from update_progress above).
        with database.engine().begin() as connection:
            for recipient, other in ((ALEX, SAM), (SAM, ALEX)):
                connection.execute(insert(database.friend_streak_marks).values(
                    student_id=recipient, friend_id=other, kind="milestone", mark="3:2026-10-01", created_at=now))
        with database.engine().connect() as connection:
            alex_event = connection.execute(select(database.xp_events.c.id).where(database.xp_events.c.student_id == ALEX)).scalar()
            sam_event = connection.execute(select(database.xp_events.c.id).where(database.xp_events.c.student_id == SAM)).scalar()
        database.react_to_activity(SAM, alex_event)
        database.react_to_activity(ALEX, sam_event)
        database.block_person(EVE, ALEX)
        database.report_person(ALEX, EVE, "spam")
        database.report_person(EVE, ALEX, "spam")
        database.check_social_rate_limit(ALEX, "search", 60)
        # Groups: A owned by Alex with Sam and Eve (Sam joined first, so Sam inherits it),
        # B owned by Alex alone (deleted), C owned by Sam with Alex as a member.
        self.group_a = database.create_study_group(ALEX, "Alex and friends")
        database.join_study_group(SAM, self.group_a["invite_code"])
        database.join_study_group(EVE, self.group_a["invite_code"])
        self.group_b = database.create_study_group(ALEX, "Solo group")
        self.group_c = database.create_study_group(SAM, "Sam's group")
        database.join_study_group(ALEX, self.group_c["invite_code"])
        # Tasks.
        self.personal = tasks.create_task(ALEX, {"title": "Alex personal"})
        self.solo_task = tasks.create_task(ALEX, {"title": "Solo group task", "group_id": self.group_b["id"]})
        milestone = tasks.create_milestone(ALEX, self.group_a["id"], "Draft")
        self.handed = tasks.create_task(ALEX, {"title": "Alex group task", "group_id": self.group_a["id"],
                                               "assignee_ids": [ALEX, SAM], "milestone_id": milestone["id"]})
        tasks.add_comment(ALEX, self.handed["id"], "Alex comment on own task")
        tasks.add_comment(SAM, self.handed["id"], "Sam comment on Alex's task")
        tasks.add_checklist_item(ALEX, self.handed["id"], "step one")
        self.sam_task = tasks.create_task(SAM, {"title": "Sam task", "group_id": self.group_c["id"], "assignee_ids": [SAM, ALEX]})
        tasks.add_comment(ALEX, self.sam_task["id"], "Alex comment on Sam's task")
        tasks.add_comment(SAM, self.sam_task["id"], "Sam's own comment")
        tasks.add_attachment(ALEX, self.sam_task["id"], "link", "Alex link", "https://example.com/a")
        tasks.update_task(ALEX, self.sam_task["id"], {"status": "in_progress"})
        # Notes, flashcards, tutor, questions and AI caches.
        self.alex_note = note_store.save_note(ALEX, "Bio", "Cells", "cells.txt", "text/plain", "Mitochondria", 12)
        self.sam_note = note_store.save_note(SAM, "Bio", "Cells", "cells.txt", "text/plain", "Mitochondria", 12)
        with database.engine().begin() as connection:
            for owner, note in ((ALEX, self.alex_note), (SAM, self.sam_note)):
                connection.execute(insert(flashcards.cards).values(
                    id=f"card-{owner[:8]}", owner_id=owner, note_id=note["id"], course="Bio", unit="Cells",
                    front="Q", back="A", topic="cells", front_key=f"key-{owner[:8]}", position=0, created_at=now))
                connection.execute(insert(flashcards.jobs).values(
                    note_id=note["id"], owner_id=owner, status="ready", card_count=1, attempts=1, updated_at=now))
                connection.execute(insert(flashcards.styles).values(
                    note_id=note["id"], owner_id=owner, instructions_hash="h" * 64, updated_at=now))
                connection.execute(insert(flashcards.reviews).values(
                    owner_id=owner, card_id=f"card-{owner[:8]}", due_at=now, interval_days=1.0, ease=2.5,
                    reps=1, lapses=0, last_grade="good", last_reviewed_at=now, created_at=now))
            connection.execute(insert(database.uploaded_images).values(
                id="img-1", owner_id=ALEX, storage_path=f"{ALEX}/img-1.png", original_name="me.png",
                content_type="image/png", size_bytes=10, created_at=now))
            connection.execute(insert(database.progress_claims).values(guest_id="guest:old-browser", account_id=ALEX, claimed_at=now))
            connection.execute(insert(database.study_tasks).values(
                id="legacy-task", owner_id=ALEX, title="Old task", status="todo", priority="medium", created_at=now, updated_at=now))
        shared_key, private_key = "f" * 64, "e" * 64
        ai_cache.store_flashcards(shared_key, [{"front": "Q", "back": "A", "topic": "cells"}])
        ai_cache.add_ref("flashcard_cache", shared_key, ALEX, self.alex_note["id"])
        ai_cache.add_ref("flashcard_cache", shared_key, SAM, self.sam_note["id"])
        ai_cache.store_extraction(private_key, "Text read from Alex's photo")
        ai_cache.add_ref("extraction_cache", private_key, ALEX, self.alex_note["id"])
        ai_cache.store_grade("d" * 64, {"correct": True, "score": 1, "mistake_type": "none", "explanation": "Yes",
                                        "hint": "", "misconception": ""})
        ai_cache.add_ref("grading_cache", "d" * 64, ALEX)
        conversation = tutor.start_conversation(ALEX, "What is ATP?")
        tutor.add_message(ALEX, conversation["id"], "user", "What is ATP?")
        reply = tutor.add_message(ALEX, conversation["id"], "assistant", "Energy currency")
        tutor.rate_message(ALEX, reply["id"], 1)
        tutor.update_settings(ALEX, conversation["id"], pinned=True, study_mode="guide")
        ai_cache.store_tutor_reply("c" * 64, ALEX, "Energy currency")
        ai_cache.add_ref("tutor_reply_cache", "c" * 64, ALEX, ai_cache.conversation_source(conversation["id"]))
        questions.save_question(ALEX, "1+1?", "2", "addition", 1)
        questions.save_to_bank("private-bank-key", "Alex note question?", "Yes", "cells", 1, owner_id=ALEX)
        questions.save_to_bank("shared-bank-key", "Shared question?", "Yes", "addition", 1)
        # Practice tests (with their items) and a cached test tied to Alex's note; Sam's stay.
        question = {"type": "short_answer", "prompt": "Which organelle makes ATP?", "choices": [], "answer": "Mitochondria",
                    "explanation": "The notes say so.", "topic": "cells"}
        self.alex_test = practice_tests.create_test(ALEX, "Bio", "Cells", 600, [question])
        self.sam_test = practice_tests.create_test(SAM, "Bio", "Cells", 600, [question])
        ai_cache.store_practice_test("b" * 64, ALEX, [question])
        ai_cache.add_ref("practice_test_cache", "b" * 64, ALEX, self.alex_note["id"])
        self.shared_key, self.private_key = shared_key, private_key
        # Practice lab: a round and best of Alex's, a challenge Alex sent Sam (played by
        # both) and one Sam sent Alex, a round of Sam's; and feedback from Alex.
        practice.submit_round(ALEX, course="Bio", unit="Cells", length_s=60, mode="self",
                              answers=[(f"card-{ALEX[:8]}", True)])
        sent = practice.create_challenge(ALEX, to_id=SAM, course="Bio", unit="Cells", length_s=60, mode="self",
                                         card_ids=[f"card-{ALEX[:8]}"], answers=[True])
        practice.submit_challenge_result(SAM, sent["id"], [False])
        practice.submit_round(SAM, course="Bio", unit="Cells", length_s=60, mode="self", answers=[(f"card-{SAM[:8]}", True)])
        self.received = practice.create_challenge(SAM, to_id=ALEX, course="Bio", unit="Cells", length_s=60, mode="self",
                                                  card_ids=[f"card-{SAM[:8]}"])
        feedback.save(ALEX, "bug", "The timer froze", {"browser": "Safari 18", "os": "iOS"}, "games")
        onboarding.update_state(ALEX, setup_done=True)
        onboarding.update_state(SAM, setup_done=True, checklist_dismissed=True)
        # Otto: settings and memory for Alex (one item Otto saved, one Alex wrote) and for Sam.
        for person in (ALEX, SAM):
            otto.save_profile(person, preferred_name=PEOPLE[person].title(), personality="chill",
                              about="I like worked examples", memory_enabled=True)
            otto.add_memory(person, "taking AP Biology")
            otto.apply_memory_ops(person, [{"op": "add", "text": "has a test on cells on Oct 10"}])

    # --- helpers --------------------------------------------------------------------

    def rows_mentioning(self, student_id: str) -> dict[str, int]:
        """Rows, in every table of every module, with student_id in any text column."""
        found: dict[str, int] = {}
        with database.engine().connect() as connection:
            for table_metadata in ALL_METADATA:
                for table in table_metadata.sorted_tables:
                    columns = [column for column in table.columns if isinstance(column.type, (String, Text))]
                    count = 0
                    for row in connection.execute(select(*columns)).all() if columns else ():
                        count += any(isinstance(value, str) and student_id in value for value in row)
                    if count:
                        found[table.name] = count
        return found

    def delete(self, authorization=None, body=CONFIRM, supabase=None, env=None, user=ALEX):
        supabase = supabase or FakeSupabase()
        authorization = authorization or fresh_token(user)
        with patch.dict(os.environ, env if env is not None else ENV), \
                patch.object(auth, "authenticated_user", return_value={"id": user}):
            post, request, http_delete = supabase.patches()
            with post, request, http_delete:
                return self.client.request("DELETE", "/api/account", json=body, headers={"Authorization": authorization})

    # --- tests ----------------------------------------------------------------------

    def test_every_locked_table_is_checked(self):
        checked = {table.name for table_metadata in ALL_METADATA for table in table_metadata.sorted_tables}
        self.assertLessEqual(set(database.RLS_TABLES) | {"study_notes"}, checked)

    def test_seed_covers_every_table_that_holds_account_data(self):
        before = self.rows_mentioning(ALEX)
        for name in ("student_progress", "topic_progress", "profiles", "friendships", "friend_quests",
                     "study_groups", "study_group_members", "xp_events", "social_reactions", "social_notifications",
                     "social_blocks", "social_reports", "social_action_events", "uploaded_images", "cache_refs",
                     "tutor_reply_cache", "progress_claims", "study_tasks", "study_notes", "flashcards",
                     "flashcard_jobs", "flashcard_styles", "flashcard_reviews", "generated_questions", "tutor_conversations",
                     "workspace_tasks", "workspace_task_assignees", "workspace_task_comments",
                     "workspace_task_activity", "workspace_task_attachments", "workspace_group_milestones",
                     "practice_tests", "practice_test_cache",
                     "practice_rounds", "practice_bests", "practice_challenges", "feedback", "account_onboarding",
                     "otto_profiles", "otto_memories", "tutor_conversation_settings", "tutor_message_ratings",
                     "study_days", "friend_streak_marks"):
            self.assertIn(name, before, name)

    def test_deletes_every_row_of_the_account_and_keeps_everyone_elses(self):
        sam_before = self.rows_mentioning(SAM)
        supabase = FakeSupabase(objects={
            "study-group-images": [f"{self.group_a['id']}/{ALEX}/1-photo.png", f"{self.group_c['id']}/{ALEX}/2.png",
                                   f"{self.group_c['id']}/{SAM}/3.png", f"{self.group_b['id']}/{ALEX}/4.png"],
            "student-images": [f"{ALEX}/img-1.png", f"{SAM}/img-2.png"],
        })
        result = self.delete(supabase=supabase)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json(), {"deleted": True})
        self.assertEqual(self.rows_mentioning(ALEX), {})
        self.assertEqual(supabase.auth_deletes, [ALEX])
        # Storage: Alex's chat images and private images are gone, Sam's are not.
        self.assertEqual(supabase.objects["study-group-images"], {f"{self.group_c['id']}/{SAM}/3.png"})
        self.assertEqual(supabase.objects["student-images"], {f"{SAM}/img-2.png"})
        self.assertTrue(all(headers.get("Authorization") == "Bearer service-secret" for headers in supabase.headers_seen))

        # Sam still has everything that was Sam's (only rows also naming Alex went).
        sam_after = self.rows_mentioning(SAM)
        for name in ("profiles", "student_progress", "study_notes", "flashcards", "flashcard_reviews", "cache_refs", "xp_events",
                     "otto_profiles", "otto_memories", "study_days"):
            self.assertEqual(sam_after.get(name), sam_before.get(name), name)
        # Group A passed to Sam (who joined before Eve) and Sam was told; B is gone; C is Sam's.
        group_a = database.get_study_group(SAM, self.group_a["id"])
        self.assertEqual(group_a["role"], "owner")
        self.assertEqual(sorted(member["student_id"] for member in group_a["members"]), sorted([SAM, EVE]))
        notice = [item for item in database.notifications_for(SAM) if item["kind"] == "group_owner"]
        self.assertEqual(len(notice), 1)
        self.assertIn("Alex and friends", notice[0]["message"])
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            database.get_study_group(SAM, self.group_b["id"])
        self.assertEqual([member["student_id"] for member in database.get_study_group(SAM, self.group_c["id"])["members"]], [SAM])
        # Alex's group task stays with the group, now Sam's, without Alex's comments.
        handed = tasks.get_task(SAM, self.handed["id"])
        self.assertEqual(handed["owner"]["student_id"], SAM)
        self.assertEqual([comment["body"] for comment in handed["comments"]], ["Sam comment on Alex's task"])
        self.assertEqual([person["student_id"] for person in handed["assignees"]], [SAM])
        self.assertEqual(len(handed["checklist"]), 1)
        self.assertIsNotNone(handed["milestone_id"])
        sam_task = tasks.get_task(SAM, self.sam_task["id"])
        self.assertEqual([comment["body"] for comment in sam_task["comments"]], ["Sam's own comment"])
        self.assertEqual(sam_task["attachments"], [])
        self.assertNotIn("Deleted user", json.dumps(tasks.list_tasks(SAM), default=str))
        tasks.group_analytics(SAM, self.group_a["id"])
        database.list_friends(SAM)
        database.activity_feed(SAM)
        # Shared AI cache entry stays for Sam's note; Alex-only entries are gone.
        self.assertIsNotNone(ai_cache.cached_flashcards(self.shared_key))
        self.assertIsNone(ai_cache.cached_extraction(self.private_key))
        self.assertIsNone(questions.cached_question("private-bank-key", SAM))
        self.assertIsNotNone(questions.cached_question("shared-bank-key", SAM))
        # Alex's practice tests and their items are gone (items name no owner, so check them by test); Sam's remain.
        with database.engine().connect() as connection:
            remaining = set(connection.execute(select(practice_tests.items.c.test_id)).scalars().all())
        self.assertEqual(remaining, {self.sam_test["id"]})
        self.assertIsNone(practice_tests.get_test(ALEX, self.alex_test["id"]))
        self.assertIsNotNone(practice_tests.get_test(SAM, self.sam_test["id"]))
        self.assertIsNone(ai_cache.cached_practice_test("b" * 64, ALEX))
        # Practice: both challenges went with Alex; Sam keeps rounds and bests.
        self.assertEqual(practice.list_challenges(SAM), [])
        self.assertEqual(len(practice.list_rounds(SAM)), 2)
        self.assertEqual(len(practice.list_bests(SAM)), 1)
        self.assertEqual(feedback.latest(), [])

    def test_a_retry_after_success_is_harmless(self):
        self.assertEqual(self.delete().status_code, 200)
        again = self.delete(supabase=FakeSupabase(auth_status=404))
        self.assertEqual(again.status_code, 200)
        self.assertEqual(self.rows_mentioning(ALEX), {})

    def test_wrong_or_missing_confirmation_is_refused(self):
        for body in ({"confirm": "delete my account"}, {"confirm": "DELETE MY ACCOUNT "}, {"confirm": ""}, {}, None):
            result = self.delete(body=body)
            self.assertEqual(result.status_code, 400, body)
            self.assertEqual(result.json()["detail"]["code"], "confirm_required")
        self.assertEqual(self.delete(body={"confirm": "DELETE MY ACCOUNT", "also": 1}).status_code, 422)
        self.assertIn("profiles", self.rows_mentioning(ALEX))

    def test_a_stale_sign_in_is_refused(self):
        old = int(time.time()) - 11 * 60
        now = int(time.time())
        for authorization in (
            token(sub=ALEX, iat=old, exp=old + 3600),  # issued 11 minutes ago, no amr
            # Refreshed a moment ago, but the sign-in itself was 11 minutes ago.
            token(sub=ALEX, iat=now, exp=now + 3600, amr=[{"method": "password", "timestamp": old}]),
            "Bearer not-a-jwt",
        ):
            result = self.delete(authorization=authorization)
            self.assertEqual(result.status_code, 403, authorization)
            self.assertEqual(result.json()["detail"], {
                "code": "reauth_required", "message": "For your safety, sign in again, then delete your account.",
            })
        self.assertIn("profiles", self.rows_mentioning(ALEX))
        fresh = token(sub=ALEX, iat=now - 30, exp=now + 3600)  # no amr: iat decides
        self.assertEqual(self.delete(authorization=fresh).status_code, 200)

    def test_auth_admin_failure_returns_502_and_a_retry_finishes(self):
        failed = self.delete(supabase=FakeSupabase(auth_status=500))
        self.assertEqual(failed.status_code, 502)
        self.assertEqual(failed.json()["detail"]["code"], "auth_delete_failed")
        self.assertIn("officialbindet@gmail.com", failed.json()["detail"]["message"])
        self.assertEqual(self.rows_mentioning(ALEX), {})  # the data was already deleted
        retry = FakeSupabase()
        self.assertEqual(self.delete(supabase=retry).status_code, 200)
        self.assertEqual(retry.auth_deletes, [ALEX])

    def test_without_the_service_role_key_nothing_is_deleted(self):
        # Deleting the data while the login has to stay behind would leave half an account,
        # so without the key the app refuses and points to email instead.
        env = {key: value for key, value in ENV.items() if key != "SUPABASE_SERVICE_ROLE_KEY"}
        supabase = FakeSupabase()
        with patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": ""}):
            result = self.delete(supabase=supabase, env=env)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.json()["detail"]["code"], "account_deletion_unavailable")
        self.assertIn("officialbindet@gmail.com", result.json()["detail"]["message"])
        self.assertEqual(supabase.auth_deletes, [])
        self.assertNotEqual(self.rows_mentioning(ALEX), {})

    def test_config_reports_whether_account_deletion_is_available(self):
        client = TestClient(main.app)
        with patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": "", "SUPABASE_URL": "https://example.supabase.co", "SUPABASE_ANON_KEY": "anon"}):
            self.assertFalse(client.get("/api/auth/config").json()["account_deletion"])
        with patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": "service-secret", "SUPABASE_URL": "https://example.supabase.co", "SUPABASE_ANON_KEY": "anon"}):
            self.assertTrue(client.get("/api/auth/config").json()["account_deletion"])

    def test_storage_failure_does_not_stop_deletion(self):
        supabase = FakeSupabase()
        supabase.post = lambda *args, **kwargs: response(500)
        result = self.delete(supabase=supabase)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.rows_mentioning(ALEX), {})

    def test_logs_one_event_with_a_hashed_id(self):
        with self.assertLogs("bindit.account", level="INFO") as logs:
            self.assertEqual(self.delete().status_code, 200)
        events = [line for line in logs.output if "account_deleted" in line]
        self.assertEqual(len(events), 1)
        self.assertNotIn(ALEX, "\n".join(logs.output))
        self.assertNotIn("service-secret", "\n".join(logs.output))

    def test_signed_out_callers_get_401(self):
        with patch.dict(os.environ, ENV):
            result = self.client.request("DELETE", "/api/account", json=CONFIRM)
        self.assertEqual(result.status_code, 401)
        self.assertIn("profiles", self.rows_mentioning(ALEX))

    def test_rate_limited_to_five_an_hour(self):
        for _ in range(5):
            self.assertEqual(self.delete(body={"confirm": "nope"}).status_code, 400)
        self.assertEqual(self.delete().status_code, 429)
        self.assertIn("profiles", self.rows_mentioning(ALEX))

    def test_other_accounts_are_never_touched_by_the_route(self):
        # Sam deleting Sam's account leaves Alex intact (and the route only ever uses the token's user).
        alex_before = self.rows_mentioning(ALEX)
        self.assertEqual(self.delete(user=SAM).status_code, 200)
        self.assertEqual(self.rows_mentioning(SAM), {})
        alex_after = self.rows_mentioning(ALEX)
        self.assertEqual(alex_after["profiles"], alex_before["profiles"])
        self.assertEqual(alex_after["study_notes"], alex_before["study_notes"])
        # Group C was Sam's alone besides Alex, so Alex owns it now.
        self.assertEqual(database.get_study_group(ALEX, self.group_c["id"])["role"], "owner")
        self.assertEqual(tasks.get_task(ALEX, self.sam_task["id"])["owner"]["student_id"], ALEX)

    def test_signed_in_at_reads_amr_then_iat(self):
        self.assertEqual(auth.signed_in_at(token(iat=100, amr=[{"method": "password", "timestamp": 50},
                                                               {"method": "otp", "timestamp": 70}])), 70.0)
        self.assertEqual(auth.signed_in_at(token(iat=100)), 100.0)
        self.assertEqual(auth.signed_in_at(token(iat=True)), None)
        self.assertIsNone(auth.signed_in_at(None))
        self.assertIsNone(auth.signed_in_at("Bearer a.b"))


class OttoLockdownTests(unittest.TestCase):
    def test_tutor_extra_tables_are_locked_down_and_migrated(self):
        extra = ("tutor_conversation_settings", "tutor_message_ratings")
        for table in extra:
            self.assertIn(table, tutor.TUTOR_TABLES)
            self.assertIn(table, database.RLS_TABLES)
            self.assertIn(table, database.CLIENT_REVOKED_TABLES)
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261014_tutor_conversation_extras.sql")
        with open(path, encoding="utf-8") as handle:
            sql = handle.read()
        for table in extra:
            self.assertIn(f"'{table}'", sql)
        self.assertNotIn("drop ", sql.lower())

    def test_otto_tables_are_locked_down_and_migrated(self):
        for table in otto.OTTO_TABLES:
            self.assertIn(table, database.RLS_TABLES)
            self.assertIn(table, database.CLIENT_REVOKED_TABLES)
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261014_otto_memory_and_profile.sql")
        with open(path, encoding="utf-8") as handle:
            sql = handle.read()
        for table in otto.OTTO_TABLES:
            self.assertIn(f"'{table}'", sql)
        self.assertIn("to_regclass", sql)
        self.assertNotIn("drop ", sql.lower())
        self.assertNotIn("delete from", sql.lower())


if __name__ == "__main__":
    unittest.main()
