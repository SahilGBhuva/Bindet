"""Otto's per-student settings and memory.

- otto_profiles: what the student wants Otto to call them, Otto's personality (one of the
  fixed presets in ai_tutor.PERSONALITIES), an optional short "about me" note, and whether
  Otto may remember things about them (on by default).
- otto_memories: short, study-relevant facts Otto saved (source "otto") or the student
  added or edited (source "student"). At most ai_tutor.MEMORY_MAX_ITEMS items and
  ai_tutor.MEMORY_MAX_TOTAL_CHARS characters per student.

Every function takes the authenticated owner ID and filters by it. With memory turned
off, nothing is read for the tutor and Otto writes nothing. Everything here is deleted
with the account (account_deletion.py).
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import Boolean, Column, DateTime, Integer, MetaData, String, Table, delete, func, select, update

import ai_tutor
import database

otto_metadata = MetaData()

profiles = Table(
    "otto_profiles", otto_metadata,
    Column("owner_id", String(100), primary_key=True),
    Column("preferred_name", String(40), nullable=False, default=""),
    Column("personality", String(16), nullable=False, default=ai_tutor.DEFAULT_PERSONALITY),
    Column("about", String(400), nullable=False, default=""),
    Column("memory_enabled", Boolean, nullable=False, default=True),
    # Whether the student has been told (once) that Otto saved something about them.
    Column("memory_noticed", Boolean, nullable=False, default=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

memories = Table(
    "otto_memories", otto_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("owner_id", String(100), nullable=False, index=True),
    Column("text", String(160), nullable=False),
    Column("source", String(8), nullable=False, default="otto"),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

OTTO_TABLES = ("otto_memories", "otto_profiles")


@lru_cache(maxsize=1)
def init_otto() -> None:
    database.init_db()
    # Backend-only: created with RLS on and the client grants removed, in one transaction.
    database.create_locked_tables(database.engine(), otto_metadata, OTTO_TABLES, OTTO_TABLES)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


DEFAULT_PROFILE = {"preferred_name": "", "personality": ai_tutor.DEFAULT_PERSONALITY, "about": "",
                   "memory_enabled": True, "memory_noticed": False}


def _profile_row(connection, owner_id: str) -> dict:
    row = connection.execute(select(profiles).where(profiles.c.owner_id == owner_id)).mappings().first()
    if row is None:
        return dict(DEFAULT_PROFILE)
    personality = row["personality"] if row["personality"] in ai_tutor.PERSONALITIES else ai_tutor.DEFAULT_PERSONALITY
    return {"preferred_name": row["preferred_name"], "personality": personality, "about": row["about"],
            "memory_enabled": bool(row["memory_enabled"]), "memory_noticed": bool(row["memory_noticed"])}


def _upsert_profile(connection, owner_id: str, values: dict) -> None:
    exists = connection.execute(select(profiles.c.owner_id).where(profiles.c.owner_id == owner_id)).first()
    if exists:
        connection.execute(update(profiles).where(profiles.c.owner_id == owner_id).values(**values, updated_at=_now()))
    else:
        connection.execute(profiles.insert().values(**{**DEFAULT_PROFILE, **values, "owner_id": owner_id, "updated_at": _now()}))


def get_profile(owner_id: str) -> dict:
    init_otto()
    with database.engine().connect() as connection:
        return _profile_row(connection, owner_id)


def save_profile(owner_id: str, *, preferred_name: str, personality: str, about: str, memory_enabled: bool) -> dict:
    """Validates and saves. Raises ValueError("otto_name_rejected" | "otto_about_rejected" | "otto_personality")."""
    if personality not in ai_tutor.PERSONALITIES:
        raise ValueError("otto_personality")
    values = {
        "preferred_name": ai_tutor.clean_otto_name(preferred_name),
        "about": ai_tutor.clean_otto_about(about),
        "personality": personality,
        "memory_enabled": bool(memory_enabled),
    }
    init_otto()
    with database.engine().begin() as connection:
        _upsert_profile(connection, owner_id, values)
        return _profile_row(connection, owner_id)


def _memory(row) -> dict:
    return {"id": row["id"], "text": row["text"], "source": row["source"],
            "created_at": _utc(row["created_at"]), "updated_at": _utc(row["updated_at"])}


def _items(connection, owner_id: str) -> list[dict]:
    rows = connection.execute(select(memories).where(memories.c.owner_id == owner_id)
                              .order_by(memories.c.created_at.asc(), memories.c.id.asc())).mappings().all()
    return [_memory(row) for row in rows]


def list_memory(owner_id: str) -> dict:
    """The student's own view of their memory (shown even while it is turned off)."""
    init_otto()
    with database.engine().connect() as connection:
        profile = _profile_row(connection, owner_id)
        items = _items(connection, owner_id)
    return {"enabled": profile["memory_enabled"], "items": items,
            "limits": {"max_items": ai_tutor.MEMORY_MAX_ITEMS, "max_chars": ai_tutor.MEMORY_MAX_TOTAL_CHARS,
                       "item_max_chars": ai_tutor.MEMORY_ITEM_MAX_CHARS}}


def _fits(items: list[dict], text: str, replacing: int | None = None) -> bool:
    kept = [item for item in items if item["id"] != replacing]
    return len(kept) < ai_tutor.MEMORY_MAX_ITEMS and sum(len(item["text"]) for item in kept) + len(text) <= ai_tutor.MEMORY_MAX_TOTAL_CHARS


def add_memory(owner_id: str, text: str) -> dict:
    """The student adds an item. Raises ValueError("memory_disabled" | "memory_rejected" |
    "memory_sensitive" | "memory_duplicate" | "memory_full")."""
    clean = ai_tutor.clean_memory_text(text)
    init_otto()
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"otto:memory:{owner_id}")
        if not _profile_row(connection, owner_id)["memory_enabled"]:
            raise ValueError("memory_disabled")
        items = _items(connection, owner_id)
        if ai_tutor.memory_key(clean) in {ai_tutor.memory_key(item["text"]) for item in items}:
            raise ValueError("memory_duplicate")
        if not _fits(items, clean):
            raise ValueError("memory_full")
        now = _now()
        new_id = connection.execute(memories.insert().values(owner_id=owner_id, text=clean, source="student",
                                                             created_at=now, updated_at=now)).inserted_primary_key[0]
    return {"id": new_id, "text": clean, "source": "student", "created_at": now, "updated_at": now}


def edit_memory(owner_id: str, item_id: int, text: str) -> dict:
    """The student rewrites an item (it becomes theirs, so Otto won't change it). Raises
    ValueError("memory_not_found" | "memory_disabled" | ...) like add_memory."""
    clean = ai_tutor.clean_memory_text(text)
    init_otto()
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"otto:memory:{owner_id}")
        if not _profile_row(connection, owner_id)["memory_enabled"]:
            raise ValueError("memory_disabled")
        items = _items(connection, owner_id)
        target = next((item for item in items if item["id"] == item_id), None)
        if target is None:
            raise ValueError("memory_not_found")
        if ai_tutor.memory_key(clean) in {ai_tutor.memory_key(item["text"]) for item in items if item["id"] != item_id}:
            raise ValueError("memory_duplicate")
        if not _fits(items, clean, replacing=item_id):
            raise ValueError("memory_full")
        now = _now()
        connection.execute(update(memories).where(memories.c.id == item_id, memories.c.owner_id == owner_id)
                           .values(text=clean, source="student", updated_at=now))
    return {**target, "text": clean, "source": "student", "updated_at": now}


def delete_memory(owner_id: str, item_id: int) -> bool:
    init_otto()
    with database.engine().begin() as connection:
        deleted = connection.execute(delete(memories).where(memories.c.id == item_id, memories.c.owner_id == owner_id)).rowcount
    if not deleted:
        raise ValueError("memory_not_found")
    return True


def clear_memory(owner_id: str) -> int:
    init_otto()
    with database.engine().begin() as connection:
        return connection.execute(delete(memories).where(memories.c.owner_id == owner_id)).rowcount or 0


def tutor_context(owner_id: str) -> dict:
    """What the tutor may use for this student: {"name", "about", "personality", "memory": [texts],
    "memory_enabled"}. With memory off, no memory is read."""
    init_otto()
    with database.engine().connect() as connection:
        profile = _profile_row(connection, owner_id)
        texts: list[str] = []
        if profile["memory_enabled"]:
            texts = list(connection.execute(select(memories.c.text).where(memories.c.owner_id == owner_id)
                                            .order_by(memories.c.created_at.asc(), memories.c.id.asc())
                                            .limit(ai_tutor.MEMORY_MAX_ITEMS)).scalars().all())
    return {"name": profile["preferred_name"], "about": profile["about"], "personality": profile["personality"],
            "memory": ai_tutor.usable_memory(texts), "memory_enabled": profile["memory_enabled"]}


def memory_for_update(owner_id: str) -> list[dict] | None:
    """The items the memory model may see, or None when memory is turned off."""
    init_otto()
    with database.engine().connect() as connection:
        if not _profile_row(connection, owner_id)["memory_enabled"]:
            return None
        return [{"id": item["id"], "text": item["text"], "source": item["source"]} for item in _items(connection, owner_id)]


def apply_memory_ops(owner_id: str, ops: list[dict]) -> dict:
    """Apply validated ops (ai_tutor.validate_memory_ops) inside the caps. Returns {"changed",
    "notice"}: notice is True the first time Otto ever saves something for this student.
    Writes nothing if memory was turned off meanwhile."""
    if not ops:
        return {"changed": 0, "notice": False}
    init_otto()
    changed = 0
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"otto:memory:{owner_id}")
        profile = _profile_row(connection, owner_id)
        if not profile["memory_enabled"]:
            return {"changed": 0, "notice": False}
        items = _items(connection, owner_id)
        now = _now()
        for op in ops:
            if op["op"] == "remove":
                target = next((item for item in items if item["id"] == op["id"] and item["source"] == "otto"), None)
                if target:
                    connection.execute(delete(memories).where(memories.c.id == target["id"], memories.c.owner_id == owner_id))
                    items = [item for item in items if item["id"] != target["id"]]
                    changed += 1
                continue
            keys = {ai_tutor.memory_key(item["text"]) for item in items if item["id"] != op.get("id")}
            if ai_tutor.memory_key(op["text"]) in keys:
                continue
            if op["op"] == "replace":
                target = next((item for item in items if item["id"] == op["id"] and item["source"] == "otto"), None)
                if target and _fits(items, op["text"], replacing=target["id"]):
                    connection.execute(update(memories).where(memories.c.id == target["id"], memories.c.owner_id == owner_id)
                                       .values(text=op["text"], updated_at=now))
                    target["text"] = op["text"]
                    changed += 1
                continue
            if op["op"] == "add" and _fits(items, op["text"]):
                new_id = connection.execute(memories.insert().values(owner_id=owner_id, text=op["text"], source="otto",
                                                                     created_at=now, updated_at=now)).inserted_primary_key[0]
                items.append({"id": new_id, "text": op["text"], "source": "otto"})
                changed += 1
        notice = bool(changed) and not profile["memory_noticed"]
        if notice:
            _upsert_profile(connection, owner_id, {"memory_noticed": True})
    return {"changed": changed, "notice": notice}


def count_items(owner_id: str) -> int:
    init_otto()
    with database.engine().connect() as connection:
        return connection.execute(select(func.count()).select_from(memories).where(memories.c.owner_id == owner_id)).scalar_one()


def delete_for_account_in(connection, owner_id: str) -> None:
    """Account deletion: the student's memory and Otto settings, in the caller's transaction."""
    connection.execute(delete(memories).where(memories.c.owner_id == owner_id))
    connection.execute(delete(profiles).where(profiles.c.owner_id == owner_id))


def reset_otto() -> None:
    """Test helper."""
    init_otto()
    with database.engine().begin() as connection:
        connection.execute(delete(memories))
        connection.execute(delete(profiles))
