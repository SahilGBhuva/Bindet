"""Spaced-repetition review of a student's saved flashcards (SM-2 style).

State lives in `flashcard_reviews` (flashcards.reviews), one row per (owner, card).
A card with no row is *new*. A card whose interval is under a day is *learning*
(it was just failed, or rated Hard on its first sight) and is due at an exact time;
a card with an interval of a day or more is in *review* and is due on a local day:
its due_at is the student's local midnight, so "due today" matches their day.

Grades:
  again  relearn: due in 10 minutes, ease -0.2, reps reset (a lapse if it had graduated)
  hard   first sight: 12 hours; otherwise max(interval x 1.2, interval + 1 day); ease -0.15
  good   1 day, then 3 days, then interval x ease
  easy   first sight: 4 days; otherwise interval x ease x 1.3 (and above Good); ease +0.15
Ease never drops below 1.3. Intervals of 3 days or more get a deterministic +/-5%
fuzz (seeded by card id and rep count) so cards learned together spread out, are
rounded to whole days and capped at 365.

Each student meets at most NEW_PER_DAY new cards per local day; due cards are
never capped. Nothing here calls the AI. Every function takes the authenticated
owner id and filters by it.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, select, update

import database
import flashcards
import note_store

GRADES = ("again", "hard", "good", "easy")
DEFAULT_EASE = 2.5
MIN_EASE = 1.3
MAX_INTERVAL_DAYS = 365
RELEARN_DAYS = 10 / 1440          # 10 minutes
HARD_FIRST_DAYS = 0.5             # 12 hours
FUZZ_MIN_DAYS = 3
FUZZ = 0.05
NEW_PER_DAY = 20
DEDUPE_SECONDS = 2
MAX_TZ_OFFSET = 840


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: datetime | None) -> str | None:
    value = _utc(value)
    return value.isoformat() if value else None


def clamp_offset(tz_offset: int | None) -> int:
    """Minutes, as JavaScript's Date.getTimezoneOffset() gives them (UTC minus local)."""
    return max(-MAX_TZ_OFFSET, min(MAX_TZ_OFFSET, int(tz_offset or 0)))


def day_bounds(now: datetime, tz_offset: int = 0) -> tuple[datetime, datetime]:
    """(start of the student's local today, start of local tomorrow), both in UTC."""
    offset = timedelta(minutes=clamp_offset(tz_offset))
    local_day = (now - offset).date()
    start = datetime(local_day.year, local_day.month, local_day.day, tzinfo=timezone.utc) + offset
    return start, start + timedelta(days=1)


def _fuzz(card_id: str, reps: int) -> float:
    digest = hashlib.sha256(f"{card_id}:{reps}".encode()).digest()
    unit = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF  # 0..1
    return 1 + (unit * 2 - 1) * FUZZ


def _state_name(interval_days: float | None) -> str:
    if interval_days is None:
        return "new"
    return "learning" if interval_days < 1 else "review"


def next_values(state: dict | None, grade: str, card_id: str) -> dict:
    """The new {interval_days, ease, reps, lapses} after grading a card in `state` (None: new)."""
    if grade not in GRADES:
        raise ValueError("invalid_grade")
    interval = float(state["interval_days"]) if state else 0.0
    ease = float(state["ease"]) if state else DEFAULT_EASE
    reps = int(state["reps"]) if state else 0
    lapses = int(state["lapses"]) if state else 0

    if grade == "again":
        return {"interval_days": RELEARN_DAYS, "ease": max(MIN_EASE, round(ease - 0.2, 4)), "reps": 0,
                "lapses": lapses + (1 if interval >= 1 else 0)}

    if reps == 0:
        hard, good, easy = HARD_FIRST_DAYS, 1.0, 4.0
    else:
        hard = max(interval * 1.2, interval + 1)
        good = max(3.0 if reps == 1 else interval * ease, hard + 1)
        easy = max(interval * ease * 1.3, good + 1)
    chosen = {"hard": hard, "good": good, "easy": easy}[grade]
    if chosen >= 1:
        if chosen >= FUZZ_MIN_DAYS:
            chosen *= _fuzz(card_id, reps)
        chosen = float(min(MAX_INTERVAL_DAYS, max(1, round(chosen))))
    new_ease = {"hard": ease - 0.15, "good": ease, "easy": ease + 0.15}[grade]
    # Hard on a first sight keeps the card learning; any other pass counts a successful rep.
    new_reps = reps if (grade == "hard" and reps == 0) else reps + 1
    return {"interval_days": chosen, "ease": max(MIN_EASE, round(new_ease, 4)), "reps": new_reps, "lapses": lapses}


def due_at_for(interval_days: float, now: datetime, tz_offset: int = 0) -> datetime:
    """Learning steps are due at an exact time; review intervals at the student's local midnight."""
    if interval_days < 1:
        return now + timedelta(days=interval_days)
    today, _ = day_bounds(now, tz_offset)
    return today + timedelta(days=int(round(interval_days)))


def preview(state: dict | None, card_id: str) -> dict:
    """Interval in days each grade would give, for the grade buttons."""
    return {grade: next_values(state, grade, card_id)["interval_days"] for grade in GRADES}


def is_due(row: dict, now: datetime, tomorrow: datetime) -> bool:
    due = _utc(row["due_at"])
    return due <= now if float(row["interval_days"]) < 1 else due < tomorrow


def _review_public(row: dict | None, card_id: str) -> dict:
    if row is None:
        return {"state": "new", "due_at": None, "interval_days": 0.0, "preview": preview(None, card_id)}
    return {
        "state": _state_name(float(row["interval_days"])), "due_at": _iso(row["due_at"]),
        "interval_days": float(row["interval_days"]), "preview": preview(row, card_id),
    }


# --- Reading -----------------------------------------------------------------------

def _rows(connection, owner_id: str, course: str | None, unit: str | None) -> list[dict]:
    """The owner's cards (only those whose note still exists) with their review state."""
    c, n, r = flashcards.cards, note_store.notes, flashcards.reviews
    query = (
        select(
            c.c.id, c.c.note_id, c.c.course, c.c.unit, c.c.front, c.c.back, c.c.topic, c.c.created_at,
            c.c.front_key, c.c.position, n.c.created_at.label("note_created_at"),
            r.c.due_at, r.c.interval_days, r.c.ease, r.c.reps, r.c.lapses, r.c.card_id.label("reviewed"),
        )
        .select_from(c.join(n, and_(n.c.id == c.c.note_id, n.c.student_id == owner_id))
                     .outerjoin(r, and_(r.c.card_id == c.c.id, r.c.owner_id == owner_id)))
        .where(c.c.owner_id == owner_id)
    )
    if course is not None:
        query = query.where(c.c.course == course)
    if unit is not None:
        query = query.where(c.c.unit == unit)
    return [dict(row) for row in connection.execute(query).mappings().all()]


def _introduced_today(connection, owner_id: str, today: datetime) -> int:
    r = flashcards.reviews
    return int(connection.execute(select(func.count()).select_from(r).where(
        r.c.owner_id == owner_id, r.c.created_at >= today)).scalar_one())


def _classify(rows: list[dict], now: datetime, tomorrow: datetime) -> dict:
    """Split cards into due learning, due reviews, new and later, one card per question per unit
    (the same notes saved twice make the same cards; reviewed copies win over unseen ones)."""
    def note_order(row):
        return (_utc(row["note_created_at"]) or now, row["note_id"], row["position"], _utc(row["created_at"]) or now)

    learning = sorted((row for row in rows if row["reviewed"] and float(row["interval_days"]) < 1 and is_due(row, now, tomorrow)),
                      key=lambda row: (_utc(row["due_at"]), row["id"]))
    reviews = sorted((row for row in rows if row["reviewed"] and float(row["interval_days"]) >= 1 and is_due(row, now, tomorrow)),
                     key=lambda row: (_utc(row["due_at"]), row["id"]))
    later = [row for row in rows if row["reviewed"] and not is_due(row, now, tomorrow)]
    new = sorted((row for row in rows if not row["reviewed"]), key=lambda row: (row["course"], row["unit"], *note_order(row)))
    seen: set[tuple[str, str, str]] = set()

    def keep(group):
        kept = []
        for row in group:
            key = (row["course"], row["unit"], row["front_key"])
            if key in seen:
                continue
            seen.add(key)
            kept.append(row)
        return kept

    learning, reviews, later = keep(learning), keep(reviews), keep(later)
    return {"learning": learning, "reviews": reviews, "new": keep(new), "later": later}


def _card_out(row: dict) -> dict:
    card = {
        "id": row["id"], "note_id": row["note_id"], "course": row["course"], "unit": row["unit"],
        "front": row["front"], "back": row["back"], "topic": row["topic"], "created_at": _iso(row["created_at"]),
    }
    card["review"] = _review_public(row if row["reviewed"] else None, row["id"])
    return card


def summary(owner_id: str, tz_offset: int = 0, now: datetime | None = None) -> dict:
    flashcards.init_flashcards()
    now = now or _now()
    today, tomorrow = day_bounds(now, tz_offset)
    with database.engine().connect() as connection:
        rows = _rows(connection, owner_id, None, None)
        allowance = max(0, NEW_PER_DAY - _introduced_today(connection, owner_id, today))
    groups = _classify(rows, now, tomorrow)
    units: dict[tuple[str, str], dict] = {}
    for row in groups["learning"] + groups["reviews"]:
        units.setdefault((row["course"], row["unit"]), {"due": 0, "new": 0})["due"] += 1
    for row in groups["new"]:
        units.setdefault((row["course"], row["unit"]), {"due": 0, "new": 0})["new"] += 1
    later = [_utc(row["due_at"]) for row in groups["later"]]
    return {
        "due": len(groups["learning"]) + len(groups["reviews"]),
        "new_available": min(allowance, len(groups["new"])),
        "next_due_at": _iso(min(later)) if later else None,
        "by_unit": [
            {"course": course, "unit": unit, "due": counts["due"], "new": min(allowance, counts["new"])}
            for (course, unit), counts in sorted(units.items())
        ],
    }


def queue(owner_id: str, course: str | None = None, unit: str | None = None, limit: int = 20,
          tz_offset: int = 0, now: datetime | None = None) -> dict:
    """Due learning cards, then due reviews (oldest first), then new cards (note order),
    up to `limit`, with no more new cards than today's allowance has left."""
    flashcards.init_flashcards()
    now = now or _now()
    today, tomorrow = day_bounds(now, tz_offset)
    with database.engine().connect() as connection:
        rows = _rows(connection, owner_id, course, unit)
        allowance = max(0, NEW_PER_DAY - _introduced_today(connection, owner_id, today))
    groups = _classify(rows, now, tomorrow)
    picked = (groups["learning"] + groups["reviews"])[:limit]
    picked += groups["new"][:max(0, min(allowance, limit - len(picked)))]
    return {"cards": [_card_out(row) for row in picked]}


# --- Grading -----------------------------------------------------------------------

def grade(owner_id: str, card_id: str, grade_name: str, tz_offset: int = 0, now: datetime | None = None) -> dict | None:
    """Record one grade. Returns the card's new state, or None when the owner has no such card.
    A second grade for the same card within DEDUPE_SECONDS (a double tap) changes nothing and
    returns the stored state with duplicate=True."""
    if grade_name not in GRADES:
        raise ValueError("invalid_grade")
    flashcards.init_flashcards()
    now = now or _now()
    c, r = flashcards.cards, flashcards.reviews
    with flashcards._guard(), database.engine().begin() as connection:
        database._advisory_lock(connection, f"review:{owner_id}:{card_id}")
        owned = connection.execute(select(c.c.id).where(c.c.id == card_id, c.c.owner_id == owner_id)).first()
        if owned is None:
            return None
        query = select(r).where(r.c.owner_id == owner_id, r.c.card_id == card_id)
        if connection.dialect.name == "postgresql":
            query = query.with_for_update()
        row = connection.execute(query).mappings().first()
        last = _utc(row["last_reviewed_at"]) if row else None
        if row is not None and last is not None and timedelta(0) <= now - last <= timedelta(seconds=DEDUPE_SECONDS):
            return _graded(card_id, dict(row), duplicate=True)
        values = next_values(dict(row) if row else None, grade_name, card_id)
        values.update(due_at=due_at_for(values["interval_days"], now, tz_offset), last_grade=grade_name, last_reviewed_at=now)
        if row is None:
            connection.execute(r.insert().values(owner_id=owner_id, card_id=card_id, created_at=now, **values))
        else:
            connection.execute(update(r).where(r.c.owner_id == owner_id, r.c.card_id == card_id).values(**values))
    return _graded(card_id, values, duplicate=False)


def _graded(card_id: str, values: dict, *, duplicate: bool) -> dict:
    interval = float(values["interval_days"])
    return {
        "card_id": card_id,
        "review": {
            "state": _state_name(interval), "due_at": _iso(values["due_at"]), "interval_days": interval,
            "ease": float(values["ease"]), "reps": int(values["reps"]), "lapses": int(values["lapses"]),
            "last_grade": values["last_grade"], "last_reviewed_at": _iso(values["last_reviewed_at"]),
        },
        "next_due_at": _iso(values["due_at"]),
        "duplicate": duplicate,
    }
