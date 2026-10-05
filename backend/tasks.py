"""Persistent personal and group tasks.

Every read and write takes the authenticated student ID and checks access here,
so routes can never hand one student another student's tasks. Group tasks are
visible to current group members only; leaving a group removes access at once.
"""
from __future__ import annotations

import math
import re
import secrets
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from urllib.parse import urlparse

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, MetaData, String, Table, Text,
    UniqueConstraint, case, delete, func, or_, select, update,
)

import database

STATUSES = ("todo", "in_progress", "review", "done")
KINDS = ("task", "event")
PRIORITIES = ("low", "medium", "high", "urgent")
STATUS_LABELS = {"todo": "To do", "in_progress": "In progress", "review": "Review", "done": "Completed"}
MAX_TASKS_PER_OWNER = 2000
MAX_LIST = 500
MAX_CHECKLIST = 50
MAX_ATTACHMENTS = 20
MAX_ASSIGNEES = 10
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

task_metadata = MetaData()

tasks = Table(
    "workspace_tasks", task_metadata,
    Column("id", String(32), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("group_id", String(32), index=True),
    Column("title", String(140), nullable=False),
    Column("description", Text, nullable=False, default=""),
    Column("course", String(120), nullable=False, default=""),
    Column("project", String(120), nullable=False, default=""),
    Column("status", String(12), nullable=False, default="todo"),
    Column("priority", String(8), nullable=False, default="medium"),
    Column("due_date", Date),
    Column("due_time", String(5)),
    Column("kind", String(8), nullable=False, default="task"),
    Column("location", String(160), nullable=False, default=""),
    Column("milestone_id", Integer),
    Column("sort_order", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("completed_at", DateTime(timezone=True)),
    Index("ix_workspace_tasks_owner_group", "owner_id", "group_id"),
)

task_assignees = Table(
    "workspace_task_assignees", task_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("task_id", String(32), ForeignKey("workspace_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("student_id", String(100), nullable=False, index=True),
    Column("assigned_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("task_id", "student_id", name="uq_workspace_task_assignee"),
)

task_checklist = Table(
    "workspace_task_checklist", task_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("task_id", String(32), ForeignKey("workspace_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("text", String(200), nullable=False),
    Column("done", Boolean, nullable=False, default=False),
    Column("position", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

task_comments = Table(
    "workspace_task_comments", task_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("task_id", String(32), ForeignKey("workspace_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("author_id", String(100), nullable=False),
    Column("body", String(2000), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

task_activity = Table(
    "workspace_task_activity", task_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("task_id", String(32), ForeignKey("workspace_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("group_id", String(32), index=True),
    Column("actor_id", String(100), nullable=False),
    Column("kind", String(24), nullable=False),
    Column("detail", String(240), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
    Index("ix_workspace_task_activity_group_created", "group_id", "created_at"),
)

task_attachments = Table(
    "workspace_task_attachments", task_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("task_id", String(32), ForeignKey("workspace_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("added_by", String(100), nullable=False),
    Column("kind", String(8), nullable=False),
    Column("label", String(160), nullable=False),
    Column("url", String(500), nullable=False, default=""),
    Column("note_id", String(36), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

group_milestones = Table(
    "workspace_group_milestones", task_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("group_id", String(32), nullable=False, index=True),
    Column("title", String(80), nullable=False),
    Column("due_date", Date),
    Column("created_by", String(100), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

TASK_TABLES = (
    "workspace_tasks", "workspace_task_assignees", "workspace_task_checklist", "workspace_task_comments",
    "workspace_task_activity", "workspace_task_attachments", "workspace_group_milestones",
)
CHILD_TABLES = (task_assignees, task_checklist, task_comments, task_activity, task_attachments)


@lru_cache(maxsize=1)
def init_tasks() -> None:
    database.init_db()
    task_metadata.create_all(database.engine())
    if database.engine().dialect.name == "postgresql":
        # Served only through the API; with RLS on and no policy PostgREST denies access.
        with database.engine().begin() as connection:
            database.enable_row_level_security(connection, TASK_TABLES)
            database.revoke_client_access(connection, TASK_TABLES)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime | None) -> datetime | None:
    """SQLite drops tzinfo; every stored timestamp is UTC, so label it before it reaches the client."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _clean_line(value: str | None, limit: int) -> str:
    return " ".join((value or "").split())[:limit]


def _clean_text(value: str | None, limit: int) -> str:
    return (value or "").replace("\r\n", "\n").strip()[:limit]


def _group_role(connection, group_id: str, student_id: str) -> str | None:
    return connection.execute(select(database.study_group_members.c.role).where(
        database.study_group_members.c.group_id == group_id,
        database.study_group_members.c.student_id == student_id,
    )).scalar_one_or_none()


def _group_member_ids(connection, group_id: str) -> set[str]:
    return set(connection.execute(select(database.study_group_members.c.student_id).where(
        database.study_group_members.c.group_id == group_id,
    )).scalars().all())


def _my_group_roles(connection, student_id: str) -> dict[str, str]:
    rows = connection.execute(select(
        database.study_group_members.c.group_id, database.study_group_members.c.role,
    ).where(database.study_group_members.c.student_id == student_id)).all()
    return {group_id: role for group_id, role in rows}


def _access(connection, task_id: str, student_id: str) -> tuple[dict, str | None]:
    """Return the task and the viewer's group role. Unknown and forbidden look identical."""
    task = connection.execute(select(tasks).where(tasks.c.id == task_id)).mappings().first()
    if not task:
        raise ValueError("task_not_found")
    if task["group_id"] is None:
        if task["owner_id"] != student_id:
            raise ValueError("task_not_found")
        return dict(task), None
    role = _group_role(connection, task["group_id"], student_id)
    if role is None:
        raise ValueError("task_not_found")
    return dict(task), role


def _assignee_ids(connection, task_id: str) -> set[str]:
    return set(connection.execute(select(task_assignees.c.student_id).where(
        task_assignees.c.task_id == task_id,
    )).scalars().all())


def _can_edit(task: dict, student_id: str, role: str | None, assignees: set[str]) -> bool:
    return task["owner_id"] == student_id or role == "owner" or student_id in assignees


def _can_delete(task: dict, student_id: str, role: str | None) -> bool:
    return task["owner_id"] == student_id or role == "owner"


def _require_edit(connection, task_id: str, student_id: str) -> tuple[dict, str | None, set[str]]:
    task, role = _access(connection, task_id, student_id)
    assignees = _assignee_ids(connection, task_id)
    if not _can_edit(task, student_id, role, assignees):
        raise ValueError("task_forbidden")
    return task, role, assignees


def _log(connection, task: dict, actor_id: str, kind: str, detail: str = "") -> None:
    connection.execute(task_activity.insert().values(
        task_id=task["id"], group_id=task["group_id"], actor_id=actor_id,
        kind=kind, detail=detail[:240], created_at=_now(),
    ))


def _notify(connection, recipients: set[str], actor_id: str, kind: str, message: str) -> None:
    recipients = {recipient for recipient in recipients if recipient != actor_id}
    if not recipients:
        return
    now = _now()
    connection.execute(database.social_notifications.insert(), [{
        "recipient_id": recipient, "actor_id": actor_id, "kind": kind,
        "message": message[:240], "is_read": False, "created_at": now,
    } for recipient in recipients])


def _names(connection, student_ids: set[str]) -> dict[str, str]:
    if not student_ids:
        return {}
    rows = connection.execute(select(database.profiles.c.student_id, database.profiles.c.display_name).where(
        database.profiles.c.student_id.in_(student_ids),
    )).all()
    return {student_id: name for student_id, name in rows}


def _parse_date(value) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError as error:
        raise ValueError("invalid_due_date") from error


def _parse_time(value) -> str | None:
    if value in (None, ""):
        return None
    if not TIME_PATTERN.match(str(value)):
        raise ValueError("invalid_due_time")
    return str(value)


def _validated_fields(data: dict) -> dict:
    """Validate the editable task fields that are present in data."""
    values: dict = {}
    if "title" in data:
        title = _clean_line(data["title"], 140)
        if not title:
            raise ValueError("invalid_task_title")
        values["title"] = title
    if "description" in data:
        values["description"] = _clean_text(data["description"], 4000)
    if "course" in data:
        values["course"] = _clean_line(data["course"], 120)
    if "kind" in data:
        if data["kind"] not in KINDS:
            raise ValueError("invalid_task_kind")
        values["kind"] = data["kind"]
    if "location" in data:
        values["location"] = _clean_line(data["location"], 160)
    if "project" in data:
        values["project"] = _clean_line(data["project"], 120)
    if "status" in data:
        if data["status"] not in STATUSES:
            raise ValueError("invalid_task_status")
        values["status"] = data["status"]
    if "priority" in data:
        if data["priority"] not in PRIORITIES:
            raise ValueError("invalid_task_priority")
        values["priority"] = data["priority"]
    if "due_date" in data:
        values["due_date"] = _parse_date(data["due_date"])
    if "due_time" in data:
        values["due_time"] = _parse_time(data["due_time"])
    if "sort_order" in data:
        values["sort_order"] = max(-1_000_000, min(1_000_000, int(data["sort_order"] or 0)))
    return values


def _validated_assignees(connection, group_id: str | None, owner_id: str, assignee_ids) -> set[str]:
    chosen = {str(item) for item in (assignee_ids or []) if item}
    if len(chosen) > MAX_ASSIGNEES:
        raise ValueError("too_many_assignees")
    if group_id is None:
        if chosen - {owner_id}:
            raise ValueError("invalid_assignee")
        return chosen
    if chosen - _group_member_ids(connection, group_id):
        raise ValueError("invalid_assignee")
    return chosen


def _validated_milestone(connection, group_id: str | None, milestone_id) -> int | None:
    if milestone_id in (None, "", 0):
        return None
    if group_id is None:
        raise ValueError("milestone_not_found")
    found = connection.execute(select(group_milestones.c.id).where(
        group_milestones.c.id == int(milestone_id), group_milestones.c.group_id == group_id,
    )).scalar_one_or_none()
    if found is None:
        raise ValueError("milestone_not_found")
    return found


def _summaries(connection, rows: list[dict], student_id: str, roles: dict[str, str]) -> list[dict]:
    if not rows:
        return []
    ids = [row["id"] for row in rows]
    assignees: dict[str, list[str]] = defaultdict(list)
    for task_id, assignee in connection.execute(select(task_assignees.c.task_id, task_assignees.c.student_id).where(
        task_assignees.c.task_id.in_(ids),
    ).order_by(task_assignees.c.assigned_at)).all():
        assignees[task_id].append(assignee)
    checklist = {task_id: (total, int(done or 0)) for task_id, total, done in connection.execute(select(
        task_checklist.c.task_id, func.count(), func.sum(case((task_checklist.c.done.is_(True), 1), else_=0)),
    ).where(task_checklist.c.task_id.in_(ids)).group_by(task_checklist.c.task_id)).all()}
    comments = dict(connection.execute(select(task_comments.c.task_id, func.count()).where(
        task_comments.c.task_id.in_(ids),
    ).group_by(task_comments.c.task_id)).all())
    attachments = dict(connection.execute(select(task_attachments.c.task_id, func.count()).where(
        task_attachments.c.task_id.in_(ids),
    ).group_by(task_attachments.c.task_id)).all())
    group_ids = {row["group_id"] for row in rows if row["group_id"]}
    group_names = dict(connection.execute(select(database.study_groups.c.id, database.study_groups.c.name).where(
        database.study_groups.c.id.in_(group_ids),
    )).all()) if group_ids else {}
    people = {row["owner_id"] for row in rows} | {person for values in assignees.values() for person in values}
    names = _names(connection, people)
    results = []
    for row in rows:
        role = roles.get(row["group_id"]) if row["group_id"] else None
        task_assigned = assignees.get(row["id"], [])
        total, done = checklist.get(row["id"], (0, 0))
        results.append({
            "id": row["id"], "title": row["title"], "description": row["description"],
            "course": row["course"], "project": row["project"], "status": row["status"],
            "kind": row["kind"] or "task", "location": row["location"] or "",
            "priority": row["priority"],
            "due_date": row["due_date"].isoformat() if row["due_date"] else None,
            "due_time": row["due_time"], "milestone_id": row["milestone_id"], "sort_order": row["sort_order"],
            "group_id": row["group_id"], "group_name": group_names.get(row["group_id"]) if row["group_id"] else None,
            "owner": {"student_id": row["owner_id"], "display_name": names.get(row["owner_id"], "Student")},
            "assignees": [{"student_id": person, "display_name": names.get(person, "Student")} for person in task_assigned],
            "checklist_total": total, "checklist_done": done,
            "comment_count": int(comments.get(row["id"], 0)),
            "attachment_count": int(attachments.get(row["id"], 0)),
            "created_at": _utc(row["created_at"]), "updated_at": _utc(row["updated_at"]), "completed_at": _utc(row["completed_at"]),
            "can_edit": _can_edit(row, student_id, role, set(task_assigned)),
            "can_delete": _can_delete(row, student_id, role),
        })
    return results


def _summary(connection, task_id: str, student_id: str) -> dict:
    row = connection.execute(select(tasks).where(tasks.c.id == task_id)).mappings().one()
    return _summaries(connection, [dict(row)], student_id, _my_group_roles(connection, student_id))[0]


def list_tasks(student_id: str, group_id: str | None = None, limit: int = MAX_LIST) -> list[dict]:
    """Personal tasks plus tasks from every group the student currently belongs to."""
    init_tasks()
    with database.engine().connect() as connection:
        roles = _my_group_roles(connection, student_id)
        if group_id is not None:
            if group_id not in roles:
                raise ValueError("group_not_found")
            visible = tasks.c.group_id == group_id
        else:
            personal = (tasks.c.owner_id == student_id) & tasks.c.group_id.is_(None)
            visible = or_(personal, tasks.c.group_id.in_(list(roles))) if roles else personal
        rows = connection.execute(select(tasks).where(visible).order_by(
            (tasks.c.status == "done").asc(), tasks.c.due_date.is_(None).asc(), tasks.c.due_date.asc(),
            tasks.c.sort_order.asc(), tasks.c.created_at.desc(),
        ).limit(max(1, min(limit, MAX_LIST)))).mappings().all()
        return _summaries(connection, [dict(row) for row in rows], student_id, roles)


def create_task(student_id: str, data: dict) -> dict:
    init_tasks()
    values = _validated_fields({"status": "todo", "priority": "medium", **data})
    if "title" not in values:
        raise ValueError("invalid_task_title")
    group_id = data.get("group_id") or None
    now = _now()
    with database.engine().begin() as connection:
        if group_id is not None and _group_role(connection, group_id, student_id) is None:
            raise ValueError("group_not_found")
        owned = connection.execute(select(func.count()).select_from(tasks).where(tasks.c.owner_id == student_id)).scalar_one()
        if owned >= MAX_TASKS_PER_OWNER:
            raise ValueError("task_limit_reached")
        requested = data.get("assignee_ids")
        assignees = _validated_assignees(connection, group_id, student_id, requested if requested is not None else [student_id])
        milestone_id = _validated_milestone(connection, group_id, data.get("milestone_id"))
        task_id = secrets.token_hex(16)
        row = {
            "id": task_id, "owner_id": student_id, "group_id": group_id, "description": "", "course": "",
            "project": "", "due_date": None, "due_time": None, "sort_order": 0, "kind": "task", "location": "", **values,
            "milestone_id": milestone_id, "created_at": now, "updated_at": now,
            "completed_at": now if values["status"] == "done" else None,
        }
        connection.execute(tasks.insert().values(**row))
        if assignees:
            connection.execute(task_assignees.insert(), [
                {"task_id": task_id, "student_id": person, "assigned_at": now} for person in sorted(assignees)
            ])
        _log(connection, row, student_id, "created", row["title"])
        if group_id:
            actor = _names(connection, {student_id}).get(student_id, "A group member")
            _notify(connection, assignees, student_id, "task_assigned", f"{actor} assigned you “{row['title']}”.")
        return _summary(connection, task_id, student_id)


def get_task(student_id: str, task_id: str) -> dict:
    init_tasks()
    with database.engine().connect() as connection:
        _access(connection, task_id, student_id)
        summary = _summary(connection, task_id, student_id)
        checklist = connection.execute(select(task_checklist).where(task_checklist.c.task_id == task_id).order_by(
            task_checklist.c.position, task_checklist.c.id,
        )).mappings().all()
        comments = connection.execute(select(task_comments).where(task_comments.c.task_id == task_id).order_by(
            task_comments.c.created_at.desc(), task_comments.c.id.desc(),
        ).limit(100)).mappings().all()
        activity = connection.execute(select(task_activity).where(task_activity.c.task_id == task_id).order_by(
            task_activity.c.created_at.desc(), task_activity.c.id.desc(),
        ).limit(50)).mappings().all()
        attachments = connection.execute(select(task_attachments).where(task_attachments.c.task_id == task_id).order_by(
            task_attachments.c.created_at,
        )).mappings().all()
        names = _names(connection, {row["author_id"] for row in comments} | {row["actor_id"] for row in activity}
                       | {row["added_by"] for row in attachments})
    summary["checklist"] = [{"id": row["id"], "text": row["text"], "done": bool(row["done"])} for row in checklist]
    summary["comments"] = [{
        "id": row["id"], "author_id": row["author_id"], "author_name": names.get(row["author_id"], "Student"),
        "body": row["body"], "created_at": _utc(row["created_at"]), "mine": row["author_id"] == student_id,
    } for row in reversed(comments)]
    summary["activity"] = [{
        "id": row["id"], "actor_name": names.get(row["actor_id"], "Student"), "kind": row["kind"],
        "detail": row["detail"], "created_at": _utc(row["created_at"]),
    } for row in activity]
    # Note attachments expose only their label; the note text stays with its owner.
    summary["attachments"] = [{
        "id": row["id"], "kind": row["kind"], "label": row["label"], "url": row["url"] if row["kind"] == "link" else "",
        "note_id": row["note_id"] if row["added_by"] == student_id else "",
        "added_by_name": names.get(row["added_by"], "Student"), "mine": row["added_by"] == student_id,
        "created_at": _utc(row["created_at"]),
    } for row in attachments]
    return summary


def update_task(student_id: str, task_id: str, data: dict) -> dict:
    init_tasks()
    values = _validated_fields(data)
    with database.engine().begin() as connection:
        task, role, current_assignees = _require_edit(connection, task_id, student_id)
        now = _now()
        actor = _names(connection, {student_id}).get(student_id, "A group member")
        if "milestone_id" in data:
            values["milestone_id"] = _validated_milestone(connection, task["group_id"], data["milestone_id"])
        if "status" in values and values["status"] != task["status"]:
            values["completed_at"] = now if values["status"] == "done" else None
            _log(connection, task, student_id, "status", f"Moved to {STATUS_LABELS[values['status']]}")
            if task["group_id"] and values["status"] == "done":
                _notify(connection, current_assignees | {task["owner_id"]}, student_id, "task_completed",
                        f"{actor} completed “{task['title']}”.")
        if "due_date" in values and values["due_date"] != task["due_date"]:
            _log(connection, task, student_id, "due", f"Due {values['due_date'].isoformat()}" if values["due_date"] else "Due date cleared")
        if "priority" in values and values["priority"] != task["priority"]:
            _log(connection, task, student_id, "priority", f"Priority set to {values['priority']}")
        if "title" in values and values["title"] != task["title"]:
            _log(connection, task, student_id, "renamed", values["title"])
        if "assignee_ids" in data:
            assignees = _validated_assignees(connection, task["group_id"], task["owner_id"], data["assignee_ids"])
            added, removed = assignees - current_assignees, current_assignees - assignees
            if removed:
                connection.execute(delete(task_assignees).where(
                    task_assignees.c.task_id == task_id, task_assignees.c.student_id.in_(removed),
                ))
            if added:
                connection.execute(task_assignees.insert(), [
                    {"task_id": task_id, "student_id": person, "assigned_at": now} for person in sorted(added)
                ])
            if added or removed:
                names = _names(connection, added | removed)
                parts = [f"Assigned {', '.join(names.get(p, 'Student') for p in sorted(added))}"] if added else []
                parts += [f"Unassigned {', '.join(names.get(p, 'Student') for p in sorted(removed))}"] if removed else []
                _log(connection, task, student_id, "assignees", "; ".join(parts))
                if task["group_id"]:
                    _notify(connection, added, student_id, "task_assigned", f"{actor} assigned you “{task['title']}”.")
        if values:
            connection.execute(update(tasks).where(tasks.c.id == task_id).values(**values, updated_at=now))
        elif "assignee_ids" in data:
            connection.execute(update(tasks).where(tasks.c.id == task_id).values(updated_at=now))
        return _summary(connection, task_id, student_id)


def delete_task(student_id: str, task_id: str) -> bool:
    init_tasks()
    with database.engine().begin() as connection:
        task, role = _access(connection, task_id, student_id)
        if not _can_delete(task, student_id, role):
            raise ValueError("task_forbidden")
        # SQLite does not enforce ON DELETE CASCADE by default, so clear children explicitly.
        for table in CHILD_TABLES:
            connection.execute(delete(table).where(table.c.task_id == task_id))
        connection.execute(delete(tasks).where(tasks.c.id == task_id))
    return True


def _touch(connection, task_id: str) -> None:
    connection.execute(update(tasks).where(tasks.c.id == task_id).values(updated_at=_now()))


def add_checklist_item(student_id: str, task_id: str, text: str) -> dict:
    init_tasks()
    clean = _clean_line(text, 200)
    if not clean:
        raise ValueError("invalid_checklist_item")
    with database.engine().begin() as connection:
        _require_edit(connection, task_id, student_id)
        count = connection.execute(select(func.count()).select_from(task_checklist).where(task_checklist.c.task_id == task_id)).scalar_one()
        if count >= MAX_CHECKLIST:
            raise ValueError("checklist_full")
        item_id = connection.execute(task_checklist.insert().values(
            task_id=task_id, text=clean, done=False, position=count, created_at=_now(),
        )).inserted_primary_key[0]
        _touch(connection, task_id)
    return {"id": item_id, "text": clean, "done": False}


def update_checklist_item(student_id: str, task_id: str, item_id: int, data: dict) -> dict:
    init_tasks()
    values: dict = {}
    if "text" in data:
        values["text"] = _clean_line(data["text"], 200)
        if not values["text"]:
            raise ValueError("invalid_checklist_item")
    if "done" in data:
        values["done"] = bool(data["done"])
    with database.engine().begin() as connection:
        _require_edit(connection, task_id, student_id)
        item = connection.execute(select(task_checklist).where(
            task_checklist.c.id == item_id, task_checklist.c.task_id == task_id,
        )).mappings().first()
        if not item:
            raise ValueError("checklist_item_not_found")
        if values:
            connection.execute(update(task_checklist).where(task_checklist.c.id == item_id).values(**values))
            _touch(connection, task_id)
        merged = {**dict(item), **values}
    return {"id": merged["id"], "text": merged["text"], "done": bool(merged["done"])}


def delete_checklist_item(student_id: str, task_id: str, item_id: int) -> bool:
    init_tasks()
    with database.engine().begin() as connection:
        _require_edit(connection, task_id, student_id)
        result = connection.execute(delete(task_checklist).where(
            task_checklist.c.id == item_id, task_checklist.c.task_id == task_id,
        ))
        if not result.rowcount:
            raise ValueError("checklist_item_not_found")
        _touch(connection, task_id)
    return True


def add_comment(student_id: str, task_id: str, body: str) -> dict:
    init_tasks()
    clean = _clean_text(body, 2000)
    if not clean:
        raise ValueError("invalid_comment")
    with database.engine().begin() as connection:
        task, _role = _access(connection, task_id, student_id)
        now = _now()
        comment_id = connection.execute(task_comments.insert().values(
            task_id=task_id, author_id=student_id, body=clean, created_at=now,
        )).inserted_primary_key[0]
        name = _names(connection, {student_id}).get(student_id, "Student")
        if task["group_id"]:
            _notify(connection, _assignee_ids(connection, task_id) | {task["owner_id"]}, student_id, "task_comment",
                    f"{name} commented on “{task['title']}”.")
        _touch(connection, task_id)
    return {"id": comment_id, "author_id": student_id, "author_name": name, "body": clean, "created_at": now, "mine": True}


def delete_comment(student_id: str, task_id: str, comment_id: int) -> bool:
    init_tasks()
    with database.engine().begin() as connection:
        task, role = _access(connection, task_id, student_id)
        comment = connection.execute(select(task_comments).where(
            task_comments.c.id == comment_id, task_comments.c.task_id == task_id,
        )).mappings().first()
        if not comment:
            raise ValueError("comment_not_found")
        if comment["author_id"] != student_id and role != "owner":
            raise ValueError("task_forbidden")
        connection.execute(delete(task_comments).where(task_comments.c.id == comment_id))
    return True


def add_attachment(student_id: str, task_id: str, kind: str, label: str = "", url: str = "", note: dict | None = None) -> dict:
    """Attach a web link, or one of the student's own notes (pass the owner-checked note)."""
    init_tasks()
    if kind == "link":
        parsed = urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > 500:
            raise ValueError("invalid_attachment_url")
        values = {"kind": "link", "url": url.strip(), "note_id": "", "label": _clean_line(label, 160) or parsed.netloc}
    elif kind == "note":
        if not note or note.get("student_id") != student_id:
            raise ValueError("note_not_found")
        values = {"kind": "note", "url": "", "note_id": note["id"], "label": _clean_line(note["file_name"], 160)}
    else:
        raise ValueError("invalid_attachment")
    with database.engine().begin() as connection:
        task, _role, _assignees = _require_edit(connection, task_id, student_id)
        count = connection.execute(select(func.count()).select_from(task_attachments).where(task_attachments.c.task_id == task_id)).scalar_one()
        if count >= MAX_ATTACHMENTS:
            raise ValueError("attachments_full")
        now = _now()
        attachment_id = connection.execute(task_attachments.insert().values(
            task_id=task_id, added_by=student_id, created_at=now, **values,
        )).inserted_primary_key[0]
        _log(connection, task, student_id, "attachment", f"Attached {values['label']}")
        _touch(connection, task_id)
        name = _names(connection, {student_id}).get(student_id, "Student")
    return {"id": attachment_id, "kind": values["kind"], "label": values["label"], "url": values["url"],
            "note_id": values["note_id"], "added_by_name": name, "mine": True, "created_at": now}


def remove_attachment(student_id: str, task_id: str, attachment_id: int) -> bool:
    init_tasks()
    with database.engine().begin() as connection:
        task, role = _access(connection, task_id, student_id)
        attachment = connection.execute(select(task_attachments).where(
            task_attachments.c.id == attachment_id, task_attachments.c.task_id == task_id,
        )).mappings().first()
        if not attachment:
            raise ValueError("attachment_not_found")
        if attachment["added_by"] != student_id and not _can_delete(task, student_id, role):
            raise ValueError("task_forbidden")
        connection.execute(delete(task_attachments).where(task_attachments.c.id == attachment_id))
    return True


def _milestone_rows(connection, group_id: str) -> list[dict]:
    rows = connection.execute(select(group_milestones).where(group_milestones.c.group_id == group_id).order_by(
        group_milestones.c.due_date.is_(None).asc(), group_milestones.c.due_date.asc(), group_milestones.c.id.asc(),
    )).mappings().all()
    counts: dict[int, tuple[int, int]] = {}
    for milestone_id, total, done in connection.execute(select(
        tasks.c.milestone_id, func.count(), func.sum(case((tasks.c.status == "done", 1), else_=0)),
    ).where(tasks.c.group_id == group_id, tasks.c.milestone_id.is_not(None)).group_by(tasks.c.milestone_id)).all():
        counts[milestone_id] = (total, int(done or 0))
    result = []
    for row in rows:
        total, done = counts.get(row["id"], (0, 0))
        result.append({
            "id": row["id"], "title": row["title"],
            "due_date": row["due_date"].isoformat() if row["due_date"] else None,
            "total": total, "done": done, "percent": round(done / total * 100) if total else 0,
        })
    return result


def list_milestones(student_id: str, group_id: str) -> list[dict]:
    init_tasks()
    with database.engine().connect() as connection:
        if _group_role(connection, group_id, student_id) is None:
            raise ValueError("group_not_found")
        return _milestone_rows(connection, group_id)


def create_milestone(student_id: str, group_id: str, title: str, due_date=None) -> dict:
    init_tasks()
    clean = _clean_line(title, 80)
    if not clean:
        raise ValueError("invalid_milestone")
    due = _parse_date(due_date)
    with database.engine().begin() as connection:
        role = _group_role(connection, group_id, student_id)
        if role is None:
            raise ValueError("group_not_found")
        if role != "owner":
            raise ValueError("group_owner_required")
        count = connection.execute(select(func.count()).select_from(group_milestones).where(group_milestones.c.group_id == group_id)).scalar_one()
        if count >= 30:
            raise ValueError("milestone_limit_reached")
        milestone_id = connection.execute(group_milestones.insert().values(
            group_id=group_id, title=clean, due_date=due, created_by=student_id, created_at=_now(),
        )).inserted_primary_key[0]
    return {"id": milestone_id, "title": clean, "due_date": due.isoformat() if due else None, "total": 0, "done": 0, "percent": 0}


def delete_milestone(student_id: str, group_id: str, milestone_id: int) -> bool:
    init_tasks()
    with database.engine().begin() as connection:
        role = _group_role(connection, group_id, student_id)
        if role is None:
            raise ValueError("group_not_found")
        if role != "owner":
            raise ValueError("group_owner_required")
        result = connection.execute(delete(group_milestones).where(
            group_milestones.c.id == milestone_id, group_milestones.c.group_id == group_id,
        ))
        if not result.rowcount:
            raise ValueError("milestone_not_found")
        connection.execute(update(tasks).where(tasks.c.milestone_id == milestone_id, tasks.c.group_id == group_id).values(milestone_id=None))
    return True


def _as_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        return datetime.fromisoformat(value).date()
    return value


def group_analytics(student_id: str, group_id: str, today: date | None = None, days: int = 28) -> dict:
    """Members, workload, milestones, a completion series and a projected finish date."""
    init_tasks()
    today = today or _now().date()
    with database.engine().connect() as connection:
        role = _group_role(connection, group_id, student_id)
        if role is None:
            raise ValueError("group_not_found")
        group = connection.execute(select(database.study_groups).where(database.study_groups.c.id == group_id)).mappings().one()
        members = connection.execute(select(
            database.profiles.c.student_id, database.profiles.c.display_name, database.profiles.c.username,
            database.study_group_members.c.role,
        ).join(database.study_group_members, database.profiles.c.student_id == database.study_group_members.c.student_id)
          .where(database.study_group_members.c.group_id == group_id)
          .order_by(database.study_group_members.c.joined_at)).mappings().all()
        rows = connection.execute(select(
            tasks.c.id, tasks.c.status, tasks.c.due_date, tasks.c.created_at, tasks.c.completed_at,
        ).where(tasks.c.group_id == group_id)).mappings().all()
        workload = connection.execute(select(
            task_assignees.c.student_id, func.count(), func.sum(case((tasks.c.status == "done", 1), else_=0)),
        ).join(tasks, tasks.c.id == task_assignees.c.task_id).where(tasks.c.group_id == group_id)
          .group_by(task_assignees.c.student_id)).all()
        milestones = _milestone_rows(connection, group_id)
        activity = connection.execute(select(task_activity, tasks.c.title).join(
            tasks, tasks.c.id == task_activity.c.task_id,
        ).where(task_activity.c.group_id == group_id).order_by(
            task_activity.c.created_at.desc(), task_activity.c.id.desc(),
        ).limit(20)).mappings().all()
        names = _names(connection, {row["actor_id"] for row in activity})
        # Who has done anything lately: task activity or practice XP in the last 7 days.
        week_ago = datetime.combine(today - timedelta(days=6), datetime.min.time(), tzinfo=timezone.utc)
        member_ids = [member["student_id"] for member in members]
        recent_actors = set(connection.execute(select(task_activity.c.actor_id).where(
            task_activity.c.group_id == group_id, task_activity.c.created_at >= week_ago,
        )).scalars().all())
        recent_xp = set(connection.execute(select(database.xp_events.c.student_id).where(
            database.xp_events.c.student_id.in_(member_ids), database.xp_events.c.created_at >= week_ago,
        )).scalars().all()) if member_ids else set()
        # "No response": open to-do tasks where no assignee has touched the task since it was created.
        assigned = defaultdict(set)
        for task_id, person in connection.execute(select(task_assignees.c.task_id, task_assignees.c.student_id).join(
            tasks, tasks.c.id == task_assignees.c.task_id,
        ).where(tasks.c.group_id == group_id)).all():
            assigned[task_id].add(person)
        touched = defaultdict(set)
        for task_id, actor, kind in connection.execute(select(task_activity.c.task_id, task_activity.c.actor_id, task_activity.c.kind).where(
            task_activity.c.group_id == group_id,
        )).all():
            if kind != "created":
                touched[task_id].add(actor)

    by_status = {status: 0 for status in STATUSES}
    for row in rows:
        by_status[row["status"]] = by_status.get(row["status"], 0) + 1
    total = len(rows)
    done = by_status["done"]
    overdue = sum(1 for row in rows if row["status"] != "done" and row["due_date"] and row["due_date"] < today)
    load = {person: (count, int(finished or 0)) for person, count, finished in workload}

    start = today - timedelta(days=days - 1)
    series = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        series.append({
            "date": day.isoformat(),
            "total": sum(1 for row in rows if _as_date(row["created_at"]) <= day),
            "done": sum(1 for row in rows if row["completed_at"] and _as_date(row["completed_at"]) <= day),
        })

    window = 14
    recent_done = sum(1 for row in rows if row["completed_at"] and _as_date(row["completed_at"]) > today - timedelta(days=window))
    remaining = total - done
    projected = None
    if remaining == 0 and total:
        projected = today.isoformat()
    elif recent_done:
        projected = (today + timedelta(days=math.ceil(remaining / (recent_done / window)))).isoformat()

    no_response = sum(1 for row in rows if row["status"] == "todo" and assigned[row["id"]] and not (touched[row["id"]] & assigned[row["id"]]))
    completion = {"completed": done, "unfinished": total - done - no_response, "no_response": no_response}

    # Pace: the projected finish against the latest milestone date, when there is one.
    target = max((date.fromisoformat(item["due_date"]) for item in milestones if item["due_date"]), default=None)
    if not total:
        pace = "not_started"
    elif remaining == 0:
        pace = "done"
    elif projected is None:
        pace = "stalled"
    elif target is None:
        pace = "on_track"
    else:
        slip = (date.fromisoformat(projected) - target).days
        pace = "on_track" if slip <= 0 else "at_risk" if slip <= 3 else "behind"

    active = {member["student_id"] for member in members if member["student_id"] in recent_actors or member["student_id"] in recent_xp}
    overview = _overview(total, done, overdue, no_response, pace, projected, target, len(active), len(members))

    return {
        "group": {"id": group["id"], "name": group["name"], "description": group["description"], "role": role},
        "members": [{
            "student_id": member["student_id"], "display_name": member["display_name"], "username": member["username"],
            "role": member["role"], "assigned": load.get(member["student_id"], (0, 0))[0],
            "completed": load.get(member["student_id"], (0, 0))[1],
            "active": member["student_id"] in active,
        } for member in members],
        "completion": completion,
        "pace": pace,
        "target_date": target.isoformat() if target else None,
        "overview": overview,
        "totals": {"total": total, "done": done, "overdue": overdue, "by_status": by_status,
                   "percent": round(done / total * 100) if total else 0},
        "milestones": milestones,
        "series": series,
        "velocity_per_week": round(recent_done / window * 7, 1),
        "projected_finish": projected,
        "activity": [{
            "id": row["id"], "task_id": row["task_id"], "task_title": row["title"], "kind": row["kind"],
            "detail": row["detail"], "actor_name": names.get(row["actor_id"], "Student"), "created_at": _utc(row["created_at"]),
        } for row in activity],
    }


def _overview(total: int, done: int, overdue: int, no_response: int, pace: str, projected: str | None, target: date | None, active: int, members: int) -> list[str]:
    """A plain-language summary computed from the numbers above (no AI involved)."""
    if not total:
        return ["No group tasks yet. Add tasks and milestones to start tracking this project."]
    lines = [f"{done} of {total} tasks are complete ({round(done / total * 100)}%)."]
    if overdue:
        lines.append(f"{overdue} {'task is' if overdue == 1 else 'tasks are'} past due.")
    if no_response:
        lines.append(f"{no_response} assigned {'task has' if no_response == 1 else 'tasks have'} had no response from the assignee yet.")
    if pace == "behind" and projected and target:
        lines.append(f"At the current pace the project finishes {date.fromisoformat(projected).strftime('%b %-d')}, after the {target.strftime('%b %-d')} milestone. Consider re-assigning work or moving the date.")
    elif pace == "at_risk" and projected:
        lines.append(f"The projected finish ({date.fromisoformat(projected).strftime('%b %-d')}) is just past the final milestone.")
    elif pace == "stalled":
        lines.append("Nothing has been completed in the last two weeks, so a finish date can't be projected yet.")
    elif pace in ("on_track", "done"):
        lines.append("The group is on pace.")
    lines.append(f"{active} of {members} members were active this week.")
    return lines


def notify_members(student_id: str, group_id: str, message: str) -> int:
    """The group owner sends one notification to every other member."""
    init_tasks()
    clean = _clean_line(message, 200)
    if not clean:
        raise ValueError("invalid_notice")
    with database.engine().begin() as connection:
        role = _group_role(connection, group_id, student_id)
        if role is None:
            raise ValueError("group_not_found")
        if role != "owner":
            raise ValueError("group_owner_required")
        recipients = _group_member_ids(connection, group_id) - {student_id}
        group_name = connection.execute(select(database.study_groups.c.name).where(database.study_groups.c.id == group_id)).scalar_one()
        _notify(connection, recipients, student_id, "group_notice", f"{group_name}: {clean}")
    return len(recipients)


def reset_tasks() -> None:
    """Test helper: clear every task table."""
    init_tasks()
    with database.engine().begin() as connection:
        for table in (*CHILD_TABLES, group_milestones, tasks):
            connection.execute(delete(table))
