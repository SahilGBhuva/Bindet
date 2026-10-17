"""Rewards: daily quests, the chest, badges, streak freezes, the weekly recap, caps and cleanup."""
import asyncio
import io
import json
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ.setdefault("POCKET_TUTOR_DB_PATH", TEST_DB.name)

from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update

import account_deletion
import ai_tutor
import database
import flashcards
import main
import note_store
import practice_tests
import questions
import rate_limit
import rewards
import tutor

Q = rewards.QUEST_BY_ID
NOW = datetime(2026, 10, 7, 15, 0, tzinfo=timezone.utc)
MONDAY = date(2026, 10, 5)


def tearDownModule():
    # The shared session database (conftest.py) is removed by pytest; only an unused temp file goes here.
    if os.environ.get("POCKET_TUTOR_DB_PATH") != TEST_DB.name and os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


def on_day(day: date):
    """Make `day` the student's local today for every streak and quest function."""
    return patch.object(database, "local_today", return_value=day)


def quests(*ids):
    return patch.object(rewards, "pick_quests", return_value=[Q[quest_id] for quest_id in ids])


class RewardsTestCase(unittest.TestCase):
    def setUp(self):
        account_deletion.init_all()
        rewards.init_rewards()
        database.reset_db()
        flashcards.reset_flashcards()
        rate_limit.limiter.reset()
        with database.engine().begin() as connection:
            connection.execute(delete(note_store.notes))
            for table in rewards.rewards_metadata.sorted_tables:
                connection.execute(delete(table))
            connection.execute(delete(practice_tests.tests))
        self.offset = database.client_tz_offset.set(0)
        self.addCleanup(database.client_tz_offset.reset, self.offset)
        self.client = TestClient(main.app)

    def tearDown(self):
        database.reset_db()
        flashcards.reset_flashcards()
        with database.engine().begin() as connection:
            for table in rewards.rewards_metadata.sorted_tables:
                connection.execute(delete(table))

    def as_user(self, student_id):
        return patch.object(main.auth, "authenticated_user", return_value={"id": student_id, "email_confirmed_at": "2026-01-01T00:00:00Z"})

    def call(self, method, path, student="alex", **kwargs):
        with self.as_user(student):
            return self.client.request(method, path, headers={"Authorization": "Bearer t"}, **kwargs)

    def profile(self, student, goal=20):
        database.create_profile(student, student[:20], student.title())
        with database.engine().begin() as connection:
            connection.execute(update(database.profiles).where(database.profiles.c.student_id == student).values(daily_goal=goal))

    def befriend(self, first, second):
        with database.engine().begin() as connection:
            connection.execute(insert(database.friendships).values(
                requester_id=first, recipient_id=second, status="accepted", created_at=NOW))

    def cards(self, owner="alex", count=10, course="Biology", unit="Cells"):
        note = note_store.save_note(owner, course, unit, "cells.txt", "text/plain", "Cells have parts.", 17)
        ids = []
        with database.engine().begin() as connection:
            for position in range(count):
                card_id = f"{note['id'][:8]}-{position}"
                connection.execute(insert(flashcards.cards).values(
                    id=card_id, owner_id=owner, note_id=note["id"], course=course, unit=unit,
                    front=f"Question {position}?", back=f"Answer {position}", topic="cells",
                    front_key=f"k-{position}", position=position, created_at=NOW))
                ids.append(card_id)
        return ids

    def freezes(self, student):
        with database.engine().connect() as connection:
            row = connection.execute(select(database.streak_freezes).where(
                database.streak_freezes.c.student_id == student)).mappings().first()
        return dict(row) if row else None

    def stored_streak(self, student):
        with database.engine().connect() as connection:
            return connection.execute(select(database.student_progress.c.streak).where(
                database.student_progress.c.student_id == student)).scalar_one()


# --- Streak freezes ------------------------------------------------------------------------

class FreezeRuleTests(unittest.TestCase):
    def test_next_streak_spends_freezes_only_when_they_cover_every_missed_day(self):
        today = date(2026, 10, 8)
        self.assertEqual(database._next_streak(5, today - timedelta(days=1), True, today, 0), 6)
        self.assertEqual(database._next_streak(5, today - timedelta(days=2), True, today, 0), 1)
        self.assertEqual(database._next_streak(5, today - timedelta(days=2), True, today, 1), 6)
        self.assertEqual(database._next_streak(5, today - timedelta(days=3), True, today, 1), 1)
        self.assertEqual(database._next_streak(5, today - timedelta(days=3), True, today, 2), 6)
        self.assertEqual(database._next_streak(5, today - timedelta(days=4), True, today, 2), 1)
        self.assertEqual(database._next_streak(0, today - timedelta(days=2), True, today, 2), 1)  # nothing to save
        self.assertEqual(database._next_streak(5, today - timedelta(days=2), False, today, 2), 5)  # not a study action

    def test_live_streak_stays_alive_exactly_as_long_as_the_freezes_last(self):
        today = date(2026, 10, 8)
        self.assertEqual(database.live_streak(5, today - timedelta(days=1), today, 0), 5)
        self.assertEqual(database.live_streak(5, today - timedelta(days=2), today, 0), 0)
        self.assertEqual(database.live_streak(5, today - timedelta(days=2), today, 1), 5)
        self.assertEqual(database.live_streak(5, today - timedelta(days=3), today, 1), 0)
        self.assertEqual(database.live_streak(5, today - timedelta(days=3), today, 2), 5)
        self.assertEqual(database.live_streak(5, today - timedelta(days=4), today, 2), 0)


class FreezeStoreTests(RewardsTestCase):
    def study(self, student, day):
        with on_day(day):
            return database.mark_study_day(student)

    def test_one_freeze_is_earned_per_week_of_study_and_at_most_two_are_banked(self):
        self.study("fay", MONDAY)
        self.assertEqual(self.freezes("fay")["banked"], 1)
        self.study("fay", MONDAY + timedelta(days=1))
        self.study("fay", MONDAY + timedelta(days=6))  # Sunday: still the same week
        self.assertEqual(self.freezes("fay")["banked"], 1)
        self.study("fay", MONDAY + timedelta(days=7))  # next Monday
        self.assertEqual(self.freezes("fay")["banked"], 2)
        self.study("fay", MONDAY + timedelta(days=14))  # a gap too long to cover: restarts, keeps the bank
        self.assertEqual(self.stored_streak("fay"), 1)
        self.assertEqual(self.freezes("fay")["banked"], 2)  # the max, not 3
        self.study("fay", MONDAY + timedelta(days=21))
        self.assertEqual(self.freezes("fay")["banked"], 2)

    def test_a_missed_day_uses_a_freeze_and_the_save_is_announced_once(self):
        self.study("gus", MONDAY)
        self.study("gus", MONDAY + timedelta(days=1))
        self.assertEqual(self.study("gus", MONDAY + timedelta(days=3)), 3)  # Wednesday missed
        row = self.freezes("gus")
        self.assertEqual((row["banked"], row["used_total"], row["saved_streak"]), (0, 1, 2))
        self.assertEqual(database.pop_streak_saved("gus"), {"streak": 2, "on": (MONDAY + timedelta(days=3)).isoformat()})
        self.assertIsNone(database.pop_streak_saved("gus"))
        # The same day again changes nothing and spends nothing.
        self.assertEqual(self.study("gus", MONDAY + timedelta(days=3)), 3)
        self.assertEqual(self.freezes("gus")["banked"], 0)

    def test_two_missed_days_need_two_freezes(self):
        self.study("hal", MONDAY - timedelta(days=1))  # Sunday of the week before: 1
        self.study("hal", MONDAY)                       # Monday: this week's freeze, 2
        self.assertEqual(self.freezes("hal")["banked"], 2)
        self.assertEqual(self.study("hal", MONDAY + timedelta(days=3)), 3)  # Tue and Wed missed
        self.assertEqual(self.freezes("hal")["banked"], 0)

    def test_with_too_few_freezes_the_streak_restarts_and_none_are_spent(self):
        self.study("ivy", MONDAY)
        self.study("ivy", MONDAY + timedelta(days=1))
        self.assertEqual(self.study("ivy", MONDAY + timedelta(days=4)), 1)  # two missed, one freeze
        row = self.freezes("ivy")
        self.assertEqual((row["banked"], row["used_total"], row["saved_streak"]), (1, 0, None))
        self.assertIsNone(database.pop_streak_saved("ivy"))

    def test_progress_shows_a_frozen_streak_until_the_freezes_run_out(self):
        self.study("jo", MONDAY)
        self.study("jo", MONDAY + timedelta(days=1))
        with on_day(MONDAY + timedelta(days=3)):  # Wednesday missed, one freeze banked
            self.assertEqual(database.get_progress("jo")["streak"], 2)
            self.assertEqual(database.get_progress("jo")["streak_freezes"], 1)
            self.assertEqual(database.freeze_status("jo"), {"banked": 1, "max": 2, "covering": 1})
        with on_day(MONDAY + timedelta(days=4)):  # two missed now
            self.assertEqual(database.get_progress("jo")["streak"], 0)
            self.assertEqual(database.freeze_status("jo")["covering"], 0)

    def test_every_study_writer_uses_freezes(self):
        for student, act in (
            ("w-answer", lambda s: database.update_progress(s, "t", True, 5)),
            ("w-award", lambda s: database.award_xp(s, 5)),
            ("w-review", database.mark_study_day),
        ):
            with on_day(MONDAY):
                act(student)
            with on_day(MONDAY + timedelta(days=1)):
                act(student)
            with on_day(MONDAY + timedelta(days=3)):
                act(student)
            self.assertEqual(self.stored_streak(student), 3, student)
            self.assertEqual(self.freezes(student)["banked"], 0, student)

        def lab_round(student):
            with database.engine().begin() as connection:
                database.award_xp_in(connection, student, 3, active=True)
        for day in (MONDAY, MONDAY + timedelta(days=1), MONDAY + timedelta(days=3)):
            with on_day(day):
                lab_round("w-lab")
        self.assertEqual(self.stored_streak("w-lab"), 3)

    def test_a_wrong_answer_neither_earns_nor_spends_a_freeze(self):
        with on_day(MONDAY):
            database.update_progress("kai", "t", False, 0)
        self.assertIsNone(self.freezes("kai"))

    def test_bonus_xp_is_not_a_study_day(self):
        with on_day(MONDAY):
            database.award_xp("lee", 15, study_day=False)
        progress = database.get_progress("lee")
        self.assertEqual((progress["total_xp"], self.stored_streak("lee")), (15, 0))
        with database.engine().connect() as connection:
            self.assertIsNone(connection.execute(select(database.study_days).where(database.study_days.c.student_id == "lee")).first())

    def test_friend_streaks_do_not_use_freezes(self):
        for day in (MONDAY, MONDAY + timedelta(days=1), MONDAY + timedelta(days=3)):
            self.study("mia", day)
            self.study("ned", day)
        self.assertEqual(self.stored_streak("mia"), 3)  # her own streak was saved by a freeze
        with database.engine().connect() as connection:
            days = database._study_days(connection, ["mia", "ned"], MONDAY)
        self.assertEqual(database._shared_streak(days["mia"], days["ned"], MONDAY + timedelta(days=3)), 1)

    def test_freeze_table_is_locked_down(self):
        for table in ("streak_freezes", *rewards.REWARD_TABLES):
            self.assertIn(table, database.RLS_TABLES)
            self.assertIn(table, database.CLIENT_REVOKED_TABLES)


# --- Quests --------------------------------------------------------------------------------

class QuestSelectionTests(RewardsTestCase):
    def test_three_distinct_quests_chosen_the_same_way_every_time(self):
        first = rewards.pick_quests("alex", MONDAY, {"cards", "friends"})
        self.assertEqual(first, rewards.pick_quests("alex", MONDAY, {"cards", "friends"}))
        self.assertEqual(len({quest.id for quest in first}), 3)
        week = {tuple(quest.id for quest in rewards.pick_quests("alex", MONDAY + timedelta(days=n), {"cards", "friends"})) for n in range(14)}
        self.assertGreater(len(week), 3)  # they change from day to day
        others = {tuple(quest.id for quest in rewards.pick_quests(f"s{n}", MONDAY, {"cards", "friends"})) for n in range(14)}
        self.assertGreater(len(others), 3)  # and from student to student

    def test_quests_the_student_cant_do_yet_are_never_picked(self):
        for n in range(60):
            chosen = {quest.id for quest in rewards.pick_quests("new", MONDAY + timedelta(days=n), set())}
            self.assertFalse(chosen & {"review_cards", "instant_round", "friend_day"})

    def test_a_days_quests_are_stored_and_kept_when_the_student_changes_mid_day(self):
        self.profile("alex")
        first = self.call("GET", "/api/quests/today").json()
        self.assertEqual(len(first["quests"]), 3)
        self.profile("bo")
        self.befriend("alex", "bo")
        self.cards("alex")
        again = self.call("GET", "/api/quests/today").json()
        self.assertEqual([quest["id"] for quest in first["quests"]], [quest["id"] for quest in again["quests"]])

    def test_the_quest_day_is_the_students_local_day(self):
        database.client_tz_offset.set(420)  # UTC-7
        late = datetime(2026, 10, 8, 5, 0, tzinfo=timezone.utc)  # Oct 7, 10 pm local
        morning = datetime(2026, 10, 8, 15, 0, tzinfo=timezone.utc)  # Oct 8, 8 am local
        self.assertEqual(rewards.today_state("alex", now=late)["day"], "2026-10-07")
        self.assertEqual(rewards.today_state("alex", now=morning)["day"], "2026-10-08")
        with database.engine().connect() as connection:
            days = set(connection.execute(select(rewards.daily_quests.c.day).where(
                rewards.daily_quests.c.student_id == "alex")).scalars().all())
        self.assertEqual(days, {date(2026, 10, 7), date(2026, 10, 8)})


class QuestProgressTests(RewardsTestCase):
    def quest(self, student, quest_id):
        state = rewards.today_state(student)
        return next(quest for quest in state["quests"] if quest["id"] == quest_id)

    def test_reviews_count_and_the_tenth_completes_the_quest(self):
        ids = self.cards("alex", 10)
        with quests("review_cards", "ask_otto", "add_notes"):
            for index, card_id in enumerate(ids):
                body = self.call("POST", f"/api/review/{card_id}", json={"grade": "good"}).json()
                if index < 9:
                    self.assertNotIn("quests_completed", body.get("rewards") or {})
            self.assertEqual(body["rewards"]["quests_completed"], [{"id": "review_cards", "title": "Review 10 flashcards"}])
            self.assertEqual(body["rewards"]["xp"], rewards.QUEST_XP)
            self.assertEqual(self.quest("alex", "review_cards")["progress"], 10)

    def test_quiz_answers_and_right_in_a_row(self):
        with quests("quiz_answers", "right_in_a_row", "add_notes"):
            results = []
            for correct in (True, True, False, True, True):
                question_id = questions.save_question("alex", "What is 2 + 2?", "4", "addition", 1)
                answer = "4" if correct else "5"
                response = self.call("POST", "/api/analyze-answer", json={"question_id": question_id, "student_answer": answer, "student_id": "alex"})
                self.assertEqual(response.status_code, 200, response.text)
                results.append(response.json())
            self.assertEqual(self.quest("alex", "quiz_answers")["progress"], 5)
            self.assertTrue(self.quest("alex", "quiz_answers")["done"])
            self.assertEqual(self.quest("alex", "right_in_a_row")["progress"], 2)  # broken by the miss, then 2
            question_id = questions.save_question("alex", "What is 2 + 2?", "4", "addition", 1)
            last = self.call("POST", "/api/analyze-answer", json={"question_id": question_id, "student_answer": "4", "student_id": "alex"}).json()
            self.assertEqual([quest["id"] for quest in last["rewards"]["quests_completed"]], ["right_in_a_row"])
            # The answer's own XP plus the quest's.
            self.assertEqual(last["rewards"]["xp"], last["xp_earned"] + rewards.QUEST_XP)

    def test_guests_get_no_rewards(self):
        question_id = questions.save_question(main.guest_student_id("guest-1"), "2+2?", "4", "addition", 1)
        body = self.client.post("/api/analyze-answer", json={"question_id": question_id, "student_answer": "4", "student_id": "guest-1"}).json()
        self.assertIsNone(body["rewards"])

    def test_a_question_to_otto(self):
        with quests("ask_otto", "add_notes", "quiz_answers"), self.as_user("alex"), \
                patch.object(ai_tutor, "stream_tutor_reply", side_effect=lambda **_: iter(["Light ", "energy."])):
            response = main.send_tutor_message(main.TutorMessageRequest(content="What does chlorophyll absorb?"), "Bearer t")

            async def drain():
                return "".join([chunk if isinstance(chunk, str) else chunk.decode() async for chunk in response.body_iterator])

            events = []
            for block in asyncio.run(drain()).strip().split("\n\n"):
                if block.startswith("event: "):
                    name, data = block.split("\n", 1)
                    events.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
        names = [name for name, _ in events]
        self.assertLess(names.index("done"), names.index("rewards"))
        self.assertEqual(dict(events)["rewards"]["quests_completed"][0]["id"], "ask_otto")

    def test_a_note_upload(self):
        with quests("add_notes", "ask_otto", "quiz_answers"):
            response = self.call("POST", "/api/notes", data={"course": "Biology", "unit": "Cells"},
                                 files={"file": ("cells.txt", io.BytesIO(b"Mitochondria release energy as ATP."), "text/plain")})
        self.assertEqual(response.status_code, 201, response.text)
        rewards_body = response.json()["rewards"]
        self.assertEqual(rewards_body["quests_completed"][0]["id"], "add_notes")
        self.assertIn("first_notes", [badge["id"] for badge in rewards_body["badges_earned"]])

    def test_an_instant_study_round_needs_real_study_first(self):
        ids = self.cards("alex", 2)
        with quests("instant_round", "ask_otto", "quiz_answers"):
            refused = self.call("POST", "/api/instant-study/complete")
            self.assertEqual((refused.status_code, refused.json()["detail"]["code"]), (409, "nothing_studied"))
            self.call("POST", f"/api/review/{ids[0]}", json={"grade": "good"})
            done = self.call("POST", "/api/instant-study/complete").json()
        self.assertEqual(done["rewards"]["quests_completed"][0]["id"], "instant_round")
        with database.engine().connect() as connection:
            self.assertEqual(rewards._metric(connection, "alex", "instant_rounds", None), 1)

    def test_practice_lab_rounds_count_as_cards_and_practice_tests_as_quiz_answers(self):
        with quests("review_cards", "quiz_answers", "right_in_a_row"):
            rewards.record("alex", "lab_round", cards=6)
            out = rewards.record("alex", "practice_test", results=[True, True, True, False, True])
        self.assertEqual(self.quest("alex", "review_cards")["progress"], 6)
        self.assertEqual(sorted(quest["id"] for quest in out["quests_completed"]), ["quiz_answers", "right_in_a_row"])

    def test_the_daily_goal_and_studying_with_a_friend_are_checked_on_their_own(self):
        self.profile("alex", goal=10)
        self.profile("bo")
        self.befriend("alex", "bo")
        with quests("daily_goal", "friend_day", "add_notes"):
            self.assertFalse(self.quest("alex", "daily_goal")["done"])
            database.update_progress("alex", "t", True, 10)
            self.assertTrue(self.quest("alex", "daily_goal")["done"])
            self.assertFalse(self.quest("alex", "friend_day")["done"])
            database.mark_study_day("bo")  # the friend studies later the same day
            self.assertTrue(self.quest("alex", "friend_day")["done"])


class ChestTests(RewardsTestCase):
    def test_all_three_open_the_chest_once_and_the_day_is_done(self):
        self.profile("alex", goal=10)
        with quests("add_notes", "ask_otto", "instant_round"):
            rewards.record("alex", "note")
            rewards.record("alex", "tutor")
            database.mark_study_day("alex")
            opened = rewards.record("alex", "instant")
            self.assertEqual(opened["chest"], {"xp": rewards.CHEST_XP})
            self.assertEqual(opened["xp"], rewards.QUEST_XP + rewards.CHEST_XP)
            self.assertIsNone((rewards.record("alex", "instant") or {}).get("chest"))
            state = rewards.today_state("alex")
        self.assertTrue(state["chest"]["open"])
        self.assertTrue(all(quest["done"] for quest in state["quests"]))
        # 3 quests x 5 XP + 15 XP chest = 30 XP, past the 10 XP goal: the day is done.
        self.assertEqual(state["goal"], {"xp": 3 * rewards.QUEST_XP + rewards.CHEST_XP, "target": 10, "met": True})
        self.assertTrue(state["all_done"])
        with database.engine().connect() as connection:
            chests = connection.execute(select(rewards.daily_chests)).mappings().all()
        self.assertEqual([(row["student_id"], row["xp"]) for row in chests], [("alex", rewards.CHEST_XP)])

    def test_the_day_is_not_done_until_the_goal_is_met_too(self):
        self.profile("alex", goal=50)
        with quests("add_notes", "ask_otto", "quiz_answers"):
            rewards.record("alex", "note")
            rewards.record("alex", "tutor")
            rewards.record("alex", "quiz", results=[True] * 5)
            state = rewards.today_state("alex")
        self.assertTrue(state["chest"]["open"])
        self.assertFalse(state["all_done"])

    def test_quest_and_chest_xp_respect_the_daily_cap(self):
        database.award_xp("alex", database.DAILY_XP_CAP - 8)
        with quests("add_notes", "ask_otto", "quiz_answers"):
            first = rewards.record("alex", "note")
            self.assertEqual(first["xp"], rewards.QUEST_XP)
            rewards.record("alex", "tutor")  # 3 XP left of the cap
            last = rewards.record("alex", "quiz", results=[False] * 5)
        self.assertEqual(last["chest"], {"xp": 0})
        self.assertEqual(database.get_progress("alex")["total_xp"], database.DAILY_XP_CAP)

    def test_a_level_up_is_reported(self):
        database.award_xp("alex", 98)
        with quests("add_notes", "ask_otto", "quiz_answers"):
            out = rewards.record("alex", "note")
        self.assertEqual(out["level_up"], {"from": 1, "to": 2})


# --- Badges --------------------------------------------------------------------------------

class BadgeTests(RewardsTestCase):
    def test_each_badge_is_awarded_once(self):
        note_store.save_note("alex", "Biology", "Cells", "a.txt", "text/plain", "Cells.", 6)
        with quests("add_notes", "ask_otto", "quiz_answers"):
            first = rewards.record("alex", "note")
            second = rewards.record("alex", "note")
        self.assertIn("first_notes", [badge["id"] for badge in first["badges_earned"]])
        self.assertNotIn("first_notes", [badge["id"] for badge in (second or {}).get("badges_earned", [])])
        with database.engine().connect() as connection:
            rows = connection.execute(select(rewards.earned_badges.c.badge_id).where(
                rewards.earned_badges.c.student_id == "alex")).scalars().all()
        self.assertEqual(rows.count("first_notes"), 1)

    def test_badges_from_existing_data(self):
        self.cards("alex", 3)
        self.profile("alex")
        self.profile("bo")
        self.befriend("alex", "bo")
        for day in range(7):
            with on_day(MONDAY + timedelta(days=day)):
                database.mark_study_day("alex")
                database.mark_study_day("bo")
        practice_tests.init_practice()
        with database.engine().begin() as connection:
            for test_id, difficulty, score in (("t-perfect", "medium", 5), ("t-hard", "hard", 4)):
                connection.execute(insert(practice_tests.tests).values(
                    id=test_id, owner_id="alex", course="Biology", unit="Cells", created_at=NOW, started_at=NOW,
                    submitted_at=NOW, question_count=5, score=score, status="submitted", difficulty=difficulty))
        with on_day(MONDAY + timedelta(days=6)):
            earned = {badge.id for badge in rewards.award_badges("alex")}
        self.assertEqual(earned, {"first_notes", "first_cards", "streak_3", "streak_7", "perfect_quiz", "hard_test",
                                  "first_friend", "friend_streak_7"})

    def test_card_review_counts_and_otto_questions(self):
        with database.engine().begin() as connection:
            rewards._bump_activity(connection, "alex", MONDAY, "cards", 99)
        self.assertNotIn("cards_100", {badge.id for badge in rewards.award_badges("alex")})
        rewards.record("alex", "review", cards=1)
        self.assertIn("cards_100", {badge["id"] for badge in rewards.badges("alex")["badges"] if badge["earned"]})
        for _ in range(10):
            rewards.record("alex", "tutor")
        self.assertIn("otto_10", {badge["id"] for badge in rewards.badges("alex")["badges"] if badge["earned"]})

    def test_early_bird_and_night_owl_only_at_healthy_hours(self):
        for hour, expected in ((3, set()), (6, {"early_bird"}), (14, set()), (22, {"night_owl"}), (0, set())):
            student = f"hour-{hour}"
            at = datetime(2026, 10, 7, hour, 30, tzinfo=timezone.utc)
            out = rewards.record(student, "quiz", results=[False], now=at) or {}
            got = {badge["id"] for badge in out.get("badges_earned", [])} & {"early_bird", "night_owl"}
            self.assertEqual(got, expected, hour)
        # Adding notes is not studying, so it never earns either.
        out = rewards.record("hour-notes", "note", now=datetime(2026, 10, 7, 6, 30, tzinfo=timezone.utc)) or {}
        self.assertNotIn("early_bird", {badge["id"] for badge in out.get("badges_earned", [])})

    def test_badge_list_has_progress_and_hides_the_surprise(self):
        with database.engine().begin() as connection:
            rewards._bump_activity(connection, "alex", MONDAY, "cards", 40)
        listed = self.call("GET", "/api/badges").json()
        self.assertEqual(listed["total"], len(rewards.BADGES))
        self.assertGreaterEqual(len(rewards.BADGES), 15)
        by_id = {badge["id"]: badge for badge in listed["badges"]}
        self.assertEqual((by_id["cards_100"]["progress"], by_id["cards_100"]["target"]), (40, 100))
        self.assertEqual(by_id["night_owl"]["title"], "A surprise badge")
        self.assertIsNone(by_id["night_owl"]["target"])
        self.assertIn("freezes", listed)

    def test_friends_see_earned_badges_only_when_friends_and_not_blocked(self):
        self.profile("alex")
        self.profile("bo")
        self.profile("cy")
        note_store.save_note("bo", "Biology", "Cells", "a.txt", "text/plain", "Cells.", 6)
        rewards.award_badges("bo")
        self.assertEqual(self.call("GET", "/api/friends/bo/badges", student="cy").status_code, 404)
        self.befriend("alex", "bo")
        seen = self.call("GET", "/api/friends/bo/badges").json()["badges"]
        self.assertEqual([badge["id"] for badge in seen], ["first_notes"])
        self.assertTrue(all(badge["earned"] for badge in seen))
        database.block_person("bo", "alex")
        self.assertEqual(self.call("GET", "/api/friends/bo/badges").status_code, 404)


# --- Weekly recap --------------------------------------------------------------------------

class RecapTests(RewardsTestCase):
    def test_last_weeks_numbers(self):
        ids = self.cards("alex", 3)
        for offset in (0, 1, 2, 4):  # Mon, Tue, Wed, Fri
            with database.engine().begin() as connection:
                connection.execute(insert(database.study_days).values(student_id="alex", day=MONDAY + timedelta(days=offset)))
        database.update_progress("alex", "t", True, 1)  # makes the progress row
        with database.engine().begin() as connection:
            connection.execute(delete(database.xp_events))
            connection.execute(delete(database.study_days).where(database.study_days.c.day > MONDAY + timedelta(days=6)))
            connection.execute(insert(database.xp_events).values(student_id="alex", xp=40, created_at=datetime(2026, 10, 6, 12, tzinfo=timezone.utc)))
            connection.execute(insert(database.xp_events).values(student_id="alex", xp=25, created_at=datetime(2026, 10, 11, 23, tzinfo=timezone.utc)))
            connection.execute(insert(database.xp_events).values(student_id="alex", xp=99, created_at=datetime(2026, 10, 12, 1, tzinfo=timezone.utc)))
            rewards._bump_activity(connection, "alex", MONDAY + timedelta(days=1), "cards", 12)
            rewards._bump_activity(connection, "alex", MONDAY + timedelta(days=7), "cards", 50)  # this week: not counted
            connection.execute(insert(flashcards.reviews).values(
                owner_id="alex", card_id=ids[0], due_at=NOW, interval_days=1, ease=2.5, reps=1, lapses=0,
                last_grade="good", last_reviewed_at=datetime(2026, 10, 6, 9, tzinfo=timezone.utc), created_at=NOW))
            connection.execute(insert(rewards.earned_badges).values(student_id="alex", badge_id="streak_3", earned_at=datetime(2026, 10, 7, 9, tzinfo=timezone.utc)))
        practice_tests.init_practice()
        with database.engine().begin() as connection:
            connection.execute(insert(practice_tests.tests).values(
                id="t-chem", owner_id="alex", course="Chemistry", unit="Atoms", created_at=NOW, started_at=NOW,
                submitted_at=datetime(2026, 10, 8, 9, tzinfo=timezone.utc), question_count=5, score=3, status="submitted"))
        recap = rewards.last_week("alex", now=datetime(2026, 10, 13, 9, tzinfo=timezone.utc))  # the Tuesday after
        self.assertEqual((recap["week_start"], recap["week_end"]), ("2026-10-05", "2026-10-11"))
        self.assertEqual(recap["days_studied"], 4)
        self.assertEqual(recap["xp"], 65)
        self.assertEqual(recap["cards_reviewed"], 12)
        self.assertEqual(recap["best_subject"], "Chemistry")  # 5 test questions beat 1 card
        self.assertEqual(recap["longest_streak"], 3)
        self.assertEqual([badge["id"] for badge in recap["badges_earned"]], ["streak_3"])
        self.assertTrue(recap["show"])

    def test_the_recap_follows_the_local_week_and_can_be_dismissed(self):
        database.client_tz_offset.set(420)  # UTC-7
        sunday_night = datetime(2026, 10, 12, 6, 0, tzinfo=timezone.utc)  # Sunday Oct 11, 11 pm local
        self.assertEqual(rewards.last_week("alex", now=sunday_night)["week_start"], "2026-09-28")
        monday = datetime(2026, 10, 12, 7, 30, tzinfo=timezone.utc)  # Monday 12:30 am local
        with database.engine().begin() as connection:
            database._progress_row(connection, "alex", NOW)
            connection.execute(insert(database.study_days).values(student_id="alex", day=date(2026, 10, 6)))
        recap = rewards.last_week("alex", now=monday)
        self.assertEqual((recap["week_start"], recap["show"]), ("2026-10-05", True))
        rewards.dismiss_recap("alex", now=monday)
        self.assertFalse(rewards.last_week("alex", now=monday)["show"])

    def test_an_empty_week_shows_nothing(self):
        recap = self.call("GET", "/api/recap/last-week").json()
        self.assertFalse(recap["show"])
        self.assertEqual(self.call("POST", "/api/recap/last-week/dismiss").json()["dismissed"], True)


# --- Account deletion ----------------------------------------------------------------------

class CleanupTests(RewardsTestCase):
    def test_deleting_an_account_removes_every_reward_row_and_keeps_friends(self):
        for student in ("alex", "bo"):
            with on_day(MONDAY):
                database.mark_study_day(student)
            with quests("add_notes", "ask_otto", "quiz_answers"):
                rewards.record(student, "note")
                rewards.record(student, "tutor")
                rewards.record(student, "quiz", results=[True] * 5)
            note_store.save_note(student, "Biology", "Cells", "a.txt", "text/plain", "Cells.", 6)
            rewards.award_badges(student)
            rewards.dismiss_recap(student)
        account_deletion.delete_account_data("alex")
        with database.engine().connect() as connection:
            for table in (*rewards.rewards_metadata.sorted_tables, database.streak_freezes):
                owners = set(connection.execute(select(table.c.student_id)).scalars().all())
                self.assertNotIn("alex", owners, table.name)
                self.assertIn("bo", owners, table.name)


if __name__ == "__main__":
    unittest.main()
