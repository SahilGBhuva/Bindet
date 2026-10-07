"""In-app feedback: a category, a message and, only when the student ticks the box,
their browser, OS, screen size and the page they were on. Nothing else is collected.

Messages are read by the bindit team through GET /api/admin/feedback, which only
answers for the emails listed in ADMIN_EMAILS (see main.py).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import JSON, Column, DateTime, MetaData, String, Table, Text, delete, select

import database

feedback_metadata = MetaData()

entries = Table(
    "feedback", feedback_metadata,
    Column("id", String(32), primary_key=True),
    Column("student_id", String(100), nullable=False, index=True),
    Column("category", String(8), nullable=False),
    Column("message", Text, nullable=False),
    Column("device", JSON, nullable=True),
    Column("page", String(80), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
)

FEEDBACK_TABLES = ("feedback",)
CATEGORIES = ("bug", "idea", "other")
MESSAGE_MAX = 2000
DEVICE_FIELDS = {"browser": 60, "os": 60, "screen": 20, "viewport": 20}


@lru_cache(maxsize=1)
def init_feedback() -> None:
    database.init_db()
    database.create_locked_tables(database.engine(), feedback_metadata, FEEDBACK_TABLES, FEEDBACK_TABLES)


def clean_device(device: dict | None) -> dict | None:
    """Only the known fields, as short strings."""
    if not device:
        return None
    kept = {key: " ".join(str(device.get(key) or "").split())[:limit] for key, limit in DEVICE_FIELDS.items()}
    kept = {key: value for key, value in kept.items() if value}
    return kept or None


def save(student_id: str, category: str, message: str, device: dict | None, page: str) -> dict:
    init_feedback()
    row = {
        "id": uuid.uuid4().hex, "student_id": student_id, "category": category,
        "message": message.replace("\r\n", "\n").strip()[:MESSAGE_MAX],
        "device": clean_device(device), "page": (page or "")[:80] if device else "",
        "created_at": datetime.now(timezone.utc),
    }
    with database.engine().begin() as connection:
        connection.execute(entries.insert().values(**row))
    return {"id": row["id"], "received": True}


def latest(limit: int = 200) -> list[dict]:
    init_feedback()
    profiles = database.profiles
    with database.engine().connect() as connection:
        rows = connection.execute(select(
            entries, profiles.c.username, profiles.c.display_name,
        ).outerjoin(profiles, profiles.c.student_id == entries.c.student_id)
         .order_by(entries.c.created_at.desc(), entries.c.id).limit(limit)).mappings().all()
    result = []
    for row in rows:
        created = row["created_at"]
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        result.append({
            "id": row["id"], "student_id": row["student_id"], "username": row["username"] or "",
            "display_name": row["display_name"] or "", "category": row["category"], "message": row["message"],
            "device": row["device"], "page": row["page"], "created_at": created.isoformat() if created else None,
        })
    return result


def delete_for_account_in(connection, student_id: str) -> None:
    connection.execute(delete(entries).where(entries.c.student_id == student_id))


def reset_feedback() -> None:
    """Test helper."""
    init_feedback()
    with database.engine().begin() as connection:
        connection.execute(delete(entries))
