"""Timed practice tests built from a unit's (or a whole course's) notes.

A test is written once by the AI (ai_tutor.generate_practice_test), stored here with
its answers, and served WITHOUT answers, explanations or topics until it is submitted.
Submitting grades it exactly once: the test is claimed (`in_progress` -> `grading`)
inside a transaction, so a double submit gets 409 and never spends the AI twice; if
grading fails the claim is released and the student can submit again. A claim older
than GRADING_STALE_SECONDS is treated as crashed and can be taken again.

Every function takes the authenticated owner ID and filters by it, so one student can
never read, submit or list another student's tests.
"""
from __future__ import annotations

import random
import threading
import uuid
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, MetaData, String, Table, delete, select, update

import database

practice_metadata = MetaData()

tests = Table(
    "practice_tests", practice_metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("course", String(120), nullable=False),
    Column("unit", String(160), nullable=True),  # None: the whole course
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("submitted_at", DateTime(timezone=True), nullable=True),
    Column("time_limit_s", Integer, nullable=True),  # None: untimed
    Column("question_count", Integer, nullable=False),
    Column("score", Integer, nullable=True),  # correct answers, once submitted
    Column("status", String(12), nullable=False),  # in_progress | grading | submitted
    Column("over_time", Boolean, nullable=False, default=False),
    Column("xp_awarded", Integer, nullable=False, default=0),
    Column("grading_started_at", DateTime(timezone=True), nullable=True),
    Column("grading_token", String(36), nullable=True),  # which request holds the grading claim
)
Index("ix_practice_tests_owner_course_unit", tests.c.owner_id, tests.c.course, tests.c.unit)

items = Table(
    "practice_test_items", practice_metadata,
    Column("test_id", String(36), ForeignKey("practice_tests.id", ondelete="CASCADE"), primary_key=True),
    Column("position", Integer, primary_key=True),
    Column("type", String(16), nullable=False),
    Column("prompt", String(500), nullable=False),
    Column("choices", JSON, nullable=True),
    Column("answer", String(300), nullable=False),
    Column("explanation", String(700), nullable=False),
    Column("topic", String(60), nullable=False),
    Column("student_answer", String(500), nullable=True),
    Column("correct", Boolean, nullable=True),
    Column("grading_source", String(16), nullable=True),
    Column("feedback", String(400), nullable=True),
)

PRACTICE_TABLES = ("practice_tests", "practice_test_items")
STATUSES = ("in_progress", "grading", "submitted")
GRADING_STALE_SECONDS = 120
# Submissions after the time limit plus this grace are still graded, but marked over time.
GRACE_SECONDS = 120
HISTORY_LIMIT = 20
XP_PER_CORRECT = 2
# A topic answered below this share correct is a weak spot.
WEAK_BELOW = 0.7

_sqlite_lock = threading.Lock()


class Conflict(Exception):
    """The test was already submitted (or is being graded right now)."""


@lru_cache(maxsize=1)
def init_practice() -> None:
    database.init_db()
    # Served only through the API: RLS on, no policy and no client grants (one transaction).
    database.create_locked_tables(database.engine(), practice_metadata, PRACTICE_TABLES, PRACTICE_TABLES)


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
    return _sqlite_lock if database.engine().dialect.name == "sqlite" else nullcontext()


def _deadline(row) -> datetime | None:
    limit = row["time_limit_s"]
    return _utc(row["started_at"]) + timedelta(seconds=int(limit)) if limit else None


def topic_breakdown(rows) -> list[dict]:
    """[{topic, correct, total, weak}] in the order topics first appear (case-insensitive)."""
    groups: dict[str, dict] = {}
    for row in rows:
        key = " ".join(str(row["topic"]).casefold().split())
        group = groups.setdefault(key, {"topic": row["topic"], "correct": 0, "total": 0})
        group["total"] += 1
        group["correct"] += int(bool(row["correct"]))
    return [{**group, "weak": group["correct"] / group["total"] < WEAK_BELOW} for group in groups.values()]


def _public(test, item_rows, now: datetime | None = None) -> dict:
    """The test as the student may see it: no answers, explanations or topics before submission."""
    submitted = test["status"] == "submitted"
    deadline = _deadline(test)
    result = {
        "id": test["id"], "course": test["course"], "unit": test["unit"], "status": "submitted" if submitted else "in_progress",
        "created_at": _iso(test["created_at"]), "started_at": _iso(test["started_at"]), "submitted_at": _iso(test["submitted_at"]),
        "time_limit_s": test["time_limit_s"], "deadline": _iso(deadline), "server_now": _iso(now or _now()),
        "question_count": test["question_count"], "score": test["score"] if submitted else None,
        "over_time": bool(test["over_time"]) if submitted else False,
        "xp_earned": int(test["xp_awarded"] or 0) if submitted else 0,
    }
    public_items = []
    for row in item_rows:
        item = {"position": row["position"], "type": row["type"], "prompt": row["prompt"],
                "choices": list(row["choices"] or []) if row["type"] == "multiple_choice" else []}
        if submitted:
            item.update({"answer": row["answer"], "explanation": row["explanation"], "topic": row["topic"],
                         "student_answer": row["student_answer"] or "", "correct": bool(row["correct"]),
                         "grading_source": row["grading_source"], "feedback": row["feedback"] or ""})
        public_items.append(item)
    result["items"] = public_items
    if submitted:
        submitted_at, started_at = _utc(test["submitted_at"]), _utc(test["started_at"])
        result["time_used_s"] = max(0, int((submitted_at - started_at).total_seconds())) if submitted_at and started_at else None
        result["topics"] = topic_breakdown(item_rows)
    return result


def _summary(row) -> dict:
    submitted = row["status"] == "submitted"
    return {
        "id": row["id"], "course": row["course"], "unit": row["unit"], "status": "submitted" if submitted else "in_progress",
        "created_at": _iso(row["created_at"]), "submitted_at": _iso(row["submitted_at"]), "question_count": row["question_count"],
        "score": row["score"] if submitted else None, "time_limit_s": row["time_limit_s"], "deadline": _iso(_deadline(row)),
        "over_time": bool(row["over_time"]) if submitted else False,
    }


def shuffled_choices(questions: list[dict], rng: random.Random | None = None) -> list[dict]:
    """Each multiple-choice question with its choices in a fresh order (models favour the first slot)."""
    rng = rng or random.SystemRandom()
    result = []
    for question in questions:
        question = dict(question)
        if question["type"] == "multiple_choice":
            choices = list(question["choices"])
            rng.shuffle(choices)
            question["choices"] = choices
        result.append(question)
    return result


def create_test(owner_id: str, course: str, unit: str | None, time_limit_s: int | None, questions: list[dict]) -> dict:
    init_practice()
    now = _now()
    test_id = str(uuid.uuid4())
    row = {"id": test_id, "owner_id": owner_id, "course": course, "unit": unit, "created_at": now, "started_at": now,
           "submitted_at": None, "time_limit_s": time_limit_s, "question_count": len(questions), "score": None,
           "status": "in_progress", "over_time": False, "xp_awarded": 0, "grading_started_at": None, "grading_token": None}
    item_rows = [{"test_id": test_id, "position": position, "type": question["type"], "prompt": question["prompt"],
                  "choices": list(question["choices"]) if question["type"] == "multiple_choice" else None,
                  "answer": question["answer"], "explanation": question["explanation"], "topic": question["topic"],
                  "student_answer": None, "correct": None, "grading_source": None, "feedback": None}
                 for position, question in enumerate(questions)]
    with database.engine().begin() as connection:
        connection.execute(tests.insert().values(**row))
        connection.execute(items.insert(), item_rows)
    return _public(row, item_rows, now)


def _load(connection, owner_id: str, test_id: str):
    test = connection.execute(select(tests).where(tests.c.id == test_id, tests.c.owner_id == owner_id)).mappings().first()
    if test is None:
        return None, []
    item_rows = connection.execute(select(items).where(items.c.test_id == test_id).order_by(items.c.position)).mappings().all()
    return test, item_rows


def get_test(owner_id: str, test_id: str) -> dict | None:
    init_practice()
    with database.engine().connect() as connection:
        test, item_rows = _load(connection, owner_id, test_id)
    return _public(test, item_rows) if test is not None else None


def graded_items(owner_id: str, test_id: str) -> tuple[dict, list[dict]] | None:
    """(test row, item rows WITH answers) for grading on the server. Never sent to a client."""
    init_practice()
    with database.engine().connect() as connection:
        test, item_rows = _load(connection, owner_id, test_id)
    if test is None:
        return None
    return dict(test), [dict(row) for row in item_rows]


def claim_grading(owner_id: str, test_id: str) -> str:
    """Move the test from in_progress to grading. Returns the claim token; raises Conflict when
    it was already submitted or another request is grading it, LookupError when it isn't the owner's."""
    init_practice()
    now = _now()
    with _guard(), database.engine().begin() as connection:
        database._advisory_lock(connection, f"practice:{test_id}")
        query = select(tests.c.status, tests.c.grading_started_at).where(tests.c.id == test_id, tests.c.owner_id == owner_id)
        if connection.dialect.name == "postgresql":
            query = query.with_for_update()
        row = connection.execute(query).mappings().first()
        if row is None:
            raise LookupError("test_not_found")
        if row["status"] == "submitted":
            raise Conflict("already_submitted")
        started = _utc(row["grading_started_at"])
        if row["status"] == "grading" and started is not None and now - started < timedelta(seconds=GRADING_STALE_SECONDS):
            raise Conflict("grading")
        token = str(uuid.uuid4())
        connection.execute(update(tests).where(tests.c.id == test_id, tests.c.owner_id == owner_id)
                           .values(status="grading", grading_started_at=now, grading_token=token))
    return token


def release_grading(owner_id: str, test_id: str, token: str) -> None:
    """Grading failed: let the student submit again (only if this request still holds the claim)."""
    init_practice()
    with _guard(), database.engine().begin() as connection:
        connection.execute(update(tests).where(
            tests.c.id == test_id, tests.c.owner_id == owner_id, tests.c.status == "grading", tests.c.grading_token == token,
        ).values(status="in_progress", grading_started_at=None, grading_token=None))


def finish(owner_id: str, test_id: str, token: str, results: dict[int, dict], *, submitted_at: datetime,
           over_time: bool, xp: int) -> dict:
    """Store the graded answers and mark the test submitted (only with this request's claim).
    results: {position: {student_answer, correct, grading_source, feedback}}. Raises Conflict
    when the claim was lost (it went stale and another request took it)."""
    init_practice()
    score = sum(1 for result in results.values() if result["correct"])
    with _guard(), database.engine().begin() as connection:
        claimed = connection.execute(update(tests).where(
            tests.c.id == test_id, tests.c.owner_id == owner_id, tests.c.status == "grading", tests.c.grading_token == token,
        ).values(status="submitted", submitted_at=submitted_at, score=score, over_time=over_time, xp_awarded=xp,
                 grading_token=None)).rowcount
        if not claimed:
            raise Conflict("grading")
        for position, result in results.items():
            connection.execute(update(items).where(items.c.test_id == test_id, items.c.position == position).values(
                student_answer=result["student_answer"], correct=result["correct"],
                grading_source=result["grading_source"], feedback=result.get("feedback") or None,
            ))
        test, item_rows = _load(connection, owner_id, test_id)
    return _public(test, item_rows)


def set_xp_awarded(owner_id: str, test_id: str, xp: int) -> None:
    """Record the XP actually added (the daily cap can lower it)."""
    with database.engine().begin() as connection:
        connection.execute(update(tests).where(tests.c.id == test_id, tests.c.owner_id == owner_id).values(xp_awarded=xp))


def list_tests(owner_id: str, course: str, unit: str | None = None, limit: int = HISTORY_LIMIT) -> list[dict]:
    """The owner's newest tests in a course: one unit's (unit given) or every one in the course."""
    init_practice()
    query = select(tests).where(tests.c.owner_id == owner_id, tests.c.course == course)
    if unit is not None:
        query = query.where(tests.c.unit == unit)
    with database.engine().connect() as connection:
        rows = connection.execute(query.order_by(tests.c.created_at.desc()).limit(max(1, min(limit, HISTORY_LIMIT)))).mappings().all()
    return [_summary(row) for row in rows]


def move_scope(owner_id: str, course: str, unit: str | None, new_course: str, new_unit: str | None) -> int:
    """Follow a course or unit rename on the Study page, like the notes do."""
    init_practice()
    test_filter = [tests.c.owner_id == owner_id, tests.c.course == course]
    values: dict = {"course": new_course}
    if unit is not None:
        test_filter.append(tests.c.unit == unit)
        values["unit"] = new_unit if new_unit is not None else unit
    with database.engine().begin() as connection:
        return int(connection.execute(update(tests).where(*test_filter).values(**values)).rowcount or 0)


def delete_for_owner(connection, owner_id: str) -> int:
    """Inside the caller's transaction (account deletion): every test of the owner and its items."""
    owned = select(tests.c.id).where(tests.c.owner_id == owner_id)
    connection.execute(delete(items).where(items.c.test_id.in_(owned)))
    return connection.execute(delete(tests).where(tests.c.owner_id == owner_id)).rowcount or 0


def reset_practice() -> None:
    """Test helper."""
    init_practice()
    with database.engine().begin() as connection:
        connection.execute(delete(items))
        connection.execute(delete(tests))
