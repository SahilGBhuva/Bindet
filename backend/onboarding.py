"""First-run setup state for an account, kept on the server so it follows the student
to every device and is never shown again once finished or skipped.

One row per account in account_onboarding:
- setup_done_at: when the welcome setup (name, classes, Otto) was finished or skipped.
- checklist_dismissed_at: when the "Get started" checklist on Home was hidden.

Accounts from before this table have no row. They count as set up when they already
have a profile, so nobody who has been using bindet is shown the welcome again, and
only accounts that went through the new setup see the checklist.

The checklist's ticks come from the student's real data (notes, flashcards, quiz or
practice answers, Otto conversations), counted here, never from the browser.
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import Column, DateTime, MetaData, String, Table, delete, select, update
from sqlalchemy.exc import IntegrityError

import database
import flashcards
import note_store
import practice
import practice_tests
import tutor

onboarding_metadata = MetaData()

state = Table(
    "account_onboarding", onboarding_metadata,
    Column("student_id", String(100), primary_key=True),
    Column("setup_done_at", DateTime(timezone=True), nullable=True),
    Column("checklist_dismissed_at", DateTime(timezone=True), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

ONBOARDING_TABLES = ("account_onboarding",)


@lru_cache(maxsize=1)
def init_onboarding() -> None:
    database.init_db()
    # Backend-only: RLS on and the anon/authenticated grants removed, in the same
    # transaction that creates the table (see database.create_locked_tables).
    database.create_locked_tables(database.engine(), onboarding_metadata, ONBOARDING_TABLES, ONBOARDING_TABLES)


def _any(connection, query) -> bool:
    return connection.execute(query.limit(1)).first() is not None


def _steps(connection, student_id: str) -> dict:
    """Which "Get started" steps the student's own data shows as done."""
    progress = database.student_progress
    attempts = connection.execute(
        select(progress.c.attempts).where(progress.c.student_id == student_id)
    ).scalar_one_or_none() or 0
    quiz = attempts > 0 \
        or _any(connection, select(practice_tests.tests.c.id).where(
            practice_tests.tests.c.owner_id == student_id, practice_tests.tests.c.submitted_at.is_not(None))) \
        or _any(connection, select(practice.rounds.c.id).where(practice.rounds.c.owner_id == student_id))
    return {
        "notes": _any(connection, select(note_store.notes.c.id).where(note_store.notes.c.student_id == student_id)),
        "flashcards": _any(connection, select(flashcards.cards.c.id).where(flashcards.cards.c.owner_id == student_id)),
        "quiz": bool(quiz),
        "tutor": _any(connection, select(tutor.conversations.c.id).where(tutor.conversations.c.owner_id == student_id)),
    }


def _init_sources() -> None:
    init_onboarding()
    note_store.init_notes()
    flashcards.init_flashcards()
    practice_tests.init_practice()
    practice.init_practice()
    tutor.init_tutor()


def get_state(student_id: str) -> dict:
    _init_sources()
    with database.engine().connect() as connection:
        row = connection.execute(select(state).where(state.c.student_id == student_id)).mappings().first()
        has_profile = _any(connection, select(database.profiles.c.student_id).where(
            database.profiles.c.student_id == student_id))
        steps = _steps(connection, student_id)
    tracked = row is not None
    return {
        # Older accounts (no row) that already made a profile count as set up.
        "setup_done": bool(row and row["setup_done_at"]) or (not tracked and has_profile),
        "checklist_dismissed": bool(row and row["checklist_dismissed_at"]),
        # Only accounts that went through the new setup get the checklist.
        "tracked": tracked,
        "has_profile": has_profile,
        "steps": steps,
    }


def update_state(student_id: str, setup_done: bool | None = None, checklist_dismissed: bool | None = None) -> dict:
    """Marks the setup finished (or not) and the checklist hidden (or shown). Idempotent:
    a step already marked keeps its first time."""
    init_onboarding()
    now = datetime.now(timezone.utc)
    for attempt in range(2):
        try:
            with database.engine().begin() as connection:
                row = connection.execute(select(state).where(state.c.student_id == student_id)).mappings().first()
                values: dict = {}
                if setup_done is not None:
                    kept = row["setup_done_at"] if row and row["setup_done_at"] else now
                    values["setup_done_at"] = kept if setup_done else None
                if checklist_dismissed is not None:
                    kept = row["checklist_dismissed_at"] if row and row["checklist_dismissed_at"] else now
                    values["checklist_dismissed_at"] = kept if checklist_dismissed else None
                if row is None:
                    connection.execute(state.insert().values(
                        student_id=student_id, created_at=now, updated_at=now,
                        setup_done_at=values.get("setup_done_at"),
                        checklist_dismissed_at=values.get("checklist_dismissed_at"),
                    ))
                elif values:
                    connection.execute(update(state).where(state.c.student_id == student_id).values(**values, updated_at=now))
            break
        except IntegrityError:
            # Another request created the row first: the second pass updates it.
            if attempt:
                raise
    return get_state(student_id)


def delete_for_account_in(connection, student_id: str) -> None:
    connection.execute(delete(state).where(state.c.student_id == student_id))


def reset_onboarding() -> None:
    """Test helper."""
    init_onboarding()
    with database.engine().begin() as connection:
        connection.execute(delete(state))
