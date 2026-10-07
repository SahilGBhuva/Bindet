"""Caches that let bindit skip OpenRouter calls whose answer it already has.

Privacy rule: a cache hit only ever returns output derived purely from input the
requester already supplied. Shared (cross-user) caches are keyed on a sha256 of the
*full* input the model saw (note text, file bytes, question + answer), so nobody can
retrieve another student's output without already holding the identical input. The
tutor cache is per-account: its key includes the owner and the row stores it too.

Only hashes and model outputs are stored, never the raw input. Every key includes a
version that fingerprints the prompt, model and generator settings, so changing any
of them invalidates old entries. Failures, empty results, refusals and partial
replies are never stored. Cache errors never fail a request: a broken cache is a miss.

AI_CACHE_ENABLED=0 (or false/no/off) turns every cache off.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import Table, delete, select, update
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

import ai_tutor
import database
import note_ingestion

# How long entries stay usable; older rows are ignored and pruned.
RETENTION = {
    "flashcard_cache": timedelta(days=30),
    "extraction_cache": timedelta(days=30),
}
PRUNE_SECONDS = 600  # prune at most this often per server instance (like rate-limit events)
_last_prune = float("-inf")
_prune_lock = threading.Lock()


def enabled() -> bool:
    return os.getenv("AI_CACHE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def make_key(*parts: str | bytes | int) -> str:
    """sha256 over length-prefixed parts, so ("ab", "c") and ("a", "bc") never collide."""
    digest = hashlib.sha256()
    for part in parts:
        raw = part if isinstance(part, bytes) else str(part).encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def fingerprint(*pieces: object) -> str:
    """Short hash of everything that shapes a model's output (prompt, model, limits)."""
    return make_key(*(json.dumps(piece, sort_keys=True, default=str) for piece in pieces))[:16]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _table(name: str) -> Table:
    return database.metadata.tables[name]


def prune_if_due(now: float | None = None) -> bool:
    """Delete expired entries from every cache table. Returns True if it ran."""
    global _last_prune
    now = time.monotonic() if now is None else now
    with _prune_lock:
        if now - _last_prune < PRUNE_SECONDS:
            return False
        _last_prune = now
    try:
        with database.engine().begin() as connection:
            for name, keep in RETENTION.items():
                table = _table(name)
                connection.execute(delete(table).where(table.c.created_at < _now() - keep))
    except Exception:  # noqa: BLE001 - pruning is best effort
        return False
    return True


def lookup(name: str, key: str, owner_id: str | None = None):
    """The fresh row for this key (counting the hit), or None. Never raises."""
    if not enabled():
        return None
    try:
        database.init_db()
        prune_if_due()
        table = _table(name)
        query = select(table).where(table.c.key == key, table.c.created_at >= _now() - RETENTION[name])
        if owner_id is not None:
            query = query.where(table.c.owner_id == owner_id)
        with database.engine().begin() as connection:
            row = connection.execute(query).mappings().first()
            if row is not None:
                connection.execute(update(table).where(table.c.key == key).values(hits=table.c.hits + 1))
        return dict(row) if row is not None else None
    except Exception:  # noqa: BLE001 - a broken cache is a miss
        return None


def store(name: str, key: str, **values) -> bool:
    """Insert an entry; if the key exists the first entry is kept. Never raises."""
    if not enabled():
        return False
    try:
        database.init_db()
        table = _table(name)
        insert = postgres_insert if database.engine().dialect.name == "postgresql" else sqlite_insert
        with database.engine().begin() as connection:
            connection.execute(insert(table).values(key=key, created_at=_now(), hits=0, **values)
                               .on_conflict_do_nothing(index_elements=["key"]))
        return True
    except Exception:  # noqa: BLE001 - failing to cache must not fail the request
        return False


# --- Flashcards by note content -------------------------------------------------------
#
# The flashcard prompt includes the course, unit and file name (in the notes header),
# and the unit/course is the fallback topic, so all of them are part of the key.

def flashcard_version() -> str:
    return "flashcards-v1:" + fingerprint(
        ai_tutor.FLASHCARD_PROMPT, ai_tutor._DECK_SCHEMA, ai_tutor.OPENROUTER_MODEL, ai_tutor.FLASHCARD_NOTE_CHARS,
        ai_tutor.FLASHCARD_MAX_PER_NOTE, ai_tutor.FLASHCARD_CHARS_PER_CARD,
        ai_tutor.OPERATIONS["generate_flashcards"]["max_tokens"], ai_tutor.OPERATIONS["generate_flashcards"]["temperature"],
    )


def flashcard_key(*, course: str, unit: str, file_name: str, source_text: str) -> str:
    """source_text is the note text exactly as sent to the model (after flashcard_source_text)."""
    return make_key("flashcards", flashcard_version(), course, unit, file_name, source_text)


def cached_flashcards(key: str) -> list[dict] | None:
    row = lookup("flashcard_cache", key)
    if row is None or not isinstance(row["cards"], list) or not row["cards"]:
        return None
    return row["cards"]


def store_flashcards(key: str, cards: list[dict]) -> bool:
    if not cards:
        return False
    kept = [{"front": card["front"], "back": card["back"], "topic": card["topic"]} for card in cards]
    return store("flashcard_cache", key, cards=kept, card_count=len(kept))


# --- Note OCR / extraction by file content ---------------------------------------------
#
# Only the vision OCR path (images and scanned PDFs) is cached; ordinary text, DOCX and
# text-layer PDF extraction is local and costs no AI call. Shared across students only
# through a hash of the complete file bytes, so a hit returns text read from a file the
# uploader already holds.

def extraction_version() -> str:
    return "extract-v1:" + fingerprint(
        ai_tutor.OCR_IMAGE_PROMPT, ai_tutor.OCR_PDF_PROMPT, ai_tutor.OPENROUTER_VISION_MODEL,
        note_ingestion.MAX_OCR_PDF_PAGES, note_ingestion.MAX_STORED_CHARS,
    )


def extraction_key(content: bytes, content_type: str) -> str:
    return make_key("extraction", extraction_version(), content_type, content)


def cached_extraction(key: str) -> str | None:
    row = lookup("extraction_cache", key)
    text = row["text"] if row is not None else None
    return text if isinstance(text, str) and text.strip() else None


def store_extraction(key: str, text: str) -> bool:
    text = (text or "")[:note_ingestion.MAX_STORED_CHARS]
    if not text.strip():
        return False
    return store("extraction_cache", key, text=text)


def reset_caches() -> None:
    """Test helper (SQLite only)."""
    database.init_db()
    if database.engine().dialect.name != "sqlite":
        raise RuntimeError("reset_caches is only available for local SQLite databases")
    with database.engine().begin() as connection:
        for name in RETENTION:
            connection.execute(delete(_table(name)))
