from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from uuid import uuid4

from sqlalchemy import Column, DateTime, Integer, MetaData, String, Table, delete, select, update

import database

metadata = MetaData()

generated_questions = Table(
    "generated_questions",
    metadata,
    Column("question_id", String(64), primary_key=True),
    Column("student_id", String(100), nullable=False, index=True),
    Column("question", String(500), nullable=False),
    Column("correct_answer", String(200), nullable=False),
    Column("topic", String(50), nullable=False),
    Column("difficulty", Integer, nullable=False),
    Column("completed", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

question_bank = Table(
    "question_bank",
    metadata,
    Column("bank_id", String(64), primary_key=True),
    Column("cache_key", String(64), nullable=False, index=True),
    Column("question", String(500), nullable=False),
    Column("correct_answer", String(200), nullable=False),
    Column("topic", String(50), nullable=False),
    Column("difficulty", Integer, nullable=False),
    Column("use_count", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
)


QUESTION_TABLES = ("generated_questions", "question_bank")
# Column sizes. AI output and unit names can run longer, and Postgres rejects oversize values.
MAX_QUESTION_CHARS = 500
MAX_ANSWER_CHARS = 200
MAX_TOPIC_CHARS = 50


def clip_question(question: str, correct_answer: str, topic: str) -> tuple[str, str, str]:
    return question[:MAX_QUESTION_CHARS], correct_answer[:MAX_ANSWER_CHARS], topic[:MAX_TOPIC_CHARS]


def init_questions() -> None:
    _init_question_tables(database.engine())


@lru_cache(maxsize=4)
def _init_question_tables(active_engine) -> None:
    """Create the question tables once per engine and keep them closed to Supabase clients
    (created and locked in one transaction, see database.create_locked_tables)."""
    database.create_locked_tables(active_engine, metadata, QUESTION_TABLES, QUESTION_TABLES)


def save_question(student_id: str, question: str, correct_answer: str, topic: str, difficulty: int) -> str:
    init_questions()
    question, correct_answer, topic = clip_question(question, correct_answer, topic)
    question_id = uuid4().hex
    with database.engine().begin() as connection:
        connection.execute(delete(generated_questions).where(
            generated_questions.c.created_at < datetime.now(timezone.utc) - timedelta(days=7)
        ))
        older_ids = connection.execute(select(generated_questions.c.question_id).where(
            generated_questions.c.student_id == student_id
        ).order_by(generated_questions.c.created_at.desc()).offset(49)).scalars().all()
        if older_ids:
            connection.execute(delete(generated_questions).where(generated_questions.c.question_id.in_(older_ids)))
        connection.execute(generated_questions.insert().values(
            question_id=question_id,
            student_id=student_id,
            question=question,
            correct_answer=correct_answer,
            topic=topic,
            difficulty=difficulty,
            completed=0,
            created_at=datetime.now(timezone.utc),
        ))
    return question_id


# A student is never served one of their last RECENT_WINDOW questions again, and the
# model is shown the same number of them (AVOID_IN_PROMPT) so it knows every question
# that would be rejected as a repeat.
RECENT_WINDOW = 20
AVOID_IN_PROMPT = RECENT_WINDOW
BANK_CANDIDATES = 60


def question_fingerprint(text: str) -> str:
    """Case-, spacing- and punctuation-insensitive form of a question, for spotting repeats.

    Word characters in any script count (NFKC + casefold + \\w), so questions in Chinese,
    Cyrillic or Greek keep their own fingerprints. A question with no word characters at
    all fingerprints to "", which never matches anything (see same_question).
    """
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", text or "").casefold()))


def same_question(fingerprint: str, seen: set[str]) -> bool:
    """True when a non-empty fingerprint is in seen. An empty one is never a repeat."""
    return bool(fingerprint) and fingerprint in seen


def fingerprints(texts) -> set[str]:
    return {fingerprint for fingerprint in (question_fingerprint(text) for text in texts) if fingerprint}


def recent_questions(student_id: str, limit: int = RECENT_WINDOW) -> list[str]:
    """The questions most recently served to this student, newest first."""
    init_questions()
    with database.engine().connect() as connection:
        return list(connection.execute(
            select(generated_questions.c.question)
            .where(generated_questions.c.student_id == student_id)
            .order_by(generated_questions.c.created_at.desc())
            .limit(limit)
        ).scalars().all())


def _bank_rows(connection, cache_key: str) -> list[dict]:
    return [dict(row) for row in connection.execute(
        select(question_bank).where(
            question_bank.c.cache_key == cache_key,
            question_bank.c.created_at >= datetime.now(timezone.utc) - timedelta(days=30),
        ).order_by(question_bank.c.use_count.asc(), question_bank.c.created_at.desc()).limit(BANK_CANDIDATES)
    ).mappings().all()]


def banked_among(cache_key: str, texts: list[str]) -> list[str]:
    """For each text (in order) that is already in this key's bank, the BANKED wording of it.

    Only these may be shown to the model as questions to avoid, so a shared prompt never
    carries anything unshared: the text returned is always the bank row's own question,
    never the student's (possibly private) text that merely fingerprints the same.
    """
    init_questions()
    with database.engine().connect() as connection:
        banked: dict[str, str] = {}
        for row in _bank_rows(connection, cache_key):
            fingerprint = question_fingerprint(row["question"])
            if fingerprint:
                banked.setdefault(fingerprint, row["question"])
    result: list[str] = []
    for text in texts:
        bank_text = banked.get(question_fingerprint(text))
        if bank_text is not None and bank_text not in result:
            result.append(bank_text)
    return result


def cached_question(cache_key: str, student_id: str, recent: list[str] | None = None) -> dict | None:
    """Return the least-used matching question that is not one of this student's recent ones.

    Repeats are matched on question_fingerprint, so a reworded copy (different case,
    spacing or punctuation) of a question the student just saw is never served again.
    """
    init_questions()
    if recent is None:
        recent = recent_questions(student_id)
    seen = fingerprints(recent)
    with database.engine().begin() as connection:
        row = next((candidate for candidate in _bank_rows(connection, cache_key)
                    if not same_question(question_fingerprint(candidate["question"]), seen)), None)
        if row is not None:
            connection.execute(
                update(question_bank)
                .where(question_bank.c.bank_id == row["bank_id"])
                .values(use_count=question_bank.c.use_count + 1)
            )
    return row


def fallback_question(cache_key: str, recent: list[str], extra: list[dict] | None = None) -> tuple[dict, bool] | None:
    """A question to serve when the model only repeats ones the student has just seen.

    Candidates are this key's banked questions plus `extra` (the model's repeats). One the
    student has not been served recently wins (repeat=False); otherwise the one served
    longest ago (repeat=True). The question served last is never chosen, so Skip never
    shows the same question twice in a row. Returns (question, repeat) or None.
    """
    init_questions()
    served_at: dict[str, int] = {}  # fingerprint -> position in recent (0 = newest)
    for position, text in enumerate(recent):
        served_at.setdefault(question_fingerprint(text), position)
    served_at.pop("", None)
    with database.engine().begin() as connection:
        candidates = [{**row, "_bank": True} for row in _bank_rows(connection, cache_key)]
        candidates += [{**item, "_bank": False} for item in (extra or [])]
        best = None
        best_rank = -1
        for candidate in candidates:
            fingerprint = question_fingerprint(candidate["question"])
            if not fingerprint:
                continue
            position = served_at.get(fingerprint)
            if position is None:
                best, best_rank = candidate, len(recent) + 1
                break
            if position > 0 and position > best_rank:
                best, best_rank = candidate, position
        if best is None:
            return None
        if best["_bank"]:
            connection.execute(
                update(question_bank)
                .where(question_bank.c.bank_id == best["bank_id"])
                .values(use_count=question_bank.c.use_count + 1)
            )
    question = {key: best[key] for key in ("question", "correct_answer", "topic")}
    return question, best_rank <= len(recent)


def save_to_bank(cache_key: str, question: str, correct_answer: str, topic: str, difficulty: int) -> None:
    init_questions()
    question, correct_answer, topic = clip_question(question, correct_answer, topic)
    with database.engine().begin() as connection:
        fingerprint = question_fingerprint(question)
        if fingerprint and any(question_fingerprint(row["question"]) == fingerprint for row in _bank_rows(connection, cache_key)):
            return  # already banked: a second copy would only crowd out other questions
        connection.execute(question_bank.insert().values(
            bank_id=uuid4().hex,
            cache_key=cache_key,
            question=question,
            correct_answer=correct_answer,
            topic=topic,
            difficulty=difficulty,
            use_count=1,
            created_at=datetime.now(timezone.utc),
        ))


def get_question(student_id: str, question_id: str) -> dict | None:
    init_questions()
    with database.engine().connect() as connection:
        row = connection.execute(
            select(generated_questions).where(
                generated_questions.c.question_id == question_id,
                generated_questions.c.student_id == student_id,
            )
        ).mappings().first()
    return dict(row) if row is not None else None


# Values of generated_questions.completed. MISSED is still open, but the
# student has already answered it wrong at least once.
OPEN = 0
COMPLETED = 1
MISSED = -1


def mark_missed(student_id: str, question_id: str) -> None:
    init_questions()
    with database.engine().begin() as connection:
        connection.execute(
            update(generated_questions)
            .where(
                generated_questions.c.question_id == question_id,
                generated_questions.c.student_id == student_id,
                generated_questions.c.completed == OPEN,
            )
            .values(completed=MISSED)
        )


def complete_question(student_id: str, question_id: str) -> int | None:
    """Close the question. Returns the state it was in (OPEN or MISSED), or None if it was already completed."""
    init_questions()
    with database.engine().begin() as connection:
        # One conditional update per prior state, so concurrent answers can't both complete it.
        for prior in (OPEN, MISSED):
            result = connection.execute(
                update(generated_questions)
                .where(
                    generated_questions.c.question_id == question_id,
                    generated_questions.c.student_id == student_id,
                    generated_questions.c.completed == prior,
                )
                .values(completed=COMPLETED)
            )
            if result.rowcount == 1:
                return prior
    return None


def reset_questions() -> None:
    init_questions()
    if database.engine().dialect.name != "sqlite":
        raise RuntimeError("reset_questions is only available for local SQLite databases")
    with database.engine().begin() as connection:
        connection.execute(delete(generated_questions))
        connection.execute(delete(question_bank))
