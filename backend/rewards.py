"""Reward systems: daily quests, the daily chest, badges and the weekly recap.

Healthy by design (bindet is used by high-school students):
- Three small quests a day, then a chest, then "All done for today": a clear stop point,
  no endless feed of tasks.
- Quest and chest XP is small (QUEST_XP, CHEST_XP) and goes through database.award_xp, so it
  is the same XP as everything else and counts toward DAILY_XP_CAP. There is no second
  currency and nothing to buy.
- Nothing here sends notifications. No guilt or loss messages; a missed day is covered by a
  streak freeze when one is banked (database._advance_streak).

Quests are chosen per student and local day (database.local_today, from X-TZ-Offset), the
same day streaks use: the same student gets the same three quests all day on any device.
They are stored the first time they are read, so a later change (a first friend, a first
deck) never swaps them mid-day.

record() is called by the study routes after their own work is done. It updates quest
progress, opens the chest, awards badges and announces a streak save, and returns the
`rewards` object the API adds to the response (frontend lib/api.ts RewardEvents):

    {"xp": int, "level_up": {"from", "to"}, "quests_completed": [{"id", "title"}],
     "chest": {"xp"}, "badges_earned": [{"id", "title", "icon"}], "streak_saved": True,
     "streak_saved_days": int}

Every key is optional; None when nothing happened. A failure here never fails the action.
"""
from __future__ import annotations

import hashlib
import logging
import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache

from sqlalchemy import Column, Date, DateTime, Integer, MetaData, String, Table, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

import database
import flashcards
import note_store
import practice
import practice_tests
import tutor

logger = logging.getLogger("bindit.rewards")

rewards_metadata = MetaData()

# Today's three quests per student (slot 0-2), with progress toward each target.
daily_quests = Table(
    "daily_quests", rewards_metadata,
    Column("student_id", String(100), primary_key=True),
    Column("day", Date, primary_key=True),
    Column("slot", Integer, primary_key=True),
    Column("quest_id", String(24), nullable=False),
    Column("progress", Integer, nullable=False, default=0),
    Column("target", Integer, nullable=False),
    Column("completed_at", DateTime(timezone=True)),
    Column("xp_awarded", Integer, nullable=False, default=0),
)

# The chest for finishing all three quests: one row per student and day (opened once).
daily_chests = Table(
    "daily_chests", rewards_metadata,
    Column("student_id", String(100), primary_key=True),
    Column("day", Date, primary_key=True),
    Column("xp", Integer, nullable=False, default=0),
    Column("opened_at", DateTime(timezone=True), nullable=False),
)

# Badges a student has earned, each once, with when.
earned_badges = Table(
    "earned_badges", rewards_metadata,
    Column("student_id", String(100), primary_key=True),
    Column("badge_id", String(32), primary_key=True),
    Column("earned_at", DateTime(timezone=True), nullable=False),
)

# Counts per student, local day and kind for what no other table records: cards reviewed
# ("cards"), quiz answers ("quiz"), Otto questions ("otto"), Instant Study rounds
# ("instant") and notes added ("notes"). Read by badges and the weekly recap.
study_activity = Table(
    "study_activity", rewards_metadata,
    Column("student_id", String(100), primary_key=True),
    Column("day", Date, primary_key=True),
    Column("kind", String(16), primary_key=True),
    Column("count", Integer, nullable=False, default=0),
)

# One-off marks, e.g. ("recap_dismissed", "<monday of the recapped week>").
reward_marks = Table(
    "reward_marks", rewards_metadata,
    Column("student_id", String(100), primary_key=True),
    Column("kind", String(24), primary_key=True),
    Column("mark", String(32), primary_key=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

REWARD_TABLES = ("daily_quests", "daily_chests", "earned_badges", "study_activity", "reward_marks")

QUESTS_PER_DAY = 3
QUEST_XP = 5        # per quest completed
CHEST_XP = 15       # once a day, for all three
XP_PER_LEVEL = 100  # frontend pages/Profile.tsx xpLevel uses the same


@lru_cache(maxsize=1)
def init_rewards() -> None:
    database.init_db()
    # Served only through the API: RLS on, no policy and no client grants (one transaction).
    database.create_locked_tables(database.engine(), rewards_metadata, REWARD_TABLES, REWARD_TABLES)


def _init_sources() -> None:
    init_rewards()
    note_store.init_notes()
    flashcards.init_flashcards()
    practice_tests.init_practice()
    practice.init_practice()
    tutor.init_tutor()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def level_of(total_xp: int) -> int:
    return max(0, int(total_xp)) // XP_PER_LEVEL + 1


def _insert_ignore(connection, table, rows: list[dict], keys: list[str]) -> int:
    return database._insert_ignore(connection, table, rows, keys)


def _bump_activity(connection, student_id: str, day: date, kind: str, count: int) -> None:
    if count <= 0:
        return
    insert = postgres_insert if connection.dialect.name == "postgresql" else sqlite_insert
    statement = insert(study_activity).values(student_id=student_id, day=day, kind=kind, count=count)
    connection.execute(statement.on_conflict_do_update(
        index_elements=["student_id", "day", "kind"], set_={"count": study_activity.c.count + statement.excluded.count},
    ))


def _as_date(value) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


# --- Quests ------------------------------------------------------------------------------

@dataclass(frozen=True)
class Quest:
    id: str
    title: str
    target: int          # 0: the student's daily goal (XP)
    needs: str = ""      # "cards": has flashcards; "friends": has a friend


QUESTS = (
    Quest("review_cards", "Review 10 flashcards", 10, "cards"),
    Quest("quiz_answers", "Answer 5 quiz questions", 5),
    Quest("ask_otto", "Ask Otto 1 question", 1),
    Quest("instant_round", "Finish an Instant Study round", 1, "cards"),
    Quest("add_notes", "Add notes", 1),
    Quest("right_in_a_row", "Get 3 right in a row", 3),
    Quest("daily_goal", "Hit your daily goal", 0),
    Quest("friend_day", "Study with a friend", 1, "friends"),
)
QUEST_BY_ID = {quest.id: quest for quest in QUESTS}


def pick_quests(student_id: str, day: date, have: set[str] | frozenset[str] = frozenset()) -> list[Quest]:
    """Three quests for this student and local day, chosen deterministically from the quests
    the student can do (`have`: "cards", "friends")."""
    pool = [quest for quest in QUESTS if not quest.needs or quest.needs in have]
    seed = int.from_bytes(hashlib.sha256(f"bindet-quests:{student_id}:{day.isoformat()}".encode()).digest()[:8], "big")
    return random.Random(seed).sample(pool, QUESTS_PER_DAY)


def _daily_goal(connection, student_id: str) -> int:
    goal = connection.execute(select(database.profiles.c.daily_goal).where(
        database.profiles.c.student_id == student_id)).scalar_one_or_none()
    return int(goal or 20)


def _xp_today(connection, student_id: str, today: date) -> int:
    start = database._local_day_start(today)
    return int(connection.execute(select(func.coalesce(func.sum(database.xp_events.c.xp), 0)).where(
        database.xp_events.c.student_id == student_id, database.xp_events.c.created_at >= start,
        database.xp_events.c.created_at < start + timedelta(days=1),
    )).scalar_one())


def _studied_with_friend(connection, student_id: str, today: date) -> bool:
    days = database.study_days
    if connection.execute(select(days.c.day).where(days.c.student_id == student_id, days.c.day == today)).first() is None:
        return False
    friend_ids = database._streak_friend_ids(connection, student_id)
    if not friend_ids:
        return False
    return connection.execute(select(days.c.student_id).where(
        days.c.student_id.in_(friend_ids), days.c.day == today).limit(1)).first() is not None


def _quest_rows(connection, student_id: str, today: date) -> list[dict]:
    rows = connection.execute(select(daily_quests).where(
        daily_quests.c.student_id == student_id, daily_quests.c.day == today,
    ).order_by(daily_quests.c.slot)).mappings().all()
    if rows:
        return [dict(row) for row in rows]
    have = set()
    if connection.execute(select(flashcards.cards.c.id).where(flashcards.cards.c.owner_id == student_id).limit(1)).first():
        have.add("cards")
    if database._streak_friend_ids(connection, student_id):
        have.add("friends")
    goal = _daily_goal(connection, student_id)
    _insert_ignore(connection, daily_quests, [{
        "student_id": student_id, "day": today, "slot": slot, "quest_id": quest.id, "progress": 0,
        "target": quest.target or goal, "completed_at": None, "xp_awarded": 0,
    } for slot, quest in enumerate(pick_quests(student_id, today, have))], ["student_id", "day", "slot"])
    rows = connection.execute(select(daily_quests).where(
        daily_quests.c.student_id == student_id, daily_quests.c.day == today,
    ).order_by(daily_quests.c.slot)).mappings().all()
    return [dict(row) for row in rows]


def _advance(row: dict, event: str, data: dict) -> int:
    """The quest's new progress after one event (capped at its target)."""
    quest_id, progress, target = row["quest_id"], int(row["progress"]), int(row["target"])
    if quest_id == "review_cards" and event in ("review", "lab_round"):
        progress += int(data.get("cards", 0))
    elif quest_id == "quiz_answers" and event in ("quiz", "practice_test"):
        progress += len(data.get("results", ()))
    elif quest_id == "right_in_a_row" and event in ("quiz", "practice_test"):
        for correct in data.get("results", ()):
            progress = progress + 1 if correct else 0
            if progress >= target:
                break
    elif quest_id == "ask_otto" and event == "tutor":
        progress += 1
    elif quest_id == "instant_round" and event == "instant":
        progress += 1
    elif quest_id == "add_notes" and event == "note":
        progress += 1
    return min(progress, target)


STUDY_EVENTS = ("review", "lab_round", "quiz", "practice_test", "instant", "tutor")
ACTIVITY_KIND = {"review": "cards", "lab_round": "cards", "quiz": "quiz", "practice_test": "quiz",
                 "tutor": "otto", "instant": "instant", "note": "notes"}


def _update_quests(student_id: str, event: str, data: dict, today: date) -> tuple[list[dict], bool]:
    """Apply one event to today's quests in one transaction. Returns the quests this call
    completed (each completed exactly once, even with parallel requests) and whether this
    call opened today's chest."""
    completed: list[dict] = []
    opened = False
    now = _now()
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"rewards:{student_id}")
        kind = ACTIVITY_KIND.get(event)
        if kind:
            amount = int(data.get("cards", 0)) if kind == "cards" else len(data.get("results", ())) if kind == "quiz" else 1
            _bump_activity(connection, student_id, today, kind, amount)
        rows = _quest_rows(connection, student_id, today)
        for row in rows:
            if row["completed_at"] is not None:
                continue
            if row["quest_id"] == "daily_goal":
                progress = min(int(row["target"]), _xp_today(connection, student_id, today))
            elif row["quest_id"] == "friend_day":
                progress = 1 if _studied_with_friend(connection, student_id, today) else 0
            else:
                progress = _advance(row, event, data)
            done = progress >= int(row["target"])
            if progress == int(row["progress"]) and not done:
                continue
            changed = connection.execute(update(daily_quests).where(
                daily_quests.c.student_id == student_id, daily_quests.c.day == today, daily_quests.c.slot == row["slot"],
                daily_quests.c.completed_at.is_(None),
            ).values(progress=progress, completed_at=now if done else None)).rowcount
            row["progress"] = progress
            if done and changed:
                row["completed_at"] = now
                completed.append(row)
        if rows and all(row["completed_at"] is not None for row in rows):
            opened = bool(_insert_ignore(connection, daily_chests, [{
                "student_id": student_id, "day": today, "xp": 0, "opened_at": now,
            }], ["student_id", "day"]))
    return completed, opened


def _give_bonus(student_id: str, today: date, completed: list[dict], opened: bool) -> tuple[int, int | None]:
    """Quest and chest XP through database.award_xp (daily cap applies; no study day).
    Returns (quest XP added, chest XP added or None when no chest opened)."""
    quest_xp = 0
    if completed:
        quest_xp = database.award_xp(student_id, QUEST_XP * len(completed), study_day=False)["xp_awarded"]
        with database.engine().begin() as connection:
            left = quest_xp
            for row in completed:
                share = min(QUEST_XP, left)
                left -= share
                connection.execute(update(daily_quests).where(
                    daily_quests.c.student_id == student_id, daily_quests.c.day == today, daily_quests.c.slot == row["slot"],
                ).values(xp_awarded=share))
    chest_xp = None
    if opened:
        chest_xp = database.award_xp(student_id, CHEST_XP, study_day=False)["xp_awarded"]
        with database.engine().begin() as connection:
            connection.execute(update(daily_chests).where(
                daily_chests.c.student_id == student_id, daily_chests.c.day == today).values(xp=chest_xp))
    return quest_xp, chest_xp


def _total_xp(student_id: str) -> int:
    with database.engine().connect() as connection:
        return int(connection.execute(select(database.student_progress.c.total_xp).where(
            database.student_progress.c.student_id == student_id)).scalar_one_or_none() or 0)


def record(student_id: str, event: str, *, xp: int = 0, cards: int = 0, results=(), now: datetime | None = None) -> dict | None:
    """After a study action: quests, chest, badges and a streak save. Returns the rewards
    object for the response, or None when nothing happened. Never raises.

    event: "review" (cards=1), "lab_round" (cards=answers), "quiz" (results=[correct]),
    "practice_test" (results=[correct per question], in order), "tutor", "instant", "note",
    or "check" (nothing new; passive quests such as the daily goal are re-checked).
    xp: what the action itself already awarded (for the total and a level-up)."""
    try:
        return _record(student_id, event, xp=xp, data={"cards": cards, "results": list(results)}, now=now)
    except Exception:  # noqa: BLE001 - rewards must never break studying
        logger.exception("rewards_record_failed", extra={"event": event})
        return None


def _record(student_id: str, event: str, *, xp: int, data: dict, now: datetime | None) -> dict | None:
    _init_sources()
    now = now or _now()
    today = database.local_today(now)
    completed, opened = _update_quests(student_id, event, data, today)
    quest_xp, chest_xp = _give_bonus(student_id, today, completed, opened)
    badges = award_badges(student_id, hour=_local_hour(now) if event in STUDY_EVENTS else None)
    saved = database.pop_streak_saved(student_id)
    out: dict = {}
    gained = max(0, int(xp)) + quest_xp + (chest_xp or 0)
    if gained:
        out["xp"] = gained
        after = _total_xp(student_id)
        if level_of(after - gained) < level_of(after):
            out["level_up"] = {"from": level_of(after - gained), "to": level_of(after)}
    if completed:
        out["quests_completed"] = [{"id": row["quest_id"], "title": QUEST_BY_ID[row["quest_id"]].title} for row in completed]
    if chest_xp is not None:
        out["chest"] = {"xp": chest_xp}
    if badges:
        out["badges_earned"] = [{"id": badge.id, "title": badge.title, "icon": badge.icon} for badge in badges]
    if saved:
        out["streak_saved"] = True
        out["streak_saved_days"] = saved["streak"]
    return out or None


def _local_hour(now: datetime) -> int:
    return (now - timedelta(minutes=database.client_tz_offset.get())).hour


def today_state(student_id: str, now: datetime | None = None) -> dict:
    """GET /api/quests/today: today's quests, the chest, the daily goal, streak freezes and
    whether the day is done. Re-checks passive quests first (the daily goal, studying with a
    friend), so `rewards` can be present here too."""
    rewards_now = record(student_id, "check", now=now)
    now = now or _now()
    day = database.local_today(now)
    with database.engine().connect() as connection:
        rows = connection.execute(select(daily_quests).where(
            daily_quests.c.student_id == student_id, daily_quests.c.day == day,
        ).order_by(daily_quests.c.slot)).mappings().all()
        chest = connection.execute(select(daily_chests).where(
            daily_chests.c.student_id == student_id, daily_chests.c.day == day)).mappings().first()
        goal = _daily_goal(connection, student_id)
        xp_today = _xp_today(connection, student_id, day)
    quests = [{
        "id": row["quest_id"], "title": QUEST_BY_ID[row["quest_id"]].title,
        "progress": int(row["progress"]), "target": int(row["target"]),
        "unit": "XP" if row["quest_id"] == "daily_goal" else "",
        "done": row["completed_at"] is not None, "xp": QUEST_XP,
    } for row in rows if row["quest_id"] in QUEST_BY_ID]
    quests_done = bool(quests) and all(quest["done"] for quest in quests)
    goal_met = xp_today >= goal
    return {
        "day": day.isoformat(),
        "quests": quests,
        "chest": {"open": chest is not None, "xp": int(chest["xp"]) if chest is not None else CHEST_XP},
        "goal": {"xp": xp_today, "target": goal, "met": goal_met},
        "all_done": quests_done and goal_met,
        "freezes": database.freeze_status(student_id),
        "rewards": rewards_now,
    }


# --- Badges -----------------------------------------------------------------------------

@dataclass(frozen=True)
class Badge:
    id: str
    title: str
    description: str
    icon: str
    tone: str
    target: int
    metric: str
    secret: bool = False  # hidden until earned (shown only as "A surprise badge")


BADGES = (
    Badge("first_notes", "First notes", "Added your first notes.", "note", "blue", 1, "notes"),
    Badge("first_cards", "First flashcards", "Made your first flashcards.", "cards", "violet", 1, "cards"),
    Badge("streak_3", "3-day streak", "Studied three days in a row.", "flame", "orange", 3, "best_streak"),
    Badge("streak_7", "7-day streak", "A whole week in a row.", "flame", "orange", 7, "best_streak"),
    Badge("streak_30", "30-day streak", "A month of steady study.", "flame", "amber", 30, "best_streak"),
    Badge("cards_100", "100 cards", "Reviewed 100 flashcards.", "stack", "teal", 100, "cards_reviewed"),
    Badge("cards_500", "500 cards", "Reviewed 500 flashcards.", "stack", "teal", 500, "cards_reviewed"),
    Badge("perfect_quiz", "Perfect quiz", "Got every answer right on a practice test.", "check", "green", 1, "perfect_tests"),
    Badge("hard_test", "Hard test passed", "Scored 70% or more on a Hard practice test.", "trophy", "violet", 1, "hard_passed"),
    Badge("first_friend", "First friend", "Added a friend to study with.", "heart", "pink", 1, "friends"),
    Badge("friend_streak_7", "Study buddies", "Studied 7 days in a row with a friend.", "people", "pink", 7, "best_friend_streak"),
    Badge("instant_10", "Quick starter", "Finished 10 Instant Study rounds.", "bolt", "blue", 10, "instant_rounds"),
    Badge("otto_10", "Curious mind", "Asked Otto 10 questions.", "chat", "teal", 10, "otto_questions"),
    Badge("early_bird", "Early bird", "Studied before 8 am.", "sun", "amber", 1, "early"),
    Badge("night_owl", "Night owl", "Wrapped up some evening study. Rest well!", "moon", "violet", 1, "evening", secret=True),
)
BADGE_BY_ID = {badge.id: badge for badge in BADGES}


def _metric(connection, student_id: str, metric: str, hour: int | None) -> int:
    if metric == "notes":
        return connection.execute(select(func.count()).select_from(note_store.notes).where(
            note_store.notes.c.student_id == student_id)).scalar_one()
    if metric == "cards":
        return connection.execute(select(func.count()).select_from(flashcards.cards).where(
            flashcards.cards.c.owner_id == student_id)).scalar_one()
    if metric == "best_streak":
        row = connection.execute(select(database.student_progress.c.best_streak).where(
            database.student_progress.c.student_id == student_id)).scalar_one_or_none()
        return int(row or 0)
    if metric == "cards_reviewed":
        logged = connection.execute(select(func.coalesce(func.sum(study_activity.c.count), 0)).where(
            study_activity.c.student_id == student_id, study_activity.c.kind == "cards")).scalar_one()
        # Reviews from before rewards existed: the review state's counts are a floor.
        r = flashcards.reviews
        earlier = connection.execute(select(func.coalesce(func.sum(r.c.reps + r.c.lapses), 0)).where(
            r.c.owner_id == student_id)).scalar_one()
        return max(int(logged), int(earlier))
    if metric in ("perfect_tests", "hard_passed"):
        t = practice_tests.tests
        query = select(func.count()).select_from(t).where(
            t.c.owner_id == student_id, t.c.status == "submitted", t.c.question_count > 0)
        if metric == "perfect_tests":
            query = query.where(t.c.score >= t.c.question_count)
        else:
            query = query.where(t.c.difficulty == "hard", t.c.score * 10 >= t.c.question_count * 7)
        return connection.execute(query).scalar_one()
    if metric == "friends":
        return len(database._streak_friend_ids(connection, student_id))
    if metric == "best_friend_streak":
        friend_ids = database._streak_friend_ids(connection, student_id)
        if not friend_ids:
            return 0
        today = database.local_today()
        days = database._study_days(connection, [student_id, *friend_ids], today - timedelta(days=database.STREAK_LOOKBACK_DAYS))
        mine = days.get(student_id, set())
        return max((database._streak_view(mine, days.get(friend, set()), today)["best_friend_streak"] for friend in friend_ids), default=0)
    if metric == "instant_rounds":
        return int(connection.execute(select(func.coalesce(func.sum(study_activity.c.count), 0)).where(
            study_activity.c.student_id == student_id, study_activity.c.kind == "instant")).scalar_one())
    if metric == "otto_questions":
        c, m = tutor.conversations, tutor.messages
        asked = connection.execute(select(func.count()).select_from(m.join(c, m.c.conversation_id == c.c.id)).where(
            c.c.owner_id == student_id, m.c.role == "user")).scalar_one()
        logged = connection.execute(select(func.coalesce(func.sum(study_activity.c.count), 0)).where(
            study_activity.c.student_id == student_id, study_activity.c.kind == "otto")).scalar_one()
        return max(int(asked), int(logged))
    if metric == "early":
        # 5:00-7:59 local. Not the small hours: those are for sleeping.
        return 1 if hour is not None and 5 <= hour < 8 else 0
    if metric == "evening":
        # 9 pm to midnight local only, never after midnight.
        return 1 if hour is not None and 21 <= hour <= 23 else 0
    return 0


def _earned(connection, student_id: str) -> dict[str, datetime]:
    return dict(connection.execute(select(earned_badges.c.badge_id, earned_badges.c.earned_at).where(
        earned_badges.c.student_id == student_id)).all())


def award_badges(student_id: str, hour: int | None = None) -> list[Badge]:
    """Award every badge the student now qualifies for and hasn't got. Returns the new ones
    (each badge is inserted once; a parallel request that loses the insert returns nothing)."""
    _init_sources()
    new: list[Badge] = []
    now = _now()
    with database.engine().begin() as connection:
        earned = _earned(connection, student_id)
        values: dict[str, int] = {}
        for badge in BADGES:
            if badge.id in earned:
                continue
            if badge.metric not in values:
                values[badge.metric] = int(_metric(connection, student_id, badge.metric, hour))
            if values[badge.metric] >= badge.target and _insert_ignore(connection, earned_badges, [{
                "student_id": student_id, "badge_id": badge.id, "earned_at": now,
            }], ["student_id", "badge_id"]):
                new.append(badge)
    return new


def _badge_view(badge: Badge, earned_at: datetime | None, progress: int | None) -> dict:
    hidden = badge.secret and earned_at is None
    return {
        "id": badge.id,
        "title": "A surprise badge" if hidden else badge.title,
        "description": "Keep studying your way to find this one." if hidden else badge.description,
        "icon": "gift" if hidden else badge.icon,
        "tone": badge.tone,
        "earned": earned_at is not None,
        "earned_at": earned_at.isoformat() if earned_at else None,
        "progress": None if hidden or earned_at else min(int(progress or 0), badge.target),
        "target": None if hidden else badge.target,
        "secret": hidden,
    }


def badges(student_id: str) -> dict:
    """GET /api/badges: every badge, earned ones first (newest first), locked ones with progress."""
    award_badges(student_id)
    with database.engine().connect() as connection:
        earned = _earned(connection, student_id)
        values: dict[str, int] = {}
        for badge in BADGES:
            if badge.id not in earned and not badge.secret and badge.metric not in values:
                values[badge.metric] = int(_metric(connection, student_id, badge.metric, None))
    earned_list = sorted((badge for badge in BADGES if badge.id in earned), key=lambda badge: earned[badge.id], reverse=True)
    locked = [badge for badge in BADGES if badge.id not in earned]
    return {
        "badges": [_badge_view(badge, earned[badge.id], None) for badge in earned_list]
        + [_badge_view(badge, None, values.get(badge.metric)) for badge in locked],
        "earned": len(earned_list),
        "total": len(BADGES),
        "freezes": database.freeze_status(student_id),
    }


def friend_badges(viewer_id: str, friend_id: str) -> list[dict] | None:
    """A friend's earned badges, only for an accepted friend with no block either way (the
    friend's profile is visible there already). None when the viewer can't see them."""
    init_rewards()
    with database.engine().connect() as connection:
        if friend_id not in database._streak_friend_ids(connection, viewer_id):
            return None
        earned = _earned(connection, friend_id)
    ordered = sorted((badge for badge in BADGES if badge.id in earned), key=lambda badge: earned[badge.id], reverse=True)
    return [_badge_view(badge, earned[badge.id], None) for badge in ordered]


# --- Weekly recap -----------------------------------------------------------------------

def _week_bounds(today: date) -> tuple[date, date]:
    """Monday and Sunday of last week (local days)."""
    this_monday = today - timedelta(days=today.weekday())
    return this_monday - timedelta(days=7), this_monday - timedelta(days=1)


def _longest_run(days: set[date]) -> int:
    best = run = 0
    previous = None
    for day in sorted(days):
        run = run + 1 if previous is not None and day - previous == timedelta(days=1) else 1
        best = max(best, run)
        previous = day
    return best


def last_week(student_id: str, now: datetime | None = None) -> dict:
    """GET /api/recap/last-week: last Monday-Sunday (local) from existing tables. `show` is
    true until dismissed, and only when the week had any study in it."""
    _init_sources()
    now = now or _now()
    today = database.local_today(now)
    start, end = _week_bounds(today)
    begin_utc = database._local_day_start(start)
    end_utc = database._local_day_start(end + timedelta(days=1))
    with database.engine().connect() as connection:
        studied = {_as_date(day) for day in connection.execute(select(database.study_days.c.day).where(
            database.study_days.c.student_id == student_id, database.study_days.c.day >= start,
            database.study_days.c.day <= end)).scalars().all()}
        xp = int(connection.execute(select(func.coalesce(func.sum(database.xp_events.c.xp), 0)).where(
            database.xp_events.c.student_id == student_id, database.xp_events.c.created_at >= begin_utc,
            database.xp_events.c.created_at < end_utc)).scalar_one())
        cards = int(connection.execute(select(func.coalesce(func.sum(study_activity.c.count), 0)).where(
            study_activity.c.student_id == student_id, study_activity.c.kind == "cards",
            study_activity.c.day >= start, study_activity.c.day <= end)).scalar_one())
        # Best subject: the course with the most practice in it (test questions, lab answers,
        # cards last reviewed that week).
        subjects: dict[str, int] = {}
        t = practice_tests.tests
        for course, count in connection.execute(select(t.c.course, func.sum(t.c.question_count)).where(
                t.c.owner_id == student_id, t.c.status == "submitted", t.c.submitted_at >= begin_utc,
                t.c.submitted_at < end_utc).group_by(t.c.course)).all():
            subjects[course] = subjects.get(course, 0) + int(count or 0)
        r = practice.rounds
        for course, count in connection.execute(select(r.c.course, func.sum(r.c.total)).where(
                r.c.owner_id == student_id, r.c.created_at >= begin_utc, r.c.created_at < end_utc).group_by(r.c.course)).all():
            subjects[course] = subjects.get(course, 0) + int(count or 0)
        fr, fc = flashcards.reviews, flashcards.cards
        for course, count in connection.execute(select(fc.c.course, func.count()).select_from(
                fr.join(fc, fr.c.card_id == fc.c.id)).where(
                fr.c.owner_id == student_id, fr.c.last_reviewed_at >= begin_utc, fr.c.last_reviewed_at < end_utc,
                ).group_by(fc.c.course)).all():
            subjects[course] = subjects.get(course, 0) + int(count or 0)
        earned = connection.execute(select(earned_badges.c.badge_id).where(
            earned_badges.c.student_id == student_id, earned_badges.c.earned_at >= begin_utc,
            earned_badges.c.earned_at < end_utc).order_by(earned_badges.c.earned_at)).scalars().all()
        dismissed = connection.execute(select(reward_marks.c.mark).where(
            reward_marks.c.student_id == student_id, reward_marks.c.kind == "recap_dismissed",
            reward_marks.c.mark == start.isoformat())).first() is not None
    best = max(sorted(subjects), key=lambda course: subjects[course]) if subjects else None
    return {
        "week_start": start.isoformat(),
        "week_end": end.isoformat(),
        "days_studied": len(studied),
        "xp": xp,
        "cards_reviewed": cards,
        "best_subject": best,
        "longest_streak": _longest_run(studied),
        "badges_earned": [{"id": badge_id, "title": BADGE_BY_ID[badge_id].title, "icon": BADGE_BY_ID[badge_id].icon,
                           "tone": BADGE_BY_ID[badge_id].tone} for badge_id in earned if badge_id in BADGE_BY_ID],
        "dismissed": dismissed,
        "show": not dismissed and (bool(studied) or xp > 0),
    }


def dismiss_recap(student_id: str, now: datetime | None = None) -> dict:
    init_rewards()
    start, _ = _week_bounds(database.local_today(now or _now()))
    with database.engine().begin() as connection:
        _insert_ignore(connection, reward_marks, [{
            "student_id": student_id, "kind": "recap_dismissed", "mark": start.isoformat(), "created_at": _now(),
        }], ["student_id", "kind", "mark"])
        # Only the latest few weeks matter.
        connection.execute(delete(reward_marks).where(
            reward_marks.c.student_id == student_id, reward_marks.c.kind == "recap_dismissed",
            reward_marks.c.mark < (start - timedelta(days=56)).isoformat()))
    return {"dismissed": True, "week_start": start.isoformat()}


# --- Instant Study ----------------------------------------------------------------------

def studied_today(student_id: str) -> bool:
    database.init_db()
    days = database.study_days
    with database.engine().connect() as connection:
        return connection.execute(select(days.c.day).where(
            days.c.student_id == student_id, days.c.day == database.local_today())).first() is not None


# --- Account deletion -------------------------------------------------------------------

def delete_for_account_in(connection, student_id: str) -> None:
    """Every reward row of the account, inside account_deletion's transaction. Friends'
    rows are untouched (no reward table refers to another student)."""
    for table in (daily_quests, daily_chests, earned_badges, study_activity, reward_marks):
        connection.execute(delete(table).where(table.c.student_id == student_id))
