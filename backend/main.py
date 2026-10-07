from __future__ import annotations

import math
import os
import random
import re
import threading
import time
import unicodedata
import hashlib
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Literal

from fastapi import BackgroundTasks, Body, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi import Path as PathParam
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import func, select, text

import base64
import binascii
import json

import ai_cache
import ai_tutor
import auth
import database
import flashcards
import questions
import note_ingestion
import note_store
import rate_limit
import tutor
import tasks

# Refuse to start in production without a durable PostgreSQL database.
database.validate_database_configuration()

LOCAL_DEV_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def cors_origins() -> list[str]:
    """Browser origins allowed to call the API. Local dev servers only outside production;
    in production the frontend is served from the same origin as the API."""
    return [] if database.is_production() else list(LOCAL_DEV_ORIGINS)


def docs_settings() -> dict:
    """The interactive docs and the OpenAPI schema are for local development only."""
    if database.is_production():
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {}


app = FastAPI(
    title="Bindit API",
    version="1.2.0",
    description="Practice, accounts, profiles, secure progress tracking, personalized quizzes, AI flashcards, and AI tutoring.",
    **docs_settings(),
)

social_reads = ThreadPoolExecutor(max_workers=4, thread_name_prefix="bindit-social")
# Runs the independent database steps that precede an AI call side by side, so a
# request pays for the slowest of them instead of their sum.
ai_prep = ThreadPoolExecutor(max_workers=12, thread_name_prefix="bindit-ai-prep")


def gather(*calls):
    """Run (function, *args) calls concurrently and return their results in order.

    The first failure (in call order) is re-raised once every call has been
    started, so a failed limit check still raises the same error it always did.
    """
    futures = [ai_prep.submit(function, *args) for function, *args in calls]
    return [future.result() for future in futures]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Server-Timing", "X-Bindit-Response-Ms"],
)


@app.middleware("http")
async def limit_request_rate(request, call_next):
    """Burst guard: refuse floods before any sign-in check, database or AI work (see rate_limit.py)."""
    address = rate_limit.address_of(request.headers, request.client.host if request.client else None)
    rate_limit.client_address.set(address)
    wait = rate_limit.check_request(request.url.path, request.method, address, request.headers.get("authorization"))
    if wait:
        seconds = rate_limit.retry_after(wait)
        return JSONResponse(
            status_code=429,
            content={"detail": f"You’re sending requests too quickly. Wait {seconds} seconds and try again."},
            headers={"Retry-After": seconds},
        )
    return await call_next(request)


@app.middleware("http")
async def measure_request_time(request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["Server-Timing"] = f'app;dur={elapsed_ms:.1f}'
    response.headers["X-Bindit-Response-Ms"] = f'{elapsed_ms:.1f}'
    return response

# Body caps per route. Ordinary JSON routes carry a few KB at most, so they get a
# small cap: Starlette reads and parses the whole JSON body on the event loop, and a
# huge body would stall every other request on the instance. Only the note upload
# (10 MB file plus form fields) and tutor messages (images up to 8.5 MB in total,
# about 11.4 MB as base64, plus text) need more.
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024
LARGE_BODY_ROUTES = {
    "/api/notes": MAX_REQUEST_BYTES,
    "/api/tutor/messages": MAX_REQUEST_BYTES,
}


def _size_label(limit: int) -> str:
    if limit >= 1024 * 1024:
        return f"{limit // (1024 * 1024)} MB"
    return f"{max(1, limit // 1024)} KB"


class RequestBodyLimit:
    """Pure ASGI middleware: refuse oversized bodies with 413 before any route uses them.

    Content-Length is checked up front. Bodies without one (chunked) are counted as
    they stream in; once over the cap the app sees the body end early, and whatever
    it answers is replaced with the 413, so a missing header cannot slip past.

    max_bytes applies to every path not listed in route_limits.
    """

    def __init__(self, app, max_bytes: int = MAX_REQUEST_BYTES, route_limits: dict[str, int] | None = None):
        self.app = app
        self.max_bytes = max_bytes
        self.route_limits = dict(route_limits or {})

    def limit_for(self, path: str, root_path: str = "") -> int:
        """The cap for a path, matched the way routing would: without the app's mount
        prefix (root_path, which ASGI servers may include in path) or a trailing slash."""
        root_path = root_path.rstrip("/")
        if root_path and (path == root_path or path.startswith(root_path + "/")):
            path = path[len(root_path):]
        path = path.rstrip("/") or "/"
        return self.route_limits.get(path, self.max_bytes)

    def _response(self, status: int, detail: str) -> JSONResponse:
        return JSONResponse(status_code=status, content={"detail": detail})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        max_bytes = self.limit_for(scope.get("path", ""), scope.get("root_path", ""))
        too_large = f"That request is too large. Keep it under {_size_label(max_bytes)}."
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None:
            try:
                length = int(declared)
            except ValueError:
                await self._response(400, "Invalid Content-Length header")(scope, receive, send)
                return
            if length > max_bytes:
                await self._response(413, too_large)(scope, receive, send)
                return
        received = 0
        overflowed = False
        replaced = False

        async def counted_receive():
            nonlocal received, overflowed
            if overflowed:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > max_bytes:
                    overflowed = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        async def guarded_send(message):
            nonlocal replaced
            if not overflowed:
                await send(message)
                return
            if not replaced and message["type"] == "http.response.start":
                replaced = True
                response = self._response(413, too_large)
                await send({"type": "http.response.start", "status": 413, "headers": response.raw_headers})
                await send({"type": "http.response.body", "body": response.body})

        await self.app(scope, counted_receive, guarded_send)


# Added last so it is the outermost middleware and runs before rate limiting or auth.
app.add_middleware(RequestBodyLimit, max_bytes=MAX_JSON_BYTES, route_limits=LARGE_BODY_ROUTES)


@app.exception_handler(RequestValidationError)
async def request_validation_error(request, exc: RequestValidationError):
    """422 with where and why, but never the submitted input (or ctx, which can quote it).

    The default handler echoes each invalid value back, which turns a large bad
    payload into an equally large response.
    """
    errors = [
        {"loc": list(error.get("loc", ())), "msg": str(error.get("msg", ""))[:200], "type": str(error.get("type", ""))}
        for error in exc.errors()[:20]
    ]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})

Topic = Literal["addition", "subtraction", "multiplication", "division", "mixed"]

# Unauthenticated callers choose their own ID, so it is stored under this prefix.
# Supabase account IDs are bare UUIDs and can never contain it, which means a
# guest request can never read or write a real account's rows.
GUEST_ID_PREFIX = "guest:"
GUEST_ID_MAX_LENGTH = 100 - len(GUEST_ID_PREFIX)


def ai_session_id(*parts: str) -> str:
    """Stable, non-identifying key for OpenRouter provider stickiness."""
    value = "\x1f".join(part.strip().lower() for part in parts)
    return f"bindit-{hashlib.blake2s(value.encode('utf-8'), digest_size=16).hexdigest()}"


def question_scope_is_shared(source_text: str) -> bool:
    """Questions without the student's notes go to a bank every student draws from."""
    return not source_text.strip()


def neutral_personalization(target_topic: str) -> dict:
    """What the model is told about the student for a shared question: nothing.

    A banked shared question is served to other students, so it must never depend on
    (or reveal) one student's weak topics, accuracy or streak.
    """
    return {
        "overall_attempts": 0,
        "overall_accuracy": None,
        "current_topic": target_topic,
        "current_topic_attempts": 0,
        "current_topic_accuracy": None,
        "weak_topics": [],
        "streak": 0,
    }


def question_cache_key(student_id: str, course: str, unit: str, focus: str, difficulty: int, source_text: str) -> str:
    """Share generic questions, while keeping note-grounded (personalized) questions private."""
    owner_scope = "shared" if question_scope_is_shared(source_text) else student_id
    source_fingerprint = hashlib.blake2s(source_text.encode("utf-8"), digest_size=12).hexdigest() if source_text else "none"
    return ai_session_id(owner_scope, course, unit, focus, str(difficulty), source_fingerprint)


# Database row IDs (32-bit integer columns). Anything outside this range can't exist,
# so it is refused before it reaches a query.
MAX_DB_ID = 2**31 - 1
DbId = Annotated[int, PathParam(ge=1, le=MAX_DB_ID)]


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_id: str = Field(min_length=16, max_length=64)
    student_answer: str = Field(max_length=2000)
    student_id: str = Field(default="anonymous", min_length=1, max_length=GUEST_ID_MAX_LENGTH)


class AnswerResponse(BaseModel):
    correct: bool
    score: int = Field(ge=0, le=100)
    mistake_type: str | None
    misconception: str | None = None
    explanation: str
    hint: str | None
    grading_source: Literal["deterministic", "ai", "fallback"]
    xp_earned: int
    total_xp: int
    streak: int


def _clip_names(max_items: int, max_chars: int) -> BeforeValidator:
    """Keep the first few names, each cut to a sane length. These lists are hints, so
    clipping beats rejecting a real student whose unit has many notes."""
    def clip(value):
        if not isinstance(value, list):
            return value
        return [item[:max_chars] if isinstance(item, str) else item for item in value[:max_items]]
    return BeforeValidator(clip)


FileNames = Annotated[list[str], _clip_names(30, 255)]
UnitNames = Annotated[list[str], _clip_names(30, 160)]
CourseNames = Annotated[list[str], _clip_names(30, 120)]


class NoteContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    course: str = Field(default="", max_length=120)
    unit: str = Field(default="", max_length=160)
    files: FileNames = Field(default_factory=list)
    other_units: UnitNames = Field(default_factory=list)
    other_courses: CourseNames = Field(default_factory=list)


class QuestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: Topic = "mixed"
    difficulty: int = Field(default=1, ge=1, le=3)
    student_id: str = Field(default="anonymous", min_length=1, max_length=GUEST_ID_MAX_LENGTH)
    notes: NoteContext | None = None


class GeneratedQuestion(BaseModel):
    question: str
    correct_answer: str
    topic: str
    difficulty: int


class QuestionResponse(BaseModel):
    question_id: str
    question: str
    topic: str
    difficulty: int


TUTOR_HOURLY_LIMIT = 60
TUTOR_DAILY_LIMIT = 200
# Replies routed to OPENROUTER_TUTOR_STRONG_MODEL per account per day; after that the
# normal model answers hard questions too.
TUTOR_STRONG_PER_DAY = 30
# Most characters of earlier turns sent with each tutor message (newest kept first).
TUTOR_HISTORY_MAX_CHARS = 16_000
# Tutor replies one account may be streaming at once, per server instance.
TUTOR_MAX_CONCURRENT_STREAMS = 2
# A stream that never started (the client left before the first byte) frees its slot after this.
TUTOR_STREAM_SLOT_SECONDS = 300
# Every paid AI call across all accounts per day; past it AI features pause with a 503.
AI_DAILY_GLOBAL_LIMIT_DEFAULT = 20_000
GLOBAL_AI_BUDGET_ID = "global:ai"
NOTE_UPLOADS_PER_DAY = 60
AI_OCR_PER_DAY = 30
GUEST_QUESTIONS_PER_DAY = 300
TUTOR_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
TUTOR_IMAGE_MAX_BYTES = 4 * 1024 * 1024
TUTOR_IMAGE_TOO_LARGE = "Images must be 4 MB or smaller"
# All images in one message together; as base64 this still fits the 12 MB body cap.
TUTOR_IMAGES_TOTAL_MAX_BYTES = int(8.5 * 1024 * 1024)
TUTOR_IMAGES_TOO_LARGE = "Attached images must add up to 8.5 MB or less"


class TutorImage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="image", max_length=120)
    # 4 MB of image data is about 5.6 million base64 characters; tutor_image_parts
    # checks the exact decoded size, so this only stops absurd payloads early.
    data_url: str = Field(min_length=20, max_length=5_600_000)


class TutorMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str | None = Field(default=None, max_length=32)
    content: str = Field(min_length=1, max_length=4000)
    course: str = Field(default="", max_length=120)
    unit: str = Field(default="", max_length=160)
    images: list[TutorImage] = Field(default_factory=list, max_length=3)


TaskStatus = Literal["todo", "in_progress", "review", "done"]
TaskPriority = Literal["low", "medium", "high", "urgent"]
TASK_CREATE_LIMIT = 200
TASK_WRITE_LIMIT = 900
TASK_COMMENT_LIMIT = 120
# Changing who is assigned notifies people, so it has its own, tighter hourly cap.
TASK_ASSIGN_LIMIT = 60


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=140)
    description: str = Field(default="", max_length=4000)
    course: str = Field(default="", max_length=120)
    project: str = Field(default="", max_length=120)
    status: TaskStatus = "todo"
    priority: TaskPriority = "medium"
    due_date: str | None = Field(default=None, max_length=10)
    due_time: str | None = Field(default=None, max_length=5)
    group_id: str | None = Field(default=None, max_length=32)
    assignee_ids: list[str] | None = Field(default=None, max_length=10)
    milestone_id: int | None = Field(default=None, ge=0, le=MAX_DB_ID)
    kind: Literal["task", "event"] = "task"
    location: str = Field(default="", max_length=160)


class TaskUpdate(BaseModel):
    """Only fields the client sends are applied; send null to clear an optional field."""
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=140)
    description: str | None = Field(default=None, max_length=4000)
    course: str | None = Field(default=None, max_length=120)
    project: str | None = Field(default=None, max_length=120)
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    due_date: str | None = Field(default=None, max_length=10)
    due_time: str | None = Field(default=None, max_length=5)
    assignee_ids: list[str] | None = Field(default=None, max_length=10)
    group_id: str | None = Field(default=None, max_length=32)
    milestone_id: int | None = Field(default=None, ge=0, le=MAX_DB_ID)
    sort_order: int | None = None
    kind: Literal["task", "event"] | None = None
    location: str | None = Field(default=None, max_length=160)


class ChecklistItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=200)


class ChecklistItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(default=None, min_length=1, max_length=200)
    done: bool | None = None


class TaskCommentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str = Field(min_length=1, max_length=2000)


class TaskAttachmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["link", "note"]
    url: str = Field(default="", max_length=500)
    label: str = Field(default="", max_length=160)
    note_id: str = Field(default="", max_length=36)


class GroupNotice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=200)


class MilestoneCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=80)
    due_date: str | None = Field(default=None, max_length=10)


class FlashcardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    student_id: str = Field(default="anonymous", min_length=1, max_length=100)
    course: str = Field(default="", max_length=120)
    unit: str = Field(default="", max_length=160)
    files: FileNames = Field(default_factory=list)
    count: int = Field(default=10, ge=3, le=30)


class Flashcard(BaseModel):
    front: str
    back: str
    topic: str


class FlashcardResponse(BaseModel):
    course: str
    unit: str
    personalized: bool
    cards: list[Flashcard]


class NoteResponse(BaseModel):
    id: str
    course: str
    unit: str
    file_name: str
    content_type: str
    size_bytes: int
    status: Literal["ready"] = "ready"
    text_preview: str
    created_at: datetime
    pages_skipped: int = 0
    notice: str | None = None


class TopicStat(BaseModel):
    topic: str
    attempts: int
    correct_answers: int
    accuracy: float


class DailyXp(BaseModel):
    day: str
    xp: int


class ProgressResponse(BaseModel):
    student_id: str
    total_xp: int
    attempts: int
    correct_answers: int
    accuracy: float
    streak: int
    best_streak: int
    login_streak: int = 0
    best_login_streak: int = 0
    weak_topics: list[str]
    topics: list[TopicStat] = Field(default_factory=list)
    recent_xp: list[DailyXp] = Field(default_factory=list)


AVATAR_PATH_PATTERN = r"^$|^[A-Za-z0-9-]{1,100}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|gif)$"


def avatar_path_belongs_to(student_id: str, avatar_path: str | None) -> bool:
    return not avatar_path or avatar_path.split("/", 1)[0] == student_id


class AccountProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(pattern=r"^[a-z0-9_]{3,24}$")
    display_name: str = Field(min_length=1, max_length=40)
    guest_id: str | None = Field(default=None, min_length=1, max_length=100)
    # Empty, or a path in the student's own storage folder: "<student_id>/<uuid>.<ext>"
    # (the shape storage.upload_private_image creates). The owner part is checked in the route.
    avatar_path: str | None = Field(default=None, max_length=200, pattern=AVATAR_PATH_PATTERN)
    daily_goal: int | None = None


class ProfileResponse(BaseModel):
    student_id: str
    username: str
    display_name: str
    avatar_path: str = ""
    friend_code: str
    daily_goal: int = 20
    discoverable: bool = True
    allow_friend_requests: bool = True
    total_xp: int = 0
    streak: int = 0
    best_streak: int = 0
    login_streak: int = 0
    best_login_streak: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AccountResponse(BaseModel):
    id: str
    email: str | None = None
    username: str | None = None


class AuthConfigResponse(BaseModel):
    supabase_url: str
    supabase_anon_key: str


class DailyLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Ignored: the student is always the authenticated caller. Accepted for older clients.
    student_id: str | None = Field(default=None, max_length=100)


class FriendRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    friend_code: str = Field(min_length=4, max_length=12)


class FriendRequestDecision(BaseModel):
    accept: bool


class FriendQuestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    friend_id: str = Field(min_length=1, max_length=100)
    target_xp: int = Field(default=100, ge=50, le=1000)


class StudyGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=48)
    description: str = Field(default="", max_length=160)
    weekly_goal_xp: int = Field(default=500, ge=100, le=10000)


class StudyGroupJoin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invite_code: str = Field(min_length=6, max_length=10)


class SocialPrivacyUpdate(BaseModel):
    discoverable: bool
    allow_friend_requests: bool


class SocialReportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=2, max_length=40)
    details: str = Field(default="", max_length=1000)


def normalize_text(value: str) -> str:
    return " ".join(value.strip().lower().split())


# Numbers further than this many powers of ten from 1 are not graded as numbers.
# Huge exponents ("1e999999999") overflow or stall Decimal arithmetic, and no real
# answer needs them; such text is compared as text instead.
MAX_DECIMAL_EXPONENT = 50


def finite_decimal(text: str) -> Decimal | None:
    """Decimal(text) when it is a finite number of sane magnitude, else None.

    NaN, sNaN and Infinity are refused, as is any value whose exponent or magnitude
    is beyond MAX_DECIMAL_EXPONENT. Never raises.
    """
    try:
        number = Decimal(text)
        if not number.is_finite():
            return None
        exponent = number.as_tuple().exponent
        if not isinstance(exponent, int) or abs(exponent) > MAX_DECIMAL_EXPONENT:
            return None
        if number and abs(number.adjusted()) > MAX_DECIMAL_EXPONENT:
            return None
        return number
    except (ArithmeticError, ValueError, TypeError):
        return None


def parse_number(value: str) -> Decimal | None:
    cleaned = value.strip().replace(",", "")
    if cleaned.endswith("%"):
        cleaned = cleaned[:-1].strip()
    return finite_decimal(cleaned)


def truthy_alias(value: str) -> str:
    aliases = {"yes": "true", "y": "true", "true": "true", "no": "false", "n": "false", "false": "false"}
    return aliases.get(normalize_text(value), normalize_text(value))


_FILE_NAME = re.compile(r"^[^\s/\\]+\.[a-z]{2,4}$")


def file_stem(value: str) -> str:
    """A note's file name without its extension, so "mendel" matches "mendel.pdf".

    Only a single word ending in a short alphabetic extension counts as a file
    name; "3.7 cm" or "3.5" keep their full text so "3" can never match them.
    """
    text = normalize_text(value)
    return text.rsplit(".", 1)[0] if _FILE_NAME.match(text) else text


# --- Deterministic grading ----------------------------------------------------------
# Answers that can be judged exactly are graded here, instantly and for free; only
# genuinely open answers go to the AI grader.

_NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
}
_QUANTITY = re.compile(
    r"^(?P<number>[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?)"
    r"(?:\s*/\s*(?P<denominator>\d+))?"
    r"\s*(?P<unit>%|[a-zµ°][a-zµ°²³/^0-9]{0,11})?$"
)
_ARTICLE = re.compile(r"^(?:the|a|an)\s+")
MATH_TOPICS = {"addition", "subtraction", "multiplication", "division"}


def canonical_answer(value: str) -> str:
    """Case, width, spacing, surrounding quotes, a leading article and a final full stop
    never change what an answer means. Inner symbols are kept: "-f(x)" and "f(-x)" differ."""
    text = unicodedata.normalize("NFKC", value).replace("\u2212", "-").casefold()
    text = " ".join(text.split()).strip("\"'`“”‘’ ")
    text = text.rstrip(".!? ").strip()
    return _ARTICLE.sub("", text)


def parse_quantity(value: str) -> tuple[Decimal, str, int] | None:
    """(value, unit, decimal places) for answers like "12", "3.5 cm", "1/2", "40%", "seven"."""
    text = canonical_answer(value)
    if text in _NUMBER_WORDS:
        return Decimal(_NUMBER_WORDS[text]), "", 0
    match = _QUANTITY.match(text)
    if not match or not any(char.isdigit() for char in match["number"]):
        return None
    number = finite_decimal(match["number"].replace(",", ""))
    if number is None:
        return None
    if match["denominator"]:
        denominator = finite_decimal(match["denominator"])
        if denominator is None or denominator == 0:
            return None
        try:
            # A fraction is exact, so it may match a rounded decimal at any precision.
            return number / denominator, match["unit"] or "", 28
        except ArithmeticError:
            return None
    places = max(0, -number.as_tuple().exponent) if "e" not in match["number"] else 0
    return number, match["unit"] or "", places


def _rounds_to(exact: Decimal, rounded: Decimal, places: int) -> bool:
    """True when `rounded`, given to `places` (2 or more) decimals, is `exact` correctly rounded."""
    if places < 2 or places > 12:
        return False
    try:
        return exact.quantize(Decimal(1).scaleb(-places)) == rounded
    except ArithmeticError:
        return False


def quantities_match(student: tuple[Decimal, str, int], reference: tuple[Decimal, str, int]) -> bool:
    try:
        return _quantities_match(student, reference)
    except ArithmeticError:
        return False


def _quantities_match(student: tuple[Decimal, str, int], reference: tuple[Decimal, str, int]) -> bool:
    student_value, _, student_places = student
    reference_value, reference_unit, reference_places = reference
    # A missing % sign is forgiven, and "0.4" also answers "40%".
    candidates = [student_value]
    if reference_unit == "%" and student[1] != "%":
        candidates.append(student_value * 100)
    for value in candidates:
        if value == reference_value:
            return True
        if abs(value - reference_value) <= Decimal("1e-9") * max(Decimal(1), abs(reference_value)):
            return True
        # Correct rounding either way: 3.14 for 3.14159, or 0.333 written for an exact 1/3.
        if _rounds_to(reference_value, value, student_places) or _rounds_to(value, reference_value, reference_places):
            return True
    return False


def deterministic_verdict(student_answer: str, correct_answer: str, topic: str = "") -> bool | None:
    """True or False when the answer can be judged exactly, None when it needs the AI grader.

    Correct answers are recognised for every question. An answer is only judged
    wrong here when that is certain and an AI explanation would add nothing: a
    blank answer, or a wrong number on a generated arithmetic exercise.
    """
    if not canonical_answer(student_answer):
        return False
    if answers_match(student_answer, correct_answer):
        return True
    student = parse_quantity(student_answer)
    reference = parse_quantity(correct_answer)
    if student and reference:
        units_agree = not student[1] or not reference[1] or student[1] == reference[1] or "%" in (student[1], reference[1])
        if units_agree and quantities_match(student, reference):
            return True
        if topic in MATH_TOPICS and not student[1] and not reference[1]:
            return False
        return None
    if canonical_answer(student_answer) == canonical_answer(correct_answer):
        return True
    return None


def answers_match(student_answer: str, correct_answer: str) -> bool:
    student_number = parse_number(student_answer)
    correct_number = parse_number(correct_answer)
    if student_number is not None and correct_number is not None:
        try:
            return student_number == correct_number
        except ArithmeticError:
            return False
    if truthy_alias(student_answer) == truthy_alias(correct_answer):
        return True
    if file_stem(student_answer) == file_stem(correct_answer) and file_stem(correct_answer):
        return True
    return normalize_text(student_answer) == normalize_text(correct_answer)


def classify_mistake(student_answer: str, correct_answer: str) -> str:
    if not student_answer.strip():
        return "blank_answer"
    student_number = parse_number(student_answer)
    correct_number = parse_number(correct_answer)
    if student_number is not None and correct_number is not None:
        try:
            if student_number == -correct_number:
                return "sign_error"
            if abs(student_number - correct_number) == 1:
                return "off_by_one"
            if correct_number != 0 and (student_number * 10 == correct_number or student_number == correct_number * 10):
                return "place_value_error"
        except ArithmeticError:
            return "concept_or_format_error"
        return "calculation_error"
    return "concept_or_format_error"


def make_hint(question: str, mistake_type: str) -> str:
    hints = {
        "blank_answer": "Start by identifying what the question is asking and write down what you know.",
        "sign_error": "Check whether the result should be positive or negative.",
        "off_by_one": "Recount once carefully; your answer is only one away.",
        "place_value_error": "Check the decimal point and each number's place value.",
        "calculation_error": "Break the calculation into smaller steps and check each one.",
        "concept_or_format_error": "State the key idea first, then connect it directly to what the question asks.",
    }
    lowered = question.lower()
    base = hints[mistake_type]
    if "/" in question or "divide" in lowered:
        return base + " Remember: division asks how many equal groups can be made."
    if "*" in question or "×" in question:
        return base + " You can check multiplication with repeated addition."
    return base


def number_range(difficulty: int) -> tuple[int, int]:
    return {1: (1, 10), 2: (10, 50), 3: (25, 150)}[difficulty]


def generate_math_question(topic: Topic, difficulty: int) -> GeneratedQuestion:
    chosen = random.choice(["addition", "subtraction", "multiplication", "division"]) if topic == "mixed" else topic
    low, high = number_range(difficulty)
    if chosen == "addition":
        a, b = random.randint(low, high), random.randint(low, high)
        question, answer = f"What is {a} + {b}?", a + b
    elif chosen == "subtraction":
        a, b = random.randint(low, high), random.randint(low, high)
        a, b = max(a, b), min(a, b)
        question, answer = f"What is {a} - {b}?", a - b
    elif chosen == "multiplication":
        upper = {1: 10, 2: 15, 3: 25}[difficulty]
        a, b = random.randint(2, upper), random.randint(2, upper)
        question, answer = f"What is {a} × {b}?", a * b
    else:
        divisor = random.randint(2, {1: 10, 2: 15, 3: 25}[difficulty])
        answer = random.randint(2, {1: 10, 2: 20, 3: 40}[difficulty])
        question = f"What is {divisor * answer} ÷ {divisor}?"
    return GeneratedQuestion(question=question, correct_answer=str(answer), topic=chosen, difficulty=difficulty)


def generate_notes_question(notes: NoteContext, difficulty: int) -> GeneratedQuestion:
    """Legacy offline helper retained for compatibility with existing tests."""
    files = [name.strip() for name in notes.files if name.strip()]
    if not files:
        return generate_math_question("mixed", difficulty)
    file_name = random.choice(files)
    unit = notes.unit.strip() or "this unit"
    course = notes.course.strip() or "this course"
    return GeneratedQuestion(
        question=f'Which course are the notes “{file_name}” saved in?',
        correct_answer=course,
        topic=unit,
        difficulty=difficulty,
    )


def guest_student_id(claimed_id: str) -> str:
    return f"{GUEST_ID_PREFIX}{claimed_id}"


def verified_student_id(claimed_id: str, authorization: str | None) -> str:
    """Authenticated callers are their token's subject; anyone else is a namespaced guest."""
    if authorization:
        return auth.authenticated_user(authorization)["id"]
    return guest_student_id(claimed_id)


def topic_stats(record: dict) -> list[TopicStat]:
    stats = []
    for topic, row in record.get("topics", {}).items():
        attempts = row["attempts"]
        correct = row["correct"]
        accuracy = round(correct / attempts * 100, 1) if attempts else 0.0
        stats.append(TopicStat(topic=topic, attempts=attempts, correct_answers=correct, accuracy=accuracy))
    return sorted(stats, key=lambda item: (-item.attempts, item.topic.lower()))


def progress_response(student_id: str, record: dict) -> ProgressResponse:
    accuracy = round(record["correct_answers"] / record["attempts"] * 100, 1) if record["attempts"] else 0.0
    weak = [
        topic for topic, stats in record["topics"].items()
        if stats["attempts"] >= 2 and stats["correct"] / stats["attempts"] < 0.6
    ]
    return ProgressResponse(
        student_id=student_id,
        total_xp=record["total_xp"],
        attempts=record["attempts"],
        correct_answers=record["correct_answers"],
        accuracy=accuracy,
        streak=record["streak"],
        best_streak=record["best_streak"],
        login_streak=record.get("login_streak", 0),
        best_login_streak=record.get("best_login_streak", 0),
        weak_topics=weak,
        topics=topic_stats(record),
    )


def quiz_personalization(student_id: str, requested_difficulty: int, target_topic: str) -> tuple[int, dict]:
    record = database.get_progress(student_id) or {}
    topics = record.get("topics", {})
    target = topics.get(target_topic, {})
    topic_attempts = int(target.get("attempts", 0))
    topic_correct = int(target.get("correct", 0))
    topic_accuracy = round(topic_correct / topic_attempts * 100, 1) if topic_attempts else None
    attempts = int(record.get("attempts", 0))
    correct = int(record.get("correct_answers", 0))
    overall_accuracy = round(correct / attempts * 100, 1) if attempts else None

    difficulty = requested_difficulty
    if topic_attempts >= 3 and topic_accuracy is not None and topic_accuracy >= 85:
        difficulty = min(3, difficulty + 1)
    elif topic_attempts >= 2 and topic_accuracy is not None and topic_accuracy < 55:
        difficulty = max(1, difficulty - 1)

    weak_topics = [
        name for name, stats in topics.items()
        if stats.get("attempts", 0) >= 2 and stats.get("correct", 0) / stats["attempts"] < 0.6
    ]
    return difficulty, {
        "overall_attempts": attempts,
        "overall_accuracy": overall_accuracy,
        "current_topic": target_topic,
        "current_topic_attempts": topic_attempts,
        "current_topic_accuracy": topic_accuracy,
        "weak_topics": weak_topics[:8],
        "streak": int(record.get("streak", 0)),
    }


def social_error(error: ValueError) -> HTTPException:
    messages = {
        "username_taken": (409, "That username is already taken"),
        "invalid_daily_goal": (400, "Pick a daily goal of 10, 20, 30, or 50 XP"),
        "friend_not_found": (404, "No learner was found with that friend code"),
        "cannot_friend_self": (400, "You cannot add yourself"),
        "friendship_exists": (409, "You are already friends or a request is pending"),
        "friend_requests_disabled": (403, "This learner is not accepting friend requests"),
        "profile_not_found": (400, "Finish setting up your profile first"),
        "request_not_found": (404, "Friend request not found"),
        "request_already_answered": (409, "That friend request was already answered"),
        "invalid_quest_target": (400, "Friend quests must be between 50 and 1000 XP"),
        "activity_not_found": (404, "That activity is not available"),
        "cannot_block_self": (400, "You cannot block yourself"),
        "cannot_report_self": (400, "You cannot report yourself"),
        "social_rate_limited": (429, "You’re doing that too quickly. Please wait and try again."),
        "invalid_group_name": (400, "Group names must be between 2 and 48 characters"),
        "invalid_group_goal": (400, "The weekly group goal must be between 100 and 10,000 XP"),
        "group_not_found": (404, "That study group could not be found"),
        "already_in_group": (409, "You are already in that study group"),
        "group_full": (409, "That study group already has 20 members"),
        "group_limit_reached": (409, "You can be in up to 5 study groups. Leave one to start or join another."),
        "group_owner_cannot_leave": (409, "Group owners cannot leave their group"),
        "task_not_found": (404, "That task could not be found"),
        "task_forbidden": (403, "Only the task creator, its assignees, or the group owner can change this task"),
        "task_manage_forbidden": (403, "Only the task creator or the group owner can change the title, due date, assignees, milestone or group"),
        "task_owner_not_in_group": (409, "The task creator isn’t a member of that group"),
        "invalid_task_title": (400, "Give the task a title"),
        "invalid_task_status": (400, "Choose a valid task status"),
        "invalid_task_priority": (400, "Choose a valid priority"),
        "invalid_due_date": (400, "Use a valid due date"),
        "invalid_due_time": (400, "Use a valid due time"),
        "invalid_assignee": (400, "Tasks can only be assigned to members of the task's group"),
        "too_many_assignees": (400, "A task can have up to 10 assignees"),
        "task_limit_reached": (409, "You have reached the task limit. Delete finished tasks to add more."),
        "invalid_checklist_item": (400, "Checklist items need some text"),
        "checklist_full": (409, "A task can have up to 50 checklist items"),
        "checklist_item_not_found": (404, "That checklist item could not be found"),
        "invalid_comment": (400, "Write a comment first"),
        "comment_not_found": (404, "That comment could not be found"),
        "invalid_attachment": (400, "That attachment type is not supported"),
        "invalid_attachment_url": (400, "Links must start with http:// or https://"),
        "attachments_full": (409, "A task can have up to 20 attachments"),
        "attachment_not_found": (404, "That attachment could not be found"),
        "note_not_found": (404, "Note not found"),
        "milestone_not_found": (404, "That milestone could not be found in this group"),
        "invalid_milestone": (400, "Give the milestone a title"),
        "milestone_limit_reached": (409, "A group can have up to 30 milestones"),
        "group_owner_required": (403, "Only the group owner can do that"),
        "invalid_task_kind": (400, "Choose task or event"),
        "invalid_notice": (400, "Write a message for the group"),
    }
    status, message = messages.get(str(error), (400, "Could not update that profile"))
    headers = {"Retry-After": "60"} if status == 429 else None
    return HTTPException(status_code=status, detail=message, headers=headers)


MATH_QUESTIONS_PER_DAY = 300    # signed-in practice questions without a course or unit
FIRST_TRY_XP = 10
RETRY_XP = 5


AI_PAUSED = "bindit’s AI features have reached today’s limit. Please try again later."


def ai_daily_global_limit() -> int:
    try:
        return max(0, int(os.getenv("AI_DAILY_GLOBAL_LIMIT", "") or AI_DAILY_GLOBAL_LIMIT_DEFAULT))
    except ValueError:
        return AI_DAILY_GLOBAL_LIMIT_DEFAULT


def global_ai_available() -> bool:
    """Spend one call from the shared daily AI budget. False once it is used up.

    Counted in the database, so the budget holds across every server instance.
    Callers check their per-student limits first, so refused requests cost nothing here.
    """
    try:
        database.check_social_rate_limit(GLOBAL_AI_BUDGET_ID, "ai_call", ai_daily_global_limit(), 1440)
    except ValueError:
        return False
    return True


def spend_global_ai_call() -> None:
    """Like global_ai_available, but answers a friendly 503 when the budget is used up."""
    if not global_ai_available():
        raise HTTPException(status_code=503, detail=AI_PAUSED, headers={"Retry-After": "3600"})


class StreamSlots:
    """In-memory count of the tutor replies each account is streaming on this instance."""

    def __init__(self) -> None:
        self._slots: dict[str, dict[int, float]] = {}
        self._lock = threading.Lock()
        self._next = 0

    def acquire(self, owner: str, limit: int, now: float | None = None) -> int | None:
        """A slot token, or None when the account already has `limit` live streams."""
        now = time.monotonic() if now is None else now
        with self._lock:
            live = {token: started for token, started in self._slots.get(owner, {}).items()
                    if now - started < TUTOR_STREAM_SLOT_SECONDS}
            if len(live) >= limit:
                self._slots[owner] = live
                return None
            self._next += 1
            live[self._next] = now
            self._slots[owner] = live
            return self._next

    def release(self, owner: str, token: int) -> None:
        with self._lock:
            live = self._slots.get(owner)
            if live is not None:
                live.pop(token, None)
                if not live:
                    del self._slots[owner]

    def reset(self) -> None:
        with self._lock:
            self._slots.clear()


tutor_streams = StreamSlots()


def trim_history(history: list[dict], max_chars: int = TUTOR_HISTORY_MAX_CHARS) -> list[dict]:
    """The most recent turns whose text adds up to at most max_chars."""
    kept: list[dict] = []
    used = 0
    for item in reversed(history):
        size = len(item.get("content") or "")
        if used + size > max_chars:
            break
        kept.append(item)
        used += size
    return list(reversed(kept))


def limit_action(student_id: str, action: str, limit: int, window_minutes: int = 60) -> None:
    """Durable per-action limit (shared across server instances); raises a friendly 429."""
    try:
        database.check_social_rate_limit(student_id, action, limit, window_minutes)
    except ValueError as error:
        raise social_error(error) from error


@app.get("/")
def home():
    return {"message": "bindet backend is running", "version": app.version}


HEALTH_DB_CACHE_SECONDS = 5.0
_health_db_probe: dict = {"at": float("-inf"), "result": None}


def _database_probe() -> dict:
    """select 1, at most once per HEALTH_DB_CACHE_SECONDS per instance.

    /api/health is exempt from the rate limiter, so the cache keeps ?db=1 from
    becoming a way to hammer the database. Errors are reported without details,
    because they can include connection information.
    """
    now = time.monotonic()
    if now - _health_db_probe["at"] < HEALTH_DB_CACHE_SECONDS and _health_db_probe["result"] is not None:
        return _health_db_probe["result"]
    started = time.perf_counter()
    try:
        with database.engine().connect() as connection:
            connection.execute(text("select 1"))
        result = {"ok": True, "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                  "dialect": database.engine().dialect.name}
    except Exception:  # noqa: BLE001 - any failure means "not reachable"
        result = {"ok": False, "latency_ms": round((time.perf_counter() - started) * 1000, 1)}
    _health_db_probe.update(at=now, result=result)
    return result


@app.get("/api/health")
@app.get("/health", include_in_schema=False)
def health(db: bool = False):
    """Liveness by default (no database work). ?db=1 also checks the database."""
    if not db:
        return {"status": "healthy"}
    probe = _database_probe()
    body = {"status": "healthy" if probe["ok"] else "degraded", "database": probe}
    return body if probe["ok"] else JSONResponse(status_code=503, content=body)


@app.post("/api/ai/warm")
def warm_ai():
    """Called when a student is about to use an AI feature (focusing the tutor, opening a quiz).

    It wakes this instance and opens the pooled OpenRouter connection ahead of the
    real request. It needs no sign-in because it touches no student data and sends
    nothing to the model; it runs at most once every few minutes per instance.
    """
    return {"warming": ai_tutor.warm_connection()}


@app.get("/api/auth/config", response_model=AuthConfigResponse)
def auth_config():
    url, key = auth.public_settings()
    return {"supabase_url": url, "supabase_anon_key": key}


def note_response(row: dict, pages_skipped: int = 0) -> NoteResponse:
    notice = None
    if pages_skipped:
        kept = note_ingestion.MAX_OCR_PDF_PAGES
        notice = f"Only the first {kept} pages of this scanned PDF were read. Upload the remaining {pages_skipped} pages as a separate file."
    return NoteResponse(
        id=row["id"], course=row["course"], unit=row["unit"], file_name=row["file_name"],
        content_type=row["content_type"], size_bytes=row["size_bytes"], status="ready",
        text_preview=row["text"][:500], created_at=row["created_at"],
        pages_skipped=pages_skipped, notice=notice,
    )


# The content types a note upload may be stored with, by extension. The first is the default.
NOTE_CONTENT_TYPES = {
    ".pdf": ("application/pdf",),
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",),
    ".txt": ("text/plain",),
    ".md": ("text/markdown", "text/x-markdown", "text/plain"),
    ".csv": ("text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"),
    ".json": ("application/json", "text/json", "text/plain"),
    ".png": ("image/png",),
    ".jpg": ("image/jpeg", "image/jpg"),
    ".jpeg": ("image/jpeg", "image/jpg"),
    ".webp": ("image/webp",),
}


# What an image note's bytes must be, by extension (checked with sniff_image_type).
NOTE_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
NOTE_IMAGE_MISMATCH = "That image couldn’t be read. Upload a real PNG, JPG or WebP photo of your notes."


def note_content_type(suffix: str, claimed: str | None) -> str:
    """The browser's content type if it fits the extension, else the extension's default."""
    allowed = NOTE_CONTENT_TYPES.get(suffix)
    if not allowed:
        return ""
    value = (claimed or "").split(";", 1)[0].strip().lower()[:100]
    return value if value in allowed else allowed[0]


@app.post("/api/notes", response_model=NoteResponse, status_code=201)
async def upload_note(
    course: Annotated[str, Form(min_length=1, max_length=120)],
    unit: Annotated[str, Form(min_length=1, max_length=160)],
    file: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
):
    # Sign-in checks, parsing, OCR and the database are all blocking calls. They run in
    # the thread pool so a slow OCR request never stalls the event loop, and with it
    # every other request (including streaming tutor replies) on this instance.
    user = await run_in_threadpool(auth.authenticated_user, authorization)
    await run_in_threadpool(limit_action, user["id"], "note_upload", NOTE_UPLOADS_PER_DAY, 1440)
    content = await file.read(note_ingestion.MAX_NOTE_BYTES + 1)
    return await run_in_threadpool(ingest_note, user["id"], course, unit, file.filename or "notes", file.content_type, content)


def cached_ocr_text(owner: str, cache_key: str) -> str | None:
    """Text already read from identical file bytes, or None (logged as a hit or miss)."""
    text = ai_cache.cached_extraction(cache_key)
    if text is not None:
        ai_tutor.log_ai_event("extract_notes", outcome="cache_hit", student_id=owner, tier="vision")
    elif ai_cache.enabled():
        ai_tutor.log_ai_event("extract_notes", outcome="cache_miss", student_id=owner, tier="vision")
    return text


def ingest_note(owner: str, course: str, unit: str, filename: str, claimed_type: str | None, content: bytes) -> NoteResponse:
    suffix = Path(filename).suffix.lower()
    content_type = note_content_type(suffix, claimed_type)
    pages_skipped = 0
    try:
        if suffix in note_ingestion.IMAGE_EXTENSIONS:
            if len(content) > note_ingestion.MAX_NOTE_BYTES:
                raise note_ingestion.NoteIngestionError("Notes must be 10 MB or smaller")
            if not content:
                raise note_ingestion.NoteIngestionError("The uploaded file is empty")
            # The bytes must really be the image type the extension claims; the
            # browser's label and the file name are never trusted on their own.
            actual_type = sniff_image_type(content)
            if actual_type is None or actual_type != NOTE_IMAGE_TYPES.get(suffix):
                raise HTTPException(status_code=415, detail=NOTE_IMAGE_MISMATCH)
            content_type = actual_type
            # The same image was read before (by anyone: the key hashes its full bytes),
            # so reuse that text without an OCR quota, budget or model call.
            cache_key = ai_cache.extraction_key(content, content_type)
            text = cached_ocr_text(owner, cache_key)
            if text is None:
                limit_action(owner, "ai_ocr", AI_OCR_PER_DAY, 1440)
                spend_global_ai_call()
                ai_tutor.warm_connection()
                # The image goes to the vision model only; it is never stored.
                text = note_ingestion.clean_text(ai_tutor.extract_image_notes(
                    image_bytes=content, content_type=content_type
                ))
                ai_cache.store_extraction(cache_key, text)
        else:
            try:
                text = note_ingestion.extract_text(filename, content)
            except note_ingestion.NoteIngestionError as exc:
                if suffix == ".pdf" and str(exc) == "No readable text was found in that file":
                    ocr_pdf, pages_skipped = note_ingestion.first_pdf_pages(content)
                    cache_key = ai_cache.extraction_key(content, "application/pdf")
                    text = cached_ocr_text(owner, cache_key)
                    if text is None:
                        limit_action(owner, "ai_ocr", AI_OCR_PER_DAY, 1440)
                        spend_global_ai_call()
                        ai_tutor.warm_connection()
                        text = note_ingestion.clean_text(ai_tutor.extract_pdf_notes(pdf_bytes=ocr_pdf))
                        ai_cache.store_extraction(cache_key, text)
                else:
                    raise
    except ai_tutor.AITutorError as exc:
        if str(exc).startswith("No readable notes"):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        raise HTTPException(status_code=503, detail=OCR_UNAVAILABLE) from exc
    except note_ingestion.NoteIngestionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not text:
        raise HTTPException(status_code=400, detail="No readable text was found in that file")
    row = note_store.save_note(owner, course.strip(), unit.strip(), Path(filename).name[:255], content_type, text, len(content))
    return note_response(row, pages_skipped)


@app.get("/api/notes", response_model=list[NoteResponse])
def get_notes(course: Annotated[str, Query(max_length=120)], unit: Annotated[str, Query(max_length=160)], authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    return [note_response(row) for row in note_store.list_notes(user["id"], course.strip(), unit.strip())]


@app.get("/api/notes/{note_id}", response_model=NoteResponse)
def get_note(note_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    row = note_store.get_note(user["id"], note_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return note_response(row)


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    limit_action(user["id"], "note_delete", 120)
    # The note's flashcards and their generation state go with it.
    if not flashcards.delete_note_and_cards(user["id"], note_id):
        raise HTTPException(status_code=404, detail="Note not found")
    return {"deleted": True}


@app.get("/api/auth/me", response_model=AccountResponse)
def auth_me(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    return {
        "id": user["id"],
        "email": user.get("email"),
        "username": (user.get("user_metadata") or {}).get("username"),
    }


@app.get("/api/account/profile", response_model=ProfileResponse)
def get_account_profile(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    database.record_daily_login(user["id"])
    profile = database.get_profile(user["id"])
    if profile is None:
        raise HTTPException(status_code=404, detail="Finish setting up your profile")
    progress = database.get_progress(user["id"])
    if progress:
        profile["login_streak"] = progress.get("login_streak", 0)
        profile["best_login_streak"] = progress.get("best_login_streak", 0)
    return profile


@app.get("/api/friends")
def get_friends(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    student_id = user["id"]
    readers = {
        "friends": database.list_friends,
        "requests": database.pending_friend_requests,
        "leaderboard": database.friend_leaderboard,
        "quests": database.active_friend_quests,
        "suggestions": database.suggested_people,
        "activity": database.activity_feed,
        "notifications": database.notifications_for,
    }
    pending = {name: social_reads.submit(reader, student_id) for name, reader in readers.items()}
    return {
        name: future.result() for name, future in pending.items()
    }


@app.get("/api/study-groups")
def get_study_groups(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    return database.list_study_groups(user["id"])


@app.post("/api/study-groups", status_code=201)
def create_study_group(data: StudyGroupCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "group_create", 8, 1440)
        return database.create_study_group(user["id"], data.name, data.description, data.weekly_goal_xp)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/study-groups/join")
def join_study_group(data: StudyGroupJoin, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "group_join", 20, 1440)
        return database.join_study_group(user["id"], data.invite_code)
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/study-groups/{group_id}/members/me")
def leave_study_group(group_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "group_leave", 20, 1440)
        tasks.leave_group(user["id"], group_id)
    except ValueError as error:
        raise social_error(error) from error
    return {"left": True}


@app.get("/api/tutor/conversations")
def tutor_conversations(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    return tutor.list_conversations(user["id"])


@app.get("/api/tutor/conversations/{conversation_id}/messages")
def tutor_messages(conversation_id: str, before: Annotated[int | None, Query(ge=1, le=MAX_DB_ID)] = None, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        return tutor.list_messages(user["id"], conversation_id, before_id=before)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Conversation not found") from error


@app.delete("/api/tutor/conversations/{conversation_id}")
def delete_tutor_conversation(conversation_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    limit_action(user["id"], "tutor_delete", 60)
    try:
        return {"deleted": tutor.delete_conversation(user["id"], conversation_id)}
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Conversation not found") from error


def sniff_image_type(raw: bytes) -> str | None:
    """Identify an image by its magic bytes; the declared data URL type is never trusted."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def tutor_image_parts(images: list[TutorImage]) -> list[dict]:
    """Validate data URLs (type, size, real base64, magic bytes) before anything is sent to a model."""
    parts = []
    total = 0
    for image in images:
        header, _, encoded = image.data_url.partition(",")
        content_type = header.removeprefix("data:").removesuffix(";base64")
        if not header.startswith("data:") or not header.endswith(";base64") or content_type not in TUTOR_IMAGE_TYPES:
            raise HTTPException(status_code=415, detail="Attach a JPG, PNG, WebP, or GIF image")
        # Cheap length check before decoding: 4 base64 characters carry 3 bytes.
        if len(encoded) > (TUTOR_IMAGE_MAX_BYTES + 2) // 3 * 4 + 4:
            raise HTTPException(status_code=413, detail=TUTOR_IMAGE_TOO_LARGE)
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="That image could not be read. Try attaching it again.") from error
        if not raw:
            raise HTTPException(status_code=400, detail="That image is empty")
        if len(raw) > TUTOR_IMAGE_MAX_BYTES:
            raise HTTPException(status_code=413, detail=TUTOR_IMAGE_TOO_LARGE)
        total += len(raw)
        if total > TUTOR_IMAGES_TOTAL_MAX_BYTES:
            raise HTTPException(status_code=413, detail=TUTOR_IMAGES_TOO_LARGE)
        actual_type = sniff_image_type(raw)
        if actual_type is None:
            raise HTTPException(status_code=415, detail="Attach a JPG, PNG, WebP, or GIF image")
        # A mislabelled but genuine image is relabelled with its real type.
        data_url = image.data_url if actual_type == content_type else f"data:{actual_type};base64,{encoded}"
        parts.append({"type": "image_url", "image_url": {"url": data_url}})
    return parts


# Streamed replies must reach the browser token by token: no caching, no proxy
# buffering (nginx-style X-Accel-Buffering) and no transforms such as compression.
SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


def sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str, ensure_ascii=False)}\n\n"


OCR_UNAVAILABLE = "Reading that file took too long or the reader is unavailable. Try again in a moment, or upload a text PDF, DOCX or TXT instead."
TUTOR_RATE_LIMITED = "You’ve sent a lot of messages this hour. Take a short break and try again soon."
TUTOR_DAILY_LIMITED = "You’ve reached today’s tutor limit. It resets within a day."
TUTOR_TOO_MANY_STREAMS = "The tutor is still answering your other messages. Wait for one to finish, then try again."
TUTOR_UNAVAILABLE = "The tutor is unavailable right now. Your message is saved, so you can try again in a moment."
TUTOR_NOT_SAVED = "Your message couldn’t be saved. Try sending it again."


def tutor_limits(owner: str) -> None:
    """Hourly then daily per-account tutor limits. Raises ValueError("hour" | "day")."""
    try:
        database.check_social_rate_limit(owner, "tutor_message", TUTOR_HOURLY_LIMIT, 60)
    except ValueError as error:
        raise ValueError("hour") from error
    try:
        database.check_social_rate_limit(owner, "tutor_message_day", TUTOR_DAILY_LIMIT, 1440)
    except ValueError as error:
        raise ValueError("day") from error


def capped_tutor_route(owner: str, content: str, has_images: bool) -> dict:
    """ai_tutor.tutor_route, but the configured strong model only TUTOR_STRONG_PER_DAY times a day."""
    route = ai_tutor.tutor_route(content, has_images)
    strong = ai_tutor.OPENROUTER_TUTOR_STRONG_MODEL
    if strong and route["model"] == strong and strong != ai_tutor.OPENROUTER_MODEL:
        try:
            database.check_social_rate_limit(owner, "tutor_strong", TUTOR_STRONG_PER_DAY, 1440)
        except ValueError:
            route = {**route, "model": ai_tutor.OPENROUTER_MODEL}
    return route


@app.post("/api/tutor/messages")
def send_tutor_message(data: TutorMessageRequest, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    owner = user["id"]
    content = data.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Write a message first")
    image_parts = tutor_image_parts(data.images)
    slot = tutor_streams.acquire(owner, TUTOR_MAX_CONCURRENT_STREAMS)
    if slot is None:
        raise HTTPException(status_code=429, detail=TUTOR_TOO_MANY_STREAMS, headers={"Retry-After": "10"})
    try:
        return _send_tutor_message(data, owner, content, image_parts, slot)
    except BaseException:
        tutor_streams.release(owner, slot)
        raise


def _send_tutor_message(data: TutorMessageRequest, owner: str, content: str, image_parts: list[dict], slot: int):
    ai_tutor.warm_connection()  # the TLS/HTTP2 setup overlaps the database work below

    # Independent preparation runs side by side: the hourly limit, the conversation
    # with its recent turns, and the student's notes when the request names them.
    requested_course, requested_unit = data.course.strip(), data.unit.strip()
    limit = ai_prep.submit(tutor_limits, owner)
    existing = ai_prep.submit(tutor.conversation_with_history, owner, data.conversation_id) if data.conversation_id else None
    # Only this student's own notes are ever used for grounding.
    early_context = ai_prep.submit(note_store.context_for, owner, requested_course, requested_unit, 12_000) if requested_course and requested_unit else None
    try:
        limit.result()
    except ValueError as error:
        if str(error) == "day":
            raise HTTPException(status_code=429, detail=TUTOR_DAILY_LIMITED, headers={"Retry-After": "3600"}) from error
        raise HTTPException(status_code=429, detail=TUTOR_RATE_LIMITED, headers={"Retry-After": "300"}) from error
    # Obvious attempts to extract or override the tutor's instructions get the fixed
    # refusal without a model call (a cheap filter, not a guarantee).
    prefiltered = ai_tutor.is_prompt_extraction(content)
    if not prefiltered:
        spend_global_ai_call()
    try:
        conversation, recent = existing.result() if existing else (tutor.start_conversation(owner, content, requested_course, requested_unit), [])
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Conversation not found") from error
    # Retrying a message whose reply failed must not store (or send the model) the same turn twice.
    retry_of = recent[-1] if recent and recent[-1]["role"] == "user" and recent[-1]["content"] == content else None
    history = trim_history([{"role": item["role"], "content": item["content"]} for item in (recent[:-1] if retry_of else recent)])
    course = requested_course or conversation["course"]
    unit = requested_unit or conversation["unit"]
    if early_context:
        labels, source_text = early_context.result()
    else:
        labels, source_text = note_store.context_for(owner, course, unit, limit_chars=12_000) if (course or unit) else ([], "")
    # History was read above, so saving the new turn now cannot duplicate it. The write
    # overlaps the model's time to first token instead of delaying the request.
    if retry_of:
        saving: Future = Future()
        saving.set_result(retry_of)
    else:
        saving = ai_prep.submit(tutor.add_message, owner, conversation["id"], "user", content, [image.name for image in data.images])
    route = ai_tutor.tutor_route(content, bool(image_parts)) if prefiltered else capped_tutor_route(owner, content, bool(image_parts))
    # The system prompt is fixed; the course, unit and notes travel in a delimited data
    # block inside the student's turn, never in the system prompt.
    turn_text = ai_tutor.tutor_user_text(content, course, unit, labels, source_text)
    model_messages = [
        {"role": "system", "content": ai_tutor.tutor_system_prompt()},
        *history,
        {"role": "user", "content": [{"type": "text", "text": turn_text}, *image_parts] if image_parts else turn_text},
    ]
    started = time.perf_counter()

    def reply_chunks():
        """The model's reply, minus the off-topic sentinel: an off-topic reply becomes the fixed refusal."""
        if prefiltered:
            ai_tutor.log_ai_event("explain_material", outcome="prefiltered", student_id=owner, tier=route["tier"], started=started)
            yield ai_tutor.TUTOR_REFUSAL
            return
        guard = ai_tutor.ReplyGuard()
        upstream = ai_tutor.stream_tutor_reply(messages=model_messages, route=route, session_id=ai_session_id(owner, conversation["id"], "tutor"))
        try:
            for chunk in upstream:
                text = guard.feed(chunk)
                if guard.off_topic:
                    break
                if text:
                    yield text
            tail = guard.finish()
            if tail:
                yield tail
        except ai_tutor.AITutorError as error:
            tail = guard.finish()
            ai_tutor.log_ai_event("explain_material", outcome="ai_error", student_id=owner, tier=route["tier"], started=started, error=error)
            if tail:
                yield tail
            raise
        finally:
            close = getattr(upstream, "close", None)
            if close:
                close()  # stops reading the upstream stream (and closes the connection) early
        if guard.off_topic:
            ai_tutor.log_ai_event("explain_material", outcome="off_topic", student_id=owner, tier=route["tier"], started=started)
            yield ai_tutor.TUTOR_REFUSAL
        else:
            ai_tutor.log_ai_event("explain_material", outcome="ok", student_id=owner, tier=route["tier"], started=started)

    def saved_user() -> bool:
        try:
            saving.result()
            return True
        except Exception:  # the database write failed; the student is told to resend
            return False

    def events():
        chunks: list[str] = []
        saved = False
        user_sent = False
        try:
            # Inside the try, so a client that leaves at the very first event still
            # releases its stream slot straight away.
            yield sse("meta", {"conversation": conversation, "tier": route["tier"], "grounded_in": labels[:10]})
            for chunk in reply_chunks():
                if not user_sent:
                    user_sent = True
                    if not saved_user():
                        yield sse("error", {"message": TUTOR_NOT_SAVED, "retry": True})
                        return
                    yield sse("user", {"user_message": saving.result()})
                chunks.append(chunk)
                yield sse("delta", {"text": chunk})
            reply = tutor.add_message(owner, conversation["id"], "assistant", "".join(chunks), model_tier=route["tier"])
            saved = True
            yield sse("done", {"message": reply})
        except ai_tutor.AITutorError:
            if not user_sent:
                user_sent = True
                if not saved_user():
                    yield sse("error", {"message": TUTOR_NOT_SAVED, "retry": True})
                    return
                yield sse("user", {"user_message": saving.result()})
            if chunks:
                reply = tutor.add_message(owner, conversation["id"], "assistant", "".join(chunks) + "\n\n(The reply was cut off.)", model_tier=route["tier"])
                saved = True
                yield sse("done", {"message": reply, "partial": True})
            else:
                yield sse("error", {"message": TUTOR_UNAVAILABLE, "retry": True})
        finally:
            tutor_streams.release(owner, slot)
            # The student stopped the reply or left: keep what was already written,
            # after the question it answers.
            if chunks and not saved and saved_user():
                tutor.add_message(owner, conversation["id"], "assistant", "".join(chunks), model_tier=route["tier"])

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/friends/search")
def search_friends(q: Annotated[str, Query(max_length=60)] = "", authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "search", 60)
        return database.search_people(user["id"], q)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/social/activity/{event_id}/reaction")
def react_to_social_activity(event_id: DbId, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "reaction", 80)
        return database.react_to_activity(user["id"], event_id)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/social/notifications/read")
def read_social_notifications(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "notification_read", 60)
    except ValueError as error:
        raise social_error(error) from error
    database.mark_notifications_read(user["id"])
    return {"updated": True}


@app.put("/api/social/privacy")
def save_social_privacy(data: SocialPrivacyUpdate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "privacy", 20)
        return database.update_social_privacy(user["id"], data.discoverable, data.allow_friend_requests)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/social/blocks/{user_id}")
def block_social_user(user_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "block", 20)
        database.block_person(user["id"], user_id)
    except ValueError as error:
        raise social_error(error) from error
    return {"blocked": True}


@app.post("/api/social/reports", status_code=201)
def report_social_user(data: SocialReportCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "report", 10)
        return database.report_person(user["id"], data.user_id, data.reason, data.details)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/friends/requests", status_code=201)
def create_friend_request(data: FriendRequestCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "friend_request", 20)
        return database.send_friend_request(user["id"], data.friend_code.strip())
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/friends/requests/{request_id}")
def decide_friend_request(request_id: DbId, data: FriendRequestDecision, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "friend_decision", 40)
        return database.respond_to_friend_request(request_id, user["id"], data.accept)
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/friends/{friend_id}")
def delete_friend(friend_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "unfriend", 20)
    except ValueError as error:
        raise social_error(error) from error
    if not database.remove_friend(user["id"], friend_id):
        raise HTTPException(status_code=404, detail="Friend not found")
    return {"deleted": True}


@app.post("/api/friend-quests", status_code=201)
def start_friend_quest(data: FriendQuestCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "quest", 20)
        return database.create_friend_quest(user["id"], data.friend_id, data.target_xp)
    except ValueError as error:
        raise social_error(error) from error


@app.put("/api/account/profile", response_model=ProfileResponse)
def update_account_profile(data: AccountProfileUpdate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    if not avatar_path_belongs_to(user["id"], data.avatar_path):
        raise HTTPException(status_code=400, detail="Choose an image you uploaded yourself as your avatar")
    limit_action(user["id"], "profile_update", 30)
    try:
        profile = database.onboard_account(
            user["id"],
            data.username,
            data.display_name.strip(),
            data.guest_id,
            data.avatar_path,
            data.daily_goal,
        )
    except ValueError as error:
        raise social_error(error) from error
    progress = database.get_progress(user["id"])
    if progress:
        profile["login_streak"] = progress.get("login_streak", 0)
        profile["best_login_streak"] = progress.get("best_login_streak", 0)
    return profile


@app.get("/api/tasks")
def list_tasks_route(group_id: str | None = None, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        return tasks.list_tasks(user["id"], group_id)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/tasks", status_code=201)
def create_task_route(data: TaskCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_create", TASK_CREATE_LIMIT, 1440)
        if data.group_id and any(person != user["id"] for person in data.assignee_ids or []):
            database.check_social_rate_limit(user["id"], "task_assign", TASK_ASSIGN_LIMIT, 60)
        return tasks.create_task(user["id"], data.model_dump())
    except ValueError as error:
        raise social_error(error) from error


@app.get("/api/tasks/{task_id}")
def get_task_route(task_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        return tasks.get_task(user["id"], task_id)
    except ValueError as error:
        raise social_error(error) from error


@app.patch("/api/tasks/{task_id}")
def update_task_route(task_id: str, data: TaskUpdate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        changes = data.model_dump(exclude_unset=True)
        # Charged only when the edit newly assigns a group task to someone else, not for
        # personal tasks, assigning yourself, unassigning or moving with the same people.
        return tasks.update_task(
            user["id"], task_id, changes,
            before_assigning_others=lambda: database.check_social_rate_limit(user["id"], "task_assign", TASK_ASSIGN_LIMIT, 60),
        )
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/tasks/{task_id}")
def delete_task_route(task_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        return {"deleted": tasks.delete_task(user["id"], task_id)}
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/tasks/{task_id}/checklist", status_code=201)
def add_checklist_item_route(task_id: str, data: ChecklistItemCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        return tasks.add_checklist_item(user["id"], task_id, data.text)
    except ValueError as error:
        raise social_error(error) from error


@app.patch("/api/tasks/{task_id}/checklist/{item_id}")
def update_checklist_item_route(task_id: str, item_id: DbId, data: ChecklistItemUpdate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        return tasks.update_checklist_item(user["id"], task_id, item_id, data.model_dump(exclude_unset=True))
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/tasks/{task_id}/checklist/{item_id}")
def delete_checklist_item_route(task_id: str, item_id: DbId, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        return {"deleted": tasks.delete_checklist_item(user["id"], task_id, item_id)}
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/tasks/{task_id}/comments", status_code=201)
def add_task_comment_route(task_id: str, data: TaskCommentCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_comment", TASK_COMMENT_LIMIT, 60)
        return tasks.add_comment(user["id"], task_id, data.body)
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/tasks/{task_id}/comments/{comment_id}")
def delete_task_comment_route(task_id: str, comment_id: DbId, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    limit_action(user["id"], "task_write", TASK_WRITE_LIMIT)
    try:
        return {"deleted": tasks.delete_comment(user["id"], task_id, comment_id)}
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/tasks/{task_id}/attachments", status_code=201)
def add_task_attachment_route(task_id: str, data: TaskAttachmentCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        # get_note only returns notes owned by the signed-in student.
        note = note_store.get_note(user["id"], data.note_id) if data.kind == "note" and data.note_id else None
        return tasks.add_attachment(user["id"], task_id, data.kind, data.label, data.url, note)
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/tasks/{task_id}/attachments/{attachment_id}")
def delete_task_attachment_route(task_id: str, attachment_id: DbId, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    limit_action(user["id"], "task_write", TASK_WRITE_LIMIT)
    try:
        return {"deleted": tasks.remove_attachment(user["id"], task_id, attachment_id)}
    except ValueError as error:
        raise social_error(error) from error


@app.get("/api/study-groups/{group_id}/milestones")
def list_milestones_route(group_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        return tasks.list_milestones(user["id"], group_id)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/study-groups/{group_id}/milestones", status_code=201)
def create_milestone_route(group_id: str, data: MilestoneCreate, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "task_write", TASK_WRITE_LIMIT, 60)
        return tasks.create_milestone(user["id"], group_id, data.title, data.due_date)
    except ValueError as error:
        raise social_error(error) from error


@app.delete("/api/study-groups/{group_id}/milestones/{milestone_id}")
def delete_milestone_route(group_id: str, milestone_id: DbId, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    limit_action(user["id"], "task_write", TASK_WRITE_LIMIT)
    try:
        return {"deleted": tasks.delete_milestone(user["id"], group_id, milestone_id)}
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/study-groups/{group_id}/notify")
def notify_group_route(group_id: str, data: GroupNotice, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "group_notice", 6, 1440)
        return {"notified": tasks.notify_members(user["id"], group_id, data.message)}
    except ValueError as error:
        raise social_error(error) from error


@app.get("/api/study-groups/{group_id}/analytics")
def group_analytics_route(group_id: str, authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        return tasks.group_analytics(user["id"], group_id)
    except ValueError as error:
        raise social_error(error) from error


QUIZ_UNAVAILABLE = "AI quiz generation is temporarily unavailable. Try again in a moment."


def _rate_limited(student_id: str, action: str, limit: int, window_minutes: int) -> None:
    try:
        database.check_social_rate_limit(student_id, action, limit, window_minutes)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/generate-question", response_model=QuestionResponse)
def generate_question(data: QuestionRequest, authorization: Annotated[str | None, Header()] = None, background: BackgroundTasks = None):  # type: ignore[assignment]
    has_school_context = bool(data.notes and (data.notes.course.strip() or data.notes.unit.strip()))
    if has_school_context and data.notes:
        student_id = auth.authenticated_user(authorization)["id"]
        ai_tutor.warm_connection()
        course, unit = data.notes.course.strip(), data.notes.unit.strip()
        target_topic = unit or course
        # The daily limit, the student's record and their notes are independent reads; fetch them together.
        _, (difficulty, personalization), (source_labels, source_text) = gather(
            (_rate_limited, student_id, "question_request", 80, 1440),
            (quiz_personalization, student_id, data.difficulty, target_topic),
            (note_store.context_for, student_id, course, unit),
        )
        cache_key = question_cache_key(student_id, data.notes.course, data.notes.unit, data.topic, difficulty, source_text)
        if question_scope_is_shared(source_text):
            # Shared bank: the model gets no student data. Only the difficulty (part of the
            # key) adapts to the student.
            personalization = neutral_personalization(target_topic)
        # A banked question costs no AI call and no AI quota.
        cached = questions.cached_question(cache_key, student_id)
        if cached:
            ai_question = cached
        else:
            _rate_limited(student_id, "ai_question", 40, 1440)
            spend_global_ai_call()
            try:
                ai_question = ai_tutor.generate_question(
                    course=course,
                    unit=unit,
                    source_labels=source_labels,
                    focus=data.topic,
                    difficulty=difficulty,
                    personalization=personalization,
                    source_text=source_text,
                    session_id=ai_session_id(student_id, data.notes.course, data.notes.unit, "quiz"),
                )
            except ai_tutor.AITutorError as exc:
                raise HTTPException(status_code=503, detail=QUIZ_UNAVAILABLE) from exc
        question_text, correct_answer, topic = questions.clip_question(
            ai_question["question"], ai_question["correct_answer"], ai_question["topic"] or target_topic,
        )
        if not cached:
            # Banking the new question for reuse does not need to delay this response.
            if background is not None:
                background.add_task(questions.save_to_bank, cache_key, question_text, correct_answer, topic, difficulty)
            else:
                questions.save_to_bank(cache_key, question_text, correct_answer, topic, difficulty)
        generated = GeneratedQuestion(
            question=question_text,
            correct_answer=correct_answer,
            topic=topic,
            difficulty=difficulty,
        )
    else:
        student_id = verified_student_id(data.student_id, authorization)
        if authorization:
            limit_action(student_id, "math_question", MATH_QUESTIONS_PER_DAY, 1440)
        else:
            # Without a sign-in the caller picks its own ID, so the limit follows the network address instead.
            limit_action(f"ip:{rate_limit.client_address.get()}", "guest_question", GUEST_QUESTIONS_PER_DAY, 1440)
        generated = generate_math_question(data.topic, data.difficulty)

    question_id = questions.save_question(
        student_id,
        generated.question,
        generated.correct_answer,
        generated.topic,
        generated.difficulty,
    )
    return QuestionResponse(
        question_id=question_id,
        question=generated.question,
        topic=generated.topic,
        difficulty=generated.difficulty,
    )


# --- Flashcards ----------------------------------------------------------------------
#
# Cards are made once per note, from that note's text only, and stored (flashcards.py).
# Errors from these routes carry {"code", "message"} so the app can react to each case.

FLASHCARD_NOTES_PER_DAY = 40      # notes a student can generate cards for per day (retries count)
LEGACY_FLASHCARD_DECKS_PER_DAY = 20
FLASHCARD_MESSAGES = {
    "ai_unavailable": "Couldn’t make flashcards right now. Try again in a moment.",
    "ai_bad_output": "Couldn’t make usable flashcards from this note right now. Try again in a moment.",
    "generation_in_progress": "Flashcards for this note are already being made.",
    "no_notes": "Add notes to this unit first — flashcards are made only from your notes.",
    "ai_daily_limit": AI_PAUSED,
}


def ai_error(status: int, code: str, message: str | None = None, retry_after: int | None = None) -> HTTPException:
    headers = {"Retry-After": str(retry_after)} if retry_after else None
    return HTTPException(status_code=status, detail={"code": code, "message": message or FLASHCARD_MESSAGES[code]}, headers=headers)


def _wait_phrase(seconds: int) -> str:
    if seconds < 90:
        return "in a minute"
    if seconds < 3600:
        return f"in about {math.ceil(seconds / 60)} minutes"
    hours = math.ceil(seconds / 3600)
    return "in about an hour" if hours == 1 else f"in about {hours} hours"


def limit_retry_after(student_id: str, action: str, window_minutes: int) -> int:
    """Seconds until the oldest counted event of a rolling-window limit expires."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    events = database.social_action_events
    try:
        with database.engine().connect() as connection:
            oldest = connection.execute(select(func.min(events.c.created_at)).where(
                events.c.student_id == student_id, events.c.action == action, events.c.created_at >= cutoff,
            )).scalar_one_or_none()
    except Exception:  # noqa: BLE001 - the limit still holds; only the hint is lost
        return 3600
    if oldest is None:
        return 60
    oldest = oldest if oldest.tzinfo else oldest.replace(tzinfo=timezone.utc)
    return max(60, math.ceil((oldest + timedelta(minutes=window_minutes) - datetime.now(timezone.utc)).total_seconds()))


def flashcard_rate_limit(student_id: str, action: str, limit: int, window_minutes: int = 1440) -> None:
    try:
        database.check_social_rate_limit(student_id, action, limit, window_minutes)
    except ValueError as error:
        wait = limit_retry_after(student_id, action, window_minutes)
        raise ai_error(429, "rate_limited", f"You’ve made a lot of flashcards today. Try again {_wait_phrase(wait)}.", retry_after=wait) from error


def flashcard_budget() -> None:
    if not global_ai_available():
        raise ai_error(503, "ai_daily_limit", retry_after=3600)


class NoteFlashcardsRequest(BaseModel):
    """The generate request carries nothing: the note, its text and every model setting are server-side."""
    model_config = ConfigDict(extra="forbid")


def _note_flashcards_result(note_id: str, status: str, created: bool, cards: list[dict], error: str | None = None) -> dict:
    result = {"note_id": note_id, "status": status, "created": created, "cards": cards}
    if error:
        result["error"] = error
    return result


@app.post("/api/notes/{note_id}/flashcards")
def make_note_flashcards(
    note_id: Annotated[str, PathParam(min_length=1, max_length=64)],
    data: Annotated[NoteFlashcardsRequest | None, Body()] = None,
    retry: Annotated[bool, Query()] = False,
    authorization: Annotated[str | None, Header()] = None,
):
    """Make (once) and return the flashcards for one of the student's notes. Idempotent."""
    owner = auth.authenticated_user(authorization)["id"]
    started = time.perf_counter()
    log = lambda outcome, **fields: ai_tutor.log_ai_event("generate_flashcards", outcome=outcome, student_id=owner, note_id=note_id, tier="text", started=started, **fields)  # noqa: E731
    flashcards.init_flashcards()  # once per process, before the two reads below run side by side
    note, state = gather((note_store.get_note, owner, note_id), (flashcards.job_state, owner, note_id))
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    if state["status"] == "ready":
        return _note_flashcards_result(note_id, "ready", False, flashcards.note_cards(owner, note_id))
    if state["status"] == "generating":
        log("locked")
        raise ai_error(409, "generation_in_progress")
    if state["status"] == "failed" and not retry and not state["interrupted"]:
        return _note_flashcards_result(note_id, "failed", False, [], state["error"])
    text = ai_tutor.flashcard_source_text(note["text"])
    if ai_tutor.note_too_short(text):
        flashcards.mark_too_short(owner, note_id)
        log("too_short")
        return _note_flashcards_result(note_id, "too_short", False, [])
    # Identical note text (with the same course, unit and file name the prompt carries)
    # was already turned into cards: reuse them without an AI call, AI quota or budget.
    # Shared across students only through a hash of that full input, so a hit returns
    # nothing the student doesn't already hold.
    cache_key = ai_cache.flashcard_key(course=note["course"], unit=note["unit"], file_name=note["file_name"], source_text=text)
    cached = ai_cache.cached_flashcards(cache_key)
    if cached is not None:
        reused, _ = ai_tutor.clean_flashcards(cached, text, ai_tutor.flashcard_target(text), default_topic=note["unit"] or note["course"])
        if reused:
            stored = flashcards.complete(owner, note_id, note["course"], note["unit"], reused)
            if stored is None:
                raise HTTPException(status_code=404, detail="Note not found")
            log("cache_hit", cards_kept=len(reused))
            return _note_flashcards_result(note_id, "ready", True, stored)
    elif ai_cache.enabled():
        log("cache_miss")
    try:
        flashcard_rate_limit(owner, "flashcards_note", FLASHCARD_NOTES_PER_DAY)
    except HTTPException:
        log("rate_limited")
        raise
    flashcard_budget()
    outcome, attempt = flashcards.claim(owner, note_id, retry=retry)
    if outcome == "ready":
        return _note_flashcards_result(note_id, "ready", False, flashcards.note_cards(owner, note_id))
    if outcome == "generating":
        log("locked")
        raise ai_error(409, "generation_in_progress")
    if outcome == "failed":
        return _note_flashcards_result(note_id, "failed", False, [], flashcards.job_state(owner, note_id)["error"])
    ai_tutor.warm_connection()
    try:
        batch = ai_tutor.generate_note_flashcards(
            course=note["course"], unit=note["unit"], file_name=note["file_name"], note_text=text,
            session_id=ai_session_id(owner, note_id, "flashcards"),
        )
    except ai_tutor.AIBadOutput as exc:
        flashcards.fail(owner, note_id, attempt, "ai_bad_output")
        log("bad_output", error=exc)
        raise ai_error(503, "ai_bad_output", retry_after=30) from exc
    except ai_tutor.AITutorError as exc:
        flashcards.fail(owner, note_id, attempt, "ai_unavailable")
        log("ai_error", error=exc)
        raise ai_error(503, "ai_unavailable", retry_after=30) from exc
    except BaseException as exc:
        flashcards.fail(owner, note_id, attempt, "ai_unavailable")
        log("ai_error", error=exc)
        raise
    stored = flashcards.complete(owner, note_id, note["course"], note["unit"], batch.cards)
    if stored is None:
        raise HTTPException(status_code=404, detail="Note not found")
    ai_cache.store_flashcards(cache_key, batch.cards)
    log("ok", cards_in=batch.received, cards_kept=len(batch.cards))
    return _note_flashcards_result(note_id, "ready", True, stored)


@app.get("/api/flashcards")
def list_flashcards(
    course: Annotated[str, Query(min_length=1, max_length=120)],
    unit: Annotated[str, Query(min_length=1, max_length=160)],
    authorization: Annotated[str | None, Header()] = None,
):
    """The student's stored cards for a unit and each note's flashcard state. Never calls the AI."""
    owner = auth.authenticated_user(authorization)["id"]
    stored, states = flashcards.list_for_unit(owner, course.strip(), unit.strip())
    return {"cards": stored, "notes": states}


@app.post("/api/generate-flashcards", response_model=FlashcardResponse)
def generate_flashcards(data: FlashcardRequest, authorization: Annotated[str | None, Header()] = None):
    """Legacy unit-wide deck. Grounded only, and served from stored cards when the unit has them."""
    student_id = auth.authenticated_user(authorization)["id"]
    course = data.course.strip()
    unit = data.unit.strip()
    if not course and not unit:
        raise HTTPException(status_code=400, detail="Choose a course or unit before generating flashcards")
    started = time.perf_counter()
    target_topic = unit or course
    (_, personalization), (source_labels, source_text) = gather(
        (quiz_personalization, student_id, 2, target_topic),
        # The model only ever sees the first 12,000 characters, so read no more than that.
        (note_store.context_for, student_id, course, unit, 12_000),
    )
    personalized = bool(personalization.get("overall_attempts", 0))
    if not source_text.strip():
        raise ai_error(400, "no_notes")
    if course and unit:
        stored, _ = flashcards.list_for_unit(student_id, course, unit)
        if stored:
            return FlashcardResponse(course=course, unit=unit, personalized=personalized,
                                     cards=[Flashcard(front=card["front"], back=card["back"], topic=card["topic"]) for card in stored[:data.count]])
    flashcard_rate_limit(student_id, "ai_flashcards", LEGACY_FLASHCARD_DECKS_PER_DAY)
    flashcard_budget()
    ai_tutor.warm_connection()
    try:
        cards = ai_tutor.generate_flashcards(
            course=course,
            unit=unit,
            source_labels=source_labels,
            count=data.count,
            personalization=personalization,
            source_text=source_text,
            session_id=ai_session_id(student_id, course, unit, "flashcards"),
        )
    except ai_tutor.AIBadOutput as exc:
        ai_tutor.log_ai_event("generate_flashcards", outcome="bad_output", student_id=student_id, tier="text", started=started, error=exc)
        raise ai_error(503, "ai_bad_output", retry_after=30) from exc
    except ai_tutor.AITutorError as exc:
        ai_tutor.log_ai_event("generate_flashcards", outcome="ai_error", student_id=student_id, tier="text", started=started, error=exc)
        raise ai_error(503, "ai_unavailable", retry_after=30) from exc
    ai_tutor.log_ai_event("generate_flashcards", outcome="ok", student_id=student_id, tier="text", started=started, cards_kept=len(cards))
    return FlashcardResponse(
        course=course,
        unit=unit,
        personalized=personalized,
        cards=[Flashcard(**card) for card in cards],
    )


GRADING_UNAVAILABLE = "We couldn’t check this answer right now — try again in a bit."


@app.post("/api/analyze-answer", response_model=AnswerResponse)
def analyze_answer(data: AnswerRequest, authorization: Annotated[str | None, Header()] = None):
    student_id = verified_student_id(data.student_id, authorization)
    question = questions.get_question(student_id, data.question_id)
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")
    if question["completed"] == questions.COMPLETED:
        raise HTTPException(status_code=409, detail="Question already completed")

    verdict = deterministic_verdict(data.student_answer, question["correct_answer"], question["topic"])
    grading_source: Literal["deterministic", "ai", "fallback"] = "deterministic"
    if verdict is True:
        correct = True
        score = 100
        mistake_type = None
        misconception = None
        explanation = "Correct! Great work."
        hint = None
    elif verdict is False:
        correct = False
        score = 0
        mistake_type = classify_mistake(data.student_answer, question["correct_answer"])
        misconception = None
        explanation = "Not quite yet. Use the hint and try again."
        hint = make_hint(question["question"], mistake_type)
    else:
        if authorization:
            try:
                database.check_social_rate_limit(student_id, "ai_grading", 120, 1440)
            except ValueError as error:
                raise social_error(error) from error
        if authorization and not global_ai_available():
            # The shared AI budget is used up. Grading offline would mark answers the
            # AI might accept as wrong, so don't grade at all: the student can resubmit.
            raise HTTPException(status_code=503, detail=GRADING_UNAVAILABLE, headers={"Retry-After": "30"})
        try:
            if not authorization:
                raise ai_tutor.AITutorError("Sign in for AI grading")
            ai_result = ai_tutor.grade_answer(
                question=question["question"],
                correct_answer=question["correct_answer"],
                student_answer=data.student_answer,
                topic=question["topic"],
                difficulty=question["difficulty"],
                session_id=ai_session_id(student_id, question["topic"], "grading"),
            )
            correct = ai_result["correct"]
            score = ai_result["score"]
            mistake_type = ai_result["mistake_type"]
            misconception = ai_result["misconception"]
            explanation = ai_result["explanation"]
            hint = ai_result["hint"]
            grading_source = "ai"
        except ai_tutor.AITutorError as error:
            if authorization:
                # The AI grader is unavailable: leave the question open and award or deny
                # nothing, so the student can resubmit the same answer.
                raise HTTPException(status_code=503, detail=GRADING_UNAVAILABLE, headers={"Retry-After": "30"}) from error
            # Guests never get AI grading; they keep the offline fallback.
            correct = False
            score = 0
            mistake_type = classify_mistake(data.student_answer, question["correct_answer"])
            misconception = None
            explanation = "That answer is not correct yet. Use the hint and try again."
            hint = make_hint(question["question"], mistake_type)
            grading_source = "fallback"

    xp = 0
    if correct:
        prior = questions.complete_question(student_id, data.question_id)
        if prior is None:
            raise HTTPException(status_code=409, detail="Question already completed")
        # Full credit on the first try; retrying after a wrong answer earns less, so guessing doesn't pay.
        xp = FIRST_TRY_XP if prior == questions.OPEN else RETRY_XP
        record = database.update_progress(student_id, question["topic"], correct, xp)
    else:
        # Marking the miss and recording the attempt are independent writes.
        _, record = gather(
            (questions.mark_missed, student_id, data.question_id),
            (database.update_progress, student_id, question["topic"], correct, xp),
        )
    return AnswerResponse(
        correct=correct,
        score=score,
        mistake_type=mistake_type,
        misconception=misconception,
        explanation=explanation,
        hint=hint,
        grading_source=grading_source,
        xp_earned=record.get("xp_awarded", xp),
        total_xp=record["total_xp"],
        streak=record["streak"],
    )


@app.get("/api/progress/me", response_model=ProgressResponse)
def get_my_progress(authorization: Annotated[str | None, Header()] = None, tz_offset: int = 0):
    user = auth.authenticated_user(authorization)
    record = database.get_progress(user["id"])
    if record is None:
        raise HTTPException(status_code=404, detail="No progress found for this student")
    response = progress_response(user["id"], record)
    response.recent_xp = [DailyXp(**row) for row in database.recent_xp(user["id"], tz_offset_minutes=tz_offset)]
    return response


@app.get("/api/progress/{student_id}", response_model=ProgressResponse)
def get_progress(student_id: str, authorization: Annotated[str | None, Header()] = None, tz_offset: int = 0):
    verified = auth.authenticated_user(authorization)["id"]
    if verified != student_id:
        raise HTTPException(status_code=403, detail="You can only view your own progress")
    record = database.get_progress(student_id)
    if record is None:
        raise HTTPException(status_code=404, detail="No progress found for this student")
    response = progress_response(student_id, record)
    response.recent_xp = [DailyXp(**row) for row in database.recent_xp(student_id, tz_offset_minutes=tz_offset)]
    return response


@app.post("/api/daily-login", response_model=ProgressResponse)
def daily_login(data: DailyLoginRequest, authorization: Annotated[str | None, Header()] = None):
    student_id = auth.authenticated_user(authorization)["id"]
    limit_action(student_id, "daily_login", 30)
    record = database.record_daily_login(student_id)
    return progress_response(student_id, record)
