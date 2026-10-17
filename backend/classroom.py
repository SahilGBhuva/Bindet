"""Google Classroom import through a class calendar's secret iCal address.

Google Classroom puts each class's assignments on a Google Calendar. A student copies
that calendar's "Secret address in iCal format" and pastes it in Settings; bindet then
imports the assignments as personal tasks in a course the student picks and keeps them
in sync (on connect, on "Sync now", and when the app opens if the last sync is more
than SYNC_AFTER old). There are no background workers.

Security
- The server fetches a URL the student typed, so only one shape is accepted:
  https://calendar.google.com/calendar/ical/<calendar id>/private-<hex token>/basic.ics
  (parse_calendar_url, a strict full-match regex). The URL that is fetched is rebuilt
  from the matched parts, never the raw input. httpx never follows redirects on its
  own; a redirect is followed (at most MAX_REDIRECTS times) only when its target passes
  the same check, so no other host, IP, port or path is ever requested. Timeout
  FETCH_TIMEOUT, environment proxies ignored, the body is streamed and cut off at
  MAX_BYTES, and only a text/calendar response or a body that is an iCalendar is used.
- The address is a secret, like a password. It is stored (the server needs it to sync)
  but never returned by any API (masked_url) and never logged: logs carry url_hash.
- Adding classes and manual syncs are rate limited per student; at most MAX_FEEDS feeds.
- Everything parsed from the calendar is untrusted plain text: control characters and
  any HTML are stripped, lengths are capped, at most MAX_EVENTS events are read.

Import rules
- Each event becomes a personal task in the feed's course (dedupe by student, feed,
  UID). Classroom's "Assignment: " style prefixes are stripped from titles. A
  https://classroom.google.com link is kept as the task's link attachment.
- Only events due from IMPORT_WINDOW ago onwards are imported or updated.
- Re-syncs update the title and due date unless the student changed that field by
  hand (classroom_store locks), mark cancelled events, and never duplicate. A task the
  student deleted is not recreated. Tasks the student made themselves are never touched.
- Priority follows how close the due date is (priority_for), recomputed on every sync
  and on the app-open check, until the student sets a priority by hand.
- Instructions of at least NOTE_MIN_CHARS become a text note in the course's
  "Classroom" unit (per-feed switch, on by default), deduped by UID and updated when
  the instructions change. A note the student deletes is not recreated. No AI runs.
"""
from __future__ import annotations

import hashlib
import html
import logging
import re
import secrets
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import delete, func, select, update

import classroom_store
import database
import note_store
import tasks

logger = logging.getLogger("bindit.classroom")

MAX_FEEDS = 15
MAX_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT = 8.0
MAX_REDIRECTS = 2
MAX_EVENTS = 1000
MAX_VALUE_CHARS = 20_000
MAX_DESCRIPTION = 4000
MAX_NOTE_CHARS = 20_000
NOTE_MIN_CHARS = 120
NOTE_UNIT = "Classroom"
IMPORT_WINDOW = timedelta(days=14)
SYNC_AFTER = timedelta(hours=3)
AUTO_SYNC_FEEDS_PER_CALL = 3

# Per-student limits (database.check_social_rate_limit; action names are at most 24 chars).
ADD_LIMIT_PER_DAY = 10
SYNC_LIMIT_PER_HOUR = 10
AUTO_LIMIT_PER_HOUR = 20
FETCH_LIMIT_PER_DAY = 120

HOST = "calendar.google.com"
URL_PATTERN = re.compile(
    r"https://calendar\.google\.com/calendar/ical/"
    r"(?P<calendar>[A-Za-z0-9._%+-]{1,200})/"
    r"(?P<token>private-[0-9a-f]{16,64})/"
    r"(?P<file>basic\.ics)"
)
CLASSROOM_LINK = re.compile(r"https://classroom\.google\.com/[A-Za-z0-9/_?=&%.#~+-]{1,400}")
TITLE_PREFIX = re.compile(
    r"^(?:quiz assignment|short answer question|multiple choice question|assignment|question|material)\s*:\s*",
    re.IGNORECASE,
)
TZ_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:/[A-Za-z0-9_+-]{1,30}){0,2}$")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f​-‏ -‮⁦-⁩]")


class ClassroomError(ValueError):
    """A friendly, user-facing failure. str(error) is the code."""


# --- URL --------------------------------------------------------------------------------


def parse_calendar_url(value: str) -> str:
    """The canonical secret iCal address, or ClassroomError("invalid_calendar_url").

    Only https://calendar.google.com/calendar/ical/<id>/private-<hex>/basic.ics: no other
    scheme, host, IP, port, user info, path, query or fragment."""
    if not isinstance(value, str):
        raise ClassroomError("invalid_calendar_url")
    match = URL_PATTERN.fullmatch(value.strip())
    if not match:
        raise ClassroomError("invalid_calendar_url")
    calendar = match["calendar"]
    # Percent-escapes in the id must be well formed and may not hide a slash or dot-segment.
    if re.search(r"%(?![0-9A-Fa-f]{2})", calendar) or re.search(r"%(2[fF]|5[cC]|2[eE])", calendar) or calendar in (".", ".."):
        raise ClassroomError("invalid_calendar_url")
    return f"https://{HOST}/calendar/ical/{calendar}/{match['token']}/{match['file']}"


def url_hash(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def masked_url(_url: str | None = None) -> str:
    """What the API shows instead of the secret address. Nothing from it is revealed:
    the calendar id can be an email address and the token is the secret."""
    return "calendar.google.com/…/private-••••"


# --- Fetch ------------------------------------------------------------------------------


def _client() -> httpx.Client:
    # trust_env=False: no proxy or netrc from the environment. Redirects are checked by hand.
    return httpx.Client(follow_redirects=False, timeout=httpx.Timeout(FETCH_TIMEOUT), trust_env=False,
                        headers={"Accept": "text/calendar", "User-Agent": "bindet-classroom-sync/1"})


def fetch_calendar(url: str) -> bytes:
    """GET the (validated) calendar. Raises ClassroomError calendar_unreachable,
    calendar_private, calendar_invalid or calendar_too_large."""
    target = parse_calendar_url(url)
    fingerprint = url_hash(target)[:12]
    try:
        with _client() as client:
            for _hop in range(MAX_REDIRECTS + 1):
                with client.stream("GET", target) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location", "")
                        try:
                            target = parse_calendar_url(location)
                        except ClassroomError:
                            logger.info("classroom_fetch_redirect_refused url=%s", fingerprint)
                            raise ClassroomError("calendar_private") from None
                        continue
                    if response.status_code in (401, 403, 404, 410):
                        raise ClassroomError("calendar_private")
                    if response.status_code != 200:
                        logger.info("classroom_fetch_status url=%s status=%s", fingerprint, response.status_code)
                        raise ClassroomError("calendar_unreachable")
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > MAX_BYTES:
                        raise ClassroomError("calendar_too_large")
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body += chunk
                        if len(body) > MAX_BYTES:
                            raise ClassroomError("calendar_too_large")
                    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    looks_like_ics = bytes(body[:64]).lstrip(b"\xef\xbb\xbf \r\n\t").upper().startswith(b"BEGIN:VCALENDAR")
                    if not looks_like_ics:
                        # A sign-in page (HTML) is what Google sends for a reset or private link.
                        raise ClassroomError("calendar_private" if content_type == "text/html" else "calendar_invalid")
                    if content_type not in ("text/calendar", "application/octet-stream", "text/plain", ""):
                        raise ClassroomError("calendar_invalid")
                    return bytes(body)
            raise ClassroomError("calendar_unreachable")
    except ClassroomError:
        raise
    except httpx.HTTPError as error:
        logger.info("classroom_fetch_failed url=%s error=%s", fingerprint, type(error).__name__)
        raise ClassroomError("calendar_unreachable") from None


# --- Parse ------------------------------------------------------------------------------


@dataclass
class Event:
    uid: str
    summary: str = ""
    description: str = ""
    start: date | datetime | None = None   # date (all day), aware datetime, or naive (floating)
    tzid: str = ""
    url: str = ""
    cancelled: bool = False
    has_due: bool = False


def _unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in re.split(r"\r\n|\n|\r", text):
        if raw[:1] in (" ", "\t") and lines:
            if len(lines[-1]) < MAX_VALUE_CHARS + 200:
                lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _split_property(line: str) -> tuple[str, dict[str, str], str] | None:
    """NAME;PARAM=VALUE;...:value, with ':' and ';' allowed inside quoted params."""
    quoted = False
    colon = -1
    for index, char in enumerate(line):
        if char == '"':
            quoted = not quoted
        elif char == ":" and not quoted:
            colon = index
            break
    if colon <= 0:
        return None
    head, value = line[:colon], line[colon + 1:]
    parts: list[str] = []
    current, quoted = "", False
    for char in head:
        if char == '"':
            quoted = not quoted
        elif char == ";" and not quoted:
            parts.append(current)
            current = ""
            continue
        current += char
    parts.append(current)
    params: dict[str, str] = {}
    for part in parts[1:]:
        key, _, param = part.partition("=")
        params[key.strip().upper()] = param.strip().strip('"')
    return parts[0].strip().upper(), params, value


def _unescape(value: str) -> str:
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m[1] in "nN" else m[1], value)


def plain_text(value: str, limit: int) -> str:
    """Untrusted calendar text as plain text: HTML tags and entities removed, control
    and bidi characters dropped, whitespace tidied, capped at limit characters."""
    value = value[:MAX_VALUE_CHARS]
    if re.search(r"<\s*(?:br|p|div|a|b|i|u|span|ul|ol|li|strong|em|html)\b", value, re.IGNORECASE):
        value = re.sub(r"<\s*br\s*/?\s*>|</\s*(?:p|div|li)\s*>", "\n", value, flags=re.IGNORECASE)
        value = re.sub(r"<[^<>]{0,1000}>", "", value)
    value = html.unescape(value) if "&" in value else value
    value = CONTROL.sub("", value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "))
    lines = [" ".join(line.split()) for line in value.split("\n")]
    value = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return value[:limit].strip()


def _parse_when(value: str, params: dict[str, str]) -> tuple[date | datetime | None, str]:
    value = value.strip()
    try:
        if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", value):
            return datetime.strptime(value[:8], "%Y%m%d").date(), ""
        match = re.fullmatch(r"(\d{8}T\d{6})(Z?)", value)
        if not match:
            return None, ""
        moment = datetime.strptime(match[1], "%Y%m%dT%H%M%S")
    except ValueError:
        return None, ""
    if match[2]:
        return moment.replace(tzinfo=timezone.utc), ""
    tzid = params.get("TZID", "")[:64]
    zone = _zone(tzid) if tzid else None
    if zone is not None:
        return moment.replace(tzinfo=zone), tzid
    return moment, ""  # floating: read in the student's own time zone


def parse_ics(data: bytes | str) -> list[Event]:
    """VEVENTs of an iCalendar body, at most MAX_EVENTS. Nested components (alarms) are
    skipped; events without a UID are skipped."""
    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
    text = text.lstrip("﻿")
    events: list[Event] = []
    current: Event | None = None
    depth = 0  # nesting inside the current VEVENT
    for line in _unfold(text):
        if not line.strip():
            continue
        parsed = _split_property(line)
        if parsed is None:
            continue
        name, params, value = parsed
        if name == "BEGIN":
            if current is not None:
                depth += 1
            elif value.strip().upper() == "VEVENT":
                current, depth = Event(uid=""), 0
            continue
        if name == "END":
            if current is not None and depth > 0:
                depth -= 1
            elif current is not None and value.strip().upper() == "VEVENT":
                if current.uid and current.start is not None:
                    events.append(current)
                    if len(events) >= MAX_EVENTS:
                        break
                current = None
            continue
        if current is None or depth > 0:
            continue
        value = value[:MAX_VALUE_CHARS]
        if name == "UID":
            current.uid = CONTROL.sub("", value.strip())[:512]
        elif name == "SUMMARY":
            current.summary = plain_text(_unescape(value), 300)
        elif name == "DESCRIPTION":
            current.description = plain_text(_unescape(value), MAX_NOTE_CHARS)
        elif name == "URL":
            current.url = value.strip()[:500]
        elif name == "STATUS":
            current.cancelled = value.strip().upper() == "CANCELLED"
        elif name in ("DUE", "DTSTART"):
            # DUE (when present) wins over DTSTART, whatever their order.
            when, tzid = _parse_when(value, params)
            if when is not None and (name == "DUE" or not current.has_due):
                current.start, current.tzid = when, tzid
                current.has_due = current.has_due or name == "DUE"
    return events


# --- Mapping events to tasks ------------------------------------------------------------


@lru_cache(maxsize=256)
def _zone(name: str) -> ZoneInfo | None:
    if not name or not TZ_NAME.match(name):
        return None
    try:
        return ZoneInfo(name)
    except Exception:  # unknown zone or no tz database
        return None


def clean_tz(name: str | None) -> str:
    return name if name and _zone(name) is not None else "UTC"


def due_of(event: Event, tz_name: str) -> tuple[date, str | None]:
    """(due date, "HH:MM" or None) on the student's own clock."""
    zone = _zone(tz_name) or timezone.utc
    start = event.start
    if isinstance(start, datetime):
        local = start.astimezone(zone) if start.tzinfo else start
        return local.date(), local.strftime("%H:%M")
    return start, None


def clean_title(summary: str) -> str:
    title = TITLE_PREFIX.sub("", summary.strip())
    return " ".join(title.split())[:140] or "Classroom assignment"


def classroom_link(event: Event) -> str:
    url = event.url.strip()
    if CLASSROOM_LINK.fullmatch(url):
        return url
    found = CLASSROOM_LINK.search(event.description)
    return found[0].rstrip(".,)") if found else ""


def clean_description(event: Event) -> str:
    """The instructions without the Classroom link (kept as the task's link instead)."""
    text = CLASSROOM_LINK.sub("", event.description)
    return plain_text(text, MAX_NOTE_CHARS)


PRIORITY_THRESHOLDS = ((timedelta(days=1), "urgent"), (timedelta(days=3), "high"), (timedelta(days=7), "medium"))


def priority_for(due_date: date, due_time: str | None, tz_name: str, now: datetime) -> str:
    """Due within 1 day (or overdue): urgent; within 3 days: high; within 7: medium; else low.
    An all-day due date counts as due at the end of that day."""
    zone = _zone(tz_name) or timezone.utc
    if due_time:
        hour, minute = (int(part) for part in due_time.split(":"))
        due = datetime.combine(due_date, dtime(hour, minute), tzinfo=zone)
    else:
        due = datetime.combine(due_date + timedelta(days=1), dtime(0, 0), tzinfo=zone)
    left = due - now
    for limit, level in PRIORITY_THRESHOLDS:
        if left <= limit:
            return level
    return "low"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- Storage ----------------------------------------------------------------------------


def init_classroom() -> None:
    tasks.init_tasks()  # creates the classroom tables with the task tables
    note_store.init_notes()


def _feed_view(connection, row) -> dict:
    count = connection.execute(select(func.count()).select_from(classroom_store.items).join(
        tasks.tasks, tasks.tasks.c.id == classroom_store.items.c.task_id,
    ).where(classroom_store.items.c.feed_id == row["id"])).scalar_one()
    return {
        "id": row["id"], "course": row["course"], "masked_url": masked_url(),
        "save_notes": bool(row["save_notes"]), "last_status": row["last_status"],
        "last_synced_at": tasks._utc(row["last_synced_at"]), "imported_count": int(count or 0),
        "created_at": tasks._utc(row["created_at"]),
    }


def list_feeds(student_id: str) -> list[dict]:
    init_classroom()
    with database.engine().connect() as connection:
        rows = connection.execute(select(classroom_store.feeds).where(
            classroom_store.feeds.c.owner_id == student_id,
        ).order_by(classroom_store.feeds.c.created_at)).mappings().all()
        return [_feed_view(connection, row) for row in rows]


def _feed(connection, student_id: str, feed_id: str) -> dict:
    row = connection.execute(select(classroom_store.feeds).where(
        classroom_store.feeds.c.id == feed_id, classroom_store.feeds.c.owner_id == student_id,
    )).mappings().first()
    if not row:
        raise ClassroomError("feed_not_found")
    return dict(row)


def check_new_feed(student_id: str, url: str, course: str) -> tuple[str, str]:
    """Validate before any fetch. Returns (canonical url, clean course)."""
    init_classroom()
    canonical = parse_calendar_url(url)
    clean_course = tasks._clean_line(course, 120)
    if not clean_course:
        raise ClassroomError("invalid_course")
    with database.engine().connect() as connection:
        _check_room(connection, student_id, canonical)
    return canonical, clean_course


def _check_room(connection, student_id: str, canonical: str) -> None:
    feeds = classroom_store.feeds
    existing = connection.execute(select(feeds.c.url_hash).where(feeds.c.owner_id == student_id)).scalars().all()
    if url_hash(canonical) in existing:
        raise ClassroomError("feed_exists")
    if len(existing) >= MAX_FEEDS:
        raise ClassroomError("feed_limit")


def add_feed(student_id: str, url: str, course: str, tz_name: str | None, body: bytes, now: datetime | None = None) -> dict:
    """Store a feed whose calendar (body) was already fetched, and import it."""
    canonical, clean_course = check_new_feed(student_id, url, course)
    events = parse_ics(body)
    now = now or _now()
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"classroom:{student_id}")
        _check_room(connection, student_id, canonical)
        feed = {
            "id": secrets.token_hex(16), "owner_id": student_id, "course": clean_course, "calendar_url": canonical,
            "url_hash": url_hash(canonical), "tz": clean_tz(tz_name), "save_notes": True, "last_status": "ok",
            "last_synced_at": now, "last_attempt_at": now, "created_at": now,
        }
        connection.execute(classroom_store.feeds.insert().values(**feed))
        summary = _import(connection, feed, events, now)
        view = _feed_view(connection, feed)
    logger.info("classroom_feed_added url=%s events=%s", feed["url_hash"][:12], len(events))
    return {**view, "sync": summary}


def feed_url(student_id: str, feed_id: str) -> str:
    """The secret address, for the server's own fetch only."""
    init_classroom()
    with database.engine().connect() as connection:
        return _feed(connection, student_id, feed_id)["calendar_url"]


def apply_sync(student_id: str, feed_id: str, body: bytes | None, error: str | None = None,
               tz_name: str | None = None, now: datetime | None = None) -> dict:
    """Record one sync attempt: import body, or remember why it failed."""
    init_classroom()
    now = now or _now()
    events = parse_ics(body) if body is not None else []
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"classroom:{student_id}")
        feed = _feed(connection, student_id, feed_id)
        values: dict = {"last_attempt_at": now}
        if tz_name and _zone(tz_name) is not None:
            values["tz"] = feed["tz"] = tz_name
        summary = {"created": 0, "updated": 0, "notes": 0}
        if error:
            values["last_status"] = {"calendar_private": "private", "calendar_unreachable": "unreachable"}.get(error, "invalid")
        else:
            summary = _import(connection, feed, events, now)
            values.update(last_status="ok", last_synced_at=now)
        connection.execute(update(classroom_store.feeds).where(classroom_store.feeds.c.id == feed_id).values(**values))
        feed.update(values)
        return {**_feed_view(connection, feed), "sync": summary}


def set_save_notes(student_id: str, feed_id: str, save_notes: bool) -> dict:
    init_classroom()
    with database.engine().begin() as connection:
        feed = _feed(connection, student_id, feed_id)
        connection.execute(update(classroom_store.feeds).where(classroom_store.feeds.c.id == feed_id).values(save_notes=bool(save_notes)))
        feed["save_notes"] = bool(save_notes)
        return _feed_view(connection, feed)


def disconnect(student_id: str, feed_id: str, delete_tasks: bool) -> dict:
    """Remove a feed. With delete_tasks, its imported tasks go too (only personal tasks the
    student still owns); otherwise they stay as ordinary tasks. Instruction notes stay."""
    init_classroom()
    items, t = classroom_store.items, tasks.tasks
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"classroom:{student_id}")
        _feed(connection, student_id, feed_id)
        removed = 0
        if delete_tasks:
            task_ids = connection.execute(select(t.c.id).join(items, items.c.task_id == t.c.id).where(
                items.c.feed_id == feed_id, items.c.owner_id == student_id,
                t.c.owner_id == student_id, t.c.group_id.is_(None),
            )).scalars().all()
            if task_ids:
                for table in tasks.CHILD_TABLES:
                    connection.execute(delete(table).where(table.c.task_id.in_(task_ids)))
                connection.execute(delete(t).where(t.c.id.in_(task_ids)))
            removed = len(task_ids)
        connection.execute(delete(items).where(items.c.feed_id == feed_id, items.c.owner_id == student_id))
        connection.execute(delete(classroom_store.feeds).where(classroom_store.feeds.c.id == feed_id))
    return {"deleted": True, "tasks_deleted": removed}


def stale_feed_ids(student_id: str, now: datetime | None = None, limit: int = AUTO_SYNC_FEEDS_PER_CALL) -> list[str]:
    init_classroom()
    now = now or _now()
    feeds = classroom_store.feeds
    cutoff = now - SYNC_AFTER
    with database.engine().connect() as connection:
        rows = connection.execute(select(feeds.c.id, feeds.c.last_attempt_at).where(feeds.c.owner_id == student_id)).all()
    stale = [(tasks._utc(at) or datetime.min.replace(tzinfo=timezone.utc), feed_id) for feed_id, at in rows
             if at is None or tasks._utc(at) <= cutoff]
    return [feed_id for _at, feed_id in sorted(stale)[:limit]]


def has_feeds(student_id: str) -> bool:
    init_classroom()
    with database.engine().connect() as connection:
        return connection.execute(select(classroom_store.feeds.c.id).where(
            classroom_store.feeds.c.owner_id == student_id).limit(1)).first() is not None


def delete_for_account_in(connection, student_id: str) -> None:
    connection.execute(delete(classroom_store.items).where(classroom_store.items.c.owner_id == student_id))
    connection.execute(delete(classroom_store.feeds).where(classroom_store.feeds.c.owner_id == student_id))


# --- Import -----------------------------------------------------------------------------


def _set_priority(connection, item: dict, task: dict, tz_name: str, now: datetime) -> bool:
    """Recompute an imported task's priority. Returns True when it changed."""
    if item["priority_locked"] or task["status"] == "done" or task["due_date"] is None:
        return False
    if item["synced_priority"] and task["priority"] != item["synced_priority"]:
        # Changed outside sync (an older client, or any path that skipped the hook): hands off.
        connection.execute(update(classroom_store.items).where(classroom_store.items.c.id == item["id"]).values(priority_locked=True))
        return False
    level = priority_for(task["due_date"], task["due_time"], tz_name, now)
    if level != task["priority"]:
        connection.execute(update(tasks.tasks).where(tasks.tasks.c.id == task["id"]).values(priority=level, updated_at=now))
    if level != item["synced_priority"]:
        connection.execute(update(classroom_store.items).where(classroom_store.items.c.id == item["id"]).values(synced_priority=level))
    return level != task["priority"]


def refresh_priorities(student_id: str, now: datetime | None = None) -> int:
    """The cheap app-open pass: recompute priorities of imported tasks without fetching."""
    init_classroom()
    now = now or _now()
    items, t, feeds = classroom_store.items, tasks.tasks, classroom_store.feeds
    changed = 0
    with database.engine().begin() as connection:
        rows = connection.execute(select(items, feeds.c.tz, t.c.priority, t.c.status, t.c.due_date, t.c.due_time)
                                  .join(feeds, feeds.c.id == items.c.feed_id)
                                  .join(t, t.c.id == items.c.task_id)
                                  .where(items.c.owner_id == student_id, items.c.priority_locked.is_(False),
                                         t.c.status != "done", t.c.due_date.is_not(None))).mappings().all()
        for row in rows:
            task = {"id": row["task_id"], "priority": row["priority"], "status": row["status"],
                    "due_date": row["due_date"], "due_time": row["due_time"]}
            changed += _set_priority(connection, dict(row), task, row["tz"], now)
    return changed


def _note_title(title: str) -> str:
    return f"{title} — instructions"[:255]


def _sync_note(connection, feed: dict, item: dict, title: str, text: str) -> int:
    """Create or update the instructions note. Returns 1 when one was written."""
    notes = note_store.notes
    if not feed["save_notes"] or item["note_dismissed"] or len(text) < NOTE_MIN_CHARS:
        return 0
    digest = _hash(text)
    values: dict = {}
    if item["note_id"]:
        exists = connection.execute(select(notes.c.id).where(
            notes.c.id == item["note_id"], notes.c.student_id == feed["owner_id"],
        )).scalar_one_or_none()
        if exists is None:
            # The student deleted it: remember, never bring it back.
            values = {"note_dismissed": True}
        elif digest != item["note_hash"]:
            connection.execute(update(notes).where(notes.c.id == item["note_id"]).values(
                text=text, size_bytes=len(text.encode("utf-8")), file_name=_note_title(title)))
            values = {"note_hash": digest}
    else:
        note = note_store.save_note_in(connection, feed["owner_id"], feed["course"], NOTE_UNIT, _note_title(title), text)
        values = {"note_id": note["id"], "note_hash": digest}
    if values:
        connection.execute(update(classroom_store.items).where(classroom_store.items.c.id == item["id"]).values(**values))
        item.update(values)
    return int("note_hash" in values)


def _create_task(connection, feed: dict, title: str, due_date: date, due_time: str | None,
                 description: str, link: str, now: datetime) -> str:
    t = tasks.tasks
    task_id = secrets.token_hex(16)
    connection.execute(t.insert().values(
        id=task_id, owner_id=feed["owner_id"], group_id=None, title=title, description=description[:MAX_DESCRIPTION],
        course=feed["course"], project="", status="todo", priority=priority_for(due_date, due_time, feed["tz"], now),
        due_date=due_date, due_time=due_time, kind="task", location="", milestone_id=None, sort_order=0,
        created_at=now, updated_at=now, completed_at=None,
    ))
    connection.execute(tasks.task_assignees.insert().values(task_id=task_id, student_id=feed["owner_id"], assigned_at=now))
    connection.execute(tasks.task_activity.insert().values(
        task_id=task_id, group_id=None, actor_id=feed["owner_id"], kind="created",
        detail="Imported from Google Classroom", created_at=now,
    ))
    if link:
        connection.execute(tasks.task_attachments.insert().values(
            task_id=task_id, added_by=feed["owner_id"], kind="link", label="Open in Google Classroom",
            url=link, note_id="", created_at=now,
        ))
    return task_id


def _import(connection, feed: dict, events: list[Event], now: datetime) -> dict:
    items, t = classroom_store.items, tasks.tasks
    owner = feed["owner_id"]
    zone = _zone(feed["tz"]) or timezone.utc
    earliest = (now.astimezone(zone) - IMPORT_WINDOW).date()
    known = {row["uid_hash"]: dict(row) for row in connection.execute(select(items).where(
        items.c.owner_id == owner, items.c.feed_id == feed["id"],
    )).mappings().all()}
    owned = connection.execute(select(func.count()).select_from(t).where(t.c.owner_id == owner)).scalar_one()
    summary = {"created": 0, "updated": 0, "notes": 0}
    seen: set[str] = set()
    for event in events:
        uid = _hash(event.uid)
        if uid in seen:
            continue
        seen.add(uid)
        due_date, due_time = due_of(event, feed["tz"])
        if due_date < earliest:
            continue
        title = clean_title(event.summary)
        shown_title = f"Cancelled: {title}"[:140] if event.cancelled else title
        description = clean_description(event)
        item = known.get(uid)
        if item is None:
            if owned >= tasks.MAX_TASKS_PER_OWNER:
                continue
            task_id = _create_task(connection, feed, shown_title, due_date, due_time, description, classroom_link(event), now)
            owned += 1
            created = connection.execute(t.select().where(t.c.id == task_id)).mappings().one()
            item_id = connection.execute(items.insert().values(
                owner_id=owner, feed_id=feed["id"], uid_hash=uid, task_id=task_id, synced_title=shown_title,
                synced_due_date=due_date, synced_due_time=due_time, synced_priority=created["priority"],
                title_locked=False, due_locked=False, priority_locked=False, cancelled=event.cancelled,
                note_id=None, note_hash=None, note_dismissed=False, created_at=now, updated_at=now,
            )).inserted_primary_key[0]
            item = connection.execute(select(items).where(items.c.id == item_id)).mappings().one()
            item = dict(item)
            summary["created"] += 1
        else:
            task = connection.execute(select(t).where(t.c.id == item["task_id"])).mappings().first() if item["task_id"] else None
            if task is None or task["owner_id"] != owner or task["group_id"] is not None:
                # Deleted (or moved into a group) by the student: leave it be.
                summary["notes"] += _sync_note(connection, feed, item, title, description)
                continue
            task = dict(task)
            changes: dict = {}
            locks: dict = {}
            if not item["title_locked"]:
                if task["title"] != item["synced_title"]:
                    locks["title_locked"] = True
                elif task["title"] != shown_title:
                    changes["title"] = shown_title
            if not item["due_locked"]:
                if (task["due_date"], task["due_time"]) != (item["synced_due_date"], item["synced_due_time"]):
                    locks["due_locked"] = True
                elif (task["due_date"], task["due_time"]) != (due_date, due_time):
                    changes.update(due_date=due_date, due_time=due_time)
            if changes:
                connection.execute(update(t).where(t.c.id == task["id"]).values(**changes, updated_at=now))
                task.update(changes)
                summary["updated"] += 1
            connection.execute(update(items).where(items.c.id == item["id"]).values(
                **locks, synced_title=shown_title, synced_due_date=due_date, synced_due_time=due_time,
                cancelled=event.cancelled, updated_at=now,
            ))
            item.update(locks)
            if _set_priority(connection, item, task, feed["tz"], now) and not changes:
                summary["updated"] += 1
        summary["notes"] += _sync_note(connection, feed, item, title, description)
    return summary


# --- Fetch + sync orchestration (used by the routes) ------------------------------------


def sync_feed(student_id: str, feed_id: str, tz_name: str | None = None) -> dict:
    """Fetch one feed now and import it. Raises ClassroomError on a failed fetch, after
    recording it on the feed."""
    url = feed_url(student_id, feed_id)
    try:
        body = fetch_calendar(url)
    except ClassroomError as error:
        apply_sync(student_id, feed_id, None, error=str(error), tz_name=tz_name)
        raise
    return apply_sync(student_id, feed_id, body, tz_name=tz_name)


def auto_sync(student_id: str, tz_name: str | None = None, fetch_allowed=lambda: True) -> dict:
    """App-open check: recompute priorities, and fetch feeds last tried over SYNC_AFTER ago
    (a few per call, in parallel). fetch_allowed() may refuse (rate limit)."""
    if not has_feeds(student_id):
        return {"feeds": 0, "synced": 0, "changed": 0}
    stale = stale_feed_ids(student_id)
    synced = 0
    changed = 0
    if stale and fetch_allowed():
        def one(feed_id: str):
            try:
                return sync_feed(student_id, feed_id, tz_name)
            except ClassroomError:
                return None
        with ThreadPoolExecutor(max_workers=AUTO_SYNC_FEEDS_PER_CALL) as pool:
            for result in pool.map(one, stale):
                if result is not None:
                    synced += 1
                    changed += sum(result["sync"].values())
    changed += refresh_priorities(student_id)
    return {"feeds": len(list_feeds(student_id)), "synced": synced, "changed": changed}
