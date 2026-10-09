import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ.setdefault("POCKET_TUTOR_DB_PATH", TEST_DB.name)

from sqlalchemy import select

import database
import main
import rate_limit


def tearDownModule():
    # Only when no other module's tests could still be using it through the cached engine.
    if os.path.exists(TEST_DB.name) and database.engine().url.database != TEST_DB.name:
        os.unlink(TEST_DB.name)


class FrozenDatetime(datetime):
    """datetime with a settable now(), patched into database for clock-sensitive tests."""
    frozen = datetime(2026, 10, 7, 20, 0, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        return cls.frozen.astimezone(tz) if tz else cls.frozen.replace(tzinfo=None)


def at(moment: datetime):
    FrozenDatetime.frozen = moment
    return patch.object(database, "datetime", FrozenDatetime)


class FriendStreakTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        rate_limit.limiter.reset()
        self.alex = database.onboard_account("alex-id", "alex", "Alex", None)
        self.sam = database.onboard_account("sam-id", "sam", "Sam", None)
        database.onboard_account("eve-id", "eve", "Eve", None)
        request = database.send_friend_request("alex-id", self.sam["friend_code"])
        database.respond_to_friend_request(request["request_id"], "sam-id", True)
        self.offset = database.client_tz_offset.set(0)
        self.addCleanup(database.client_tz_offset.reset, self.offset)

    # --- helpers --------------------------------------------------------------------

    def add_days(self, student_id, *days_ago):
        today = database.local_today()
        with database.engine().begin() as connection:
            database._insert_ignore(connection, database.study_days, [
                {"student_id": student_id, "day": today - timedelta(days=offset)} for offset in days_ago
            ], ["student_id", "day"])

    def days(self, student_id):
        with database.engine().connect() as connection:
            return sorted(connection.execute(select(database.study_days.c.day).where(
                database.study_days.c.student_id == student_id)).scalars().all())

    def notices(self, student_id, kind=None):
        return [item for item in database.notifications_for(student_id)
                if item["kind"].startswith("streak_") and (kind is None or item["kind"] == kind)]

    def friend(self, viewer="alex-id"):
        return database.list_friends(viewer)[0]

    # --- study days -----------------------------------------------------------------

    def test_study_days_follow_the_students_local_day_across_utc_midnight(self):
        database.client_tz_offset.set(420)  # UTC-7
        # Tue Oct 6, 6pm local is already Oct 7 in UTC; Wed Oct 7, 1pm local is Oct 7 too.
        for moment in (datetime(2026, 10, 7, 1, 0, tzinfo=timezone.utc), datetime(2026, 10, 7, 20, 0, tzinfo=timezone.utc)):
            with at(moment):
                database.update_progress("alex-id", "Biology", True, 10)
                database.update_progress("sam-id", "Biology", True, 10)
        self.assertEqual(self.days("alex-id"), [date(2026, 10, 6), date(2026, 10, 7)])
        with at(datetime(2026, 10, 7, 21, 0, tzinfo=timezone.utc)):
            self.assertEqual(database._friend_streak("alex-id", "sam-id"), 2)  # UTC days alone would say 1
            friend = self.friend()
        self.assertEqual(friend["friend_streak"], 2)
        self.assertEqual(friend["streak_status"], "done")
        # Early on Thu Oct 8 local (still Oct 8 in UTC too), the streak is alive but at risk.
        with at(datetime(2026, 10, 8, 15, 0, tzinfo=timezone.utc)):
            friend = self.friend()
        self.assertEqual((friend["friend_streak"], friend["streak_status"]), (2, "at_risk"))
        # A day later with nobody studying, it's broken and shows 0.
        with at(datetime(2026, 10, 9, 15, 0, tzinfo=timezone.utc)):
            friend = self.friend()
        self.assertEqual((friend["friend_streak"], friend["streak_status"], friend["best_friend_streak"]), (0, "broken", 2))

    def test_reviews_tests_and_practice_rounds_count_but_wrong_answers_do_not(self):
        database.update_progress("eve-id", "Biology", False, 0)
        self.assertEqual(self.days("eve-id"), [])
        database.mark_study_day("alex-id")  # flashcard review
        database.mark_study_day("alex-id")
        database.award_xp("sam-id", 0)  # finished practice test, even with no XP left
        with database.engine().begin() as connection:
            database.award_xp_in(connection, "eve-id", 0, active=False)
        self.assertEqual(self.days("eve-id"), [])
        with database.engine().begin() as connection:
            database.award_xp_in(connection, "eve-id", 3, active=True)  # Practice lab round
        today = database.local_today()
        self.assertEqual(self.days("alex-id"), [today])
        self.assertEqual(self.days("sam-id"), [today])
        self.assertEqual(self.days("eve-id"), [today])
        self.assertEqual(self.friend()["friend_streak"], 1)

    def test_states_history_and_best(self):
        friend = self.friend()
        self.assertEqual((friend["friend_streak"], friend["streak_status"]), (0, "none"))
        self.assertEqual(len(friend["streak_days"]), database.STREAK_HISTORY_DAYS)
        self.add_days("alex-id", 1, 2, 3, 6, 7)
        self.add_days("sam-id", 0, 1, 2, 3, 6, 7)
        friend = self.friend()
        self.assertEqual((friend["friend_streak"], friend["streak_status"]), (3, "at_risk"))
        self.assertEqual((friend["me_today"], friend["friend_today"]), (False, True))
        self.assertEqual(friend["best_friend_streak"], 3)
        self.assertEqual(friend["streak_days"][-1], {"day": database.local_today().isoformat(), "me": False, "friend": True})
        self.assertEqual(friend["streak_days"][-2]["me"], True)
        self.add_days("alex-id", 0)
        friend = self.friend()
        self.assertEqual((friend["friend_streak"], friend["streak_status"]), (4, "done"))

    def test_old_study_days_are_pruned(self):
        self.add_days("alex-id", database.STREAK_LOOKBACK_DAYS + 5)
        database.mark_study_day("alex-id")
        self.assertEqual(self.days("alex-id"), [database.local_today()])

    # --- notifications --------------------------------------------------------------

    def test_milestones_are_sent_to_both_friends_once(self):
        self.add_days("alex-id", 1, 2)
        self.add_days("sam-id", 1, 2)
        database.mark_study_day("alex-id")
        self.assertEqual(self.notices("alex-id", "streak_milestone"), [])
        database.update_progress("sam-id", "Biology", True, 10)
        for person, other in (("alex-id", "Sam"), ("sam-id", "Alex")):
            milestone = self.notices(person, "streak_milestone")
            self.assertEqual([item["message"] for item in milestone], [f"You and {other} hit a 3-day streak!"])
        # More study today, and reading the friends list, never repeats it.
        database.mark_study_day("alex-id")
        database.update_progress("sam-id", "Biology", True, 10)
        database.list_friends("alex-id")
        database.list_friends("sam-id")
        self.assertEqual(len(self.notices("alex-id", "streak_milestone")), 1)
        self.assertEqual(len(self.notices("sam-id", "streak_milestone")), 1)

    def test_a_missed_milestone_is_caught_up_when_the_friends_list_is_read(self):
        self.add_days("alex-id", 0, 1, 2, 3, 4, 5, 6)
        self.add_days("sam-id", 0, 1, 2, 3, 4, 5, 6)
        database.list_friends("alex-id")
        database.list_friends("alex-id")
        self.assertEqual([item["message"] for item in self.notices("alex-id")], ["You and Sam hit a 7-day streak!"])

    def test_at_risk_reminder_once_per_day_when_a_friend_studied_first(self):
        self.add_days("alex-id", 1, 2)
        self.add_days("sam-id", 1, 2)
        database.mark_study_day("sam-id")
        database.update_progress("sam-id", "Biology", True, 10)
        database.list_friends("alex-id")
        at_risk = self.notices("alex-id", "streak_at_risk")
        self.assertEqual([item["message"] for item in at_risk], ["Sam studied today. Your turn to keep your 2-day streak going."])
        self.assertEqual(self.notices("sam-id"), [])
        # No reminder without a streak to lose.
        self.assertEqual(self.notices("eve-id"), [])

    def test_at_risk_is_caught_up_on_read_without_duplicates(self):
        self.add_days("alex-id", 1)
        self.add_days("sam-id", 0, 1)
        database.list_friends("alex-id")
        database.list_friends("alex-id")
        self.assertEqual(len(self.notices("alex-id", "streak_at_risk")), 1)

    def test_blocked_people_have_no_streak_and_get_no_notices(self):
        self.add_days("alex-id", 1, 2)
        self.add_days("sam-id", 1, 2)
        database.block_person("alex-id", "sam-id")
        database.mark_study_day("alex-id")
        database.mark_study_day("sam-id")
        self.assertEqual(database.list_friends("alex-id"), [])
        self.assertEqual(self.notices("alex-id"), [])
        self.assertEqual(self.notices("sam-id"), [])
        with self.assertRaisesRegex(ValueError, "not_friends"):
            database.nudge_friend("sam-id", "alex-id")

    # --- nudges ---------------------------------------------------------------------

    def nudge(self, friend_id, user="alex-id"):
        with patch.object(main.auth, "authenticated_user", return_value={"id": user}):
            try:
                return 200, main.nudge_friend(friend_id, "Bearer t")
            except main.HTTPException as error:
                return error.status_code, error.detail

    def test_nudges_are_in_app_only_and_limited_per_friend_per_day(self):
        self.add_days("alex-id", 1)
        self.add_days("sam-id", 1)
        for _ in range(main.NUDGES_PER_FRIEND_PER_DAY):
            self.assertEqual(self.nudge("sam-id"), (200, {"nudged": True}))
        self.assertEqual(self.nudge("sam-id")[0], 429)
        nudges = self.notices("sam-id", "streak_nudge")
        self.assertEqual(len(nudges), main.NUDGES_PER_FRIEND_PER_DAY)
        self.assertEqual(nudges[0]["message"], "Alex reminded you to study today to keep your 1-day streak going.")

    def test_nudges_need_a_friend_who_has_not_studied_yet(self):
        self.assertEqual(self.nudge("eve-id")[0], 404)
        self.assertEqual(self.nudge("alex-id")[0], 404)
        database.mark_study_day("sam-id")
        self.assertEqual(self.nudge("sam-id")[0], 409)
        self.assertEqual(self.notices("eve-id"), [])

    # --- reminder cap and "Let friends nudge me" ---------------------------------------

    def befriend(self, *names):
        for name in names:
            database.onboard_account(f"{name}-id", name, name.title(), None)
            request = database.send_friend_request(f"{name}-id", self.alex["friend_code"])
            database.respond_to_friend_request(request["request_id"], "alex-id", True)
            self.add_days(f"{name}-id", 1)
        self.add_days("alex-id", 1)

    def test_at_risk_notices_and_nudges_are_capped_per_recipient_per_day(self):
        friends = ["ana", "ben", "cal", "dee", "eli", "fay", "gus"]
        self.befriend(*friends)
        # Three friends study first: three "at risk" notices.
        for name in friends[:3]:
            database.mark_study_day(f"{name}-id")
        self.assertEqual(len(self.notices("alex-id", "streak_at_risk")), 3)
        # Two nudges fill the day's five reminders; the next nudge is refused.
        for name in friends[3:5]:
            self.assertEqual(self.nudge("alex-id", user=f"{name}-id"), (200, {"nudged": True}))
        status, detail = self.nudge("alex-id", user=f"{friends[5]}-id")
        self.assertEqual((status, detail["code"]), (429, "reminders_full"))
        # More friends studying first send no more "at risk" notices today.
        database.mark_study_day(f"{friends[6]}-id")
        database.list_friends("alex-id")
        reminders = self.notices("alex-id", "streak_at_risk") + self.notices("alex-id", "streak_nudge")
        self.assertEqual(len(reminders), database.REMINDERS_PER_RECIPIENT_PER_DAY)
        # Milestones are always delivered.
        self.add_days("alex-id", 0, 2, 3, 4, 5, 6)
        self.add_days("sam-id", 0, 1, 2, 3, 4, 5, 6)
        database.list_friends("alex-id")
        self.assertEqual([item["message"] for item in self.notices("alex-id", "streak_milestone")], ["You and Sam hit a 7-day streak!"])
        # Tomorrow starts a new count.
        with at(datetime.now(timezone.utc) + timedelta(days=1)):
            self.assertEqual(self.nudge("alex-id", user="fay-id"), (200, {"nudged": True}))

    def test_students_can_turn_off_nudges_from_friends(self):
        self.add_days("alex-id", 1)
        self.add_days("sam-id", 1)
        self.assertTrue(self.friend("alex-id")["accepts_nudges"])
        self.assertTrue(database.get_profile("sam-id")["allow_nudges"])
        with patch.object(main.auth, "authenticated_user", return_value={"id": "sam-id"}):
            saved = main.save_social_privacy(main.SocialPrivacyUpdate(discoverable=True, allow_friend_requests=True, allow_nudges=False), "Bearer t")
            self.assertFalse(saved["allow_nudges"])
            # An older client that doesn't send the setting leaves it as it is.
            saved = main.save_social_privacy(main.SocialPrivacyUpdate(discoverable=False, allow_friend_requests=True), "Bearer t")
            self.assertEqual((saved["discoverable"], saved["allow_nudges"]), (False, False))
        self.assertFalse(database.get_profile("sam-id")["allow_nudges"])
        self.assertFalse(self.friend("alex-id")["accepts_nudges"])
        status, detail = self.nudge("sam-id")
        self.assertEqual((status, detail["code"]), (403, "nudges_off"))
        self.assertIn("turned off", detail["message"])
        self.assertEqual(self.notices("sam-id", "streak_nudge"), [])
        database.update_social_privacy("sam-id", True, True, True)
        self.assertEqual(self.nudge("sam-id"), (200, {"nudged": True}))


class StudyDayBackfillTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        database.onboard_account("alex-id", "alex", "Alex", None)

    def test_backfill_runs_once_from_recent_xp_and_is_idempotent(self):
        now = datetime.now(timezone.utc)
        with database.engine().begin() as connection:
            for days_ago in (1, 2, 90):
                connection.execute(database.xp_events.insert().values(student_id="alex-id", xp=5, created_at=now - timedelta(days=days_ago)))
            database._backfill_study_days(connection)
            database._backfill_study_days(connection)
        days = {now.date() - timedelta(days=1), now.date() - timedelta(days=2)}
        with database.engine().connect() as connection:
            stored = {value if isinstance(value, date) else date.fromisoformat(str(value)) for value in connection.execute(
                select(database.study_days.c.day).where(database.study_days.c.student_id == "alex-id")).scalars()}
        self.assertEqual(stored, days)


class FriendStreakLockdownTests(unittest.TestCase):
    def test_tables_are_locked_down_and_migrated(self):
        tables = ("study_days", "friend_streak_marks")
        for table in tables:
            self.assertIn(table, database.metadata.tables)
            self.assertIn(table, database.RLS_TABLES)
            self.assertIn(table, database.CLIENT_REVOKED_TABLES)
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261018_friend_streaks.sql")
        with open(path, encoding="utf-8") as handle:
            sql = handle.read().lower()
        for table in tables:
            self.assertIn(f"'{table}'", sql)
            self.assertIn(f"create table if not exists public.{table}", sql)
        self.assertIn("enable row level security", sql)
        self.assertIn("revoke all", sql)
        self.assertIn("on conflict do nothing", sql)
        self.assertNotIn("drop ", sql)
        self.assertNotIn("delete from", sql)
        self.assertNotIn("truncate", sql)


if __name__ == "__main__":
    unittest.main()
