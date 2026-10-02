from __future__ import annotations

import os
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Integer, MetaData, String, Table, Text,
    UniqueConstraint, and_, create_engine, delete, func, inspect, or_, select, update,
)
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import ArgumentError


load_dotenv(Path(__file__).with_name(".env"))

DEFAULT_DB_PATH = Path(__file__).with_name("pocket_tutor.db")
metadata = MetaData()

student_progress = Table(
    "student_progress", metadata,
    Column("student_id", String(100), primary_key=True),
    Column("total_xp", Integer, nullable=False, default=0),
    Column("attempts", Integer, nullable=False, default=0),
    Column("correct_answers", Integer, nullable=False, default=0),
    Column("streak", Integer, nullable=False, default=0),
    Column("best_streak", Integer, nullable=False, default=0),
    Column("last_active_date", Date),
    Column("login_streak", Integer, nullable=False, default=0),
    Column("best_login_streak", Integer, nullable=False, default=0),
    Column("last_login_date", Date),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

topic_progress = Table(
    "topic_progress", metadata,
    Column("student_id", String(100), ForeignKey("student_progress.student_id", ondelete="CASCADE"), primary_key=True),
    Column("topic", String(50), primary_key=True),
    Column("attempts", Integer, nullable=False, default=0),
    Column("correct_answers", Integer, nullable=False, default=0),
)

profiles = Table(
    "profiles", metadata,
    Column("student_id", String(100), ForeignKey("student_progress.student_id", ondelete="CASCADE"), primary_key=True),
    Column("username", String(24), nullable=False, unique=True),
    Column("display_name", String(40), nullable=False),
    Column("avatar_path", String(500), nullable=False, default=""),
    Column("friend_code", String(12), nullable=False, unique=True),
    Column("daily_goal", Integer, nullable=False, default=20),
    Column("discoverable", Boolean, nullable=False, default=True),
    Column("allow_friend_requests", Boolean, nullable=False, default=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

friendships = Table(
    "friendships", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("requester_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("recipient_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("status", String(10), nullable=False, default="pending"),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("requester_id", "recipient_id", name="uq_friend_request_direction"),
)

friend_quests = Table(
    "friend_quests", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("creator_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("partner_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("target_xp", Integer, nullable=False, default=100),
    Column("starting_xp", Integer, nullable=False, default=0),
    Column("status", String(12), nullable=False, default="active"),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
)

study_groups = Table(
    "study_groups", metadata,
    Column("id", String(32), primary_key=True),
    Column("name", String(48), nullable=False),
    Column("description", String(160), nullable=False, default=""),
    Column("owner_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("invite_code", String(10), nullable=False, unique=True),
    Column("weekly_goal_xp", Integer, nullable=False, default=500),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

study_group_members = Table(
    "study_group_members", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("group_id", String(32), ForeignKey("study_groups.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("student_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False, index=True),
    Column("role", String(12), nullable=False, default="member"),
    Column("joined_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("group_id", "student_id", name="uq_study_group_member"),
)

xp_events = Table(
    "xp_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("student_id", String(100), ForeignKey("student_progress.student_id", ondelete="CASCADE"), nullable=False, index=True),
    Column("xp", Integer, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
)

social_reactions = Table(
    "social_reactions", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("event_id", Integer, ForeignKey("xp_events.id", ondelete="CASCADE"), nullable=False),
    Column("reactor_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("reaction", String(16), nullable=False, default="high_five"),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("event_id", "reactor_id", name="uq_social_event_reactor"),
)

social_notifications = Table(
    "social_notifications", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("recipient_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False, index=True),
    Column("actor_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE")),
    Column("kind", String(24), nullable=False),
    Column("message", String(240), nullable=False),
    Column("is_read", Boolean, nullable=False, default=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

social_blocks = Table(
    "social_blocks", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("blocker_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("blocked_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("blocker_id", "blocked_id", name="uq_social_block"),
)

social_reports = Table(
    "social_reports", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("reporter_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("reported_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("reason", String(40), nullable=False),
    Column("details", Text, nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

social_action_events = Table(
    "social_action_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("student_id", String(100), nullable=False, index=True),
    Column("action", String(24), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
)

uploaded_images = Table(
    "uploaded_images", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("storage_path", String(500), nullable=False, unique=True),
    Column("original_name", String(255), nullable=False),
    Column("content_type", String(100), nullable=False),
    Column("size_bytes", Integer, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

progress_claims = Table(
    "progress_claims", metadata,
    Column("guest_id", String(100), primary_key=True),
    Column("account_id", String(100), nullable=False, index=True),
    Column("claimed_at", DateTime(timezone=True), nullable=False),
)

study_tasks = Table(
    "study_tasks", metadata,
    Column("id", String(32), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("title", String(120), nullable=False),
    Column("description", String(500), nullable=False, default=""),
    Column("course", String(120), nullable=False, default=""),
    Column("unit", String(160), nullable=False, default=""),
    Column("status", String(16), nullable=False, default="todo", index=True),
    Column("priority", String(12), nullable=False, default="medium"),
    Column("due_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)


# Tables created by metadata.create_all() that must never be served unrestricted
# through Supabase's PostgREST API. create_all() skips existing tables, so a
# table it creates would otherwise have RLS off even after the migration ran.
# Policies live in supabase/migrations; with RLS on and no policy, access is
# denied, and the backend (the table owner) is unaffected either way.
RLS_TABLES = (
    "progress_claims",
    "social_action_events",
    "social_blocks",
    "social_notifications",
    "social_reactions",
    "social_reports",
    "study_group_members",
    "study_groups",
    "study_tasks",
    "xp_events",
)


def list_tasks(owner_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        rows = connection.execute(select(study_tasks).where(
            study_tasks.c.owner_id == owner_id
        ).order_by(study_tasks.c.status.asc(), study_tasks.c.due_at.asc(), study_tasks.c.created_at.desc())).mappings().all()
    return [dict(row) for row in rows]


def create_task(owner_id: str, *, title: str, description: str, course: str, unit: str, status: str, priority: str, due_at: datetime | None) -> dict:
    init_db()
    now = datetime.now(timezone.utc)
    task = {
        "id": secrets.token_hex(16), "owner_id": owner_id, "title": title.strip(),
        "description": description.strip(), "course": course.strip(), "unit": unit.strip(),
        "status": status, "priority": priority, "due_at": due_at, "created_at": now, "updated_at": now,
    }
    with engine().begin() as connection:
        connection.execute(study_tasks.insert().values(**task))
    return task


def update_task(owner_id: str, task_id: str, values: dict) -> dict:
    init_db()
    allowed = {
        key: value
        for key, value in values.items()
        if key in {"title", "description", "course", "unit", "status", "priority", "due_at"}
        and (value is not None or key == "due_at")
    }
    allowed["updated_at"] = datetime.now(timezone.utc)
    with engine().begin() as connection:
        result = connection.execute(update(study_tasks).where(
            study_tasks.c.id == task_id, study_tasks.c.owner_id == owner_id,
        ).values(**allowed))
        if not result.rowcount:
            raise ValueError("task_not_found")
        row = connection.execute(select(study_tasks).where(
            study_tasks.c.id == task_id, study_tasks.c.owner_id == owner_id,
        )).mappings().one()
    return dict(row)


def delete_task(owner_id: str, task_id: str) -> None:
    init_db()
    with engine().begin() as connection:
        result = connection.execute(delete(study_tasks).where(
            study_tasks.c.id == task_id, study_tasks.c.owner_id == owner_id,
        ))
    if not result.rowcount:
        raise ValueError("task_not_found")


def enable_row_level_security(connection, tables) -> None:
    for table in tables:
        connection.exec_driver_sql(f"ALTER TABLE IF EXISTS {table} ENABLE ROW LEVEL SECURITY")


class DatabaseConfigurationError(RuntimeError):
    """Raised instead of silently storing production data somewhere temporary."""


def is_production() -> bool:
    """Vercel sets VERCEL on every deployment; APP_ENV=production covers other hosts."""
    return bool(os.getenv("VERCEL")) or os.getenv("APP_ENV", "").strip().lower() == "production"


def sqlite_path() -> Path:
    configured_path = os.getenv("POCKET_TUTOR_DB_PATH")
    if configured_path:
        return Path(configured_path)
    return DEFAULT_DB_PATH


def database_url() -> str:
    """Resolve the database URL. SQLite is only ever used for local dev and tests.

    In production a missing or non-Postgres DATABASE_URL raises instead of
    falling back to SQLite, which on a serverless host lives on ephemeral disk
    and loses every write when the instance is recycled.
    """
    production = is_production()
    if os.getenv("POCKET_TUTOR_DB_PATH"):
        if production:
            raise DatabaseConfigurationError(
                "POCKET_TUTOR_DB_PATH forces a local SQLite database and cannot be used in production. "
                "Unset it and configure DATABASE_URL with a PostgreSQL connection string."
            )
        return f"sqlite:///{sqlite_path()}"
    configured_url = os.getenv("DATABASE_URL")
    if not configured_url or not configured_url.strip():
        if production:
            raise DatabaseConfigurationError(
                "DATABASE_URL is not set. Production refuses to fall back to SQLite because its data would be "
                "lost whenever the server instance is replaced. Set DATABASE_URL to a PostgreSQL connection string "
                "(for Supabase, the transaction pooler URI on port 6543)."
            )
        return f"sqlite:///{sqlite_path()}"

    url = _normalized_database_url(configured_url)
    if production:
        _require_postgres_url(url)
    return url


def _normalized_database_url(configured_url: str) -> str:
    url = configured_url.strip()
    if url.startswith("DATABASE_URL="):
        url = url.removeprefix("DATABASE_URL=").strip()
    if len(url) >= 2 and url[0] == url[-1] and url[0] in "'\"`":
        url = url[1:-1].strip()
    embedded_url = re.search(
        r"(?:postgres(?:ql)?(?:\+psycopg2|\+psycopg)?|sqlite)://[^\s'\"`]+",
        url,
    )
    if embedded_url:
        url = embedded_url.group(0).rstrip("\\")

    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql+psycopg2://"):
        url = url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)

    if ("supabase.co" in url or "supabase.com" in url) and "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def _require_postgres_url(url: str) -> None:
    # Messages never include the URL itself, because it carries the database password.
    try:
        parsed = make_url(url)
    except ArgumentError as error:
        raise DatabaseConfigurationError(
            "DATABASE_URL could not be parsed as a database URL. Expected postgresql://user:password@host:port/database."
        ) from error
    if parsed.get_backend_name() != "postgresql":
        raise DatabaseConfigurationError(
            f"DATABASE_URL must point to PostgreSQL in production, but it uses '{parsed.get_backend_name()}'."
        )
    if not parsed.host or not parsed.database:
        raise DatabaseConfigurationError(
            "DATABASE_URL is missing a host or database name. Expected postgresql://user:password@host:port/database."
        )


def validate_database_configuration() -> None:
    """Fail at startup, not on the first request, when production has no durable database."""
    database_url()


def _uses_supabase_pooler(url: str) -> bool:
    return "pooler.supabase.com" in url or ":6543" in url


@lru_cache(maxsize=1)
def engine() -> Engine:
    url = database_url()
    kwargs: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        connect_args: dict = {}
        if _uses_supabase_pooler(url):
            # PgBouncer transaction mode does not support prepared statements.
            connect_args["prepare_threshold"] = None
        if connect_args:
            kwargs["connect_args"] = connect_args
        if os.getenv("VERCEL"):
            # Keep one connection alive inside a warm serverless instance. The
            # Supabase transaction pooler safely multiplexes these small pools.
            kwargs.update(pool_size=2, max_overflow=2, pool_recycle=300)
    return create_engine(url, **kwargs)


@lru_cache(maxsize=1)
def init_db() -> None:
    """Create/check tables once per warm process instead of on every request."""
    active_engine = engine()
    metadata.create_all(active_engine)
    if active_engine.dialect.name == "postgresql":
        with active_engine.begin() as connection:
            enable_row_level_security(connection, RLS_TABLES)
            connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_path varchar(500) NOT NULL DEFAULT ''")
            connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_goal integer NOT NULL DEFAULT 20")
            connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT true")
            connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS allow_friend_requests boolean NOT NULL DEFAULT true")
            connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())")
            connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN IF NOT EXISTS login_streak integer NOT NULL DEFAULT 0")
            connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN IF NOT EXISTS best_login_streak integer NOT NULL DEFAULT 0")
            connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN IF NOT EXISTS last_login_date date")
    if active_engine.dialect.name == "sqlite":
        columns = {column["name"] for column in inspect(active_engine).get_columns("student_progress")}
        if "last_active_date" not in columns:
            with active_engine.begin() as connection:
                connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN last_active_date DATE")
                connection.execute(update(student_progress).values(streak=0, best_streak=0))
        columns = {column["name"] for column in inspect(active_engine).get_columns("student_progress")}
        with active_engine.begin() as connection:
            if "login_streak" not in columns:
                connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN login_streak INTEGER NOT NULL DEFAULT 0")
            if "best_login_streak" not in columns:
                connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN best_login_streak INTEGER NOT NULL DEFAULT 0")
            if "last_login_date" not in columns:
                connection.exec_driver_sql("ALTER TABLE student_progress ADD COLUMN last_login_date DATE")
        profile_columns = {column["name"] for column in inspect(active_engine).get_columns("profiles")}
        with active_engine.begin() as connection:
            if "avatar_path" not in profile_columns:
                connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN avatar_path VARCHAR(500) NOT NULL DEFAULT ''")
            if "daily_goal" not in profile_columns:
                connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN daily_goal INTEGER NOT NULL DEFAULT 20")
            if "updated_at" not in profile_columns:
                connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN updated_at DATETIME")
                connection.execute(update(profiles).values(updated_at=datetime.now(timezone.utc)))
            if "discoverable" not in profile_columns:
                connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN discoverable BOOLEAN NOT NULL DEFAULT 1")
            if "allow_friend_requests" not in profile_columns:
                connection.exec_driver_sql("ALTER TABLE profiles ADD COLUMN allow_friend_requests BOOLEAN NOT NULL DEFAULT 1")


def _next_streak(current_streak: int, last_active: date | None, correct: bool, today: date) -> int:
    if not correct or last_active == today:
        return current_streak
    if last_active == today - timedelta(days=1):
        return current_streak + 1
    return 1


def _next_login_streak(current_streak: int, last_login: date | None, today: date) -> int:
    if last_login == today:
        return current_streak
    if last_login == today - timedelta(days=1):
        return current_streak + 1
    return 1


def check_social_rate_limit(student_id: str, action: str, limit: int, window_minutes: int = 60) -> None:
    """Use shared storage so limits still hold across serverless instances."""
    init_db()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    with engine().begin() as connection:
        connection.execute(delete(social_action_events).where(
            social_action_events.c.created_at < datetime.now(timezone.utc) - timedelta(days=7)
        ))
        count = connection.execute(select(func.count()).select_from(social_action_events).where(
            social_action_events.c.student_id == student_id,
            social_action_events.c.action == action,
            social_action_events.c.created_at >= cutoff,
        )).scalar_one()
        if count >= limit:
            raise ValueError("social_rate_limited")
        connection.execute(social_action_events.insert().values(
            student_id=student_id, action=action, created_at=datetime.now(timezone.utc),
        ))


def update_progress(student_id: str, topic: str, correct: bool, xp: int) -> dict:
    init_db()
    today = date.today()
    now = datetime.now(timezone.utc)
    with engine().begin() as connection:
        progress = connection.execute(
            select(student_progress).where(student_progress.c.student_id == student_id)
        ).mappings().first()
        if progress is None:
            connection.execute(student_progress.insert().values(
                student_id=student_id, total_xp=0, attempts=0, correct_answers=0,
                streak=0, best_streak=0, last_active_date=None,
                login_streak=0, best_login_streak=0, last_login_date=None,
                updated_at=now,
            ))
            progress = connection.execute(
                select(student_progress).where(student_progress.c.student_id == student_id)
            ).mappings().one()

        streak = _next_streak(progress["streak"], progress["last_active_date"], correct, today)
        connection.execute(
            update(student_progress)
            .where(student_progress.c.student_id == student_id)
            .values(
                total_xp=progress["total_xp"] + xp,
                attempts=progress["attempts"] + 1,
                correct_answers=progress["correct_answers"] + int(correct),
                streak=streak,
                best_streak=max(progress["best_streak"], streak),
                last_active_date=today if correct else progress["last_active_date"],
                updated_at=now,
            )
        )

        topic_record = connection.execute(
            select(topic_progress).where(
                topic_progress.c.student_id == student_id,
                topic_progress.c.topic == topic,
            )
        ).mappings().first()
        if topic_record is None:
            connection.execute(topic_progress.insert().values(
                student_id=student_id, topic=topic, attempts=1,
                correct_answers=int(correct),
            ))
        else:
            connection.execute(
                update(topic_progress)
                .where(
                    topic_progress.c.student_id == student_id,
                    topic_progress.c.topic == topic,
                )
                .values(
                    attempts=topic_record["attempts"] + 1,
                    correct_answers=topic_record["correct_answers"] + int(correct),
                )
            )

        updated = connection.execute(
            select(student_progress).where(student_progress.c.student_id == student_id)
        ).mappings().one()
        topics = connection.execute(
            select(topic_progress).where(topic_progress.c.student_id == student_id)
        ).mappings().all()
        if xp > 0:
            connection.execute(xp_events.insert().values(student_id=student_id, xp=xp, created_at=now))

    return {
        "student_id": updated["student_id"],
        "total_xp": updated["total_xp"],
        "attempts": updated["attempts"],
        "correct_answers": updated["correct_answers"],
        "streak": updated["streak"],
        "best_streak": updated["best_streak"],
        "login_streak": updated.get("login_streak", 0),
        "best_login_streak": updated.get("best_login_streak", 0),
        "topics": {
            row["topic"]: {"attempts": row["attempts"], "correct": row["correct_answers"]}
            for row in topics
        },
    }


def record_daily_login(student_id: str) -> dict:
    init_db()
    today = date.today()
    now = datetime.now(timezone.utc)
    with engine().begin() as connection:
        progress = connection.execute(
            select(student_progress).where(student_progress.c.student_id == student_id)
        ).mappings().first()
        if progress is None:
            connection.execute(student_progress.insert().values(
                student_id=student_id, total_xp=0, attempts=0, correct_answers=0,
                streak=0, best_streak=0, last_active_date=None,
                login_streak=1, best_login_streak=1, last_login_date=today,
                updated_at=now,
            ))
        elif progress["last_login_date"] != today:
            login_streak = _next_login_streak(
                progress.get("login_streak", 0),
                progress.get("last_login_date"),
                today,
            )
            connection.execute(
                update(student_progress)
                .where(student_progress.c.student_id == student_id)
                .values(
                    login_streak=login_streak,
                    best_login_streak=max(progress.get("best_login_streak", 0), login_streak),
                    last_login_date=today,
                    updated_at=now,
                )
            )
        progress = connection.execute(
            select(student_progress).where(student_progress.c.student_id == student_id)
        ).mappings().one()
        topics = connection.execute(
            select(topic_progress).where(topic_progress.c.student_id == student_id)
        ).mappings().all()
    return {
        "student_id": progress["student_id"],
        "total_xp": progress["total_xp"],
        "attempts": progress["attempts"],
        "correct_answers": progress["correct_answers"],
        "streak": progress["streak"],
        "best_streak": progress["best_streak"],
        "login_streak": progress.get("login_streak", 0),
        "best_login_streak": progress.get("best_login_streak", 0),
        "topics": {
            row["topic"]: {"attempts": row["attempts"], "correct": row["correct_answers"]}
            for row in topics
        },
    }


def save_uploaded_image(
    image_id: str,
    owner_id: str,
    storage_path: str,
    original_name: str,
    content_type: str,
    size_bytes: int,
) -> dict:
    init_db()
    created_at = datetime.now(timezone.utc)
    with engine().begin() as connection:
        connection.execute(uploaded_images.insert().values(
            id=image_id,
            owner_id=owner_id,
            storage_path=storage_path,
            original_name=original_name,
            content_type=content_type,
            size_bytes=size_bytes,
            created_at=created_at,
        ))
    return {
        "id": image_id,
        "owner_id": owner_id,
        "storage_path": storage_path,
        "original_name": original_name,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "created_at": created_at,
    }


def list_uploaded_images(owner_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        rows = connection.execute(
            select(uploaded_images)
            .where(uploaded_images.c.owner_id == owner_id)
            .order_by(uploaded_images.c.created_at.desc())
        ).mappings().all()
    return [dict(row) for row in rows]


def get_progress(student_id: str) -> dict | None:
    init_db()
    with engine().connect() as connection:
        progress = connection.execute(
            select(student_progress).where(student_progress.c.student_id == student_id)
        ).mappings().first()
        if progress is None:
            return None
        topics = connection.execute(
            select(topic_progress).where(topic_progress.c.student_id == student_id)
        ).mappings().all()

    return {
        "student_id": progress["student_id"],
        "total_xp": progress["total_xp"],
        "attempts": progress["attempts"],
        "correct_answers": progress["correct_answers"],
        "streak": progress["streak"],
        "best_streak": progress["best_streak"],
        "login_streak": progress.get("login_streak", 0),
        "best_login_streak": progress.get("best_login_streak", 0),
        "topics": {
            row["topic"]: {"attempts": row["attempts"], "correct": row["correct_answers"]}
            for row in topics
        },
    }


def create_profile(student_id: str, username: str, display_name: str) -> dict:
    init_db()
    now = datetime.now(timezone.utc)
    with engine().begin() as connection:
        if connection.execute(select(profiles).where(profiles.c.student_id == student_id)).first():
            raise ValueError("profile_exists")
        if connection.execute(select(profiles).where(profiles.c.username == username)).first():
            raise ValueError("username_taken")
        if not connection.execute(select(student_progress).where(student_progress.c.student_id == student_id)).first():
            connection.execute(student_progress.insert().values(
                student_id=student_id, total_xp=0, attempts=0, correct_answers=0,
                streak=0, best_streak=0, last_active_date=None,
                login_streak=0, best_login_streak=0, last_login_date=None,
                updated_at=now,
            ))
        friend_code = ""
        while not friend_code:
            candidate = secrets.token_hex(4).upper()
            if not connection.execute(select(profiles).where(profiles.c.friend_code == candidate)).first():
                friend_code = candidate
        connection.execute(profiles.insert().values(
            student_id=student_id, username=username, display_name=display_name,
            avatar_path="", friend_code=friend_code, daily_goal=20,
            created_at=now, updated_at=now,
        ))
    return get_profile(student_id)


def get_profile(student_id: str) -> dict | None:
    init_db()
    with engine().connect() as connection:
        row = connection.execute(
            select(profiles, student_progress.c.total_xp, student_progress.c.streak, student_progress.c.best_streak)
            .join(student_progress, profiles.c.student_id == student_progress.c.student_id)
            .where(profiles.c.student_id == student_id)
        ).mappings().first()
    if row is None:
        return None
    return {
        "student_id": row["student_id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "avatar_path": row["avatar_path"] or "",
        "friend_code": row["friend_code"],
        "daily_goal": row["daily_goal"] or 20,
        "discoverable": bool(row["discoverable"]),
        "allow_friend_requests": bool(row["allow_friend_requests"]),
        "total_xp": row["total_xp"],
        "streak": row["streak"],
        "best_streak": row["best_streak"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


DAILY_GOALS = {10, 20, 30, 50}


def onboard_account(
    account_id: str,
    username: str,
    display_name: str,
    guest_id: str | None = None,
    avatar_path: str | None = None,
    daily_goal: int | None = None,
) -> dict:
    """Create/update an account profile without trusting browser-supplied guest ownership."""
    # Guest IDs are browser-generated identifiers, not ownership credentials.
    # Keep guest history isolated until a signed migration flow is available.
    guest_id = None
    init_db()
    now = datetime.now(timezone.utc)
    if daily_goal is not None and daily_goal not in DAILY_GOALS:
        raise ValueError("invalid_daily_goal")
    with engine().begin() as connection:
        account_progress = connection.execute(
            select(student_progress).where(student_progress.c.student_id == account_id)
        ).mappings().first()
        if account_progress is None:
            connection.execute(student_progress.insert().values(
                student_id=account_id, total_xp=0, attempts=0, correct_answers=0,
                streak=0, best_streak=0, last_active_date=None, updated_at=now,
            ))
            account_progress = connection.execute(
                select(student_progress).where(student_progress.c.student_id == account_id)
            ).mappings().one()

        if guest_id and guest_id != account_id:
            already_claimed = connection.execute(
                select(progress_claims).where(progress_claims.c.guest_id == guest_id)
            ).first()
            guest_has_account = connection.execute(
                select(profiles.c.student_id).where(profiles.c.student_id == guest_id)
            ).first()
            guest_progress = connection.execute(
                select(student_progress).where(student_progress.c.student_id == guest_id)
            ).mappings().first()
            if not already_claimed and guest_has_account is None and guest_progress is not None:
                latest_active = max(
                    filter(None, [account_progress["last_active_date"], guest_progress["last_active_date"]]),
                    default=None,
                )
                connection.execute(
                    update(student_progress)
                    .where(student_progress.c.student_id == account_id)
                    .values(
                        total_xp=account_progress["total_xp"] + guest_progress["total_xp"],
                        attempts=account_progress["attempts"] + guest_progress["attempts"],
                        correct_answers=account_progress["correct_answers"] + guest_progress["correct_answers"],
                        streak=max(account_progress["streak"], guest_progress["streak"]),
                        best_streak=max(account_progress["best_streak"], guest_progress["best_streak"]),
                        last_active_date=latest_active,
                        updated_at=now,
                    )
                )
                guest_topics = connection.execute(
                    select(topic_progress).where(topic_progress.c.student_id == guest_id)
                ).mappings().all()
                for guest_topic in guest_topics:
                    account_topic = connection.execute(select(topic_progress).where(
                        topic_progress.c.student_id == account_id,
                        topic_progress.c.topic == guest_topic["topic"],
                    )).mappings().first()
                    if account_topic:
                        connection.execute(update(topic_progress).where(
                            topic_progress.c.student_id == account_id,
                            topic_progress.c.topic == guest_topic["topic"],
                        ).values(
                            attempts=account_topic["attempts"] + guest_topic["attempts"],
                            correct_answers=account_topic["correct_answers"] + guest_topic["correct_answers"],
                        ))
                    else:
                        connection.execute(topic_progress.insert().values(
                            student_id=account_id, topic=guest_topic["topic"],
                            attempts=guest_topic["attempts"], correct_answers=guest_topic["correct_answers"],
                        ))
                connection.execute(progress_claims.insert().values(
                    guest_id=guest_id, account_id=account_id, claimed_at=now,
                ))

        username_owner = connection.execute(
            select(profiles.c.student_id).where(profiles.c.username == username)
        ).scalar_one_or_none()
        if username_owner and username_owner != account_id:
            raise ValueError("username_taken")
        profile = connection.execute(
            select(profiles).where(profiles.c.student_id == account_id)
        ).mappings().first()
        if profile:
            values = {"username": username, "display_name": display_name, "updated_at": now}
            if avatar_path is not None:
                values["avatar_path"] = avatar_path
            if daily_goal is not None:
                values["daily_goal"] = daily_goal
            connection.execute(update(profiles).where(profiles.c.student_id == account_id).values(**values))
        else:
            friend_code = ""
            while not friend_code:
                candidate = secrets.token_hex(4).upper()
                if not connection.execute(select(profiles).where(profiles.c.friend_code == candidate)).first():
                    friend_code = candidate
            connection.execute(profiles.insert().values(
                student_id=account_id, username=username, display_name=display_name,
                avatar_path=avatar_path or "", friend_code=friend_code,
                daily_goal=daily_goal or 20, created_at=now, updated_at=now,
            ))
    return get_profile(account_id)


def send_friend_request(requester_id: str, friend_code: str) -> dict:
    init_db()
    with engine().begin() as connection:
        recipient = connection.execute(
            select(profiles).where(profiles.c.friend_code == friend_code.upper())
        ).mappings().first()
        if recipient is None:
            raise ValueError("friend_not_found")
        recipient_id = recipient["student_id"]
        if requester_id == recipient_id:
            raise ValueError("cannot_friend_self")
        if not recipient["allow_friend_requests"]:
            raise ValueError("friend_requests_disabled")
        if not connection.execute(select(profiles).where(profiles.c.student_id == requester_id)).first():
            raise ValueError("profile_not_found")
        if connection.execute(select(social_blocks.c.id).where(or_(
            and_(social_blocks.c.blocker_id == requester_id, social_blocks.c.blocked_id == recipient_id),
            and_(social_blocks.c.blocker_id == recipient_id, social_blocks.c.blocked_id == requester_id),
        ))).first():
            raise ValueError("friend_not_found")
        existing = connection.execute(select(friendships).where(or_(
            and_(friendships.c.requester_id == requester_id, friendships.c.recipient_id == recipient_id),
            and_(friendships.c.requester_id == recipient_id, friendships.c.recipient_id == requester_id),
        ))).mappings().first()
        if existing:
            raise ValueError("friendship_exists")
        result = connection.execute(friendships.insert().values(
            requester_id=requester_id, recipient_id=recipient_id,
            status="pending", created_at=datetime.now(timezone.utc),
        ))
        request_id = result.inserted_primary_key[0]
        requester_name = connection.execute(select(profiles.c.display_name).where(profiles.c.student_id == requester_id)).scalar_one()
        connection.execute(social_notifications.insert().values(
            recipient_id=recipient_id, actor_id=requester_id, kind="friend_request",
            message=f"{requester_name} sent you a friend request.", is_read=False,
            created_at=datetime.now(timezone.utc),
        ))
    return {"request_id": request_id, "status": "pending", "friend": dict(recipient)}


def respond_to_friend_request(request_id: int, recipient_id: str, accept: bool) -> dict:
    init_db()
    with engine().begin() as connection:
        request = connection.execute(select(friendships).where(
            friendships.c.id == request_id,
            friendships.c.recipient_id == recipient_id,
        )).mappings().first()
        if request is None:
            raise ValueError("request_not_found")
        if request["status"] != "pending":
            raise ValueError("request_already_answered")
        status = "accepted" if accept else "declined"
        connection.execute(update(friendships).where(friendships.c.id == request_id).values(status=status))
        if accept:
            recipient_name = connection.execute(select(profiles.c.display_name).where(profiles.c.student_id == recipient_id)).scalar_one()
            connection.execute(social_notifications.insert().values(
                recipient_id=request["requester_id"], actor_id=recipient_id, kind="friend_accepted",
                message=f"{recipient_name} accepted your friend request.", is_read=False,
                created_at=datetime.now(timezone.utc),
            ))
    return {"request_id": request_id, "status": status}


def pending_friend_requests(student_id: str) -> list[dict]:
    init_db()
    requester = profiles.alias("requester")
    with engine().connect() as connection:
        rows = connection.execute(
            select(
                friendships.c.id.label("request_id"), friendships.c.created_at,
                requester.c.username, requester.c.display_name,
            ).join(requester, friendships.c.requester_id == requester.c.student_id)
            .where(friendships.c.recipient_id == student_id, friendships.c.status == "pending")
            .order_by(friendships.c.created_at.desc())
        ).mappings().all()
    return [dict(row) for row in rows]


def list_friends(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        accepted = connection.execute(select(friendships).where(
            friendships.c.status == "accepted",
            or_(friendships.c.requester_id == student_id, friendships.c.recipient_id == student_id),
        )).mappings().all()
        friend_ids = [
            row["recipient_id"] if row["requester_id"] == student_id else row["requester_id"]
            for row in accepted
        ]
        if not friend_ids:
            return []
        rows = connection.execute(
            select(
                profiles.c.student_id, profiles.c.username, profiles.c.display_name, profiles.c.avatar_path,
                student_progress.c.total_xp, student_progress.c.streak, student_progress.c.last_active_date,
            ).join(student_progress, profiles.c.student_id == student_progress.c.student_id)
            .where(profiles.c.student_id.in_(friend_ids))
            .order_by(profiles.c.display_name.asc())
        ).mappings().all()
        week_start = datetime.combine(date.today() - timedelta(days=date.today().weekday()), datetime.min.time(), tzinfo=timezone.utc)
        weekly = dict(connection.execute(select(xp_events.c.student_id, func.sum(xp_events.c.xp)).where(
            xp_events.c.student_id.in_(friend_ids), xp_events.c.created_at >= week_start,
        ).group_by(xp_events.c.student_id)).all())
    today = date.today()
    return [{**dict(row), "active_today": row["last_active_date"] == today,
             "weekly_xp": weekly.get(row["student_id"], 0),
             "friend_streak": _friend_streak(student_id, row["student_id"])} for row in rows]


def _friend_streak(first_id: str, second_id: str) -> int:
    with engine().connect() as connection:
        rows = connection.execute(select(xp_events.c.student_id, xp_events.c.created_at).where(
            xp_events.c.student_id.in_([first_id, second_id])
        )).all()
    active = {first_id: set(), second_id: set()}
    for owner_id, created_at in rows:
        active[owner_id].add(created_at.date())
    shared = active[first_id] & active[second_id]
    # XP event timestamps are stored in UTC, so their calendar-day comparison
    # must use the same clock. Mixing local `date.today()` with UTC timestamps
    # breaks shared streaks for several hours around midnight UTC.
    today_utc = datetime.now(timezone.utc).date()
    cursor = today_utc if today_utc in shared else today_utc - timedelta(days=1)
    streak = 0
    while cursor in shared:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _new_group_invite_code(connection) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(12):
        code = "".join(secrets.choice(alphabet) for _ in range(8))
        if not connection.execute(select(study_groups.c.id).where(study_groups.c.invite_code == code)).first():
            return code
    raise RuntimeError("Could not generate a unique group invite code")


def create_study_group(student_id: str, name: str, description: str = "", weekly_goal_xp: int = 500) -> dict:
    init_db()
    clean_name = " ".join(name.split())
    clean_description = " ".join(description.split())
    if not 2 <= len(clean_name) <= 48:
        raise ValueError("invalid_group_name")
    if not 100 <= weekly_goal_xp <= 10000:
        raise ValueError("invalid_group_goal")
    with engine().begin() as connection:
        if not connection.execute(select(profiles.c.student_id).where(profiles.c.student_id == student_id)).first():
            raise ValueError("profile_not_found")
        membership_count = connection.execute(select(func.count()).select_from(study_group_members).where(
            study_group_members.c.student_id == student_id,
        )).scalar_one()
        if membership_count >= 8:
            raise ValueError("group_limit_reached")
        now = datetime.now(timezone.utc)
        group_id = secrets.token_hex(16)
        connection.execute(study_groups.insert().values(
            id=group_id, name=clean_name, description=clean_description[:160], owner_id=student_id,
            invite_code=_new_group_invite_code(connection), weekly_goal_xp=weekly_goal_xp, created_at=now,
        ))
        connection.execute(study_group_members.insert().values(
            group_id=group_id, student_id=student_id, role="owner", joined_at=now,
        ))
    return get_study_group(student_id, group_id)


def join_study_group(student_id: str, invite_code: str) -> dict:
    init_db()
    code = invite_code.strip().upper()
    with engine().begin() as connection:
        group = connection.execute(select(study_groups).where(study_groups.c.invite_code == code)).mappings().first()
        if not group:
            raise ValueError("group_not_found")
        if connection.execute(select(study_group_members.c.id).where(
            study_group_members.c.group_id == group["id"], study_group_members.c.student_id == student_id,
        )).first():
            raise ValueError("already_in_group")
        group_size = connection.execute(select(func.count()).select_from(study_group_members).where(
            study_group_members.c.group_id == group["id"],
        )).scalar_one()
        if group_size >= 20:
            raise ValueError("group_full")
        membership_count = connection.execute(select(func.count()).select_from(study_group_members).where(
            study_group_members.c.student_id == student_id,
        )).scalar_one()
        if membership_count >= 8:
            raise ValueError("group_limit_reached")
        now = datetime.now(timezone.utc)
        connection.execute(study_group_members.insert().values(
            group_id=group["id"], student_id=student_id, role="member", joined_at=now,
        ))
        display_name = connection.execute(select(profiles.c.display_name).where(profiles.c.student_id == student_id)).scalar_one()
        member_ids = connection.execute(select(study_group_members.c.student_id).where(
            study_group_members.c.group_id == group["id"], study_group_members.c.student_id != student_id,
        )).scalars().all()
        if member_ids:
            connection.execute(social_notifications.insert(), [{
                "recipient_id": member_id, "actor_id": student_id, "kind": "group_joined",
                "message": f"{display_name} joined {group['name']}.", "is_read": False, "created_at": now,
            } for member_id in member_ids])
    return get_study_group(student_id, group["id"])


def _study_group_result(connection, student_id: str, group: dict) -> dict:
    membership = connection.execute(select(study_group_members.c.role).where(
        study_group_members.c.group_id == group["id"], study_group_members.c.student_id == student_id,
    )).scalar_one_or_none()
    if membership is None:
        raise ValueError("group_not_found")
    today_utc = datetime.now(timezone.utc).date()
    week_start = datetime.combine(today_utc - timedelta(days=today_utc.weekday()), datetime.min.time(), tzinfo=timezone.utc)
    weekly = select(
        xp_events.c.student_id, func.sum(xp_events.c.xp).label("weekly_xp"),
    ).where(xp_events.c.created_at >= week_start).group_by(xp_events.c.student_id).subquery()
    members = connection.execute(select(
        profiles.c.student_id, profiles.c.username, profiles.c.display_name, profiles.c.avatar_path,
        study_group_members.c.role, study_group_members.c.joined_at,
        func.coalesce(weekly.c.weekly_xp, 0).label("weekly_xp"),
    ).join(study_group_members, profiles.c.student_id == study_group_members.c.student_id)
      .outerjoin(weekly, profiles.c.student_id == weekly.c.student_id)
      .where(study_group_members.c.group_id == group["id"])
      .order_by(func.coalesce(weekly.c.weekly_xp, 0).desc(), profiles.c.display_name.asc())).mappings().all()
    member_ids = [member["student_id"] for member in members]
    activity = connection.execute(select(
        xp_events.c.id, xp_events.c.student_id, xp_events.c.xp, xp_events.c.created_at,
        profiles.c.display_name,
    ).join(profiles, profiles.c.student_id == xp_events.c.student_id)
      .where(xp_events.c.student_id.in_(member_ids))
      .order_by(xp_events.c.created_at.desc()).limit(8)).mappings().all() if member_ids else []
    weekly_xp = sum(int(member["weekly_xp"] or 0) for member in members)
    return {
        "id": group["id"], "name": group["name"], "description": group["description"],
        "invite_code": group["invite_code"], "weekly_goal_xp": group["weekly_goal_xp"],
        "weekly_xp": weekly_xp, "role": membership, "created_at": group["created_at"],
        "members": [dict(member) for member in members], "activity": [dict(item) for item in activity],
    }


def get_study_group(student_id: str, group_id: str) -> dict:
    init_db()
    with engine().connect() as connection:
        group = connection.execute(select(study_groups).where(study_groups.c.id == group_id)).mappings().first()
        if not group:
            raise ValueError("group_not_found")
        return _study_group_result(connection, student_id, group)


def list_study_groups(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        groups = connection.execute(select(study_groups).join(
            study_group_members, study_groups.c.id == study_group_members.c.group_id,
        ).where(study_group_members.c.student_id == student_id)
          .order_by(study_group_members.c.joined_at.desc())).mappings().all()
        return [_study_group_result(connection, student_id, group) for group in groups]


def leave_study_group(student_id: str, group_id: str) -> bool:
    init_db()
    with engine().begin() as connection:
        membership = connection.execute(select(study_group_members).where(
            study_group_members.c.group_id == group_id, study_group_members.c.student_id == student_id,
        )).mappings().first()
        if not membership:
            raise ValueError("group_not_found")
        if membership["role"] == "owner":
            raise ValueError("group_owner_cannot_leave")
        result = connection.execute(delete(study_group_members).where(study_group_members.c.id == membership["id"]))
    return bool(result.rowcount)


def remove_friend(student_id: str, friend_id: str) -> bool:
    init_db()
    with engine().begin() as connection:
        result = connection.execute(delete(friendships).where(or_(
            and_(friendships.c.requester_id == student_id, friendships.c.recipient_id == friend_id),
            and_(friendships.c.requester_id == friend_id, friendships.c.recipient_id == student_id),
        )))
    return bool(result.rowcount)


def create_friend_quest(student_id: str, friend_id: str, target_xp: int = 100) -> dict:
    init_db()
    if not 50 <= target_xp <= 1000:
        raise ValueError("invalid_quest_target")
    with engine().begin() as connection:
        friendship = connection.execute(select(friendships).where(
            friendships.c.status == "accepted",
            or_(
                and_(friendships.c.requester_id == student_id, friendships.c.recipient_id == friend_id),
                and_(friendships.c.requester_id == friend_id, friendships.c.recipient_id == student_id),
            ),
        )).first()
        if not friendship:
            raise ValueError("friend_not_found")
        existing = connection.execute(select(friend_quests).where(
            friend_quests.c.status == "active",
            or_(
                and_(friend_quests.c.creator_id == student_id, friend_quests.c.partner_id == friend_id),
                and_(friend_quests.c.creator_id == friend_id, friend_quests.c.partner_id == student_id),
            ),
        )).mappings().first()
        if existing:
            return _quest_result(connection, existing, student_id)
        total = connection.execute(select(student_progress.c.total_xp).where(
            student_progress.c.student_id.in_([student_id, friend_id])
        )).scalars().all()
        now = datetime.now(timezone.utc)
        result = connection.execute(friend_quests.insert().values(
            creator_id=student_id, partner_id=friend_id, target_xp=target_xp,
            starting_xp=sum(total), status="active", created_at=now, expires_at=now + timedelta(days=7),
        ))
        row = connection.execute(select(friend_quests).where(friend_quests.c.id == result.inserted_primary_key[0])).mappings().one()
        return _quest_result(connection, row, student_id)


def _quest_result(connection, row: dict, student_id: str) -> dict:
    ids = [row["creator_id"], row["partner_id"]]
    profiles_by_id = {item["student_id"]: item for item in connection.execute(
        select(profiles.c.student_id, profiles.c.display_name, profiles.c.username).where(profiles.c.student_id.in_(ids))
    ).mappings().all()}
    total = sum(connection.execute(select(student_progress.c.total_xp).where(student_progress.c.student_id.in_(ids))).scalars().all())
    progress = max(0, total - row["starting_xp"])
    expires_at = row["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    status = "complete" if progress >= row["target_xp"] else ("expired" if expires_at < datetime.now(timezone.utc) else row["status"])
    friend_id = row["partner_id"] if row["creator_id"] == student_id else row["creator_id"]
    friend = profiles_by_id.get(friend_id, {})
    return {"id": row["id"], "friend_id": friend_id, "friend_name": friend.get("display_name") or friend.get("username") or "Friend", "target_xp": row["target_xp"], "progress_xp": min(progress, row["target_xp"]), "status": status, "expires_at": expires_at}


def active_friend_quests(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        rows = connection.execute(select(friend_quests).where(
            or_(friend_quests.c.creator_id == student_id, friend_quests.c.partner_id == student_id),
            friend_quests.c.status == "active",
        ).order_by(friend_quests.c.created_at.desc())).mappings().all()
        return [_quest_result(connection, row, student_id) for row in rows]


def friend_leaderboard(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        accepted = connection.execute(select(friendships).where(
            friendships.c.status == "accepted",
            or_(friendships.c.requester_id == student_id, friendships.c.recipient_id == student_id),
        )).mappings().all()
        friend_ids = {
            row["recipient_id"] if row["requester_id"] == student_id else row["requester_id"]
            for row in accepted
        }
        friend_ids.add(student_id)
        week_start = datetime.combine(date.today() - timedelta(days=date.today().weekday()), datetime.min.time(), tzinfo=timezone.utc)
        weekly_xp = select(xp_events.c.student_id, func.sum(xp_events.c.xp).label("weekly_xp")).where(
            xp_events.c.created_at >= week_start
        ).group_by(xp_events.c.student_id).subquery()
        rows = connection.execute(
            select(
                profiles.c.student_id, profiles.c.username, profiles.c.display_name,
                student_progress.c.total_xp, student_progress.c.streak,
                student_progress.c.last_active_date, func.coalesce(weekly_xp.c.weekly_xp, 0).label("weekly_xp"),
            ).join(student_progress, profiles.c.student_id == student_progress.c.student_id)
            .outerjoin(weekly_xp, profiles.c.student_id == weekly_xp.c.student_id)
            .where(profiles.c.student_id.in_(friend_ids))
            .order_by(func.coalesce(weekly_xp.c.weekly_xp, 0).desc(), profiles.c.username.asc())
        ).mappings().all()
    today = date.today()
    return [
        {
            "student_id": row["student_id"], "username": row["username"],
            "display_name": row["display_name"], "total_xp": row["total_xp"],
            "weekly_xp": row["weekly_xp"],
            "streak": row["streak"], "active_today": row["last_active_date"] == today,
        }
        for row in rows
    ]


def _excluded_social_ids(connection, student_id: str) -> set[str]:
    excluded = {student_id}
    for row in connection.execute(select(friendships).where(or_(friendships.c.requester_id == student_id, friendships.c.recipient_id == student_id))).mappings():
        excluded.add(row["recipient_id"] if row["requester_id"] == student_id else row["requester_id"])
    for row in connection.execute(select(social_blocks).where(or_(social_blocks.c.blocker_id == student_id, social_blocks.c.blocked_id == student_id))).mappings():
        excluded.add(row["blocked_id"] if row["blocker_id"] == student_id else row["blocker_id"])
    return excluded


def search_people(student_id: str, query: str) -> list[dict]:
    init_db()
    term = query.strip().lower()
    if len(term) < 2:
        return []
    with engine().connect() as connection:
        excluded = _excluded_social_ids(connection, student_id)
        rows = connection.execute(select(
            profiles.c.student_id, profiles.c.username, profiles.c.display_name,
            profiles.c.avatar_path, profiles.c.friend_code,
        ).where(
            profiles.c.discoverable.is_(True), profiles.c.allow_friend_requests.is_(True),
            profiles.c.student_id.not_in(excluded),
            or_(func.lower(profiles.c.username).like(f"%{term}%"), func.lower(profiles.c.display_name).like(f"%{term}%")),
        ).limit(12)).mappings().all()
    return [dict(row) for row in rows]


def suggested_people(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        excluded = _excluded_social_ids(connection, student_id)
        rows = connection.execute(select(
            profiles.c.student_id, profiles.c.username, profiles.c.display_name,
            profiles.c.avatar_path, profiles.c.friend_code,
        ).where(
            profiles.c.discoverable.is_(True), profiles.c.allow_friend_requests.is_(True),
            profiles.c.student_id.not_in(excluded),
        ).order_by(profiles.c.created_at.desc()).limit(6)).mappings().all()
    return [dict(row) for row in rows]


def activity_feed(student_id: str) -> list[dict]:
    init_db()
    ids = [student_id] + [friend["student_id"] for friend in list_friends(student_id)]
    with engine().connect() as connection:
        rows = connection.execute(select(
            xp_events.c.id, xp_events.c.student_id, xp_events.c.xp, xp_events.c.created_at,
            profiles.c.display_name, profiles.c.username,
        ).join(profiles, profiles.c.student_id == xp_events.c.student_id).where(
            xp_events.c.student_id.in_(ids)
        ).order_by(xp_events.c.created_at.desc()).limit(20)).mappings().all()
        event_ids = [row["id"] for row in rows]
        counts = dict(connection.execute(select(social_reactions.c.event_id, func.count().label("count")).where(
            social_reactions.c.event_id.in_(event_ids)
        ).group_by(social_reactions.c.event_id)).all()) if event_ids else {}
        mine = set(connection.execute(select(social_reactions.c.event_id).where(
            social_reactions.c.event_id.in_(event_ids), social_reactions.c.reactor_id == student_id,
        )).scalars()) if event_ids else set()
    return [{**dict(row), "reaction_count": counts.get(row["id"], 0), "reacted": row["id"] in mine} for row in rows]


def react_to_activity(student_id: str, event_id: int) -> dict:
    init_db()
    visible = {student_id} | {friend["student_id"] for friend in list_friends(student_id)}
    with engine().begin() as connection:
        event = connection.execute(select(xp_events).where(xp_events.c.id == event_id, xp_events.c.student_id.in_(visible))).mappings().first()
        if not event:
            raise ValueError("activity_not_found")
        existing = connection.execute(select(social_reactions).where(social_reactions.c.event_id == event_id, social_reactions.c.reactor_id == student_id)).first()
        if existing:
            connection.execute(delete(social_reactions).where(social_reactions.c.event_id == event_id, social_reactions.c.reactor_id == student_id))
            return {"reacted": False}
        connection.execute(social_reactions.insert().values(event_id=event_id, reactor_id=student_id, reaction="high_five", created_at=datetime.now(timezone.utc)))
        if event["student_id"] != student_id:
            name = connection.execute(select(profiles.c.display_name).where(profiles.c.student_id == student_id)).scalar_one()
            connection.execute(social_notifications.insert().values(
                recipient_id=event["student_id"], actor_id=student_id, kind="high_five",
                message=f"{name} celebrated your study session.", is_read=False, created_at=datetime.now(timezone.utc),
            ))
    return {"reacted": True}


def notifications_for(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        rows = connection.execute(select(social_notifications).where(
            social_notifications.c.recipient_id == student_id
        ).order_by(social_notifications.c.created_at.desc()).limit(30)).mappings().all()
    return [dict(row) for row in rows]


def mark_notifications_read(student_id: str) -> None:
    init_db()
    with engine().begin() as connection:
        connection.execute(update(social_notifications).where(social_notifications.c.recipient_id == student_id).values(is_read=True))


def update_social_privacy(student_id: str, discoverable: bool, allow_friend_requests: bool) -> dict:
    init_db()
    with engine().begin() as connection:
        result = connection.execute(update(profiles).where(profiles.c.student_id == student_id).values(
            discoverable=discoverable, allow_friend_requests=allow_friend_requests,
        ))
        if not result.rowcount:
            raise ValueError("profile_not_found")
    return {"discoverable": discoverable, "allow_friend_requests": allow_friend_requests}


def block_person(student_id: str, blocked_id: str) -> None:
    init_db()
    if student_id == blocked_id:
        raise ValueError("cannot_block_self")
    with engine().begin() as connection:
        if not connection.execute(select(profiles.c.student_id).where(profiles.c.student_id == blocked_id)).first():
            raise ValueError("friend_not_found")
        connection.execute(delete(friendships).where(or_(
            and_(friendships.c.requester_id == student_id, friendships.c.recipient_id == blocked_id),
            and_(friendships.c.requester_id == blocked_id, friendships.c.recipient_id == student_id),
        )))
        if not connection.execute(select(social_blocks).where(social_blocks.c.blocker_id == student_id, social_blocks.c.blocked_id == blocked_id)).first():
            connection.execute(social_blocks.insert().values(blocker_id=student_id, blocked_id=blocked_id, created_at=datetime.now(timezone.utc)))


def report_person(student_id: str, reported_id: str, reason: str, details: str = "") -> dict:
    init_db()
    if student_id == reported_id:
        raise ValueError("cannot_report_self")
    with engine().begin() as connection:
        if not connection.execute(select(profiles.c.student_id).where(profiles.c.student_id == reported_id)).first():
            raise ValueError("friend_not_found")
        result = connection.execute(social_reports.insert().values(
            reporter_id=student_id, reported_id=reported_id, reason=reason, details=details[:1000], created_at=datetime.now(timezone.utc),
        ))
    return {"report_id": result.inserted_primary_key[0], "submitted": True}


def reset_db() -> None:
    init_db()
    active_engine = engine()
    if active_engine.dialect.name != "sqlite":
        raise RuntimeError("reset_db is only available for local SQLite databases")
    with active_engine.begin() as connection:
        connection.execute(delete(study_tasks))
        connection.execute(delete(uploaded_images))
        connection.execute(delete(study_group_members))
        connection.execute(delete(study_groups))
        connection.execute(delete(social_action_events))
        connection.execute(delete(social_reports))
        connection.execute(delete(social_notifications))
        connection.execute(delete(social_reactions))
        connection.execute(delete(social_blocks))
        connection.execute(delete(xp_events))
        connection.execute(delete(friend_quests))
        connection.execute(delete(friendships))
        connection.execute(delete(profiles))
        connection.execute(delete(progress_claims))
        connection.execute(delete(topic_progress))
        connection.execute(delete(student_progress))
