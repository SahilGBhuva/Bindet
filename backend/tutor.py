"""Tutor conversations and messages.

Every function takes the authenticated owner ID and filters by it, so one
student can never read or change another student's conversations. Images sent
to the tutor are never stored; a message keeps only their file names.
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import Column, DateTime, ForeignKey, Integer, MetaData, String, Table, Text, delete, func, select, update

import database

tutor_metadata = MetaData()

conversations = Table(
    "tutor_conversations", tutor_metadata,
    Column("id", String(32), primary_key=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("title", String(80), nullable=False),
    Column("course", String(120), nullable=False, default=""),
    Column("unit", String(160), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False, index=True),
)

messages = Table(
    "tutor_messages", tutor_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(32), ForeignKey("tutor_conversations.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("role", String(10), nullable=False),
    Column("content", Text, nullable=False),
    Column("attachments", Text, nullable=False, default="[]"),
    Column("model_tier", String(12), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

MAX_CONVERSATIONS = 500
MAX_HISTORY = 12


@lru_cache(maxsize=1)
def init_tutor() -> None:
    database.init_db()
    tutor_metadata.create_all(database.engine())
    if database.engine().dialect.name == "postgresql":
        with database.engine().begin() as connection:
            database.enable_row_level_security(connection, ("tutor_conversations", "tutor_messages"))


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _conversation(row) -> dict:
    return {
        "id": row["id"], "title": row["title"], "course": row["course"], "unit": row["unit"],
        "created_at": _utc(row["created_at"]), "updated_at": _utc(row["updated_at"]),
    }


def _message(row) -> dict:
    return {
        "id": row["id"], "role": row["role"], "content": row["content"],
        "attachments": json.loads(row["attachments"] or "[]"), "model_tier": row["model_tier"],
        "created_at": _utc(row["created_at"]),
    }


def _owned(connection, owner_id: str, conversation_id: str):
    row = connection.execute(select(conversations).where(
        conversations.c.id == conversation_id, conversations.c.owner_id == owner_id,
    )).mappings().first()
    if not row:
        raise ValueError("conversation_not_found")
    return row


def list_conversations(owner_id: str, limit: int = 50) -> list[dict]:
    init_tutor()
    with database.engine().connect() as connection:
        rows = connection.execute(select(conversations).where(conversations.c.owner_id == owner_id)
                                  .order_by(conversations.c.updated_at.desc()).limit(max(1, min(limit, 100)))).mappings().all()
    return [_conversation(row) for row in rows]


def start_conversation(owner_id: str, first_message: str, course: str = "", unit: str = "") -> dict:
    init_tutor()
    title = " ".join(first_message.split())[:80] or "New conversation"
    now = datetime.now(timezone.utc)
    row = {"id": secrets.token_hex(16), "owner_id": owner_id, "title": title, "course": course[:120], "unit": unit[:160], "created_at": now, "updated_at": now}
    with database.engine().begin() as connection:
        count = connection.execute(select(func.count()).select_from(conversations).where(conversations.c.owner_id == owner_id)).scalar_one()
        if count >= MAX_CONVERSATIONS:
            # Keep the newest conversations; the oldest one makes room.
            oldest = connection.execute(select(conversations.c.id).where(conversations.c.owner_id == owner_id)
                                        .order_by(conversations.c.updated_at.asc()).limit(1)).scalar_one()
            connection.execute(delete(messages).where(messages.c.conversation_id == oldest))
            connection.execute(delete(conversations).where(conversations.c.id == oldest))
        connection.execute(conversations.insert().values(**row))
    return _conversation(row)


def get_conversation(owner_id: str, conversation_id: str) -> dict:
    init_tutor()
    with database.engine().connect() as connection:
        return _conversation(_owned(connection, owner_id, conversation_id))


def list_messages(owner_id: str, conversation_id: str, before_id: int | None = None, limit: int = 50) -> list[dict]:
    """The newest `limit` messages (older than before_id when given), oldest first."""
    init_tutor()
    with database.engine().connect() as connection:
        _owned(connection, owner_id, conversation_id)
        query = select(messages).where(messages.c.conversation_id == conversation_id)
        if before_id:
            query = query.where(messages.c.id < before_id)
        rows = connection.execute(query.order_by(messages.c.id.desc()).limit(max(1, min(limit, 100)))).mappings().all()
    return [_message(row) for row in reversed(rows)]


def history_for_model(owner_id: str, conversation_id: str) -> list[dict]:
    return [{"role": item["role"], "content": item["content"]} for item in list_messages(owner_id, conversation_id, limit=MAX_HISTORY)]


def conversation_with_history(owner_id: str, conversation_id: str) -> tuple[dict, list[dict]]:
    """The owned conversation and its recent turns for the model, on one connection.

    Raises ValueError("conversation_not_found") when the conversation is missing or
    belongs to someone else, exactly like get_conversation.
    """
    init_tutor()
    with database.engine().connect() as connection:
        conversation = _conversation(_owned(connection, owner_id, conversation_id))
        rows = connection.execute(select(messages.c.role, messages.c.content).where(messages.c.conversation_id == conversation_id)
                                  .order_by(messages.c.id.desc()).limit(MAX_HISTORY)).mappings().all()
    return conversation, [{"role": row["role"], "content": row["content"]} for row in reversed(rows)]


def add_message(owner_id: str, conversation_id: str, role: str, content: str, attachments: list[str] | None = None, model_tier: str = "") -> dict:
    if role not in ("user", "assistant"):
        raise ValueError("invalid_role")
    init_tutor()
    now = datetime.now(timezone.utc)
    with database.engine().begin() as connection:
        _owned(connection, owner_id, conversation_id)
        message_id = connection.execute(messages.insert().values(
            conversation_id=conversation_id, role=role, content=content,
            attachments=json.dumps([name[:120] for name in (attachments or [])][:3]), model_tier=model_tier, created_at=now,
        )).inserted_primary_key[0]
        connection.execute(update(conversations).where(conversations.c.id == conversation_id).values(updated_at=now))
    return {"id": message_id, "role": role, "content": content, "attachments": attachments or [], "model_tier": model_tier, "created_at": now}


def delete_conversation(owner_id: str, conversation_id: str) -> bool:
    init_tutor()
    with database.engine().begin() as connection:
        _owned(connection, owner_id, conversation_id)
        connection.execute(delete(messages).where(messages.c.conversation_id == conversation_id))
        connection.execute(delete(conversations).where(conversations.c.id == conversation_id))
    return True


def reset_tutor() -> None:
    """Test helper."""
    init_tutor()
    with database.engine().begin() as connection:
        connection.execute(delete(messages))
        connection.execute(delete(conversations))
