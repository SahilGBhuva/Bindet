from __future__ import annotations

import os
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import (
    JSON, Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, MetaData, String, Table, Text,
    UniqueConstraint, and_, create_engine, delete, func, inspect, literal, or_, select, text, union_all, update,
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
    Index("ix_friendships_recipient_status", "recipient_id", "status"),
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
    Index("ix_friend_quests_partner", "partner_id"),
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
    Index("ix_xp_events_student_created", "student_id", "created_at"),
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
    Index("ix_social_notifications_recipient_created", "recipient_id", "created_at"),
)

social_blocks = Table(
    "social_blocks", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("blocker_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("blocked_id", String(100), ForeignKey("profiles.student_id", ondelete="CASCADE"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("blocker_id", "blocked_id", name="uq_social_block"),
    Index("ix_social_blocks_blocked", "blocked_id"),
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
    Index("ix_social_action_events_student_action_created", "student_id", "action", "created_at"),
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

# --- AI result caches (see ai_cache.py) ---------------------------------------------
# Backend-only. Keys are sha256 hashes that include a prompt/generator version. The
# request input itself (file bytes, typed answers, messages) is not stored, but the
# outputs can contain student content: extraction_cache holds the full text read from
# an uploaded file, cards and tutor replies quote notes, and grade explanations can
# quote the answer. cache_refs ties each entry to where it came from, so deleting a
# note or tutor conversation (or an account) deletes the entries that came from it.

flashcard_cache = Table(
    "flashcard_cache", metadata,
    Column("key", String(64), primary_key=True),
    Column("cards", JSON, nullable=False),
    Column("card_count", Integer, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
    Column("hits", Integer, nullable=False, default=0),
)

extraction_cache = Table(
    "extraction_cache", metadata,
    Column("key", String(64), primary_key=True),
    Column("text", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
    Column("hits", Integer, nullable=False, default=0),
)

grading_cache = Table(
    "grading_cache", metadata,
    Column("key", String(64), primary_key=True),
    Column("result", JSON, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
    Column("hits", Integer, nullable=False, default=0),
)

# Per-account: the owner is part of the key and stored, and every read filters by it.
tutor_reply_cache = Table(
    "tutor_reply_cache", metadata,
    Column("key", String(64), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("reply", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, index=True),
    Column("hits", Integer, nullable=False, default=0),
)

# Which owner and source (a note ID, "conversation:<id>", or "" for none) produced or
# used each cache entry. A shared entry (flashcards, OCR text) is deleted when its last
# reference goes; see ai_cache.release_source and ai_cache.purge_user_ai_data.
cache_refs = Table(
    "cache_refs", metadata,
    Column("cache_table", String(32), primary_key=True),
    Column("key", String(64), primary_key=True),
    Column("owner_id", String(100), primary_key=True),
    Column("note_id", String(80), primary_key=True, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_cache_refs_owner_note", "owner_id", "note_id"),
    Index("ix_cache_refs_table_key", "cache_table", "key"),
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
    "cache_refs",
    "extraction_cache",
    "flashcard_cache",
    "flashcard_jobs",
    "flashcard_styles",
    "flashcards",
    "friend_quests",
    "friendships",
    "generated_questions",
    "grading_cache",
    "profiles",
    "progress_claims",
    "question_bank",
    "social_action_events",
    "social_blocks",
    "social_notifications",
    "social_reactions",
    "social_reports",
    "study_group_members",
    "study_groups",
    "student_progress",
    "study_tasks",
    "topic_progress",
    "tutor_conversations",
    "tutor_messages",
    "tutor_reply_cache",
    "uploaded_images",
    "workspace_group_milestones",
    "workspace_task_activity",
    "workspace_task_assignees",
    "workspace_task_attachments",
    "workspace_task_checklist",
    "workspace_task_comments",
    "workspace_tasks",
    "xp_events",
)

# Backend-only tables the frontend never reads through PostgREST, so Supabase's
# default anon/authenticated grants are removed as well. Tables used inside
# client-facing RLS policies (study_group_members) or read by the browser
# (study_notes) must not be listed here.
CLIENT_REVOKED_TABLES = (
    "cache_refs",
    "extraction_cache",
    "flashcard_cache",
    "flashcard_jobs",
    "flashcard_styles",
    "flashcards",
    "grading_cache",
    "tutor_conversations",
    "tutor_messages",
    "tutor_reply_cache",
    "workspace_group_milestones",
    "workspace_task_activity",
    "workspace_task_assignees",
    "workspace_task_attachments",
    "workspace_task_checklist",
    "workspace_task_comments",
    "workspace_tasks",
)


MAX_TASKS_PER_OWNER = 2000


def _task_row(row) -> dict:
    """SQLite drops tzinfo; stored task timestamps are UTC, so label them before they reach the client."""
    task = dict(row)
    for key in ("due_at", "created_at", "updated_at"):
        value = task.get(key)
        if isinstance(value, datetime) and value.tzinfo is None:
            task[key] = value.replace(tzinfo=timezone.utc)
    return task


def list_tasks(owner_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        rows = connection.execute(select(study_tasks).where(
            study_tasks.c.owner_id == owner_id
        ).order_by(study_tasks.c.status.asc(), study_tasks.c.due_at.asc(), study_tasks.c.created_at.desc())).mappings().all()
    return [_task_row(row) for row in rows]


def create_task(owner_id: str, *, title: str, description: str, course: str, unit: str, status: str, priority: str, due_at: datetime | None) -> dict:
    init_db()
    now = datetime.now(timezone.utc)
    if not title.strip():
        raise ValueError("invalid_task_title")
    task = {
        "id": secrets.token_hex(16), "owner_id": owner_id, "title": title.strip(),
        "description": description.strip(), "course": course.strip(), "unit": unit.strip(),
        "status": status, "priority": priority, "due_at": due_at, "created_at": now, "updated_at": now,
    }
    with engine().begin() as connection:
        owned = connection.execute(select(func.count()).select_from(study_tasks).where(study_tasks.c.owner_id == owner_id)).scalar_one()
        if owned >= MAX_TASKS_PER_OWNER:
            raise ValueError("task_limit_reached")
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
    allowed = {key: value.strip() if isinstance(value, str) else value for key, value in allowed.items()}
    if "title" in allowed and not allowed["title"]:
        raise ValueError("invalid_task_title")
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
    return _task_row(row)


def delete_task(owner_id: str, task_id: str) -> None:
    init_db()
    with engine().begin() as connection:
        result = connection.execute(delete(study_tasks).where(
            study_tasks.c.id == task_id, study_tasks.c.owner_id == owner_id,
        ))
    if not result.rowcount:
        raise ValueError("task_not_found")


def enable_row_level_security(connection, tables) -> None:
    """Turn RLS on for the listed public tables that exist and still have it off.

    ALTER TABLE takes an ACCESS EXCLUSIVE lock even when RLS is already on, which
    would queue every read of a busy table behind each cold start, so tables are
    checked first and only the ones that need it are altered.
    """
    names = list(tables)
    if not names:
        return
    pending = connection.execute(text(
        "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace "
        "AND relkind IN ('r', 'p') AND NOT relrowsecurity AND relname = ANY(:names)"
    ), {"names": names}).scalars().all()
    for table in pending:
        connection.exec_driver_sql(f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY')


def revoke_client_access(connection, tables) -> None:
    """Remove Supabase's default anon/authenticated grants from backend-only tables.

    Runs as one DO block so a database without those roles (plain Postgres)
    skips it instead of aborting the surrounding transaction. Each table is
    guarded with to_regclass, so tables another module has not created yet are
    skipped (that module revokes again once it creates them).
    """
    statements = " ".join(
        f"IF to_regclass('public.{table}') IS NOT NULL THEN "
        f"REVOKE ALL ON TABLE public.{table} FROM anon, authenticated; END IF;"
        for table in tables
    )
    connection.exec_driver_sql(
        "DO $$ BEGIN "
        "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') "
        "AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN "
        f"{statements} "
        "END IF; END $$"
    )


def create_locked_tables(active_engine, table_metadata, rls_tables=(), revoked_tables=(), extra=None) -> None:
    """Create any missing tables and lock them down in ONE transaction on Postgres.

    Supabase's default privileges grant anon/authenticated access to every new table in
    public. Creating a table and enabling RLS / revoking those grants in separate
    transactions would leave a window where a just-created table is readable and
    writable through PostgREST with the public anon key. Postgres DDL is transactional,
    so here the table only becomes visible to anyone already locked. extra(connection),
    if given, runs in the same transaction (init_db uses it for added columns).
    SQLite has no client roles; tables are simply created.
    """
    if active_engine.dialect.name != "postgresql":
        table_metadata.create_all(active_engine)
        return
    with active_engine.begin() as connection:
        table_metadata.create_all(connection)
        enable_row_level_security(connection, rls_tables)
        if revoked_tables:
            revoke_client_access(connection, revoked_tables)
        if extra is not None:
            extra(connection)


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


def engine_options(url: str, serverless: bool | None = None) -> dict:
    """create_engine keyword arguments for this URL.

    * SQLite (local dev and tests): one file, shared across threads.
    * Supabase transaction pooler (port 6543 / pooler.supabase.com): PgBouncer-style
      transaction pooling cannot keep server-side prepared statements, so psycopg's
      automatic preparation is turned off.
    * Serverless (Vercel): a small LIFO pool per warm instance. The pooler does the
      real multiplexing; LIFO lets idle extras age out, pre-ping and recycle replace
      connections the pooler closed, and short timeouts fail fast instead of hanging
      a function until the platform kills it.
    """
    if url.startswith("sqlite"):
        return {"pool_pre_ping": True, "connect_args": {"check_same_thread": False}}
    if serverless is None:
        serverless = bool(os.getenv("VERCEL"))
    options: dict = {"pool_pre_ping": True}
    connect_args: dict = {"connect_timeout": 10}
    if _uses_supabase_pooler(url):
        connect_args["prepare_threshold"] = None
    options["connect_args"] = connect_args
    if serverless:
        # /api/friends fans out to 4 reader threads, so allow 4 connections in total.
        options.update(pool_size=2, max_overflow=2, pool_recycle=300, pool_timeout=10, pool_use_lifo=True)
    return options


@lru_cache(maxsize=1)
def engine() -> Engine:
    url = database_url()
    return create_engine(url, **engine_options(url))


# Columns added after the first release, for databases created before them.
POSTGRES_ADDED_COLUMNS = (
    ("profiles.avatar_path", "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_path varchar(500) NOT NULL DEFAULT ''"),
    ("profiles.daily_goal", "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_goal integer NOT NULL DEFAULT 20"),
    ("profiles.discoverable", "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT true"),
    ("profiles.allow_friend_requests", "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS allow_friend_requests boolean NOT NULL DEFAULT true"),
    ("profiles.updated_at", "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())"),
    ("student_progress.login_streak", "ALTER TABLE student_progress ADD COLUMN IF NOT EXISTS login_streak integer NOT NULL DEFAULT 0"),
    ("student_progress.best_login_streak", "ALTER TABLE student_progress ADD COLUMN IF NOT EXISTS best_login_streak integer NOT NULL DEFAULT 0"),
    ("student_progress.last_login_date", "ALTER TABLE student_progress ADD COLUMN IF NOT EXISTS last_login_date date"),
)


@lru_cache(maxsize=1)
def init_db() -> None:
    """Create/check tables once per warm process instead of on every request."""
    active_engine = engine()

    def add_missing_columns(connection) -> None:
        # Like RLS, ADD COLUMN IF NOT EXISTS locks the table even when the
        # column exists, so only run the ones that are actually missing.
        existing = set(connection.execute(text(
            "SELECT table_name || '.' || column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name IN ('profiles', 'student_progress')"
        )).scalars().all())
        for column, statement in POSTGRES_ADDED_COLUMNS:
            if column not in existing:
                connection.exec_driver_sql(statement)

    create_locked_tables(active_engine, metadata, RLS_TABLES, CLIENT_REVOKED_TABLES, extra=add_missing_columns)
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


def _advisory_lock(connection, key: str) -> None:
    """Serialize count-then-insert checks on one key until this transaction ends.

    Postgres only (transaction-scoped, so safe behind the Supabase pooler).
    SQLite already serializes writers, so it is a no-op there.
    """
    if connection.dialect.name == "postgresql":
        connection.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": key})


# Old rate-limit events are pruned at most this often per server instance, not on
# every check: a table-wide DELETE per request would make every limited action slow.
RATE_EVENT_PRUNE_SECONDS = 600
RATE_EVENT_RETENTION = timedelta(days=7)
_last_rate_prune = float("-inf")
_rate_prune_lock = threading.Lock()


def _prune_rate_events_if_due(now: float | None = None) -> bool:
    """Delete rate-limit events older than the longest window. Returns True if it ran."""
    global _last_rate_prune
    now = time.monotonic() if now is None else now
    with _rate_prune_lock:
        if now - _last_rate_prune < RATE_EVENT_PRUNE_SECONDS:
            return False
        _last_rate_prune = now
    with engine().begin() as connection:
        connection.execute(delete(social_action_events).where(
            social_action_events.c.created_at < datetime.now(timezone.utc) - RATE_EVENT_RETENTION
        ))
    return True


def check_social_rate_limit(student_id: str, action: str, limit: int, window_minutes: int = 60) -> None:
    """Use shared storage so limits still hold across serverless instances."""
    init_db()
    _prune_rate_events_if_due()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    with engine().begin() as connection:
        # Without the lock, parallel requests could all count below the limit and all insert.
        _advisory_lock(connection, f"rate:{student_id}:{action}")
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


# Most XP one student can earn per UTC day. Real study rarely gets near it;
# it stops scripted answer loops from inflating leaderboards and quests.
DAILY_XP_CAP = 3000


def update_progress(student_id: str, topic: str, correct: bool, xp: int) -> dict:
    """Record one answer. The result's xp_awarded can be below xp once the daily cap is reached."""
    init_db()
    today = date.today()
    now = datetime.now(timezone.utc)
    with engine().begin() as connection:
        if xp > 0:
            day_start = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)
            earned_today = connection.execute(select(func.coalesce(func.sum(xp_events.c.xp), 0)).where(
                xp_events.c.student_id == student_id, xp_events.c.created_at >= day_start,
            )).scalar_one()
            xp = max(0, min(xp, DAILY_XP_CAP - int(earned_today)))
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
        "xp_awarded": xp,
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


def recent_xp(student_id: str, days: int = 14, tz_offset_minutes: int = 0, now: datetime | None = None) -> list[dict]:
    """XP per local day for the last `days` days, oldest first.

    tz_offset_minutes follows JavaScript's Date.getTimezoneOffset(): UTC minus local time.
    """
    init_db()
    offset = timedelta(minutes=max(-840, min(840, tz_offset_minutes)))
    now = now or datetime.now(timezone.utc)
    local_today = (now - offset).date()
    start_local = local_today - timedelta(days=days - 1)
    start_utc = datetime.combine(start_local, datetime.min.time(), tzinfo=timezone.utc) + offset
    with engine().connect() as connection:
        rows = connection.execute(select(xp_events.c.xp, xp_events.c.created_at).where(
            xp_events.c.student_id == student_id, xp_events.c.created_at >= start_utc,
        )).all()
    totals = {start_local + timedelta(days=index): 0 for index in range(days)}
    for xp, created_at in rows:
        stamp = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        day = (stamp - offset).date()
        if day in totals:
            totals[day] += int(xp)
    return [{"day": day.isoformat(), "xp": xp} for day, xp in totals.items()]


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
    # Only what a profile card shows; never the recipient's privacy settings or timestamps.
    friend = {key: recipient[key] for key in ("student_id", "username", "display_name", "avatar_path")}
    return {"request_id": request_id, "status": "pending", "friend": friend}


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
        active_days = _active_days(connection, [student_id, *friend_ids])
    today = date.today()
    return [{**dict(row), "active_today": row["last_active_date"] == today,
             "weekly_xp": weekly.get(row["student_id"], 0),
             "friend_streak": _shared_streak(active_days.get(student_id, set()), active_days.get(row["student_id"], set()))}
            for row in rows]


# Shared streaks only look back this far, so the query stays small for long-time students.
STREAK_LOOKBACK_DAYS = 400


def _active_days(connection, student_ids: list[str]) -> dict[str, set[date]]:
    """The distinct UTC days each student earned XP on, within the lookback window."""
    if connection.dialect.name == "postgresql":
        day = func.date(func.timezone("UTC", xp_events.c.created_at))
    else:
        # SQLite stores the UTC wall time as text; date() reads its calendar day.
        day = func.date(xp_events.c.created_at)
    cutoff = datetime.now(timezone.utc) - timedelta(days=STREAK_LOOKBACK_DAYS)
    rows = connection.execute(select(xp_events.c.student_id, day.label("day")).where(
        xp_events.c.student_id.in_(student_ids), xp_events.c.created_at >= cutoff,
    ).distinct()).all()
    active: dict[str, set[date]] = {}
    for owner_id, value in rows:
        if value is None:
            continue
        active.setdefault(owner_id, set()).add(value if isinstance(value, date) else date.fromisoformat(str(value)[:10]))
    return active


def _friend_streak(first_id: str, second_id: str) -> int:
    with engine().connect() as connection:
        active = _active_days(connection, [first_id, second_id])
    return _shared_streak(active.get(first_id, set()), active.get(second_id, set()))


def _shared_streak(first_days: set[date], second_days: set[date]) -> int:
    shared = first_days & second_days
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


# Each student can belong to at most this many study groups, counting ones they created.
MAX_GROUPS_PER_STUDENT = 5


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
        _advisory_lock(connection, f"groups:student:{student_id}")
        membership_count = connection.execute(select(func.count()).select_from(study_group_members).where(
            study_group_members.c.student_id == student_id,
        )).scalar_one()
        if membership_count >= MAX_GROUPS_PER_STUDENT:
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
        display_name = connection.execute(select(profiles.c.display_name).where(profiles.c.student_id == student_id)).scalar_one_or_none()
        if display_name is None:
            raise ValueError("profile_not_found")
        # Always group first, then student, so concurrent joins and creates can't deadlock.
        _advisory_lock(connection, f"groups:group:{group['id']}")
        _advisory_lock(connection, f"groups:student:{student_id}")
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
        if membership_count >= MAX_GROUPS_PER_STUDENT:
            raise ValueError("group_limit_reached")
        now = datetime.now(timezone.utc)
        connection.execute(study_group_members.insert().values(
            group_id=group["id"], student_id=student_id, role="member", joined_at=now,
        ))
        member_ids = connection.execute(select(study_group_members.c.student_id).where(
            study_group_members.c.group_id == group["id"], study_group_members.c.student_id != student_id,
        )).scalars().all()
        if member_ids:
            connection.execute(social_notifications.insert(), [{
                "recipient_id": member_id, "actor_id": student_id, "kind": "group_joined",
                "message": f"{display_name} joined {group['name']}.", "is_read": False, "created_at": now,
            } for member_id in member_ids])
    return get_study_group(student_id, group["id"])


def _blocked_by(connection, student_id: str) -> set[str]:
    """Everyone this student has blocked."""
    return set(connection.execute(select(social_blocks.c.blocked_id).where(
        social_blocks.c.blocker_id == student_id,
    )).scalars())


def _study_group_results(connection, student_id: str, groups: list[dict], roles: dict[str, str]) -> list[dict]:
    """Build several groups' views in three queries total (blocks, members, activity)
    instead of four per group. roles maps group ID to the viewer's role."""
    if not groups:
        return []
    group_ids = [group["id"] for group in groups]
    today_utc = datetime.now(timezone.utc).date()
    week_start = datetime.combine(today_utc - timedelta(days=today_utc.weekday()), datetime.min.time(), tzinfo=timezone.utc)
    member_ids_query = select(study_group_members.c.student_id).where(study_group_members.c.group_id.in_(group_ids))
    weekly = select(
        xp_events.c.student_id, func.sum(xp_events.c.xp).label("weekly_xp"),
    ).where(
        xp_events.c.created_at >= week_start, xp_events.c.student_id.in_(member_ids_query),
    ).group_by(xp_events.c.student_id).subquery()
    member_rows = connection.execute(select(
        study_group_members.c.group_id,
        profiles.c.student_id, profiles.c.username, profiles.c.display_name, profiles.c.avatar_path,
        study_group_members.c.role, study_group_members.c.joined_at,
        func.coalesce(weekly.c.weekly_xp, 0).label("weekly_xp"),
    ).join(study_group_members, profiles.c.student_id == study_group_members.c.student_id)
      .outerjoin(weekly, profiles.c.student_id == weekly.c.student_id)
      .where(study_group_members.c.group_id.in_(group_ids))
      .order_by(func.coalesce(weekly.c.weekly_xp, 0).desc(), profiles.c.display_name.asc())).mappings().all()
    members: dict[str, list[dict]] = {group_id: [] for group_id in group_ids}
    for row in member_rows:
        member = dict(row)
        members[member.pop("group_id")].append(member)
    # The viewer's activity feed leaves out anyone they have blocked.
    blocked = _blocked_by(connection, student_id)
    per_group = []
    for group_id in group_ids:
        visible = [member["student_id"] for member in members[group_id] if member["student_id"] not in blocked]
        if visible:
            per_group.append(select(
                literal(group_id).label("group_id"), xp_events.c.id, xp_events.c.student_id, xp_events.c.xp,
                xp_events.c.created_at, profiles.c.display_name,
            ).join(profiles, profiles.c.student_id == xp_events.c.student_id)
              .where(xp_events.c.student_id.in_(visible))
              .order_by(xp_events.c.created_at.desc()).limit(8).subquery())
    activity: dict[str, list[dict]] = {group_id: [] for group_id in group_ids}
    if per_group:
        # One round trip: each group's newest 8 events, combined with UNION ALL.
        combined = union_all(*[select(*part.c) for part in per_group]).subquery()
        for row in connection.execute(select(combined).order_by(combined.c.created_at.desc())).mappings():
            item = dict(row)
            activity[item.pop("group_id")].append(item)
    return [{
        "id": group["id"], "name": group["name"], "description": group["description"],
        "invite_code": group["invite_code"], "weekly_goal_xp": group["weekly_goal_xp"],
        "weekly_xp": sum(int(member["weekly_xp"] or 0) for member in members[group["id"]]),
        "role": roles[group["id"]], "created_at": group["created_at"],
        "members": members[group["id"]], "activity": activity[group["id"]],
    } for group in groups]


def get_study_group(student_id: str, group_id: str) -> dict:
    init_db()
    with engine().connect() as connection:
        row = connection.execute(select(study_groups, study_group_members.c.role.label("viewer_role")).join(
            study_group_members, study_groups.c.id == study_group_members.c.group_id,
        ).where(study_groups.c.id == group_id, study_group_members.c.student_id == student_id)).mappings().first()
        if not row:
            raise ValueError("group_not_found")
        return _study_group_results(connection, student_id, [dict(row)], {group_id: row["viewer_role"]})[0]


def list_study_groups(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        rows = connection.execute(select(study_groups, study_group_members.c.role.label("viewer_role")).join(
            study_group_members, study_groups.c.id == study_group_members.c.group_id,
        ).where(study_group_members.c.student_id == student_id)
          .order_by(study_group_members.c.joined_at.desc())).mappings().all()
        groups = [dict(row) for row in rows]
        return _study_group_results(connection, student_id, groups, {group["id"]: group["viewer_role"] for group in groups})


def leave_study_group(student_id: str, group_id: str, on_leave=None) -> bool:
    """Remove the student from the group. on_leave(connection) runs in the same
    transaction (tasks.leave_group uses it to unassign the student's open tasks)."""
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
        if on_leave is not None:
            on_leave(connection)
    return bool(result.rowcount)


def _between(first_id: str, second_id: str):
    """Quests created by either student with the other as partner."""
    return or_(
        and_(friend_quests.c.creator_id == first_id, friend_quests.c.partner_id == second_id),
        and_(friend_quests.c.creator_id == second_id, friend_quests.c.partner_id == first_id),
    )


def _cancel_quests_between(connection, first_id: str, second_id: str) -> None:
    """A quest only makes sense between friends; unfriending or blocking ends it."""
    connection.execute(update(friend_quests).where(
        _between(first_id, second_id), friend_quests.c.status.in_(("active", "complete")),
    ).values(status="cancelled"))


def remove_friend(student_id: str, friend_id: str) -> bool:
    init_db()
    with engine().begin() as connection:
        result = connection.execute(delete(friendships).where(or_(
            and_(friendships.c.requester_id == student_id, friendships.c.recipient_id == friend_id),
            and_(friendships.c.requester_id == friend_id, friendships.c.recipient_id == student_id),
        )))
        _cancel_quests_between(connection, student_id, friend_id)
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
        _advisory_lock(connection, "quest:" + ":".join(sorted((student_id, friend_id))))
        existing = connection.execute(select(friend_quests).where(
            friend_quests.c.status == "active", _between(student_id, friend_id),
        )).mappings().first()
        if existing:
            # A finished or expired quest no longer blocks a new one with the same friend.
            result = _settle_quest(connection, existing, student_id)
            if result["status"] == "active":
                return result
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


def _settle_quest(connection, row: dict, student_id: str) -> dict:
    """The quest's view for student_id, storing complete/expired once it is no longer active."""
    result = _quest_result(connection, row, student_id)
    if row["status"] == "active" and result["status"] in ("complete", "expired"):
        connection.execute(update(friend_quests).where(
            friend_quests.c.id == row["id"], friend_quests.c.status == "active",
        ).values(status=result["status"]))
    return result


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
    if row["status"] not in ("active", "complete"):
        status = row["status"]
    elif progress >= row["target_xp"] or row["status"] == "complete":
        status = "complete"
    elif expires_at < datetime.now(timezone.utc):
        status = "expired"
    else:
        status = "active"
    friend_id = row["partner_id"] if row["creator_id"] == student_id else row["creator_id"]
    friend = profiles_by_id.get(friend_id, {})
    return {"id": row["id"], "friend_id": friend_id, "friend_name": friend.get("display_name") or friend.get("username") or "Friend", "target_xp": row["target_xp"], "progress_xp": min(progress, row["target_xp"]), "status": status, "expires_at": expires_at}


def active_friend_quests(student_id: str) -> list[dict]:
    """Running quests with current friends, plus completed ones until their week ends.

    Quests that ran out are stored as expired (or complete) here and stop showing.
    """
    init_db()
    with engine().begin() as connection:
        friends = set(_friend_ids(connection, student_id))
        if not friends:
            return []
        rows = connection.execute(select(friend_quests).where(
            or_(
                and_(friend_quests.c.creator_id == student_id, friend_quests.c.partner_id.in_(friends)),
                and_(friend_quests.c.partner_id == student_id, friend_quests.c.creator_id.in_(friends)),
            ),
            friend_quests.c.status.in_(("active", "complete")),
        ).order_by(friend_quests.c.created_at.desc())).mappings().all()
        results = [_settle_quest(connection, row, student_id) for row in rows]
    now = datetime.now(timezone.utc)
    return [result for result in results
            if result["status"] == "active" or (result["status"] == "complete" and result["expires_at"] >= now)]


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
            xp_events.c.created_at >= week_start, xp_events.c.student_id.in_(friend_ids),
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
    # Match the typed text literally: % and _ would otherwise act as wildcards.
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    with engine().connect() as connection:
        excluded = _excluded_social_ids(connection, student_id)
        rows = connection.execute(select(
            profiles.c.student_id, profiles.c.username, profiles.c.display_name,
            profiles.c.avatar_path, profiles.c.friend_code,
        ).where(
            profiles.c.discoverable.is_(True), profiles.c.allow_friend_requests.is_(True),
            profiles.c.student_id.not_in(excluded),
            or_(
                func.lower(profiles.c.username).like(pattern, escape="\\"),
                func.lower(profiles.c.display_name).like(pattern, escape="\\"),
            ),
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


def _friend_ids(connection, student_id: str) -> list[str]:
    """Accepted friends only. Cheaper than list_friends when just the IDs are needed."""
    rows = connection.execute(select(friendships.c.requester_id, friendships.c.recipient_id).where(
        friendships.c.status == "accepted",
        or_(friendships.c.requester_id == student_id, friendships.c.recipient_id == student_id),
    )).all()
    return [recipient if requester == student_id else requester for requester, recipient in rows]


def activity_feed(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        ids = [student_id, *_friend_ids(connection, student_id)]
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
    with engine().begin() as connection:
        name = connection.execute(select(profiles.c.display_name).where(profiles.c.student_id == student_id)).scalar_one_or_none()
        if name is None:
            raise ValueError("profile_not_found")
        visible = {student_id, *_friend_ids(connection, student_id)}
        event = connection.execute(select(xp_events).where(xp_events.c.id == event_id, xp_events.c.student_id.in_(visible))).mappings().first()
        if not event:
            raise ValueError("activity_not_found")
        existing = connection.execute(select(social_reactions).where(social_reactions.c.event_id == event_id, social_reactions.c.reactor_id == student_id)).first()
        if existing:
            connection.execute(delete(social_reactions).where(social_reactions.c.event_id == event_id, social_reactions.c.reactor_id == student_id))
            return {"reacted": False}
        connection.execute(social_reactions.insert().values(event_id=event_id, reactor_id=student_id, reaction="high_five", created_at=datetime.now(timezone.utc)))
        if event["student_id"] != student_id:
            connection.execute(social_notifications.insert().values(
                recipient_id=event["student_id"], actor_id=student_id, kind="high_five",
                message=f"{name} celebrated your study session.", is_read=False, created_at=datetime.now(timezone.utc),
            ))
    return {"reacted": True}


def notifications_for(student_id: str) -> list[dict]:
    init_db()
    with engine().connect() as connection:
        blocked = _blocked_by(connection, student_id)
        conditions = [social_notifications.c.recipient_id == student_id]
        if blocked:
            conditions.append(or_(social_notifications.c.actor_id.is_(None), social_notifications.c.actor_id.not_in(blocked)))
        rows = connection.execute(select(social_notifications).where(
            *conditions
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
        _cancel_quests_between(connection, student_id, blocked_id)
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
        connection.execute(delete(cache_refs))
        connection.execute(delete(flashcard_cache))
        connection.execute(delete(extraction_cache))
        connection.execute(delete(grading_cache))
        connection.execute(delete(tutor_reply_cache))
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
