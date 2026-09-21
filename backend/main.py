from __future__ import annotations

import random
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

import ai_tutor
import auth
import database
import questions
import note_ingestion
import note_store

# Refuse to start in production without a durable PostgreSQL database.
database.validate_database_configuration()

app = FastAPI(
    title="Bindit API",
    version="1.2.0",
    description="Practice, accounts, profiles, secure progress tracking, personalized quizzes, AI flashcards, and AI tutoring.",
)

social_reads = ThreadPoolExecutor(max_workers=4, thread_name_prefix="bindit-social")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Server-Timing", "X-Bindit-Response-Ms"],
)


@app.middleware("http")
async def measure_request_time(request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["Server-Timing"] = f'app;dur={elapsed_ms:.1f}'
    response.headers["X-Bindit-Response-Ms"] = f'{elapsed_ms:.1f}'
    return response

Topic = Literal["addition", "subtraction", "multiplication", "division", "mixed"]

# Unauthenticated callers choose their own ID, so it is stored under this prefix.
# Supabase account IDs are bare UUIDs and can never contain it, which means a
# guest request can never read or write a real account's rows.
GUEST_ID_PREFIX = "guest:"
GUEST_ID_MAX_LENGTH = 100 - len(GUEST_ID_PREFIX)


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


class NoteContext(BaseModel):
    course: str = ""
    unit: str = ""
    files: list[str] = Field(default_factory=list)
    other_units: list[str] = Field(default_factory=list)
    other_courses: list[str] = Field(default_factory=list)


class QuestionRequest(BaseModel):
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


class FlashcardRequest(BaseModel):
    student_id: str = Field(default="anonymous", min_length=1, max_length=100)
    course: str = Field(default="", max_length=120)
    unit: str = Field(default="", max_length=160)
    files: list[str] = Field(default_factory=list, max_length=30)
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


class TopicStat(BaseModel):
    topic: str
    attempts: int
    correct_answers: int
    accuracy: float


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


class AccountProfileUpdate(BaseModel):
    username: str = Field(pattern=r"^[a-z0-9_]{3,24}$")
    display_name: str = Field(min_length=1, max_length=40)
    guest_id: str | None = Field(default=None, min_length=1, max_length=100)
    avatar_path: str | None = Field(default=None, max_length=500)
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
    # Ignored: the student is always the authenticated caller. Accepted for older clients.
    student_id: str | None = Field(default=None, max_length=100)


class FriendRequestCreate(BaseModel):
    friend_code: str = Field(min_length=4, max_length=12)


class FriendRequestDecision(BaseModel):
    accept: bool


class FriendQuestCreate(BaseModel):
    friend_id: str = Field(min_length=1, max_length=100)
    target_xp: int = Field(default=100, ge=50, le=1000)


class StudyGroupCreate(BaseModel):
    name: str = Field(min_length=2, max_length=48)
    description: str = Field(default="", max_length=160)
    weekly_goal_xp: int = Field(default=500, ge=100, le=10000)


class StudyGroupJoin(BaseModel):
    invite_code: str = Field(min_length=6, max_length=10)


class SocialPrivacyUpdate(BaseModel):
    discoverable: bool
    allow_friend_requests: bool


class SocialReportCreate(BaseModel):
    user_id: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=2, max_length=40)
    details: str = Field(default="", max_length=1000)


def normalize_text(value: str) -> str:
    return " ".join(value.strip().lower().split())


def parse_number(value: str) -> Decimal | None:
    cleaned = value.strip().replace(",", "")
    if cleaned.endswith("%"):
        cleaned = cleaned[:-1].strip()
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def truthy_alias(value: str) -> str:
    aliases = {"yes": "true", "y": "true", "true": "true", "no": "false", "n": "false", "false": "false"}
    return aliases.get(normalize_text(value), normalize_text(value))


def file_stem(value: str) -> str:
    text = normalize_text(value)
    return text.rsplit(".", 1)[0] if "." in text else text


def answers_match(student_answer: str, correct_answer: str) -> bool:
    student_number = parse_number(student_answer)
    correct_number = parse_number(correct_answer)
    if student_number is not None and correct_number is not None:
        return student_number == correct_number
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
        if student_number == -correct_number:
            return "sign_error"
        if abs(student_number - correct_number) == 1:
            return "off_by_one"
        if correct_number != 0 and (student_number * 10 == correct_number or student_number == correct_number * 10):
            return "place_value_error"
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
        "group_limit_reached": (409, "You can join up to 8 study groups"),
        "group_owner_cannot_leave": (409, "Group owners cannot leave their group"),
    }
    status, message = messages.get(str(error), (400, "Could not update that profile"))
    return HTTPException(status_code=status, detail=message)


@app.get("/")
def home():
    return {"message": "bindet backend is running", "version": app.version, "docs": "/docs"}


@app.get("/api/health")
@app.get("/health", include_in_schema=False)
def health():
    return {"status": "healthy"}


@app.get("/api/auth/config", response_model=AuthConfigResponse)
def auth_config():
    url, key = auth.public_settings()
    return {"supabase_url": url, "supabase_anon_key": key}


def note_response(row: dict) -> NoteResponse:
    return NoteResponse(
        id=row["id"], course=row["course"], unit=row["unit"], file_name=row["file_name"],
        content_type=row["content_type"], size_bytes=row["size_bytes"], status="ready",
        text_preview=row["text"][:500], created_at=row["created_at"],
    )


@app.post("/api/notes", response_model=NoteResponse, status_code=201)
async def upload_note(
    course: Annotated[str, Form(min_length=1, max_length=120)],
    unit: Annotated[str, Form(min_length=1, max_length=160)],
    file: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
):
    user = auth.authenticated_user(authorization)
    filename = file.filename or "notes"
    content = await file.read(note_ingestion.MAX_NOTE_BYTES + 1)
    try:
        suffix = Path(filename).suffix.lower()
        if suffix in note_ingestion.IMAGE_EXTENSIONS:
            if len(content) > note_ingestion.MAX_NOTE_BYTES:
                raise note_ingestion.NoteIngestionError("Notes must be 10 MB or smaller")
            if not content:
                raise note_ingestion.NoteIngestionError("The uploaded file is empty")
            fallback_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
            text = note_ingestion.clean_text(ai_tutor.extract_image_notes(
                image_bytes=content, content_type=file.content_type or fallback_types[suffix]
            ))
        else:
            try:
                text = note_ingestion.extract_text(filename, content)
            except note_ingestion.NoteIngestionError as exc:
                if suffix == ".pdf" and str(exc) == "No readable text was found in that file":
                    text = note_ingestion.clean_text(ai_tutor.extract_pdf_notes(pdf_bytes=content))
                else:
                    raise
    except (note_ingestion.NoteIngestionError, ai_tutor.AITutorError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not text:
        raise HTTPException(status_code=400, detail="No readable text was found in that file")
    row = note_store.save_note(user["id"], course.strip(), unit.strip(), Path(filename).name[:255], file.content_type or "", text, len(content))
    return note_response(row)


@app.get("/api/notes", response_model=list[NoteResponse])
def get_notes(course: str, unit: str, authorization: Annotated[str | None, Header()] = None):
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
    if not note_store.remove_note(user["id"], note_id):
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
        database.leave_study_group(user["id"], group_id)
    except ValueError as error:
        raise social_error(error) from error
    return {"left": True}


@app.get("/api/friends/search")
def search_friends(q: str = "", authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    try:
        database.check_social_rate_limit(user["id"], "search", 60)
        return database.search_people(user["id"], q)
    except ValueError as error:
        raise social_error(error) from error


@app.post("/api/social/activity/{event_id}/reaction")
def react_to_social_activity(event_id: int, authorization: Annotated[str | None, Header()] = None):
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
def decide_friend_request(request_id: int, data: FriendRequestDecision, authorization: Annotated[str | None, Header()] = None):
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


@app.post("/api/generate-question", response_model=QuestionResponse)
def generate_question(data: QuestionRequest, authorization: Annotated[str | None, Header()] = None):
    has_school_context = bool(data.notes and (data.notes.course.strip() or data.notes.unit.strip()))
    if has_school_context:
        student_id = auth.authenticated_user(authorization)["id"]
        try:
            database.check_social_rate_limit(student_id, "ai_question", 40, 1440)
        except ValueError as error:
            raise social_error(error) from error
    else:
        student_id = verified_student_id(data.student_id, authorization)

    if has_school_context and data.notes:
        target_topic = data.notes.unit.strip() or data.notes.course.strip()
        difficulty, personalization = quiz_personalization(student_id, data.difficulty, target_topic)
        source_labels, source_text = note_store.context_for(student_id, data.notes.course.strip(), data.notes.unit.strip())
        try:
            ai_question = ai_tutor.generate_question(
                course=data.notes.course.strip(),
                unit=data.notes.unit.strip(),
                source_labels=source_labels,
                focus=data.topic,
                difficulty=difficulty,
                personalization=personalization,
                source_text=source_text,
            )
        except ai_tutor.AITutorError as exc:
            raise HTTPException(status_code=503, detail="AI quiz generation is temporarily unavailable. Try again in a moment.") from exc
        generated = GeneratedQuestion(
            question=ai_question["question"],
            correct_answer=ai_question["correct_answer"],
            topic=ai_question["topic"] or target_topic,
            difficulty=difficulty,
        )
    else:
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


@app.post("/api/generate-flashcards", response_model=FlashcardResponse)
def generate_flashcards(data: FlashcardRequest, authorization: Annotated[str | None, Header()] = None):
    student_id = auth.authenticated_user(authorization)["id"]
    try:
        database.check_social_rate_limit(student_id, "ai_flashcards", 20, 1440)
    except ValueError as error:
        raise social_error(error) from error
    course = data.course.strip()
    unit = data.unit.strip()
    if not course and not unit:
        raise HTTPException(status_code=400, detail="Choose a course or unit before generating flashcards")

    target_topic = unit or course
    _, personalization = quiz_personalization(student_id, 2, target_topic)
    source_labels, source_text = note_store.context_for(student_id, course, unit)
    try:
        cards = ai_tutor.generate_flashcards(
            course=course,
            unit=unit,
            source_labels=source_labels,
            count=data.count,
            personalization=personalization,
            source_text=source_text,
        )
    except ai_tutor.AITutorError as exc:
        raise HTTPException(status_code=503, detail="AI flashcard generation is temporarily unavailable. Try again in a moment.") from exc

    personalized = bool(personalization.get("overall_attempts", 0))
    return FlashcardResponse(
        course=course,
        unit=unit,
        personalized=personalized,
        cards=[Flashcard(**card) for card in cards],
    )


@app.post("/api/analyze-answer", response_model=AnswerResponse)
def analyze_answer(data: AnswerRequest, authorization: Annotated[str | None, Header()] = None):
    student_id = verified_student_id(data.student_id, authorization)
    question = questions.get_question(student_id, data.question_id)
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")
    if question["completed"]:
        raise HTTPException(status_code=409, detail="Question already completed")

    exact_match = answers_match(data.student_answer, question["correct_answer"])
    if exact_match:
        correct = True
        score = 100
        mistake_type = None
        misconception = None
        explanation = "Correct! Great work."
        hint = None
        grading_source: Literal["deterministic", "ai", "fallback"] = "deterministic"
    else:
        if authorization:
            try:
                database.check_social_rate_limit(student_id, "ai_grading", 120, 1440)
            except ValueError as error:
                raise social_error(error) from error
        try:
            if not authorization:
                raise ai_tutor.AITutorError("Sign in for AI grading")
            ai_result = ai_tutor.grade_answer(
                question=question["question"],
                correct_answer=question["correct_answer"],
                student_answer=data.student_answer,
                topic=question["topic"],
                difficulty=question["difficulty"],
            )
            correct = ai_result["correct"]
            score = ai_result["score"]
            mistake_type = ai_result["mistake_type"]
            misconception = ai_result["misconception"]
            explanation = ai_result["explanation"]
            hint = ai_result["hint"]
            grading_source = "ai"
        except ai_tutor.AITutorError:
            correct = False
            score = 0
            mistake_type = classify_mistake(data.student_answer, question["correct_answer"])
            misconception = None
            explanation = "That answer is not correct yet. Use the hint and try again."
            hint = make_hint(question["question"], mistake_type)
            grading_source = "fallback"

    xp = 10 if correct else 0
    if correct and not questions.complete_question(student_id, data.question_id):
        raise HTTPException(status_code=409, detail="Question already completed")
    record = database.update_progress(student_id, question["topic"], correct, xp)
    return AnswerResponse(
        correct=correct,
        score=score,
        mistake_type=mistake_type,
        misconception=misconception,
        explanation=explanation,
        hint=hint,
        grading_source=grading_source,
        xp_earned=xp,
        total_xp=record["total_xp"],
        streak=record["streak"],
    )


@app.get("/api/progress/me", response_model=ProgressResponse)
def get_my_progress(authorization: Annotated[str | None, Header()] = None):
    user = auth.authenticated_user(authorization)
    record = database.get_progress(user["id"])
    if record is None:
        raise HTTPException(status_code=404, detail="No progress found for this student")
    return progress_response(user["id"], record)


@app.get("/api/progress/{student_id}", response_model=ProgressResponse)
def get_progress(student_id: str, authorization: Annotated[str | None, Header()] = None):
    verified = auth.authenticated_user(authorization)["id"]
    if verified != student_id:
        raise HTTPException(status_code=403, detail="You can only view your own progress")
    record = database.get_progress(student_id)
    if record is None:
        raise HTTPException(status_code=404, detail="No progress found for this student")
    return progress_response(student_id, record)


@app.post("/api/daily-login", response_model=ProgressResponse)
def daily_login(data: DailyLoginRequest, authorization: Annotated[str | None, Header()] = None):
    student_id = auth.authenticated_user(authorization)["id"]
    record = database.record_daily_login(student_id)
    return progress_response(student_id, record)
