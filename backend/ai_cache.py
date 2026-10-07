"""Caches that let bindit skip OpenRouter calls whose answer it already has.

Privacy rule: a cache hit only ever returns output derived purely from input the
requester already supplied. Shared (cross-user) caches are keyed on a sha256 of the
*full* input the model saw (note text, file bytes, question + answer), so nobody can
retrieve another student's output without already holding the identical input. The
tutor cache is per-account: its key includes the owner and the row stores it too.

Keys are hashes, and the request input itself (file bytes, typed answers, tutor
messages) is never stored as such. The stored outputs can still contain student
content, though: extraction_cache holds the full text read from an uploaded file,
flashcards and tutor replies quote notes, and grade explanations can quote an answer.
So every entry is tied to the owner and source that produced or used it (cache_refs):
deleting a note removes the entries made from it once no other note of any user
references them, deleting a tutor conversation removes its cached reply, and
purge_user_ai_data() removes everything an account is tied to.

Every key includes a version that fingerprints the prompt, model and generator
settings, so changing any of them invalidates old entries. Failures, empty results,
refusals and partial replies are never stored. Cache errors never fail a request: a
broken cache is a miss.

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
            # References whose entry expired (or was never stored) point at nothing.
            refs = database.cache_refs
            for name in RETENTION:
                table = _table(name)
                connection.execute(delete(refs).where(
                    refs.c.cache_table == name, refs.c.created_at < _now() - timedelta(days=1),
                    ~select(table.c.key).where(table.c.key == refs.c.key).exists(),
                ))
    except Exception:  # noqa: BLE001 - pruning is best effort
        return False
    return True


# --- Where entries came from (cache_refs) ---------------------------------------------

REF_TABLES = ("flashcard_cache", "extraction_cache", "grading_cache", "tutor_reply_cache", "question_bank")


def _cache_table_and_key(name: str):
    if name == "question_bank":
        import questions  # local: questions does not import ai_cache, but keep the graph one-way
        return questions.question_bank, questions.question_bank.c.cache_key
    table = _table(name)
    return table, table.c.key


def conversation_source(conversation_id: str) -> str:
    return f"conversation:{conversation_id}"


def add_ref(name: str, key: str, owner_id: str, source: str = "") -> bool:
    """Record that owner_id (via source: a note ID, conversation_source(...) or "") holds
    this cache entry. Idempotent. Never raises: a missing reference only means the entry
    lives until it expires instead of going with its source."""
    if not enabled() or not key or not owner_id or name not in REF_TABLES:
        return False
    try:
        database.init_db()
        refs = database.cache_refs
        insert = postgres_insert if database.engine().dialect.name == "postgresql" else sqlite_insert
        with database.engine().begin() as connection:
            connection.execute(insert(refs).values(
                cache_table=name, key=key, owner_id=owner_id, note_id=source[:80], created_at=_now(),
            ).on_conflict_do_nothing(index_elements=["cache_table", "key", "owner_id", "note_id"]))
        return True
    except Exception:  # noqa: BLE001 - caching is best effort
        return False


def _drop_unreferenced(connection, entries) -> int:
    """Delete each (cache_table, key) entry that no reference points to any more."""
    refs = database.cache_refs
    removed = 0
    for name, key in sorted(set(entries)):
        still_used = connection.execute(select(refs.c.key).where(refs.c.cache_table == name, refs.c.key == key).limit(1)).first()
        if still_used is None:
            table, key_column = _cache_table_and_key(name)
            removed += connection.execute(delete(table).where(key_column == key)).rowcount or 0
    return removed


def release_source(connection, owner_id: str, source: str) -> int:
    """Inside the caller's transaction: drop owner_id's references from source (a deleted
    note) and delete every entry that is now referenced by nobody (no other note of any
    user). Returns how many cache rows were deleted."""
    refs = database.cache_refs
    mine = (refs.c.owner_id == owner_id, refs.c.note_id == source)
    entries = connection.execute(select(refs.c.cache_table, refs.c.key).where(*mine)).all()
    if not entries:
        return 0
    connection.execute(delete(refs).where(*mine))
    return _drop_unreferenced(connection, [(name, key) for name, key in entries])


def release_conversation(connection, owner_id: str, conversation_id: str) -> int:
    """Inside the caller's transaction: delete the owner's cached tutor replies for this
    conversation's first message (even if another of the owner's conversations reused
    them) and every reference to them."""
    refs = database.cache_refs
    source = conversation_source(conversation_id)
    keys = connection.execute(select(refs.c.key).where(
        refs.c.cache_table == "tutor_reply_cache", refs.c.owner_id == owner_id, refs.c.note_id == source,
    )).scalars().all()
    if not keys:
        return 0
    connection.execute(delete(refs).where(refs.c.cache_table == "tutor_reply_cache", refs.c.owner_id == owner_id, refs.c.key.in_(keys)))
    table = _table("tutor_reply_cache")
    return connection.execute(delete(table).where(table.c.owner_id == owner_id, table.c.key.in_(keys))).rowcount or 0


def purge_user_ai_data(owner_id: str) -> int:
    """Delete every cached AI result tied to an account (for account deletion).

    Removes the owner's tutor replies, grades, private banked questions and recent
    questions outright, and the owner's references to shared entries (flashcards, OCR
    text), deleting those entries when nobody else references them. Returns how many
    cache rows were deleted. Entries cached before references were recorded are not
    linked to anyone and simply expire (RETENTION).
    """
    import questions
    database.init_db()
    questions.init_questions()
    refs = database.cache_refs
    with database.engine().begin() as connection:
        entries = connection.execute(select(refs.c.cache_table, refs.c.key).where(refs.c.owner_id == owner_id)).all()
        connection.execute(delete(refs).where(refs.c.owner_id == owner_id))
        removed = _drop_unreferenced(connection, [(name, key) for name, key in entries])
        tutor_table = _table("tutor_reply_cache")
        removed += connection.execute(delete(tutor_table).where(tutor_table.c.owner_id == owner_id)).rowcount or 0
        connection.execute(delete(questions.generated_questions).where(questions.generated_questions.c.student_id == owner_id))
    return removed


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
# difficulty, so all of them are in the key, and so is the student: a grade is only
# ever reused for the same student re-sending the same answer. Sharing grades across
# students would let one lucky jailbroken "correct" verdict be replayed by everyone who
# pastes that answer. A "correct" verdict for an answer that reads like instructions to
# the grader is never stored at all (see main.analyze_answer).

GRADE_FIELDS = ("correct", "score", "mistake_type", "explanation", "hint", "misconception")


def grading_version() -> str:
    return "grade-v1:" + fingerprint(
        ai_tutor.GRADE_PROMPT, ai_tutor.OPENROUTER_MODEL,
        ai_tutor.OPERATIONS["grade_answer"]["max_tokens"], ai_tutor.OPERATIONS["grade_answer"]["temperature"],
    )


def normalize_answer(answer: str) -> str:
    """Canonically normalised (NFC) with whitespace collapsed. Case is kept: it can matter
    (CO vs Co). NFC, not NFKC, so "x²" and "x2" or "10⁵" and "105" stay different answers."""
    return " ".join(unicodedata.normalize("NFC", answer or "").split())


def grading_key(*, student_id: str, question: str, correct_answer: str, student_answer: str, topic: str, difficulty: int) -> str:
    return make_key("grading", grading_version(), student_id, question, correct_answer, normalize_answer(student_answer), topic, int(difficulty))


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
# normalised message (case kept: "CO" and "Co" are different questions), a hash of the
# grounding the model saw (course, unit, note file names and note text), and the route
# tier and model that actually answered. Only replies whose stream finished normally
# (ai_tutor.finished_normally) are stored.

TUTOR_REPLY_PIECE_CHARS = 48


def tutor_version() -> str:
    return "tutor-v1:" + fingerprint(
        ai_tutor.TUTOR_SYSTEM_PROMPT, ai_tutor.OPENROUTER_MODEL, ai_tutor.OPENROUTER_TUTOR_STRONG_MODEL,
        ai_tutor.OPERATIONS["explain_material"]["max_tokens"], ai_tutor.OPERATIONS["explain_material"]["temperature"],
        ai_tutor.OFF_TOPIC_SENTINEL, ai_tutor.NOTES_OPEN, ai_tutor.NOTES_CLOSE,
    )


def normalize_message(message: str) -> str:
    """Whitespace collapsed, canonical (NFC) form. Case is kept: "What is CO?" (carbon
    monoxide) and "What is Co?" (cobalt) must not share a reply."""
    return " ".join(unicodedata.normalize("NFC", message or "").split())


def tutor_key(*, owner_id: str, message: str, course: str, unit: str, labels: list[str], source_text: str, tier: str, model: str = "") -> str:
    grounding = make_key("grounding", course, unit, json.dumps(labels[:10], ensure_ascii=False), (source_text or "").strip())
    return make_key("tutor", tutor_version(), owner_id, normalize_message(message), grounding, tier, model)


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
        connection.execute(delete(database.cache_refs))
        for name in RETENTION:
            connection.execute(delete(_table(name)))
