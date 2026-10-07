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
import unicodedata
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
    "grading_cache": timedelta(days=30),
    "tutor_reply_cache": timedelta(days=7),
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


def flashcard_key(*, course: str, unit: str, file_name: str, source_text: str, instructions_hash: str = "") -> str:
    """source_text is the note text exactly as sent to the model (after flashcard_source_text).
    Cards made with student instructions are keyed by their hash too (ai_tutor.instructions_hash)."""
    parts = ["flashcards", flashcard_version(), course, unit, file_name, source_text]
    if instructions_hash:
        parts += ["instructions", instructions_hash]
    return make_key(*parts)


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


# --- Answer grading ----------------------------------------------------------------
#
# The grader sees the question, reference answer, student answer, topic and
# difficulty, so all of them are in the key. Shared across students only for the
# identical question and answer, which the requester has just typed themselves.

GRADE_FIELDS = ("correct", "score", "mistake_type", "explanation", "hint", "misconception")


def grading_version() -> str:
    return "grade-v1:" + fingerprint(
        ai_tutor.GRADE_PROMPT, ai_tutor.OPENROUTER_MODEL,
        ai_tutor.OPERATIONS["grade_answer"]["max_tokens"], ai_tutor.OPERATIONS["grade_answer"]["temperature"],
    )


def normalize_answer(answer: str) -> str:
    """Unicode-normalised with whitespace collapsed. Case is kept: it can matter (CO vs Co)."""
    return " ".join(unicodedata.normalize("NFKC", answer or "").split())


def grading_key(*, question: str, correct_answer: str, student_answer: str, topic: str, difficulty: int) -> str:
    return make_key("grading", grading_version(), question, correct_answer, normalize_answer(student_answer), topic, int(difficulty))


def cached_grade(key: str) -> dict | None:
    row = lookup("grading_cache", key)
    result = row["result"] if row is not None else None
    if not isinstance(result, dict) or set(result) != set(GRADE_FIELDS) or not isinstance(result["correct"], bool):
        return None
    return result


def store_grade(key: str, result: dict) -> bool:
    if set(result) != set(GRADE_FIELDS) or not isinstance(result.get("correct"), bool) or not result.get("explanation"):
        return False
    return store("grading_cache", key, result={field: result[field] for field in GRADE_FIELDS})


# --- Tutor replies (per account, never shared) ----------------------------------------
#
# Only the first message of a new conversation, without images, is cacheable: a
# follow-up carries history that makes it unique. The key holds the owner, the
# normalised message, a hash of the grounding the model saw (course, unit, note file
# names and note text) and the route tier.

TUTOR_REPLY_PIECE_CHARS = 48


def tutor_version() -> str:
    return "tutor-v1:" + fingerprint(
        ai_tutor.TUTOR_SYSTEM_PROMPT, ai_tutor.OPENROUTER_MODEL, ai_tutor.OPENROUTER_TUTOR_STRONG_MODEL,
        ai_tutor.OPERATIONS["explain_material"]["max_tokens"], ai_tutor.OPERATIONS["explain_material"]["temperature"],
        ai_tutor.OFF_TOPIC_SENTINEL, ai_tutor.NOTES_OPEN, ai_tutor.NOTES_CLOSE,
    )


def normalize_message(message: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", message or "").casefold().split())


def tutor_key(*, owner_id: str, message: str, course: str, unit: str, labels: list[str], source_text: str, tier: str) -> str:
    grounding = make_key("grounding", course, unit, json.dumps(labels[:10], ensure_ascii=False), (source_text or "").strip())
    return make_key("tutor", tutor_version(), owner_id, normalize_message(message), grounding, tier)


def cached_tutor_reply(key: str, owner_id: str) -> str | None:
    row = lookup("tutor_reply_cache", key, owner_id=owner_id)
    reply = row["reply"] if row is not None else None
    return reply if isinstance(reply, str) and reply.strip() else None


def store_tutor_reply(key: str, owner_id: str, reply: str) -> bool:
    if not reply or not reply.strip() or reply.strip() == ai_tutor.TUTOR_REFUSAL or ai_tutor.OFF_TOPIC_SENTINEL in reply:
        return False
    return store("tutor_reply_cache", key, owner_id=owner_id, reply=reply)


def reply_pieces(reply: str) -> list[str]:
    """A cached reply in small pieces, streamed as ordinary delta events."""
    return [reply[index:index + TUTOR_REPLY_PIECE_CHARS] for index in range(0, len(reply), TUTOR_REPLY_PIECE_CHARS)]


def reset_caches() -> None:
    """Test helper (SQLite only)."""
    database.init_db()
    if database.engine().dialect.name != "sqlite":
        raise RuntimeError("reset_caches is only available for local SQLite databases")
    with database.engine().begin() as connection:
        for name in RETENTION:
            connection.execute(delete(_table(name)))
