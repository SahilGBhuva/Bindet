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

    def test_missing_profile_is_a_clean_error_not_a_500(self):
        group = database.create_study_group("alex-id", "Bio crew")
        with patch.object(main.auth, "authenticated_user", return_value={"id": "no-profile-id"}):
            with self.assertRaises(main.HTTPException) as caught:
                main.join_study_group(main.StudyGroupJoin(invite_code=group["invite_code"]), "Bearer t")
            self.assertEqual(caught.exception.status_code, 400)
            database.update_progress("alex-id", "addition", True, 10)
            event_id = database.activity_feed("alex-id")[0]["id"]
            with self.assertRaises(main.HTTPException) as caught:
                main.react_to_social_activity(event_id, "Bearer t")
            self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual([member["student_id"] for member in database.get_study_group("alex-id", group["id"])["members"]], ["alex-id"])

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

    def quest_status(self, quest_id):
        with database.engine().connect() as connection:
            return connection.execute(database.select(database.friend_quests.c.status).where(
                database.friend_quests.c.id == quest_id)).scalar_one()

    def test_unfriending_or_blocking_cancels_quests(self):
        self.become_friends()
        quest = database.create_friend_quest("alex-id", "sam-id", 100)
        database.remove_friend("sam-id", "alex-id")
        self.assertEqual(self.quest_status(quest["id"]), "cancelled")
        self.assertEqual(database.active_friend_quests("alex-id"), [])
        self.become_friends()
        quest = database.create_friend_quest("sam-id", "alex-id", 100)
        database.block_person("alex-id", "sam-id")
        self.assertEqual(self.quest_status(quest["id"]), "cancelled")
        self.assertEqual(database.active_friend_quests("sam-id"), [])

    def test_quests_are_only_listed_with_current_friends(self):
        self.become_friends()
        quest = database.create_friend_quest("alex-id", "sam-id", 100)
        # Even if a stale active row survives (data from before this fix), it is hidden once not friends.
        with database.engine().begin() as connection:
            connection.execute(database.delete(database.friendships))
            connection.execute(database.update(database.friend_quests).values(status="active"))
        self.assertEqual(database.active_friend_quests("alex-id"), [])
        self.assertEqual(self.quest_status(quest["id"]), "active")

    def test_finished_and_expired_quests_are_stored_and_free_the_pair(self):
        self.become_friends()
        quest = database.create_friend_quest("alex-id", "sam-id", 50)
        database.update_progress("sam-id", "History", True, 60)
        listed = database.active_friend_quests("alex-id")
        self.assertEqual([item["status"] for item in listed], ["complete"])  # still shown until its week ends
        self.assertEqual(self.quest_status(quest["id"]), "complete")
        second = database.create_friend_quest("sam-id", "alex-id", 100)
        self.assertNotEqual(second["id"], quest["id"])
        self.assertEqual(second["status"], "active")
        # Past its end date, an unfinished quest is stored as expired and a new one can start.
        with database.engine().begin() as connection:
            connection.execute(database.update(database.friend_quests).where(database.friend_quests.c.id == second["id"]).values(
                expires_at=database.datetime.now(database.timezone.utc) - database.timedelta(days=1)))
        third = database.create_friend_quest("alex-id", "sam-id", 100)
        self.assertEqual(self.quest_status(second["id"]), "expired")
        self.assertNotIn(second["id"], [item["id"] for item in database.active_friend_quests("alex-id")])
        self.assertIn(third["id"], [item["id"] for item in database.active_friend_quests("alex-id")])

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

    def test_listing_several_groups_keeps_each_groups_members_and_activity_apart(self):
        database.onboard_account("kim-id", "kim", "Kim", None)
        bio = database.create_study_group("alex-id", "Bio crew")
        chem = database.create_study_group("alex-id", "Chem crew")
        database.join_study_group("sam-id", bio["invite_code"])
        database.join_study_group("kim-id", chem["invite_code"])
        for _ in range(10):
            database.update_progress("sam-id", "Biology", True, 10)
        database.update_progress("kim-id", "Chemistry", True, 20)
        database.block_person("alex-id", "kim-id")
        groups = {group["name"]: group for group in database.list_study_groups("alex-id")}
        self.assertEqual({m["student_id"] for m in groups["Bio crew"]["members"]}, {"alex-id", "sam-id"})
        self.assertEqual({m["student_id"] for m in groups["Chem crew"]["members"]}, {"alex-id", "kim-id"})
        self.assertEqual(len(groups["Bio crew"]["activity"]), 8)
        self.assertEqual({item["student_id"] for item in groups["Bio crew"]["activity"]}, {"sam-id"})
        # Blocked members still count toward the group but leave the viewer's feed.
        self.assertEqual(groups["Chem crew"]["activity"], [])
        self.assertEqual(groups["Chem crew"]["weekly_xp"], 20)
        self.assertEqual(groups["Bio crew"]["role"], "owner")
        self.assertEqual(database.get_study_group("kim-id", chem["id"])["role"], "member")
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            database.get_study_group("kim-id", bio["id"])

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
