from __future__ import annotations

import uuid
from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import Column, DateTime, Integer, MetaData, String, Table, Text, delete, func, select

import database

note_metadata = MetaData()
notes = Table(
    'study_notes', note_metadata,
    Column('id', String(36), primary_key=True),
    Column('student_id', String(100), nullable=False, index=True),
    Column('course', String(120), nullable=False, index=True),
    Column('unit', String(160), nullable=False, index=True),
    Column('file_name', String(255), nullable=False),
    Column('content_type', String(100), nullable=False, default=''),
    Column('text', Text, nullable=False),
    Column('size_bytes', Integer, nullable=False),
    Column('created_at', DateTime(timezone=True), nullable=False),
)


@lru_cache(maxsize=1)
def init_notes() -> None:
    database.init_db()
    # RLS on in the same transaction that creates the table (see database.create_locked_tables).
    # Client grants stay: the browser reads study_notes under its RLS policies.
    database.create_locked_tables(database.engine(), note_metadata, ('study_notes',))


def save_note(student_id: str, course: str, unit: str, file_name: str, content_type: str, text: str, size_bytes: int) -> dict:
    init_notes()
    row = {
        'id': str(uuid.uuid4()), 'student_id': student_id, 'course': course, 'unit': unit,
        'file_name': file_name, 'content_type': content_type, 'text': text,
        'size_bytes': size_bytes, 'created_at': datetime.now(timezone.utc),
    }
    with database.engine().begin() as connection:
        connection.execute(notes.insert().values(**row))
    return row


def context_for(student_id: str, course: str, unit: str, limit_chars: int = 18_000) -> tuple[list[str], str]:
    init_notes()
    # Only the owner's notes, and only as much of each as could fit in the excerpt:
    # a unit can hold many 120,000-character notes, and the model sees at most limit_chars.
    excerpt = func.substr(notes.c.text, 1, max(0, limit_chars)).label('text')
    with database.engine().connect() as connection:
        rows = connection.execute(
            select(notes.c.file_name, excerpt).where(notes.c.student_id == student_id, notes.c.course == course, notes.c.unit == unit)
            .order_by(notes.c.created_at.desc())
        ).mappings().all()
    labels: list[str] = []
    chunks: list[str] = []
    used = 0
    for row in rows:
        labels.append(row['file_name'])
        remaining = limit_chars - used
        if remaining <= 0:
            break
        excerpt = row['text'][:remaining]
        chunks.append(f"SOURCE: {row['file_name']}\n{excerpt}")
        used += len(excerpt)
    return labels, '\n\n'.join(chunks)


def get_note(student_id: str, note_id: str) -> dict | None:
    init_notes()
    with database.engine().begin() as connection:
        row = connection.execute(
            select(notes).where(notes.c.id == note_id, notes.c.student_id == student_id)
        ).mappings().first()
    return dict(row) if row else None


def list_notes(student_id: str, course: str, unit: str) -> list[dict]:
    init_notes()
    with database.engine().begin() as connection:
        rows = connection.execute(
            select(notes).where(notes.c.student_id == student_id, notes.c.course == course, notes.c.unit == unit)
            .order_by(notes.c.created_at.desc())
        ).mappings().all()
    return [dict(row) for row in rows]


MAX_SCOPES = 500


def note_scopes(student_id: str, limit: int = MAX_SCOPES) -> list[dict]:
    """The distinct (course, unit) pairs of the student's notes, with how many notes each
    holds and when the newest was added, newest first. Reads no note text."""
    init_notes()
    last_added = func.max(notes.c.created_at).label('last_added')
    with database.engine().connect() as connection:
        rows = connection.execute(
            select(notes.c.course, notes.c.unit, func.count().label('note_count'), last_added)
            .where(notes.c.student_id == student_id)
            .group_by(notes.c.course, notes.c.unit)
            .order_by(last_added.desc(), notes.c.course, notes.c.unit)
            .limit(max(1, min(limit, MAX_SCOPES)))
        ).mappings().all()
    return [{
        'course': row['course'], 'unit': row['unit'], 'note_count': int(row['note_count']),
        'last_added': _iso(row['last_added']),
    } for row in rows]


def _iso(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, datetime):
        value = datetime.fromisoformat(str(value))
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def remove_note(student_id: str, note_id: str) -> bool:
    init_notes()
    with database.engine().begin() as connection:
        result = connection.execute(delete(notes).where(notes.c.id == note_id, notes.c.student_id == student_id))
    return bool(result.rowcount)
