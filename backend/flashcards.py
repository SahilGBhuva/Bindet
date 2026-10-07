"""Persistent, note-grounded flashcards.

Each note gets its cards once: generation is claimed through a job row
(flashcard_jobs, one per note) and the cards are stored in `flashcards` with a
unique (note_id, front_key) key, so repeated or racing requests never create
duplicates or spend the AI twice. Every function takes the authenticated owner
ID and filters by it, so one student can never read or change another
student's cards.

Concurrency: the job row is claimed inside a transaction that holds a Postgres
advisory lock for the note (on SQLite, an in-process lock plus SQLite's own
writer lock). The AI call runs outside any transaction; while it runs the job
says `generating`, which other requests answer with 409. A `generating` job
older than STALE_SECONDS is treated as crashed and can be claimed again.
"""
from __future__ import annotations

import threading
import uuid
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from sqlalchemy import Column, DateTime, Index, Integer, MetaData, String, Table, UniqueConstraint, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError

import ai_tutor
import database
import note_store

flashcard_metadata = MetaData()

cards = Table(
    "flashcards", flashcard_metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("note_id", String(36), nullable=False, index=True),
    Column("course", String(120), nullable=False),
    Column("unit", String(160), nullable=False),
    Column("front", String(300), nullable=False),
    Column("back", String(700), nullable=False),
    Column("topic", String(60), nullable=False),
    Column("front_key", String(64), nullable=False),
    Column("position", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("note_id", "front_key", name="uq_flashcards_note_front"),
)
Index("ix_flashcards_owner_course_unit", cards.c.owner_id, cards.c.course, cards.c.unit)

jobs = Table(
    "flashcard_jobs", flashcard_metadata,
    Column("note_id", String(36), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("status", String(12), nullable=False),
    Column("card_count", Integer, nullable=False, default=0),
    Column("error", String(200), nullable=True),
    Column("attempts", Integer, nullable=False, default=0),
    Column("started_at", DateTime(timezone=True), nullable=True),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

# Which student instructions a note's current cards were made with (no row: none).
# Holds only a hash, so asking again with the same instructions is answered from the stored cards.
styles = Table(
    "flashcard_styles", flashcard_metadata,
    Column("note_id", String(36), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("instructions_hash", String(64), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

FLASHCARD_TABLES = ("flashcards", "flashcard_jobs", "flashcard_styles")
STATUSES = ("ready", "generating", "failed", "too_short", "none")
# A generation that has said `generating` this long crashed or was cut off.
STALE_SECONDS = 90
# Short, safe messages stored with a failed job (never exception text).
SAFE_ERRORS = {
    "ai_unavailable": "The AI was unavailable. Try again.",
    "ai_bad_output": "The AI’s answer couldn’t be used. Try again.",
    "interrupted": "Making these flashcards was interrupted. Try again.",
}

_sqlite_lock = threading.Lock()


@lru_cache(maxsize=1)
def init_flashcards() -> None:
    note_store.init_notes()
    flashcard_metadata.create_all(database.engine())
    if database.engine().dialect.name == "postgresql":
        # Served only through the API; with RLS on, no policy and no client grants PostgREST denies access.
        with database.engine().begin() as connection:
            database.enable_row_level_security(connection, FLASHCARD_TABLES)
            database.revoke_client_access(connection, FLASHCARD_TABLES)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: datetime | None) -> str | None:
    value = _utc(value)
    return value.isoformat() if value else None


def _guard():
    """SQLite has no advisory locks: serialize claims within this process instead."""
    return _sqlite_lock if database.engine().dialect.name == "sqlite" else nullcontext()


def _lock_note(connection, note_id: str) -> None:
    database._advisory_lock(connection, f"flashcards:{note_id}")


def _note_location(connection, owner_id: str, note_id: str) -> tuple[str, str] | None:
    """(course, unit) of the owner's note, or None when it no longer exists."""
    notes = note_store.notes
    row = connection.execute(select(notes.c.course, notes.c.unit).where(
        notes.c.id == note_id, notes.c.student_id == owner_id)).first()
    return (row[0], row[1]) if row is not None else None


def _is_stale(row, now: datetime) -> bool:
    started = _utc(row["started_at"]) or _utc(row["updated_at"])
    return started is None or now - started > timedelta(seconds=STALE_SECONDS)


def _effective(row, now: datetime | None = None) -> tuple[str, str | None]:
    """(status, error) as the client should see them."""
    if row is None:
        return "none", None
    if row["status"] == "generating" and _is_stale(row, now or _now()):
        return "failed", SAFE_ERRORS["interrupted"]
    return row["status"], row["error"]


def _card(row) -> dict:
    return {
        "id": row["id"], "note_id": row["note_id"], "course": row["course"], "unit": row["unit"],
        "front": row["front"], "back": row["back"], "topic": row["topic"], "created_at": _iso(row["created_at"]),
    }


def _job_row(connection, owner_id: str, note_id: str, *, for_update: bool = False):
    query = select(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id)
    if for_update and connection.dialect.name == "postgresql":
        query = query.with_for_update()
    return connection.execute(query).mappings().first()


def job_state(owner_id: str, note_id: str) -> dict:
    """{"status", "error", "card_count"} for one of the owner's notes ("none" when never attempted)."""
    init_flashcards()
    with database.engine().connect() as connection:
        row = _job_row(connection, owner_id, note_id)
    status, error = _effective(row)
    # A crashed generation (stale `generating`) may be re-attempted without ?retry=1.
    interrupted = bool(row) and row["status"] == "generating" and status == "failed"
    return {"status": status, "error": error, "card_count": int(row["card_count"]) if row else 0, "interrupted": interrupted}


def note_cards(owner_id: str, note_id: str) -> list[dict]:
    init_flashcards()
    with database.engine().connect() as connection:
        rows = connection.execute(select(cards).where(cards.c.owner_id == owner_id, cards.c.note_id == note_id)
                                  .order_by(cards.c.position, cards.c.created_at)).mappings().all()
    return [_card(row) for row in rows]


def claim(owner_id: str, note_id: str, *, retry: bool = False) -> tuple[str, int | None]:
    """Try to start generating this note's cards.

    Returns ("claimed", attempt) when the caller should generate, or ("ready" |
    "generating" | "failed", None) when it should not. A failed job is claimed
    again only with retry=True; a stale `generating` job is always claimable.
    """
    init_flashcards()
    now = _now()
    try:
        with _guard(), database.engine().begin() as connection:
            _lock_note(connection, note_id)
            row = _job_row(connection, owner_id, note_id, for_update=True)
            if row is not None:
                status = row["status"]
                if status == "ready":
                    return "ready", None
                if status == "generating" and not _is_stale(row, now):
                    return "generating", None
                if status == "failed" and not retry:
                    return "failed", None
                attempt = int(row["attempts"] or 0) + 1
                connection.execute(update(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id).values(
                    status="generating", attempts=attempt, error=None, started_at=now, updated_at=now,
                ))
            else:
                attempt = 1
                connection.execute(jobs.insert().values(
                    note_id=note_id, owner_id=owner_id, status="generating", card_count=0, error=None,
                    attempts=attempt, started_at=now, updated_at=now,
                ))
    except IntegrityError:
        # Another process inserted the job row first: it is generating.
        return "generating", None
    return "claimed", attempt


# --- Remaking a note's cards with student instructions --------------------------------

def style_of(owner_id: str, note_id: str) -> str | None:
    """The instructions hash the note's current cards were made with, or None."""
    init_flashcards()
    with database.engine().connect() as connection:
        return connection.execute(select(styles.c.instructions_hash).where(
            styles.c.note_id == note_id, styles.c.owner_id == owner_id)).scalar_one_or_none()


def claim_regeneration(owner_id: str, note_id: str) -> tuple[str, int | None]:
    """Start remaking a note's cards, whatever state they are in, unless they are being made
    right now. Returns ("claimed", attempt) or ("generating", None). The old cards stay
    until replace() swaps them, so a failed remake loses nothing (see release())."""
    init_flashcards()
    now = _now()
    try:
        with _guard(), database.engine().begin() as connection:
            _lock_note(connection, note_id)
            row = _job_row(connection, owner_id, note_id, for_update=True)
            if row is not None and row["status"] == "generating" and not _is_stale(row, now):
                return "generating", None
            attempt = int(row["attempts"] or 0) + 1 if row is not None else 1
            values = {"status": "generating", "attempts": attempt, "error": None, "started_at": now, "updated_at": now}
            if row is None:
                connection.execute(jobs.insert().values(note_id=note_id, owner_id=owner_id, card_count=0, **values))
            else:
                connection.execute(update(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id).values(**values))
    except IntegrityError:
        return "generating", None
    return "claimed", attempt


def _note_exists(connection, owner_id: str, note_id: str) -> bool:
    notes = note_store.notes
    return connection.execute(select(notes.c.id).where(notes.c.id == note_id, notes.c.student_id == owner_id)).first() is not None


def _drop_orphan(connection, owner_id: str, note_id: str) -> None:
    """The note was deleted while its cards were being made: remove everything kept for it."""
    connection.execute(delete(cards).where(cards.c.note_id == note_id, cards.c.owner_id == owner_id))
    connection.execute(delete(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id))
    connection.execute(delete(styles).where(styles.c.note_id == note_id, styles.c.owner_id == owner_id))


def cancel_regeneration(owner_id: str, note_id: str, attempt: int, prior_status: str, prior_error: str | None = None) -> None:
    """Undo a remake claim that never reached the AI (it was refused by a limit).

    The note keeps its cards (ready) or goes back to the state it was in before the
    claim: failed or too_short as before, or no job at all when it never had one.
    Only this attempt's claim is undone; a newer attempt is left alone.
    """
    init_flashcards()
    with _guard(), database.engine().begin() as connection:
        _lock_note(connection, note_id)
        row = _job_row(connection, owner_id, note_id, for_update=True)
        if row is None or row["status"] != "generating" or int(row["attempts"] or 0) != attempt:
            return
        mine = (jobs.c.note_id == note_id, jobs.c.owner_id == owner_id)
        count = connection.execute(select(func.count()).select_from(cards).where(
            cards.c.note_id == note_id, cards.c.owner_id == owner_id)).scalar_one()
        if count:
            values = {"status": "ready", "card_count": int(count), "error": None}
        elif prior_status in ("failed", "too_short"):
            values = {"status": prior_status, "card_count": 0, "error": (prior_error or None) if prior_status == "failed" else None}
        else:
            connection.execute(delete(jobs).where(*mine))
            return
        connection.execute(update(jobs).where(*mine).values(attempts=max(0, attempt - 1), updated_at=_now(), **values))


def release(owner_id: str, note_id: str, attempt: int, code: str) -> None:
    """A remake failed: the note keeps its old cards (ready) or, with none, is marked failed."""
    init_flashcards()
    with _guard(), database.engine().begin() as connection:
        _lock_note(connection, note_id)
        if not _note_exists(connection, owner_id, note_id):
            _drop_orphan(connection, owner_id, note_id)
            return
        count = connection.execute(select(func.count()).select_from(cards).where(
            cards.c.note_id == note_id, cards.c.owner_id == owner_id)).scalar_one()
        values = ({"status": "ready", "card_count": int(count), "error": None} if count
                  else {"status": "failed", "error": SAFE_ERRORS.get(code, SAFE_ERRORS["ai_unavailable"])[:200]})
        connection.execute(update(jobs).where(
            jobs.c.note_id == note_id, jobs.c.owner_id == owner_id, jobs.c.status == "generating", jobs.c.attempts == attempt,
        ).values(updated_at=_now(), **values))


class Superseded(Exception):
    """A newer attempt claimed this note's cards while this one was running, so its result
    must not overwrite them."""


def replace(owner_id: str, note_id: str, course: str, unit: str, new_cards: list[dict], instructions_hash: str,
            attempt: int | None = None) -> list[dict] | None:
    """Swap the note's cards for new_cards and record the instructions they were made with,
    in one transaction. Returns the stored cards, or None if the note was deleted meanwhile.

    With attempt, the swap only happens while that attempt still holds the job (status
    generating, same attempt number); otherwise Superseded is raised and nothing changes,
    so a slow, stale remake can never overwrite a newer one. The course and unit stored on
    the cards are read from the note row under the note's lock (a rename may have moved it).
    """
    init_flashcards()
    now = _now()
    with _guard(), database.engine().begin() as connection:
        _lock_note(connection, note_id)
        location = _note_location(connection, owner_id, note_id)
        if location is None:
            _drop_orphan(connection, owner_id, note_id)
            return None
        course, unit = location
        if attempt is not None:
            row = _job_row(connection, owner_id, note_id, for_update=True)
            if row is None or row["status"] != "generating" or int(row["attempts"] or 0) != attempt:
                raise Superseded()
        connection.execute(delete(cards).where(cards.c.note_id == note_id, cards.c.owner_id == owner_id))
        _insert_ignoring_duplicates(connection, [
            {
                "id": str(uuid.uuid4()), "owner_id": owner_id, "note_id": note_id, "course": course[:120], "unit": unit[:160],
                "front": card["front"][:300], "back": card["back"][:700], "topic": card["topic"][:60],
                "front_key": ai_tutor.front_key(card["front"]), "position": position, "created_at": now,
            }
            for position, card in enumerate(new_cards)
        ])
        count = connection.execute(select(func.count()).select_from(cards).where(cards.c.note_id == note_id)).scalar_one()
        values = {"status": "ready", "card_count": int(count), "error": None, "updated_at": now}
        if _job_row(connection, owner_id, note_id, for_update=True) is None:
            connection.execute(jobs.insert().values(note_id=note_id, owner_id=owner_id, attempts=1, started_at=now, **values))
        else:
            connection.execute(update(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id).values(**values))
        connection.execute(delete(styles).where(styles.c.note_id == note_id, styles.c.owner_id == owner_id))
        connection.execute(styles.insert().values(note_id=note_id, owner_id=owner_id, instructions_hash=instructions_hash, updated_at=now))
        rows = connection.execute(select(cards).where(cards.c.owner_id == owner_id, cards.c.note_id == note_id)
                                  .order_by(cards.c.position, cards.c.created_at)).mappings().all()
    return [_card(row) for row in rows]


def mark_too_short(owner_id: str, note_id: str) -> None:
    """Record that the note is too short for flashcards (unless it already has cards or is generating)."""
    init_flashcards()
    now = _now()
    try:
        with _guard(), database.engine().begin() as connection:
            _lock_note(connection, note_id)
            row = _job_row(connection, owner_id, note_id, for_update=True)
            if row is None:
                connection.execute(jobs.insert().values(
                    note_id=note_id, owner_id=owner_id, status="too_short", card_count=0, error=None,
                    attempts=0, started_at=None, updated_at=now,
                ))
            elif row["status"] in ("failed", "too_short") or (row["status"] == "generating" and _is_stale(row, now)):
                connection.execute(update(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id).values(
                    status="too_short", card_count=0, error=None, updated_at=now,
                ))
    except IntegrityError:
        pass


def fail(owner_id: str, note_id: str, attempt: int, code: str) -> None:
    """Mark this attempt failed with a short, safe message. A newer attempt is left alone."""
    init_flashcards()
    with _guard(), database.engine().begin() as connection:
        connection.execute(update(jobs).where(
            jobs.c.note_id == note_id, jobs.c.owner_id == owner_id, jobs.c.status == "generating", jobs.c.attempts == attempt,
        ).values(status="failed", error=SAFE_ERRORS.get(code, SAFE_ERRORS["ai_unavailable"])[:200], updated_at=_now()))


def _insert_ignoring_duplicates(connection, rows: list[dict]) -> None:
    if not rows:
        return
    insert = postgres_insert if connection.dialect.name == "postgresql" else sqlite_insert
    connection.execute(insert(cards).values(rows).on_conflict_do_nothing(index_elements=["note_id", "front_key"]))


def complete(owner_id: str, note_id: str, course: str, unit: str, new_cards: list[dict]) -> list[dict] | None:
    """Store validated cards and mark the job ready, in one transaction.

    Returns the note's stored cards, or None if the note was deleted meanwhile.
    If another attempt already finished, its cards are kept and these are dropped.
    """
    init_flashcards()
    now = _now()
    with _guard(), database.engine().begin() as connection:
        _lock_note(connection, note_id)
        # Where the note lives now, read under its lock: a rename (move_notes) takes the same
        # lock, so cards are never stored under the old course or unit.
        location = _note_location(connection, owner_id, note_id)
        if location is None:
            _drop_orphan(connection, owner_id, note_id)
            return None
        course, unit = location
        row = _job_row(connection, owner_id, note_id, for_update=True)
        if row is None or row["status"] != "ready":
            _insert_ignoring_duplicates(connection, [
                {
                    "id": str(uuid.uuid4()), "owner_id": owner_id, "note_id": note_id, "course": course[:120], "unit": unit[:160],
                    "front": card["front"][:300], "back": card["back"][:700], "topic": card["topic"][:60],
                    "front_key": ai_tutor.front_key(card["front"]), "position": position, "created_at": now,
                }
                for position, card in enumerate(new_cards)
            ])
            count = connection.execute(select(func.count()).select_from(cards).where(cards.c.note_id == note_id)).scalar_one()
            values = {"status": "ready", "card_count": int(count), "error": None, "updated_at": now}
            # Plain (instruction-less) cards: the note no longer holds an instructed set alone.
            connection.execute(delete(styles).where(styles.c.note_id == note_id, styles.c.owner_id == owner_id))
            if row is None:
                connection.execute(jobs.insert().values(note_id=note_id, owner_id=owner_id, attempts=1, started_at=now, **values))
            else:
                connection.execute(update(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id).values(**values))
        rows = connection.execute(select(cards).where(cards.c.owner_id == owner_id, cards.c.note_id == note_id)
                                  .order_by(cards.c.position, cards.c.created_at)).mappings().all()
    return [_card(row) for row in rows]


def list_for_unit(owner_id: str, course: str, unit: str) -> tuple[list[dict], list[dict]]:
    """All the owner's cards for a course/unit (newest note first) and a state for every note there."""
    init_flashcards()
    notes = note_store.notes
    now = _now()
    with database.engine().connect() as connection:
        note_rows = connection.execute(
            select(notes.c.id, notes.c.file_name, notes.c.created_at)
            .where(notes.c.student_id == owner_id, notes.c.course == course, notes.c.unit == unit)
            .order_by(notes.c.created_at.desc(), notes.c.id)
        ).mappings().all()
        note_ids = [row["id"] for row in note_rows]
        job_rows = {}
        card_rows = []
        if note_ids:
            job_rows = {row["note_id"]: row for row in connection.execute(
                select(jobs).where(jobs.c.owner_id == owner_id, jobs.c.note_id.in_(note_ids))
            ).mappings().all()}
            card_rows = connection.execute(
                select(cards).where(cards.c.owner_id == owner_id, cards.c.note_id.in_(note_ids))
                .order_by(cards.c.position, cards.c.created_at)
            ).mappings().all()
    order = {note_id: index for index, note_id in enumerate(note_ids)}
    ordered_cards = sorted(card_rows, key=lambda row: order[row["note_id"]])  # stable: keeps each note's card order
    states = []
    for row in note_rows:
        job = job_rows.get(row["id"])
        status, error = _effective(job, now)
        states.append({
            "note_id": row["id"], "file_name": row["file_name"], "status": status,
            "card_count": int(job["card_count"]) if job and status == "ready" else 0,
            "error": error if status == "failed" else None,
            "updated_at": _iso(job["updated_at"]) if job else None,
        })
    return [_card(row) for row in ordered_cards], states


def delete_note_and_cards(owner_id: str, note_id: str) -> bool:
    """Delete one of the owner's notes together with its cards and job, in one transaction."""
    init_flashcards()
    notes = note_store.notes
    with _guard(), database.engine().begin() as connection:
        _lock_note(connection, note_id)
        result = connection.execute(delete(notes).where(notes.c.id == note_id, notes.c.student_id == owner_id))
        if not result.rowcount:
            return False
        connection.execute(delete(cards).where(cards.c.note_id == note_id, cards.c.owner_id == owner_id))
        connection.execute(delete(jobs).where(jobs.c.note_id == note_id, jobs.c.owner_id == owner_id))
        connection.execute(delete(styles).where(styles.c.note_id == note_id, styles.c.owner_id == owner_id))
    return True


def move_notes(owner_id: str, course: str, unit: str | None, new_course: str, new_unit: str | None) -> int:
    """Rename where the owner's notes (and their cards) live: a whole course, or one unit of it.

    Notes are kept by course and unit name, so renaming a course or unit on the Study page
    has to move them too, or the renamed unit shows no notes. Returns how many notes moved.
    """
    init_flashcards()
    notes = note_store.notes
    note_filter = [notes.c.student_id == owner_id, notes.c.course == course]
    card_filter = [cards.c.owner_id == owner_id, cards.c.course == course]
    values = {"course": new_course}
    if unit is not None:
        note_filter.append(notes.c.unit == unit)
        card_filter.append(cards.c.unit == unit)
        values["unit"] = new_unit if new_unit is not None else unit
    with database.engine().begin() as connection:
        moved = connection.execute(update(notes).where(*note_filter).values(**values)).rowcount
        connection.execute(update(cards).where(*card_filter).values(**values))
    return int(moved or 0)


def reset_flashcards() -> None:
    """Test helper."""
    init_flashcards()
    with database.engine().begin() as connection:
        connection.execute(delete(cards))
        connection.execute(delete(jobs))
        connection.execute(delete(styles))
