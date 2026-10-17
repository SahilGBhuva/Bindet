"""Tables for the Google Classroom calendar import (see classroom.py).

Kept apart from classroom.py so tasks.py can read them (the "Classroom" source of a
task, and the student-edit locks) without importing the fetching and parsing code.

classroom_feeds: one row per connected class calendar. calendar_url is the student's
secret iCal address: it is only ever read by the server to fetch the calendar, never
returned by any API and never logged (url_hash identifies it in logs and dedupe).

classroom_items: one row per imported calendar event (student, feed, UID). It links the
event to the task (and the optional instructions note) it became, remembers what the
last sync wrote so a re-sync can tell whether the student changed it since, and holds
the student-edit locks: once the student renames, reschedules or re-prioritizes an
imported task by hand, sync stops changing that field.
"""
from __future__ import annotations

from functools import lru_cache

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Integer, MetaData, String, Text, Table, UniqueConstraint, select, update,
)

classroom_metadata = MetaData()

feeds = Table(
    "classroom_feeds", classroom_metadata,
    Column("id", String(32), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("course", String(120), nullable=False),
    Column("calendar_url", Text, nullable=False),
    Column("url_hash", String(64), nullable=False),
    Column("tz", String(64), nullable=False, default="UTC"),
    Column("save_notes", Boolean, nullable=False, default=True),
    Column("last_status", String(16), nullable=False, default="new"),
    Column("last_synced_at", DateTime(timezone=True)),
    Column("last_attempt_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("owner_id", "url_hash", name="uq_classroom_feed_owner_url"),
)

items = Table(
    "classroom_items", classroom_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("feed_id", String(32), nullable=False, index=True),
    Column("uid_hash", String(64), nullable=False),
    Column("task_id", String(32), index=True),
    Column("synced_title", String(140), nullable=False, default=""),
    Column("synced_due_date", Date),
    Column("synced_due_time", String(5)),
    Column("synced_priority", String(8)),
    Column("title_locked", Boolean, nullable=False, default=False),
    Column("due_locked", Boolean, nullable=False, default=False),
    Column("priority_locked", Boolean, nullable=False, default=False),
    Column("cancelled", Boolean, nullable=False, default=False),
    Column("note_id", String(36)),
    Column("note_hash", String(64)),
    Column("note_dismissed", Boolean, nullable=False, default=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("owner_id", "feed_id", "uid_hash", name="uq_classroom_item"),
)

CLASSROOM_TABLES = ("classroom_feeds", "classroom_items")


@lru_cache(maxsize=1)
def init_classroom_tables() -> None:
    """Backend-only: RLS on and client grants revoked in the transaction that creates them."""
    import database  # database imports nothing from here; kept local so this module stays light

    database.create_locked_tables(database.engine(), classroom_metadata, CLASSROOM_TABLES, CLASSROOM_TABLES)

# Task fields a student edit locks against later syncs.
_LOCKS = {"title": "title_locked", "due_date": "due_locked", "due_time": "due_locked", "priority": "priority_locked"}


def record_student_edit(connection, task_id: str, fields: set[str]) -> None:
    """The student changed these fields of a task by hand; if it came from Classroom,
    sync leaves those fields alone from now on."""
    locks = {_LOCKS[field]: True for field in fields if field in _LOCKS}
    if locks:
        connection.execute(update(items).where(items.c.task_id == task_id).values(**locks))


def sources_for(connection, task_ids: list[str]) -> dict[str, dict]:
    """{task_id: {"source": "classroom", "cancelled": bool}} for imported tasks."""
    if not task_ids:
        return {}
    rows = connection.execute(select(items.c.task_id, items.c.cancelled).where(items.c.task_id.in_(task_ids))).all()
    return {task_id: {"source": "classroom", "cancelled": bool(cancelled)} for task_id, cancelled in rows}
