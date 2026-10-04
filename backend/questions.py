from __future__ import annotations

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
    """Create the question tables once per engine and keep them closed to Supabase clients."""
    metadata.create_all(active_engine)
    if active_engine.dialect.name == "postgresql":
        with active_engine.begin() as connection:
            database.enable_row_level_security(connection, QUESTION_TABLES)
            database.revoke_client_access(connection, QUESTION_TABLES)


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


def cached_question(cache_key: str, student_id: str) -> dict | None:
    """Return the least-used matching question not recently shown to this student."""
    init_questions()
    recent = select(generated_questions.c.question).where(
        generated_questions.c.student_id == student_id
    ).order_by(generated_questions.c.created_at.desc()).limit(20)
    with database.engine().begin() as connection:
        row = connection.execute(
            select(question_bank).where(
                question_bank.c.cache_key == cache_key,
                question_bank.c.question.not_in(recent),
                question_bank.c.created_at >= datetime.now(timezone.utc) - timedelta(days=30),
            ).order_by(question_bank.c.use_count.asc(), question_bank.c.created_at.desc()).limit(1)
        ).mappings().first()
        if row is not None:
            connection.execute(
                update(question_bank)
                .where(question_bank.c.bank_id == row["bank_id"])
                .values(use_count=question_bank.c.use_count + 1)
            )
    return dict(row) if row is not None else None


def save_to_bank(cache_key: str, question: str, correct_answer: str, topic: str, difficulty: int) -> None:
    init_questions()
    question, correct_answer, topic = clip_question(question, correct_answer, topic)
    with database.engine().begin() as connection:
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


def complete_question(student_id: str, question_id: str) -> bool:
    init_questions()
    with database.engine().begin() as connection:
        result = connection.execute(
            update(generated_questions)
            .where(
                generated_questions.c.question_id == question_id,
                generated_questions.c.student_id == student_id,
                generated_questions.c.completed == 0,
            )
            .values(completed=1)
        )
    return result.rowcount == 1


def reset_questions() -> None:
    init_questions()
    if database.engine().dialect.name != "sqlite":
        raise RuntimeError("reset_questions is only available for local SQLite databases")
    with database.engine().begin() as connection:
        connection.execute(delete(generated_questions))
        connection.execute(delete(question_bank))
