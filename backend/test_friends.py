import os
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

import database
import main


class FriendsTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        self.alex = database.onboard_account("alex-id", "alex", "Alex", None)
        self.sam = database.onboard_account("sam-id", "sam", "Sam", None)

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def become_friends(self):
        request = database.send_friend_request("alex-id", self.sam["friend_code"])
        database.respond_to_friend_request(request["request_id"], "sam-id", True)

    def test_friend_request_acceptance_and_leaderboard(self):
        self.become_friends()
        database.update_progress("alex-id", "Biology", True, 30)
        friends = database.list_friends("sam-id")
        self.assertEqual(friends[0]["student_id"], "alex-id")
        leaderboard = database.friend_leaderboard("sam-id")
        self.assertEqual(leaderboard[0]["student_id"], "alex-id")
        self.assertEqual(leaderboard[0]["total_xp"], 30)

    def test_friend_quest_tracks_combined_xp(self):
        self.become_friends()
        quest = database.create_friend_quest("alex-id", "sam-id", 100)
        self.assertEqual(quest["progress_xp"], 0)
        database.update_progress("sam-id", "History", True, 40)
        updated = database.active_friend_quests("alex-id")[0]
        self.assertEqual(updated["progress_xp"], 40)

    def test_friend_endpoints_use_authenticated_identity(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "alex-id"}):
            result = main.create_friend_request(main.FriendRequestCreate(friend_code=self.sam["friend_code"]), "Bearer test")
        self.assertEqual(result["status"], "pending")
        self.assertEqual(database.pending_friend_requests("sam-id")[0]["username"], "alex")

    def test_recent_xp_groups_events_by_local_day(self):
        from datetime import datetime, timedelta, timezone
        database.update_progress("alex-id", "Biology", True, 30)
        now = datetime.now(timezone.utc)
        days = database.recent_xp("alex-id", days=7, now=now)
        self.assertEqual(len(days), 7)
        self.assertEqual(days[-1]["xp"], 30)
        self.assertEqual(sum(day["xp"] for day in days), 30)
        # Twelve hours west of UTC, an event just after UTC midnight still belongs to the previous local day.
        midnight = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc) + timedelta(minutes=5)
        with database.engine().begin() as connection:
            connection.execute(database.xp_events.insert().values(student_id="sam-id", xp=5, created_at=midnight))
        west = database.recent_xp("sam-id", days=3, tz_offset_minutes=720, now=midnight + timedelta(minutes=1))
        self.assertEqual(west[-1], {"day": (now.date() - timedelta(days=1)).isoformat(), "xp": 5})

    def test_progress_route_includes_recent_xp(self):
        database.update_progress("alex-id", "Biology", True, 20)
        with patch.object(main.auth, "authenticated_user", return_value={"id": "alex-id"}):
            response = main.get_progress("alex-id", "Bearer test", tz_offset=0)
        self.assertEqual(response.recent_xp[-1].xp, 20)

    def test_students_can_be_in_at_most_five_groups(self):
        for index in range(4):
            database.create_study_group("alex-id", f"Group {index}")
        joined = database.create_study_group("sam-id", "Sam's group")
        database.join_study_group("alex-id", joined["invite_code"])
        with self.assertRaisesRegex(ValueError, "group_limit_reached"):
            database.create_study_group("alex-id", "One too many")
        other = database.create_study_group("sam-id", "Another")
        with self.assertRaisesRegex(ValueError, "group_limit_reached"):
            database.join_study_group("alex-id", other["invite_code"])

    def test_cannot_start_quest_with_non_friend(self):
        with self.assertRaisesRegex(ValueError, "friend_not_found"):
            database.create_friend_quest("alex-id", "sam-id", 100)

    def test_weekly_league_and_friend_streak_use_real_xp_events(self):
        self.become_friends()
        database.update_progress("alex-id", "Biology", True, 30)
        database.update_progress("sam-id", "Biology", True, 20)
        league = database.friend_leaderboard("sam-id")
        self.assertEqual([row["weekly_xp"] for row in league], [30, 20])
        self.assertEqual(database.list_friends("sam-id")[0]["friend_streak"], 1)

    def test_search_respects_privacy_and_blocking(self):
        result = database.search_people("alex-id", "sam")
        self.assertEqual(result[0]["student_id"], "sam-id")
        database.update_social_privacy("sam-id", False, False)
        self.assertEqual(database.search_people("alex-id", "sam"), [])
        with self.assertRaisesRegex(ValueError, "friend_requests_disabled"):
            database.send_friend_request("alex-id", self.sam["friend_code"])

    def test_block_removes_friendship_and_prevents_readding(self):
        self.become_friends()
        database.block_person("alex-id", "sam-id")
        self.assertEqual(database.list_friends("alex-id"), [])
        with self.assertRaisesRegex(ValueError, "friend_not_found"):
            database.send_friend_request("sam-id", self.alex["friend_code"])

    def test_activity_reactions_are_limited_to_friends(self):
        self.become_friends()
        database.update_progress("sam-id", "History", True, 15)
        event = database.activity_feed("alex-id")[0]
        self.assertTrue(database.react_to_activity("alex-id", event["id"])["reacted"])
        self.assertEqual(database.notifications_for("sam-id")[0]["kind"], "high_five")
        database.onboard_account("lee-id", "lee", "Lee", None)
        with self.assertRaisesRegex(ValueError, "activity_not_found"):
            database.react_to_activity("lee-id", event["id"])

    def test_report_requires_real_other_profile(self):
        report = database.report_person("alex-id", "sam-id", "spam", "Repeated requests")
        self.assertTrue(report["submitted"])
        with self.assertRaisesRegex(ValueError, "cannot_report_self"):
            database.report_person("alex-id", "alex-id", "spam")

    def test_study_group_invite_members_and_weekly_progress(self):
        group = database.create_study_group("alex-id", "Biology sprint", "Finish cell biology", 300)
        self.assertEqual(group["role"], "owner")
        self.assertEqual(len(group["members"]), 1)

        joined = database.join_study_group("sam-id", group["invite_code"].lower())
        self.assertEqual(joined["role"], "member")
        self.assertEqual(len(joined["members"]), 2)

        database.update_progress("alex-id", "Biology", True, 30)
        database.update_progress("sam-id", "Biology", True, 20)
        refreshed = database.list_study_groups("alex-id")[0]
        self.assertEqual(refreshed["weekly_xp"], 50)
        self.assertEqual([member["weekly_xp"] for member in refreshed["members"]], [30, 20])
        self.assertEqual(len(refreshed["activity"]), 2)

    def test_group_members_can_leave_but_owner_cannot(self):
        group = database.create_study_group("alex-id", "Exam week")
        database.join_study_group("sam-id", group["invite_code"])
        self.assertTrue(database.leave_study_group("sam-id", group["id"]))
        self.assertEqual(len(database.get_study_group("alex-id", group["id"])["members"]), 1)
        with self.assertRaisesRegex(ValueError, "group_owner_cannot_leave"):
            database.leave_study_group("alex-id", group["id"])

    def test_group_endpoints_use_authenticated_identity(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "alex-id"}):
            group = main.create_study_group(main.StudyGroupCreate(name="Calculus crew"), "Bearer test")
        with patch.object(main.auth, "authenticated_user", return_value={"id": "sam-id"}):
            joined = main.join_study_group(main.StudyGroupJoin(invite_code=group["invite_code"]), "Bearer test")
        self.assertEqual(joined["members"][1]["student_id"], "sam-id")


if __name__ == "__main__":
    unittest.main()
