import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select, update

import account_deletion
import classroom
import classroom_store
import database
import main
import note_store
import tasks

URL = "https://calendar.google.com/calendar/ical/c_abc123%40classroom.google.com/private-0123456789abcdef0123456789abcdef/basic.ics"
TOKEN = "private-0123456789abcdef0123456789abcdef"
NOW = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
LONG = ("Read pages 40 to 52 and answer questions 1 through 6 in full sentences. "
        "Show your working for the calculation questions and cite the textbook.")


def vevent(uid, summary, start, *, description="", extra=""):
    lines = ["BEGIN:VEVENT", f"UID:{uid}", f"SUMMARY:{summary}", start]
    if description:
        lines.append(f"DESCRIPTION:{description}")
    if extra:
        lines.append(extra)
    lines.append("END:VEVENT")
    return "\r\n".join(lines)


def ics(*events):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Google Inc//Google Calendar 70.9054//EN\r\n"
            + "\r\n".join(events) + "\r\nEND:VCALENDAR\r\n").encode()


def mock_client(handler):
    def factory():
        return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False, trust_env=False)
    return patch.object(classroom, "_client", factory)


def serve(body, status=200, content_type="text/calendar; charset=UTF-8", headers=None):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(status, content=body, headers={"content-type": content_type, **(headers or {})})
    return handler, seen


def tearDownModule():
    if os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


class UrlValidationTests(unittest.TestCase):
    def test_accepts_secret_addresses(self):
        self.assertEqual(classroom.parse_calendar_url(URL), URL)
        self.assertEqual(classroom.parse_calendar_url(f"  {URL}\n"), URL)
        other = "https://calendar.google.com/calendar/ical/student.name%40school.org/private-89ab89ab89ab89ab89ab/basic.ics"
        self.assertEqual(classroom.parse_calendar_url(other), other)

    def test_rejects_everything_else(self):
        bad = [
            URL.replace("https://", "http://"),
            URL.replace("calendar.google.com", "calendar.google.com.evil.com"),
            URL.replace("calendar.google.com", "evil.com"),
            URL.replace("calendar.google.com", "calendar.google.com:8443"),
            URL.replace("calendar.google.com", "user@calendar.google.com"),
            URL.replace("calendar.google.com", "142.250.80.46"),
            URL.replace("calendar.google.com", "[::1]"),
            URL.replace("calendar.google.com", "127.0.0.1"),
            URL + "?redirect=https://evil.com",
            URL + "#x",
            URL.replace("/basic.ics", "/basic.ics/../../x"),
            URL.replace("/basic.ics", "/full.xml"),
            URL.replace(TOKEN, "public"),
            URL.replace(TOKEN, "private-XYZ"),
            URL.replace("c_abc123%40classroom.google.com", "c_abc%2F..%2Fx"),
            URL.replace("c_abc123%40classroom.google.com", ".."),
            URL.replace("/calendar/ical/", "/calendar/embed/"),
            "https://www.google.com/calendar/ical/x/private-0123456789abcdef/basic.ics",
            "webcal://calendar.google.com/calendar/ical/x/private-0123456789abcdef/basic.ics",
            "javascript:alert(1)", "", "   ",
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid_calendar_url"):
                classroom.parse_calendar_url(value)

    def test_masked_url_reveals_nothing(self):
        masked = classroom.masked_url(URL)
        self.assertNotIn("0123456789abcdef", masked)
        self.assertNotIn("c_abc123", masked)


class FetchTests(unittest.TestCase):
    def test_returns_a_calendar(self):
        handler, seen = serve(ics())
        with mock_client(handler):
            self.assertTrue(classroom.fetch_calendar(URL).startswith(b"BEGIN:VCALENDAR"))
        self.assertEqual(seen, [URL])

    def test_fetches_the_canonical_url_only(self):
        handler, seen = serve(ics())
        with mock_client(handler):
            classroom.fetch_calendar(f" {URL} ")
        self.assertEqual(seen, [URL])

    def test_refuses_redirects_to_other_hosts(self):
        calls = []

        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_private"):
            classroom.fetch_calendar(URL)
        self.assertEqual(calls, [URL])

    def test_follows_a_redirect_only_to_a_valid_calendar_url(self):
        moved = URL.replace(TOKEN, "private-fedcba9876543210fedcba9876543210")
        calls = []

        def handler(request):
            calls.append(str(request.url))
            if str(request.url) == URL:
                return httpx.Response(301, headers={"location": moved})
            return httpx.Response(200, content=ics(), headers={"content-type": "text/calendar"})
        with mock_client(handler):
            classroom.fetch_calendar(URL)
        self.assertEqual(calls, [URL, moved])

    def test_redirect_loops_stop(self):
        def handler(request):
            return httpx.Response(302, headers={"location": URL})
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_unreachable"):
            classroom.fetch_calendar(URL)

    def test_size_cap_while_streaming(self):
        big = b"BEGIN:VCALENDAR\r\n" + b"X" * (classroom.MAX_BYTES + 10)
        handler, _ = serve(big)
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_too_large"):
            classroom.fetch_calendar(URL)

    def test_declared_length_cap(self):
        def handler(request):
            return httpx.Response(200, content=b"BEGIN:VCALENDAR", headers={
                "content-type": "text/calendar", "content-length": str(classroom.MAX_BYTES + 1)})
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_too_large"):
            classroom.fetch_calendar(URL)

    def test_private_or_reset_links(self):
        for status in (401, 403, 404, 410):
            handler, _ = serve(b"nope", status=status, content_type="text/html")
            with self.subTest(status=status), mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_private"):
                classroom.fetch_calendar(URL)
        handler, _ = serve(b"<html>Sign in</html>", content_type="text/html")
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_private"):
            classroom.fetch_calendar(URL)

    def test_non_calendar_bodies(self):
        handler, _ = serve(b'{"a":1}', content_type="application/json")
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_invalid"):
            classroom.fetch_calendar(URL)
        handler, _ = serve(ics(), content_type="application/json")
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_invalid"):
            classroom.fetch_calendar(URL)

    def test_server_errors_and_timeouts(self):
        handler, _ = serve(b"", status=503)
        with mock_client(handler), self.assertRaisesRegex(ValueError, "calendar_unreachable"):
            classroom.fetch_calendar(URL)

        def timeout(request):
            raise httpx.ReadTimeout("slow", request=request)
        with mock_client(timeout), self.assertRaisesRegex(ValueError, "calendar_unreachable"):
            classroom.fetch_calendar(URL)

    def test_client_settings(self):
        client = classroom._client()
        try:
            self.assertFalse(client.follow_redirects)
            self.assertLessEqual(client.timeout.read, 8)
            self.assertFalse(client.trust_env)
        finally:
            client.close()

    def test_secret_url_is_never_logged(self):
        def timeout(request):
            raise httpx.ConnectError("down", request=request)
        with mock_client(timeout), self.assertLogs("bindit.classroom", level="INFO") as logs, \
                self.assertRaises(ValueError):
            classroom.fetch_calendar(URL)
        self.assertNotIn("0123456789abcdef", "\n".join(logs.output))


class ParserTests(unittest.TestCase):
    def test_unfolding_and_escapes(self):
        body = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nDTSTART;VALUE=DATE:20261020\r\n"
                "SUMMARY:Assignment: Lab\\, part 2\\; draft\r\n"
                "DESCRIPTION:Line one\\nLine two with a long\r\n  folded tail\\\\ok\r\nEND:VEVENT\r\nEND:VCALENDAR")
        [event] = classroom.parse_ics(body)
        self.assertEqual(event.summary, "Assignment: Lab, part 2; draft")
        self.assertEqual(event.description, "Line one\nLine two with a long folded tail\\ok")
        self.assertEqual(classroom.clean_title(event.summary), "Lab, part 2; draft")

    def test_all_day_timed_utc_and_tzid(self):
        data = ics(
            vevent("d", "All day", "DTSTART;VALUE=DATE:20261020"),
            vevent("z", "UTC", "DTSTART:20261021T065900Z"),
            vevent("t", "Zoned", 'DTSTART;TZID="America/New_York":20261022T235900'),
            vevent("f", "Floating", "DTSTART:20261023T080000"),
            vevent("due", "Due wins", "DTSTART:20261024T080000Z", extra="DUE:20261025T090000Z"),
        )
        events = {event.uid: event for event in classroom.parse_ics(data)}
        la = "America/Los_Angeles"
        self.assertEqual(classroom.due_of(events["d"], la), (date(2026, 10, 20), None))
        self.assertEqual(classroom.due_of(events["z"], la), (date(2026, 10, 20), "23:59"))
        self.assertEqual(classroom.due_of(events["t"], la), (date(2026, 10, 22), "20:59"))
        self.assertEqual(classroom.due_of(events["f"], la), (date(2026, 10, 23), "08:00"))
        self.assertEqual(classroom.due_of(events["due"], "UTC"), (date(2026, 10, 25), "09:00"))

    def test_cancelled_url_and_alarms(self):
        data = ics(vevent("c", "Quiz assignment: Unit test", "DTSTART;VALUE=DATE:20261020",
                          description="See https://classroom.google.com/c/MTI/a/NDU/details",
                          extra="STATUS:CANCELLED\r\nBEGIN:VALARM\r\nSUMMARY:not me\r\nEND:VALARM"))
        [event] = classroom.parse_ics(data)
        self.assertTrue(event.cancelled)
        self.assertEqual(event.summary, "Quiz assignment: Unit test")
        self.assertEqual(classroom.classroom_link(event), "https://classroom.google.com/c/MTI/a/NDU/details")
        self.assertEqual(classroom.clean_description(event), "See")

    def test_only_classroom_links_are_kept(self):
        event = classroom.Event(uid="x", url="https://evil.example/c", description="https://classroom.google.com.evil.io/x")
        self.assertEqual(classroom.classroom_link(event), "")
        event = classroom.Event(uid="x", url="javascript:alert(1)")
        self.assertEqual(classroom.classroom_link(event), "")

    def test_plain_text_only(self):
        data = ics(vevent("h", "<b>Essay</b> &amp; notes‮", "DTSTART;VALUE=DATE:20261020",
                          description="<p>Hello <a href=\"javascript:x\">there</a></p><script>bad()</script>\x07"))
        [event] = classroom.parse_ics(data)
        self.assertEqual(event.summary, "Essay & notes")
        self.assertNotIn("<", event.description)
        self.assertNotIn("\x07", event.description)
        self.assertIn("Hello there", event.description)

    def test_events_without_uid_or_date_are_skipped(self):
        data = ics("BEGIN:VEVENT\r\nSUMMARY:no uid\r\nDTSTART:20261020T000000Z\r\nEND:VEVENT",
                   "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:bad date\r\nDTSTART:2026-10-20\r\nEND:VEVENT")
        self.assertEqual(classroom.parse_ics(data), [])

    def test_huge_input_is_capped(self):
        many = ics(*(vevent(f"u{index}", "S" * 5000, "DTSTART;VALUE=DATE:20261020", description="D" * 50000)
                     for index in range(1500)))
        events = classroom.parse_ics(many)
        self.assertEqual(len(events), classroom.MAX_EVENTS)
        self.assertLessEqual(len(events[0].summary), 300)
        self.assertLessEqual(len(events[0].description), classroom.MAX_NOTE_CHARS)
        # A single endless folded line is capped too.
        folded = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T000000Z\r\nSUMMARY:x" + "\r\n y" * 200000 + "\r\nEND:VEVENT\r\nEND:VCALENDAR"
        [event] = classroom.parse_ics(folded)
        self.assertLessEqual(len(event.summary), 300)


class PriorityTests(unittest.TestCase):
    def test_thresholds_at_the_boundaries(self):
        def at(delta):
            due = NOW + delta
            return classroom.priority_for(due.date(), due.strftime("%H:%M"), "UTC", NOW)
        self.assertEqual(at(-timedelta(days=2)), "urgent")
        self.assertEqual(at(timedelta(days=1)), "urgent")
        self.assertEqual(at(timedelta(days=1, minutes=1)), "high")
        self.assertEqual(at(timedelta(days=3)), "high")
        self.assertEqual(at(timedelta(days=3, minutes=1)), "medium")
        self.assertEqual(at(timedelta(days=7)), "medium")
        self.assertEqual(at(timedelta(days=7, minutes=1)), "low")

    def test_all_day_counts_to_the_end_of_the_day(self):
        # Due "Oct 17" (all day) ends at midnight Oct 18 = 36h from NOW: high.
        self.assertEqual(classroom.priority_for(date(2026, 10, 17), None, "UTC", NOW), "high")
        self.assertEqual(classroom.priority_for(date(2026, 10, 16), None, "UTC", NOW), "urgent")
        self.assertEqual(classroom.priority_for(date(2026, 10, 22), None, "UTC", NOW), "medium")
        self.assertEqual(classroom.priority_for(date(2026, 10, 23), None, "UTC", NOW), "low")


class ImportTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        tasks.reset_tasks()
        note_store.init_notes()
        with database.engine().begin() as connection:
            connection.execute(note_store.notes.delete())
        database.onboard_account("alex-id", "alex", "Alex", None)
        database.onboard_account("sam-id", "sam", "Sam", None)

    def add(self, body, student="alex-id", url=URL, now=NOW):
        return classroom.add_feed(student, url, "Biology", "UTC", body, now=now)

    def sync(self, feed, body, now=NOW, student="alex-id"):
        return classroom.apply_sync(student, feed["id"], body, now=now)

    def mine(self, student="alex-id"):
        return sorted(tasks.list_tasks(student), key=lambda task: task["title"])

    def item_for(self, task_id):
        with database.engine().connect() as connection:
            return connection.execute(select(classroom_store.items).where(classroom_store.items.c.task_id == task_id)).mappings().one()

    def test_import_creates_tasks_with_links_and_priority(self):
        body = ics(
            vevent("a1", "Assignment: Cell lab", "DTSTART:20261017T060000Z",
                   description="Short one\\nhttps://classroom.google.com/c/MTI/a/NDU/details"),
            vevent("old", "Too old", "DTSTART;VALUE=DATE:20260920"),
            vevent("recent", "Recent past", "DTSTART;VALUE=DATE:20261005"),
            vevent("far", "Material: Reading", "DTSTART;VALUE=DATE:20261201"),
        )
        feed = self.add(body)
        self.assertEqual(feed["sync"]["created"], 3)
        self.assertEqual(feed["imported_count"], 3)
        found = {task["title"]: task for task in self.mine()}
        self.assertEqual(set(found), {"Cell lab", "Recent past", "Reading"})
        lab = found["Cell lab"]
        self.assertEqual((lab["course"], lab["due_date"], lab["due_time"], lab["priority"]), ("Biology", "2026-10-17", "06:00", "urgent"))
        self.assertEqual(lab["source"], "classroom")
        self.assertEqual(lab["description"], "Short one")
        self.assertEqual(found["Reading"]["priority"], "low")
        self.assertEqual(found["Recent past"]["priority"], "urgent")
        detail = tasks.get_task("alex-id", lab["id"])
        self.assertEqual([(a["kind"], a["url"]) for a in detail["attachments"]], [("link", "https://classroom.google.com/c/MTI/a/NDU/details")])
        self.assertEqual(tasks.list_tasks("sam-id"), [])

    def test_resync_dedupes_and_updates_unedited_fields(self):
        feed = self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030"), vevent("b", "Poster", "DTSTART;VALUE=DATE:20261030")))
        own = tasks.create_task("alex-id", {"title": "My own thing", "course": "Biology", "due_date": "2026-10-30"})
        essay, poster = (task for task in self.mine() if task["title"] != "My own thing")
        tasks.update_task("alex-id", poster["id"], {"title": "Poster (with Sam)"})
        result = self.sync(feed, ics(vevent("a", "Essay v2", "DTSTART;VALUE=DATE:20261031"),
                                     vevent("b", "Poster renamed by teacher", "DTSTART;VALUE=DATE:20261101")))
        self.assertEqual(result["sync"]["created"], 0)
        titles = {task["id"]: (task["title"], task["due_date"]) for task in self.mine()}
        self.assertEqual(len(titles), 3)
        self.assertEqual(titles[essay["id"]], ("Essay v2", "2026-10-31"))
        self.assertEqual(titles[poster["id"]], ("Poster (with Sam)", "2026-11-01"))
        self.assertEqual(titles[own["id"]], ("My own thing", "2026-10-30"))
        self.assertIsNone(next(task for task in self.mine() if task["id"] == own["id"])["source"])

    def test_cancelled_events_are_marked(self):
        feed = self.add(ics(vevent("a", "Quiz", "DTSTART;VALUE=DATE:20261030")))
        self.sync(feed, ics(vevent("a", "Quiz", "DTSTART;VALUE=DATE:20261030", extra="STATUS:CANCELLED")))
        [task] = self.mine()
        self.assertEqual(task["title"], "Cancelled: Quiz")
        self.assertTrue(task["source_cancelled"])

    def test_deleted_tasks_are_not_recreated(self):
        feed = self.add(ics(vevent("a", "Quiz", "DTSTART;VALUE=DATE:20261030")))
        tasks.delete_task("alex-id", self.mine()[0]["id"])
        self.sync(feed, ics(vevent("a", "Quiz", "DTSTART;VALUE=DATE:20261030")))
        self.assertEqual(self.mine(), [])

    def test_priority_recomputes_until_the_student_sets_it(self):
        feed = self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030"), vevent("b", "Lab", "DTSTART;VALUE=DATE:20261030")))
        self.assertEqual({task["priority"] for task in self.mine()}, {"low"})
        essay, lab = self.mine()
        tasks.update_task("alex-id", lab["id"], {"priority": "low"})  # unchanged value: no lock
        tasks.update_task("alex-id", essay["id"], {"priority": "high"})
        self.assertTrue(self.item_for(essay["id"])["priority_locked"])
        self.assertFalse(self.item_for(lab["id"])["priority_locked"])
        later = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)
        self.sync(feed, ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030"), vevent("b", "Lab", "DTSTART;VALUE=DATE:20261030")), now=later)
        priorities = {task["title"]: task["priority"] for task in self.mine()}
        self.assertEqual(priorities, {"Essay": "high", "Lab": "high"})
        # The app-open pass alone (no fetch) moves it on too.
        self.assertEqual(classroom.refresh_priorities("alex-id", now=datetime(2026, 10, 30, 1, 0, tzinfo=timezone.utc)), 1)
        self.assertEqual({task["title"]: task["priority"] for task in self.mine()}, {"Essay": "high", "Lab": "urgent"})

    def test_overdue_done_tasks_keep_their_priority(self):
        self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030")))
        [essay] = self.mine()
        tasks.update_task("alex-id", essay["id"], {"status": "done"})
        classroom.refresh_priorities("alex-id", now=datetime(2026, 11, 5, tzinfo=timezone.utc))
        self.assertEqual(self.mine()[0]["priority"], "low")

    def test_instructions_become_a_deduped_note(self):
        feed = self.add(ics(vevent("a", "Assignment: Essay", "DTSTART;VALUE=DATE:20261030", description=LONG),
                            vevent("b", "Short", "DTSTART;VALUE=DATE:20261030", description="Too short")))
        notes = note_store.list_notes("alex-id", "Biology", "Classroom")
        self.assertEqual([note["file_name"] for note in notes], ["Essay — instructions"])
        self.assertEqual(notes[0]["text"], LONG)
        self.sync(feed, ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030", description=LONG)))
        self.assertEqual(len(note_store.list_notes("alex-id", "Biology", "Classroom")), 1)
        changed = LONG + " Bring a highlighter."
        self.sync(feed, ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030", description=changed)))
        [note] = note_store.list_notes("alex-id", "Biology", "Classroom")
        self.assertEqual((note["id"], note["text"]), (notes[0]["id"], changed))
        self.assertEqual(note_store.list_notes("sam-id", "Biology", "Classroom"), [])

    def test_a_deleted_note_stays_deleted(self):
        feed = self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030", description=LONG)))
        [note] = note_store.list_notes("alex-id", "Biology", "Classroom")
        note_store.remove_note("alex-id", note["id"])
        self.sync(feed, ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030", description=LONG + " changed")))
        self.assertEqual(note_store.list_notes("alex-id", "Biology", "Classroom"), [])
        self.assertTrue(self.item_for(self.mine()[0]["id"])["note_dismissed"])

    def test_notes_setting_off(self):
        feed = self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030")))
        self.assertTrue(feed["save_notes"])
        classroom.set_save_notes("alex-id", feed["id"], False)
        self.sync(feed, ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030", description=LONG)))
        self.assertEqual(note_store.list_notes("alex-id", "Biology", "Classroom"), [])
        with self.assertRaisesRegex(ValueError, "feed_not_found"):
            classroom.set_save_notes("sam-id", feed["id"], True)

    def test_feed_limits_and_duplicates(self):
        self.add(ics())
        with self.assertRaisesRegex(ValueError, "feed_exists"):
            self.add(ics())
        for index in range(classroom.MAX_FEEDS - 1):
            self.add(ics(), url=URL.replace(TOKEN, f"private-{index:032x}"))
        with self.assertRaisesRegex(ValueError, "feed_limit"):
            self.add(ics(), url=URL.replace(TOKEN, "private-ffffffffffffffffffffffffffffffff"))
        # Another student can still connect the same calendar.
        self.add(ics(), student="sam-id")

    def test_disconnect_keep_or_delete(self):
        first = self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030")))
        second = self.add(ics(vevent("b", "Lab", "DTSTART;VALUE=DATE:20261030")), url=URL.replace(TOKEN, "private-" + "1" * 32))
        own = tasks.create_task("alex-id", {"title": "Mine"})
        with self.assertRaisesRegex(ValueError, "feed_not_found"):
            classroom.disconnect("sam-id", first["id"], True)
        self.assertEqual(classroom.disconnect("alex-id", first["id"], False)["tasks_deleted"], 0)
        self.assertEqual({task["title"]: task["source"] for task in self.mine()}, {"Essay": None, "Lab": "classroom", "Mine": None})
        self.assertEqual(classroom.disconnect("alex-id", second["id"], True)["tasks_deleted"], 1)
        self.assertEqual({task["id"] for task in self.mine()} - {own["id"]}, {t["id"] for t in self.mine() if t["title"] == "Essay"})
        self.assertEqual(classroom.list_feeds("alex-id"), [])

    def test_stale_feeds(self):
        feed = self.add(ics())
        self.assertEqual(classroom.stale_feed_ids("alex-id", now=NOW + timedelta(hours=2)), [])
        self.assertEqual(classroom.stale_feed_ids("alex-id", now=NOW + timedelta(hours=3, minutes=1)), [feed["id"]])

    def test_account_deletion_removes_feeds_and_links(self):
        self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030", description=LONG)))
        self.add(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20261030")), student="sam-id")
        account_deletion.delete_account_data("alex-id")
        with database.engine().connect() as connection:
            for table in (classroom_store.feeds, classroom_store.items):
                owners = set(connection.execute(select(table.c.owner_id)).scalars().all())
                self.assertEqual(owners, {"sam-id"})
        self.assertEqual(note_store.list_notes("alex-id", "Biology", "Classroom"), [])
        self.assertEqual(len(tasks.list_tasks("sam-id")), 1)

    def test_tables_are_locked_down(self):
        for table in classroom_store.CLASSROOM_TABLES:
            self.assertIn(table, database.RLS_TABLES)
            self.assertIn(table, database.CLIENT_REVOKED_TABLES)


class RouteTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        tasks.reset_tasks()
        self.client = TestClient(main.app)

    def call(self, method, path, student="alex-id", **kwargs):
        with patch.object(main.auth, "authenticated_user", return_value={"id": student, "email_confirmed_at": "2026-01-01T00:00:00Z"}):
            return self.client.request(method, path, headers={"Authorization": "Bearer test"}, **kwargs)

    def connect(self, body=None, url=URL, **kwargs):
        handler, seen = serve(body if body is not None else ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20991030")), **kwargs)
        with mock_client(handler):
            return self.call("POST", "/api/classroom/feeds", json={"url": url, "course": "Biology", "tz": "America/Chicago"}), seen

    def test_the_secret_url_is_never_returned(self):
        response, _ = self.connect()
        self.assertEqual(response.status_code, 201, response.text)
        feed_id = response.json()["id"]
        handler, _ = serve(ics())
        with mock_client(handler):
            responses = [
                response,
                self.call("GET", "/api/classroom/feeds"),
                self.call("POST", f"/api/classroom/feeds/{feed_id}/sync", json={}),
                self.call("PATCH", f"/api/classroom/feeds/{feed_id}", json={"save_notes": False}),
                self.call("POST", "/api/classroom/refresh", json={}),
                self.call("GET", "/api/tasks"),
            ]
        for item in responses:
            self.assertEqual(item.status_code // 100, 2, item.text)
            self.assertNotIn("0123456789abcdef", item.text)
            self.assertNotIn("c_abc123", item.text)
        self.assertIn("private-••••", responses[1].json()["feeds"][0]["masked_url"])

    def test_friendly_errors(self):
        response = self.call("POST", "/api/classroom/feeds", json={"url": "https://evil.com/x.ics", "course": "Bio"})
        self.assertEqual((response.status_code, response.json()["detail"]["code"]), (400, "invalid_calendar_url"))
        response, seen = self.connect(body=b"", status=404, content_type="text/html")
        self.assertEqual(response.json()["detail"]["code"], "calendar_private")
        response, _ = self.connect(body=b"", status=500)
        self.assertEqual((response.status_code, response.json()["detail"]["code"]), (502, "calendar_unreachable"))
        self.assertEqual(self.call("GET", "/api/classroom/feeds").json()["feeds"], [])

    def test_other_students_cannot_touch_a_feed(self):
        feed_id = self.connect()[0].json()["id"]
        for method, path in (("POST", f"/api/classroom/feeds/{feed_id}/sync"), ("DELETE", f"/api/classroom/feeds/{feed_id}"),
                             ("PATCH", f"/api/classroom/feeds/{feed_id}")):
            kwargs = {"json": {"save_notes": False}} if method == "PATCH" else {}
            self.assertEqual(self.call(method, path, student="sam-id", **kwargs).status_code, 404)

    def test_adding_is_rate_limited(self):
        statuses = []
        for index in range(classroom.ADD_LIMIT_PER_DAY + 1):
            response, _ = self.connect(url=URL.replace(TOKEN, f"private-{index:032x}"))
            statuses.append(response.status_code)
            if response.status_code == 201:
                self.call("DELETE", f"/api/classroom/feeds/{response.json()['id']}")
        self.assertEqual(statuses[:-1], [201] * classroom.ADD_LIMIT_PER_DAY)
        self.assertEqual(statuses[-1], 429)

    def test_manual_sync_is_rate_limited(self):
        feed_id = self.connect()[0].json()["id"]
        handler, _ = serve(ics())
        with mock_client(handler):
            codes = [self.call("POST", f"/api/classroom/feeds/{feed_id}/sync").status_code
                     for _ in range(classroom.SYNC_LIMIT_PER_HOUR + 1)]
        self.assertEqual(codes[-1], 429)
        self.assertEqual(set(codes[:-1]), {200})

    def test_refresh_is_cheap_without_feeds_and_syncs_stale_ones(self):
        self.assertEqual(self.call("POST", "/api/classroom/refresh", json={}).json()["feeds"], 0)
        feed_id = self.connect()[0].json()["id"]
        with database.engine().begin() as connection:
            connection.execute(update(classroom_store.feeds).values(last_attempt_at=datetime.now(timezone.utc) - timedelta(hours=4)))
        handler, seen = serve(ics(vevent("a", "Essay", "DTSTART;VALUE=DATE:20991030"), vevent("b", "New", "DTSTART;VALUE=DATE:20991030")))
        with mock_client(handler):
            result = self.call("POST", "/api/classroom/refresh", json={"tz": "America/Chicago"}).json()
            again = self.call("POST", "/api/classroom/refresh", json={}).json()
        self.assertEqual((result["synced"], again["synced"]), (1, 0))
        self.assertEqual(len(seen), 1)
        self.assertEqual(self.call("GET", "/api/classroom/feeds").json()["feeds"][0]["imported_count"], 2)
        self.assertEqual(feed_id, self.call("GET", "/api/classroom/feeds").json()["feeds"][0]["id"])

    def test_disconnect_route_can_delete_tasks(self):
        feed_id = self.connect()[0].json()["id"]
        response = self.call("DELETE", f"/api/classroom/feeds/{feed_id}?delete_tasks=true")
        self.assertEqual(response.json(), {"deleted": True, "tasks_deleted": 1})
        self.assertEqual(self.call("GET", "/api/tasks").json(), [])


if __name__ == "__main__":
    unittest.main()
