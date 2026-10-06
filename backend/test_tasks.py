import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi import HTTPException
from fastapi.testclient import TestClient

import database
import main
import tasks


class TaskTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        tasks.reset_tasks()
        database.onboard_account("alex-id", "alex", "Alex", None)
        database.onboard_account("sam-id", "sam", "Sam", None)
        database.onboard_account("eve-id", "eve", "Eve", None)
        self.group = database.create_study_group("alex-id", "Bio crew")
        database.join_study_group("sam-id", self.group["invite_code"])

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def group_task(self, **extra):
        return tasks.create_task("alex-id", {"title": "Lab report", "group_id": self.group["id"], **extra})

    def test_personal_task_is_private_to_its_owner(self):
        task = tasks.create_task("alex-id", {"title": "Read chapter 4", "due_date": "2026-10-09"})
        self.assertEqual(task["assignees"][0]["student_id"], "alex-id")
        self.assertEqual([item["id"] for item in tasks.list_tasks("alex-id")], [task["id"]])
        self.assertEqual(tasks.list_tasks("sam-id"), [])
        for action in (
            lambda: tasks.get_task("sam-id", task["id"]),
            lambda: tasks.update_task("sam-id", task["id"], {"status": "done"}),
            lambda: tasks.delete_task("sam-id", task["id"]),
            lambda: tasks.add_comment("sam-id", task["id"], "hi"),
        ):
            with self.assertRaisesRegex(ValueError, "task_not_found"):
                action()

    def test_personal_tasks_cannot_be_assigned_to_others(self):
        with self.assertRaisesRegex(ValueError, "invalid_assignee"):
            tasks.create_task("alex-id", {"title": "Essay", "assignee_ids": ["sam-id"]})

    def test_group_tasks_are_visible_to_members_only(self):
        task = self.group_task(assignee_ids=["sam-id"])
        self.assertEqual(tasks.list_tasks("sam-id")[0]["id"], task["id"])
        self.assertEqual(tasks.list_tasks("eve-id"), [])
        with self.assertRaisesRegex(ValueError, "task_not_found"):
            tasks.get_task("eve-id", task["id"])
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            tasks.create_task("eve-id", {"title": "Sneaky", "group_id": self.group["id"]})

    def test_leaving_a_group_removes_access(self):
        task = self.group_task(assignee_ids=["sam-id"])
        database.leave_study_group("sam-id", self.group["id"])
        self.assertEqual(tasks.list_tasks("sam-id"), [])
        with self.assertRaisesRegex(ValueError, "task_not_found"):
            tasks.update_task("sam-id", task["id"], {"status": "done"})

    def test_assignees_must_be_group_members(self):
        with self.assertRaisesRegex(ValueError, "invalid_assignee"):
            self.group_task(assignee_ids=["eve-id"])

    def test_unassigned_member_can_view_and_comment_but_not_edit(self):
        task = self.group_task(assignee_ids=["alex-id"])
        detail = tasks.get_task("sam-id", task["id"])
        self.assertFalse(detail["can_edit"])
        self.assertFalse(detail["can_delete"])
        tasks.add_comment("sam-id", task["id"], "I can help with the graphs")
        with self.assertRaisesRegex(ValueError, "task_forbidden"):
            tasks.update_task("sam-id", task["id"], {"status": "done"})
        with self.assertRaisesRegex(ValueError, "task_forbidden"):
            tasks.add_checklist_item("sam-id", task["id"], "Graphs")

    def test_assignee_can_move_status_but_only_creator_or_owner_deletes(self):
        task = tasks.create_task("sam-id", {"title": "Slides", "group_id": self.group["id"], "assignee_ids": ["sam-id"]})
        database.onboard_account("kim-id", "kim", "Kim", None)
        database.join_study_group("kim-id", self.group["invite_code"])
        tasks.update_task("sam-id", task["id"], {"assignee_ids": ["sam-id", "kim-id"]})
        moved = tasks.update_task("kim-id", task["id"], {"status": "review"})
        self.assertEqual(moved["status"], "review")
        with self.assertRaisesRegex(ValueError, "task_forbidden"):
            tasks.delete_task("kim-id", task["id"])
        # The group owner moderates every group task.
        self.assertTrue(tasks.delete_task("alex-id", task["id"]))

    def test_status_changes_track_completion_and_activity(self):
        task = self.group_task()
        done = tasks.update_task("alex-id", task["id"], {"status": "done"})
        self.assertIsNotNone(done["completed_at"])
        reopened = tasks.update_task("alex-id", task["id"], {"status": "in_progress"})
        self.assertIsNone(reopened["completed_at"])
        kinds = [item["kind"] for item in tasks.get_task("alex-id", task["id"])["activity"]]
        self.assertEqual(kinds.count("status"), 2)
        self.assertIn("created", kinds)

    def test_validation_rejects_bad_fields(self):
        with self.assertRaisesRegex(ValueError, "invalid_task_title"):
            tasks.create_task("alex-id", {"title": "   "})
        with self.assertRaisesRegex(ValueError, "invalid_task_status"):
            tasks.create_task("alex-id", {"title": "x", "status": "archived"})
        with self.assertRaisesRegex(ValueError, "invalid_due_time"):
            tasks.create_task("alex-id", {"title": "x", "due_time": "25:00"})
        with self.assertRaisesRegex(ValueError, "invalid_due_date"):
            tasks.create_task("alex-id", {"title": "x", "due_date": "next tuesday"})

    def test_checklist_progress_is_summarised(self):
        task = tasks.create_task("alex-id", {"title": "Study guide"})
        first = tasks.add_checklist_item("alex-id", task["id"], "Vocab")
        tasks.add_checklist_item("alex-id", task["id"], "Practice set")
        tasks.update_checklist_item("alex-id", task["id"], first["id"], {"done": True})
        summary = tasks.list_tasks("alex-id")[0]
        self.assertEqual((summary["checklist_done"], summary["checklist_total"]), (1, 2))

    def test_checklist_item_ids_are_scoped_to_their_task(self):
        mine = tasks.create_task("alex-id", {"title": "Mine"})
        item = tasks.add_checklist_item("alex-id", mine["id"], "Private step")
        theirs = tasks.create_task("sam-id", {"title": "Theirs"})
        with self.assertRaisesRegex(ValueError, "checklist_item_not_found"):
            tasks.update_checklist_item("sam-id", theirs["id"], item["id"], {"done": True})

    def test_assignment_and_comment_notify_group_members(self):
        task = self.group_task(assignee_ids=["sam-id"])
        tasks.add_comment("sam-id", task["id"], "Started the intro")
        kinds = {item["kind"] for item in database.notifications_for("sam-id")}
        self.assertIn("task_assigned", kinds)
        self.assertIn("task_comment", {item["kind"] for item in database.notifications_for("alex-id")})

    def test_note_attachments_require_ownership_and_hide_note_ids(self):
        task = self.group_task(assignee_ids=["alex-id", "sam-id"])
        sam_note = {"id": "note-1", "student_id": "sam-id", "file_name": "cells.pdf"}
        with self.assertRaisesRegex(ValueError, "note_not_found"):
            tasks.add_attachment("alex-id", task["id"], "note", note=sam_note)
        tasks.add_attachment("sam-id", task["id"], "note", note=sam_note)
        alex_view = tasks.get_task("alex-id", task["id"])["attachments"][0]
        self.assertEqual(alex_view["label"], "cells.pdf")
        self.assertEqual(alex_view["note_id"], "")
        with self.assertRaisesRegex(ValueError, "invalid_attachment_url"):
            tasks.add_attachment("alex-id", task["id"], "link", url="javascript:alert(1)")

    def test_milestones_are_owner_managed(self):
        with self.assertRaisesRegex(ValueError, "group_owner_required"):
            tasks.create_milestone("sam-id", self.group["id"], "Draft due")
        milestone = tasks.create_milestone("alex-id", self.group["id"], "Draft due", "2026-10-20")
        task = self.group_task(milestone_id=milestone["id"])
        tasks.update_task("alex-id", task["id"], {"status": "done"})
        listed = tasks.list_milestones("sam-id", self.group["id"])[0]
        self.assertEqual((listed["done"], listed["total"], listed["percent"]), (1, 1, 100))
        other = database.create_study_group("eve-id", "Other")
        with self.assertRaisesRegex(ValueError, "milestone_not_found"):
            tasks.create_task("eve-id", {"title": "x", "group_id": other["id"], "milestone_id": milestone["id"]})

    def test_timestamps_are_returned_as_utc(self):
        task = tasks.create_task("alex-id", {"title": "Timezones"})
        tasks.add_comment("alex-id", task["id"], "note")
        detail = tasks.get_task("alex-id", task["id"])
        for value in (detail["created_at"], detail["comments"][0]["created_at"], detail["activity"][0]["created_at"]):
            self.assertIsNotNone(value.tzinfo)

    def test_group_analytics_reports_workload_and_projection(self):
        first = self.group_task(assignee_ids=["sam-id"])
        self.group_task(assignee_ids=["alex-id"])
        tasks.update_task("sam-id", first["id"], {"status": "done"})
        report = tasks.group_analytics("sam-id", self.group["id"])
        self.assertEqual(report["totals"]["total"], 2)
        self.assertEqual(report["totals"]["percent"], 50)
        sam = next(member for member in report["members"] if member["student_id"] == "sam-id")
        self.assertEqual((sam["assigned"], sam["completed"]), (1, 1))
        # Analytics days are UTC days, which can differ from the local date in the evening.
        today_utc = datetime.now(timezone.utc).date()
        self.assertEqual(report["series"][-1], {"date": today_utc.isoformat(), "total": 2, "done": 1})
        self.assertGreater(date.fromisoformat(report["projected_finish"]), today_utc - timedelta(days=1))
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            tasks.group_analytics("eve-id", self.group["id"])

    def test_events_keep_kind_and_location(self):
        task = tasks.create_task("alex-id", {"title": "Soccer", "kind": "event", "location": "10705 W Palms", "due_date": "2026-10-05", "due_time": "16:30"})
        self.assertEqual((task["kind"], task["location"], task["due_time"]), ("event", "10705 W Palms", "16:30"))
        with self.assertRaisesRegex(ValueError, "invalid_task_kind"):
            tasks.update_task("alex-id", task["id"], {"kind": "meeting"})

    def test_project_stats_split_completion_and_track_pace(self):
        quiet = self.group_task(assignee_ids=["sam-id"])
        started = self.group_task(assignee_ids=["sam-id"])
        finished = self.group_task(assignee_ids=["alex-id"])
        tasks.update_task("sam-id", started["id"], {"status": "in_progress"})
        tasks.update_task("alex-id", finished["id"], {"status": "done"})
        tasks.create_milestone("alex-id", self.group["id"], "Final", (date.today() + timedelta(days=1)).isoformat())
        report = tasks.group_analytics("sam-id", self.group["id"])
        self.assertEqual(report["completion"], {"completed": 1, "unfinished": 1, "no_response": 1})
        self.assertEqual(report["pace"], "behind")
        self.assertTrue(any("no response" in line for line in report["overview"]))
        self.assertEqual({m["student_id"]: m["active"] for m in report["members"]}, {"alex-id": True, "sam-id": True})
        self.assertIsNotNone(quiet)

    def join(self, student_id, name):
        database.onboard_account(student_id, name.lower(), name, None)
        database.join_study_group(student_id, self.group["invite_code"])

    def test_assignees_cannot_rename_reschedule_or_reassign(self):
        task = self.group_task(assignee_ids=["sam-id"], due_date="2026-10-20")
        self.assertTrue(task["can_manage"])
        mine = tasks.get_task("sam-id", task["id"])
        self.assertTrue(mine["can_edit"])
        self.assertFalse(mine["can_manage"])
        for change in ({"title": "Mine now"}, {"assignee_ids": ["sam-id"]}, {"due_date": None},
                       {"due_time": "09:00"}, {"group_id": None}, {"milestone_id": None}):
            with self.assertRaisesRegex(ValueError, "task_manage_forbidden"):
                tasks.update_task("sam-id", task["id"], change)
        updated = tasks.update_task("sam-id", task["id"], {"status": "in_progress", "description": "Drafted intro"})
        self.assertEqual((updated["status"], updated["description"]), ("in_progress", "Drafted intro"))
        tasks.add_checklist_item("sam-id", task["id"], "Graphs")
        self.assertEqual(tasks.get_task("sam-id", task["id"])["title"], "Lab report")

    def test_leaving_unassigns_open_tasks_and_stops_notifications(self):
        open_task = self.group_task(assignee_ids=["alex-id", "sam-id"])
        done_task = self.group_task(assignee_ids=["sam-id"])
        tasks.update_task("alex-id", done_task["id"], {"status": "done"})
        tasks.leave_group("sam-id", self.group["id"])
        self.assertEqual([p["student_id"] for p in tasks.get_task("alex-id", open_task["id"])["assignees"]], ["alex-id"])
        self.assertEqual([p["student_id"] for p in tasks.get_task("alex-id", done_task["id"])["assignees"]], ["sam-id"])
        before = len(database.notifications_for("sam-id"))
        # Completing, commenting on or reopening the former member's old task notifies no one outside the group.
        tasks.update_task("alex-id", done_task["id"], {"status": "todo"})
        tasks.update_task("alex-id", done_task["id"], {"status": "done"})
        tasks.add_comment("alex-id", done_task["id"], "Wrapping up")
        self.assertEqual(len(database.notifications_for("sam-id")), before)

    def test_stale_assignees_do_not_block_saving(self):
        self.join("kim-id", "Kim")
        task = self.group_task(assignee_ids=["sam-id", "kim-id"])
        # Simulate an older leave that kept the assignment.
        database.leave_study_group("kim-id", self.group["id"])
        saved = tasks.update_task("alex-id", task["id"], {"assignee_ids": ["sam-id", "kim-id", "alex-id"]})
        self.assertEqual({p["student_id"] for p in saved["assignees"]}, {"sam-id", "alex-id"})
        with self.assertRaisesRegex(ValueError, "invalid_assignee"):
            tasks.update_task("alex-id", task["id"], {"assignee_ids": ["eve-id"]})
        # The stale assignee is never notified about the task again.
        tasks.update_task("alex-id", task["id"], {"status": "done"})
        self.assertNotIn("task_completed", {item["kind"] for item in database.notifications_for("kim-id")})

    def test_moving_a_task_between_groups(self):
        other = database.create_study_group("alex-id", "Chem crew")
        task = self.group_task(assignee_ids=["alex-id", "sam-id"])
        milestone = tasks.create_milestone("alex-id", self.group["id"], "Draft")
        tasks.update_task("alex-id", task["id"], {"milestone_id": milestone["id"], "status": "in_progress"})
        moved = tasks.update_task("alex-id", task["id"], {"group_id": other["id"], "assignee_ids": ["alex-id"]})
        self.assertEqual((moved["group_id"], moved["group_name"], moved["milestone_id"]), (other["id"], "Chem crew", None))
        self.assertEqual([p["student_id"] for p in moved["assignees"]], ["alex-id"])
        self.assertEqual(tasks.list_tasks("sam-id"), [])
        self.assertEqual(tasks.group_analytics("alex-id", self.group["id"])["activity"], [])
        # Without an explicit list, assignees who are not in the new group are dropped.
        back = tasks.update_task("alex-id", task["id"], {"group_id": self.group["id"]})
        tasks.update_task("alex-id", task["id"], {"assignee_ids": ["alex-id", "sam-id"]})
        personal = tasks.update_task("alex-id", task["id"], {"group_id": None})
        self.assertIsNone(personal["group_id"])
        self.assertEqual([p["student_id"] for p in personal["assignees"]], ["alex-id"])
        self.assertEqual(back["group_id"], self.group["id"])
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            tasks.update_task("alex-id", task["id"], {"group_id": "0" * 32})

    def test_group_owner_cannot_move_a_task_where_its_creator_is_not_a_member(self):
        other = database.create_study_group("alex-id", "Chem crew")
        task = tasks.create_task("sam-id", {"title": "Slides", "group_id": self.group["id"]})
        with self.assertRaisesRegex(ValueError, "task_owner_not_in_group"):
            tasks.update_task("alex-id", task["id"], {"group_id": other["id"]})

    def test_moving_drops_other_peoples_comments_attachments_and_history(self):
        database.join_study_group("eve-id", self.group["invite_code"])
        other = database.create_study_group("alex-id", "Chem crew")
        database.join_study_group("eve-id", other["invite_code"])
        task = self.group_task(assignee_ids=["sam-id"])
        tasks.add_comment("sam-id", task["id"], "Sam's private thoughts")
        tasks.add_comment("alex-id", task["id"], "Alex's note")
        tasks.add_attachment("sam-id", task["id"], "link", "Sam's doc", "https://example.com/sam")
        tasks.add_attachment("alex-id", task["id"], "link", "Alex's doc", "https://example.com/alex")
        tasks.update_task("sam-id", task["id"], {"status": "in_progress"})
        tasks.update_task("alex-id", task["id"], {"group_id": other["id"]})
        seen = tasks.get_task("eve-id", task["id"])
        self.assertEqual([c["body"] for c in seen["comments"]], ["Alex's note"])
        self.assertEqual([a["label"] for a in seen["attachments"]], ["Alex's doc"])
        # Only what the move itself did: the move, and Sam dropped as a non-member.
        self.assertEqual(sorted(a["kind"] for a in seen["activity"]), ["assignees", "moved"])
        # The old group's analytics keep nothing about the task.
        self.assertEqual(tasks.group_analytics("alex-id", self.group["id"])["activity"], [])

    def test_moving_keeps_the_creators_comments_and_links(self):
        database.join_study_group("eve-id", self.group["invite_code"])
        other = database.create_study_group("alex-id", "Chem crew")
        database.join_study_group("sam-id", other["invite_code"])
        task = tasks.create_task("sam-id", {"title": "Slides", "group_id": self.group["id"], "assignee_ids": ["eve-id"]})
        tasks.add_comment("sam-id", task["id"], "Sam's outline")
        tasks.add_comment("eve-id", task["id"], "Eve's thoughts")
        tasks.add_attachment("sam-id", task["id"], "link", "Sam's deck", "https://example.com/sam")
        tasks.add_attachment("eve-id", task["id"], "link", "Eve's doc", "https://example.com/eve")
        # The group owner moves sam's task: sam's own work travels with it, eve's does not.
        tasks.update_task("alex-id", task["id"], {"group_id": other["id"]})
        seen = tasks.get_task("sam-id", task["id"])
        self.assertEqual([c["body"] for c in seen["comments"]], ["Sam's outline"])
        self.assertEqual([a["label"] for a in seen["attachments"]], ["Sam's deck"])

    def test_only_the_creator_can_make_a_group_task_personal(self):
        task = tasks.create_task("sam-id", {"title": "Slides", "group_id": self.group["id"]})
        with self.assertRaisesRegex(ValueError, "task_manage_forbidden"):
            tasks.update_task("alex-id", task["id"], {"group_id": None})
        tasks.add_comment("alex-id", task["id"], "Owner feedback")
        personal = tasks.update_task("sam-id", task["id"], {"group_id": None})
        self.assertIsNone(personal["group_id"])
        self.assertEqual(tasks.get_task("sam-id", task["id"])["comments"], [])

    def test_a_creator_who_left_cannot_get_the_task_back(self):
        other = database.create_study_group("alex-id", "Chem crew")
        database.join_study_group("sam-id", other["invite_code"])
        task = tasks.create_task("sam-id", {"title": "Slides", "group_id": self.group["id"]})
        database.leave_study_group("sam-id", self.group["id"])
        with self.assertRaisesRegex(ValueError, "task_manage_forbidden"):
            tasks.update_task("alex-id", task["id"], {"group_id": None})
        with self.assertRaisesRegex(ValueError, "task_owner_not_in_group"):
            tasks.update_task("alex-id", task["id"], {"group_id": other["id"]})
        with self.assertRaisesRegex(ValueError, "task_not_found"):
            tasks.get_task("sam-id", task["id"])
        self.assertEqual(tasks.list_tasks("sam-id"), [])

    def test_analytics_is_members_only_and_shares_no_practice_details(self):
        self.group_task(assignee_ids=["sam-id"])
        database.update_progress("sam-id", "addition", True, 10)
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            tasks.group_analytics("eve-id", self.group["id"])
        database.leave_study_group("sam-id", self.group["id"])
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            tasks.group_analytics("sam-id", self.group["id"])
        report = tasks.group_analytics("alex-id", self.group["id"])
        member_keys = {key for member in report["members"] for key in member}
        self.assertEqual(member_keys, {"student_id", "display_name", "username", "role", "assigned", "completed", "active"})
        self.assertNotIn("xp", repr(report).lower())

    def test_only_the_group_owner_can_notify_members(self):
        with self.assertRaisesRegex(ValueError, "group_owner_required"):
            tasks.notify_members("sam-id", self.group["id"], "Please finish your slides")
        self.assertEqual(tasks.notify_members("alex-id", self.group["id"], "Please finish your slides"), 1)
        self.assertIn("group_notice", {item["kind"] for item in database.notifications_for("sam-id")})
        with self.assertRaisesRegex(ValueError, "group_not_found"):
            tasks.notify_members("eve-id", self.group["id"], "hi")

    def test_repeated_notifications_are_coalesced_until_read(self):
        task = self.group_task(assignee_ids=["alex-id"])
        for _ in range(5):
            tasks.update_task("alex-id", task["id"], {"assignee_ids": ["alex-id", "sam-id"]})
            tasks.update_task("alex-id", task["id"], {"assignee_ids": ["alex-id"]})
        for _ in range(3):
            tasks.add_comment("alex-id", task["id"], "ping")
        tasks.add_comment("sam-id", task["id"], "pong")
        kinds = [item["kind"] for item in database.notifications_for("sam-id")]
        self.assertEqual(kinds.count("task_assigned"), 1)
        self.assertEqual(kinds.count("task_comment"), 0)  # sam is no longer assigned
        self.assertEqual([item["kind"] for item in database.notifications_for("alex-id")].count("task_comment"), 1)
        # Once read, the next one arrives again.
        database.mark_notifications_read("sam-id")
        tasks.update_task("alex-id", task["id"], {"assignee_ids": ["alex-id", "sam-id"]})
        unread = [item for item in database.notifications_for("sam-id") if not item["is_read"]]
        self.assertEqual([item["kind"] for item in unread], ["task_assigned"])


class TaskRouteTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        tasks.reset_tasks()
        database.onboard_account("alex-id", "alex", "Alex", None)
        database.onboard_account("sam-id", "sam", "Sam", None)

    def as_user(self, student_id):
        return patch.object(main.auth, "authenticated_user", return_value={"id": student_id})

    def test_routes_use_the_authenticated_identity(self):
        with self.as_user("alex-id"):
            created = main.create_task_route(main.TaskCreate(title="Flashcards"), "Bearer test")
        self.assertEqual(created["owner"]["student_id"], "alex-id")
        with self.as_user("sam-id"):
            self.assertEqual(main.list_tasks_route(None, "Bearer test"), [])
            with self.assertRaises(HTTPException) as caught:
                main.update_task_route(created["id"], main.TaskUpdate(status="done"), "Bearer test")
        self.assertEqual(caught.exception.status_code, 404)

    def test_task_payloads_reject_unknown_fields(self):
        with self.assertRaises(Exception):
            main.TaskCreate(title="x", owner_id="sam-id")

    def test_task_creation_is_rate_limited(self):
        with self.as_user("alex-id"), patch.object(main, "TASK_CREATE_LIMIT", 2):
            main.create_task_route(main.TaskCreate(title="One"), "Bearer test")
            main.create_task_route(main.TaskCreate(title="Two"), "Bearer test")
            with self.assertRaises(HTTPException) as caught:
                main.create_task_route(main.TaskCreate(title="Three"), "Bearer test")
        self.assertEqual(caught.exception.status_code, 429)

    def test_assignee_changes_have_their_own_hourly_cap(self):
        group = database.create_study_group("alex-id", "Bio crew")
        database.join_study_group("sam-id", group["invite_code"])
        task = tasks.create_task("alex-id", {"title": "Lab", "group_id": group["id"]})
        with self.as_user("alex-id"), patch.object(main, "TASK_ASSIGN_LIMIT", 2):
            main.update_task_route(task["id"], main.TaskUpdate(assignee_ids=["sam-id"]), "Bearer test")
            # Assigning only yourself, unassigning, or resending the same list costs nothing.
            for _ in range(3):
                main.update_task_route(task["id"], main.TaskUpdate(assignee_ids=["alex-id"]), "Bearer test")
            main.update_task_route(task["id"], main.TaskUpdate(assignee_ids=["sam-id"]), "Bearer test")
            main.update_task_route(task["id"], main.TaskUpdate(assignee_ids=["sam-id"]), "Bearer test")
            main.update_task_route(task["id"], main.TaskUpdate(assignee_ids=[]), "Bearer test")
            with self.assertRaises(HTTPException) as caught:
                main.update_task_route(task["id"], main.TaskUpdate(assignee_ids=["sam-id"]), "Bearer test")
            self.assertEqual(caught.exception.status_code, 429)
            # The refused edit changed nothing.
            self.assertEqual(tasks.get_task("alex-id", task["id"])["assignees"], [])
            # Other edits still go through.
            main.update_task_route(task["id"], main.TaskUpdate(status="in_progress"), "Bearer test")
            with self.assertRaises(HTTPException):
                main.create_task_route(main.TaskCreate(title="More", group_id=group["id"], assignee_ids=["sam-id"]), "Bearer test")

    def test_personal_tasks_and_moves_do_not_use_the_assignment_cap(self):
        group = database.create_study_group("alex-id", "Bio crew")
        other = database.create_study_group("alex-id", "Chem crew")
        database.join_study_group("sam-id", group["invite_code"])
        database.join_study_group("sam-id", other["invite_code"])
        personal = tasks.create_task("alex-id", {"title": "Read"})
        task = tasks.create_task("alex-id", {"title": "Lab", "group_id": group["id"], "assignee_ids": ["sam-id"]})
        with self.as_user("alex-id"), patch.object(main, "TASK_ASSIGN_LIMIT", 0):
            for _ in range(3):
                main.update_task_route(personal["id"], main.TaskUpdate(assignee_ids=["alex-id"]), "Bearer test")
            # Moving keeps sam assigned without assigning anyone new.
            moved = main.update_task_route(task["id"], main.TaskUpdate(group_id=other["id"]), "Bearer test")
        self.assertEqual([p["student_id"] for p in moved["assignees"]], ["sam-id"])

    def test_update_only_applies_fields_that_were_sent(self):
        with self.as_user("alex-id"):
            created = main.create_task_route(main.TaskCreate(title="Essay", due_date="2026-10-10", priority="high"), "Bearer test")
            updated = main.update_task_route(created["id"], main.TaskUpdate(status="in_progress"), "Bearer test")
            cleared = main.update_task_route(created["id"], main.TaskUpdate(due_date=None), "Bearer test")
        self.assertEqual((updated["due_date"], updated["priority"]), ("2026-10-10", "high"))
        self.assertIsNone(cleared["due_date"])

    def test_patch_can_move_a_task_to_another_group(self):
        group = database.create_study_group("alex-id", "Bio crew")
        other = database.create_study_group("alex-id", "Chem crew")
        database.join_study_group("sam-id", group["invite_code"])
        task = tasks.create_task("alex-id", {"title": "Lab", "group_id": group["id"], "assignee_ids": ["sam-id"]})
        client = TestClient(main.app)
        with self.as_user("alex-id"):
            response = client.patch(f"/api/tasks/{task['id']}", json={"group_id": other["id"], "assignee_ids": ["alex-id"]},
                                    headers={"Authorization": "Bearer test"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["group_id"], other["id"])
        with self.as_user("sam-id"):
            response = client.get(f"/api/study-groups/{other['id']}/analytics", headers={"Authorization": "Bearer test"})
        self.assertEqual(response.status_code, 404)

    def test_leave_route_unassigns_open_tasks(self):
        group = database.create_study_group("alex-id", "Bio crew")
        database.join_study_group("sam-id", group["invite_code"])
        task = tasks.create_task("alex-id", {"title": "Lab", "group_id": group["id"], "assignee_ids": ["sam-id"]})
        with self.as_user("sam-id"):
            self.assertEqual(main.leave_study_group(group["id"], "Bearer test"), {"left": True})
        self.assertEqual(tasks.get_task("alex-id", task["id"])["assignees"], [])


if __name__ == "__main__":
    unittest.main()
