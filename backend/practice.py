"""Practice lab: quick rounds, personal bests and asynchronous challenges.

Everything here runs on the student's saved flashcards (flashcards.cards) and never
calls an AI model, so it costs nothing to run.

- A quick round is a timed run through the student's cards for one unit (or every unit
  of a course). The browser sends each answer as (card ID, right or wrong) once the
  round ends; the server checks that every card is the student's own and in scope, and
  derives the score, correct count and best streak itself, so impossible scores can't
  be stored. XP is small and capped per round, per day from rounds, and by the global
  daily XP cap (database.award_xp_in).
- A personal best is kept per course, unit, round length and mode, and only replaced
  when a round beats it (higher score, or the same score with better accuracy).
- A challenge snapshots up to 30 of the challenger's cards (question and answer text,
  in order) so the friend can play the identical round without access to the
  challenger's notes. Only accepted friends or members of a shared study group can
  challenge each other, never across a block in either direction. Each participant
  submits once; challenges expire after 7 days.

Every function takes the authenticated student's ID and filters by it, and a
challenge is only visible to its two participants.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from sqlalchemy import (
    JSON, Column, DateTime, Index, Integer, MetaData, String, Table, and_, delete, func, or_, select, update,
)

import database
import flashcards

practice_metadata = MetaData()

rounds = Table(
    "practice_rounds", practice_metadata,
    Column("id", String(32), primary_key=True),
    Column("owner_id", String(100), nullable=False),
    Column("course", String(120), nullable=False),
    Column("unit", String(160), nullable=False, default=""),  # "" = every unit of the course
    Column("length_s", Integer, nullable=False),
    Column("mode", String(8), nullable=False),
    Column("score", Integer, nullable=False),
    Column("correct", Integer, nullable=False),
    Column("total", Integer, nullable=False),
    Column("best_streak", Integer, nullable=False),
    Column("xp", Integer, nullable=False, default=0),
    Column("challenge_id", String(32), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_practice_rounds_owner_created", "owner_id", "created_at"),
)

bests = Table(
    "practice_bests", practice_metadata,
    Column("owner_id", String(100), primary_key=True),
    Column("course", String(120), primary_key=True),
    Column("unit", String(160), primary_key=True),
    Column("length_s", Integer, primary_key=True),
    Column("mode", String(8), primary_key=True),
    Column("best_score", Integer, nullable=False),
    Column("best_accuracy", Integer, nullable=False),  # whole percent
    Column("achieved_at", DateTime(timezone=True), nullable=False),
)

challenges = Table(
    "practice_challenges", practice_metadata,
    Column("id", String(32), primary_key=True),
    Column("from_id", String(100), nullable=False, index=True),
    Column("to_id", String(100), nullable=False, index=True),
    Column("course", String(120), nullable=False),
    Column("unit", String(160), nullable=False, default=""),
    Column("length_s", Integer, nullable=False),
    Column("mode", String(8), nullable=False),
    Column("cards", JSON, nullable=False),  # [{"front", "back", "unit"}], copies, max 30
    Column("status", String(10), nullable=False, default="pending"),
    Column("from_score", Integer, nullable=True),
    Column("to_score", Integer, nullable=True),
    Column("from_correct", Integer, nullable=True),
    Column("to_correct", Integer, nullable=True),
    Column("from_total", Integer, nullable=True),
    Column("to_total", Integer, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("completed_at", DateTime(timezone=True), nullable=True),
    Column("expires_at", DateTime(timezone=True), nullable=False),
)

PRACTICE_TABLES = ("practice_rounds", "practice_bests", "practice_challenges")

LENGTHS = (60, 120, 300)
MODES = ("self", "choice")
CHOICE_MIN_CARDS = 4
# A student can't honestly answer more than one card a second, so a round of N seconds
# holds at most N answers.
MAX_ANSWERS = max(LENGTHS)
STREAK_BONUS_FROM = 5          # from the 5th right answer in a row, each one counts double
ROUND_XP_MAX = 15              # XP from one round (1 per right answer)
ROUNDS_XP_PER_DAY = 50         # XP from all rounds and challenge plays in one UTC day
CHALLENGE_MAX_CARDS = 30
CHALLENGE_DAYS = 7
CARD_FRONT_MAX = 300           # the flashcards table's own column sizes
CARD_BACK_MAX = 700
UNIT_MAX = 160


@lru_cache(maxsize=1)
def init_practice() -> None:
    database.init_db()
    flashcards.init_flashcards()
    # Served only through the API; RLS on, no policy and no client grants, created and
    # locked in one transaction (see database.create_locked_tables).
    database.create_locked_tables(database.engine(), practice_metadata, PRACTICE_TABLES, PRACTICE_TABLES)


class PracticeError(ValueError):
    """A refused request: status, machine code and a message written for the student."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: datetime | None) -> str | None:
    value = _utc(value)
    return value.isoformat() if value else None


def _accuracy(correct: int, total: int) -> int:
    return round(correct * 100 / total) if total else 0


def score_answers(results: list[bool]) -> dict:
    """Score, right answers and best streak for a sequence of right/wrong answers."""
    score = correct = streak = best = 0
    for right in results:
        if right:
            correct += 1
            streak += 1
            best = max(best, streak)
            score += 2 if streak >= STREAK_BONUS_FROM else 1
        else:
            streak = 0
    return {"score": score, "correct": correct, "total": len(results), "best_streak": best}


def _check_settings(length_s: int, mode: str) -> None:
    if length_s not in LENGTHS:
        raise PracticeError(400, "invalid_length", "Pick a round of 1, 2 or 5 minutes.")
    if mode not in MODES:
        raise PracticeError(400, "invalid_mode", "Pick self-check or multiple choice.")


def _scope_filter(owner_id: str, course: str, unit: str):
    conditions = [flashcards.cards.c.owner_id == owner_id, flashcards.cards.c.course == course]
    if unit:
        conditions.append(flashcards.cards.c.unit == unit)
    return conditions


# --- Cards -----------------------------------------------------------------------------

def scopes(owner_id: str) -> list[dict]:
    """Every course and unit where the student has saved cards, with how many."""
    init_practice()
    cards = flashcards.cards
    with database.engine().connect() as connection:
        rows = connection.execute(select(cards.c.course, cards.c.unit, func.count().label("card_count")).where(
            cards.c.owner_id == owner_id,
        ).group_by(cards.c.course, cards.c.unit).order_by(cards.c.course, cards.c.unit)).mappings().all()
    return [dict(row) for row in rows]


def cards_for(owner_id: str, course: str, unit: str = "") -> list[dict]:
    """The student's own saved cards for a unit, or every unit of a course when unit is ""."""
    init_practice()
    cards = flashcards.cards
    with database.engine().connect() as connection:
        rows = connection.execute(select(cards.c.id, cards.c.unit, cards.c.front, cards.c.back).where(
            *_scope_filter(owner_id, course, unit),
        ).order_by(cards.c.unit, cards.c.position, cards.c.created_at, cards.c.id)).mappings().all()
    return [dict(row) for row in rows]


def _owned_cards(connection, owner_id: str, course: str, unit: str, card_ids: list[str]) -> list[dict]:
    """The listed cards in the given order, or a 400 if any is not the owner's card in scope."""
    if len(set(card_ids)) != len(card_ids):
        raise PracticeError(400, "invalid_cards", "Each card can only appear once in a round.")
    cards = flashcards.cards
    rows = {row["id"]: dict(row) for row in connection.execute(select(cards.c.id, cards.c.unit, cards.c.front, cards.c.back).where(
        *_scope_filter(owner_id, course, unit), cards.c.id.in_(card_ids),
    )).mappings().all()} if card_ids else {}
    if len(rows) != len(card_ids):
        raise PracticeError(400, "invalid_cards", "Those cards aren’t in your saved flashcards for this unit. Refresh and try again.")
    return [rows[card_id] for card_id in card_ids]


def _scope_size(connection, owner_id: str, course: str, unit: str) -> int:
    return int(connection.execute(select(func.count()).select_from(flashcards.cards).where(
        *_scope_filter(owner_id, course, unit),
    )).scalar_one())


# --- Rounds and bests -----------------------------------------------------------------------

def _round_xp_left(connection, owner_id: str) -> int:
    now = _now()
    day_start = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)
    earned = connection.execute(select(func.coalesce(func.sum(rounds.c.xp), 0)).where(
        rounds.c.owner_id == owner_id, rounds.c.created_at >= day_start,
    )).scalar_one()
    return max(0, ROUNDS_XP_PER_DAY - int(earned))


def _store_round(connection, owner_id: str, *, course: str, unit: str, length_s: int, mode: str,
                 scored: dict, challenge_id: str | None = None) -> dict:
    """Insert the round, award its XP and return the stored row (as the API shows it)."""
    database._advisory_lock(connection, f"practice:xp:{owner_id}")
    xp = min(scored["correct"], ROUND_XP_MAX, _round_xp_left(connection, owner_id))
    awarded = database.award_xp_in(connection, owner_id, xp, active=scored["correct"] > 0)
    row = {
        "id": uuid.uuid4().hex, "owner_id": owner_id, "course": course, "unit": unit,
        "length_s": length_s, "mode": mode, "score": scored["score"], "correct": scored["correct"],
        "total": scored["total"], "best_streak": scored["best_streak"], "xp": awarded["xp_awarded"],
        "challenge_id": challenge_id, "created_at": _now(),
    }
    connection.execute(rounds.insert().values(**row))
    return {**_round_view(row), "total_xp": awarded["total_xp"], "streak": awarded["streak"]}


def _round_view(row) -> dict:
    return {
        "id": row["id"], "course": row["course"], "unit": row["unit"], "length_s": row["length_s"],
        "mode": row["mode"], "score": row["score"], "correct": row["correct"], "total": row["total"],
        "accuracy": _accuracy(row["correct"], row["total"]), "best_streak": row["best_streak"],
        "xp": row["xp"], "challenge_id": row["challenge_id"], "created_at": _iso(row["created_at"]),
    }


def _best_view(row) -> dict:
    return {
        "course": row["course"], "unit": row["unit"], "length_s": row["length_s"], "mode": row["mode"],
        "best_score": row["best_score"], "best_accuracy": row["best_accuracy"], "achieved_at": _iso(row["achieved_at"]),
    }


def submit_round(owner_id: str, *, course: str, unit: str, length_s: int, mode: str, answers: list[tuple[str, bool]]) -> dict:
    """Validate and store a finished quick round. answers are (card ID, right) in the order played."""
    init_practice()
    _check_settings(length_s, mode)
    if not answers:
        raise PracticeError(400, "empty_round", "Answer at least one card to save a round.")
    if len(answers) > length_s:
        raise PracticeError(400, "impossible_round", "That round has more answers than its time allows.")
    with flashcards._guard(), database.engine().begin() as connection:
        available = _scope_size(connection, owner_id, course, unit)
        if mode == "choice" and available < CHOICE_MIN_CARDS:
            raise PracticeError(400, "invalid_mode", "Multiple choice needs at least 4 cards in this unit.")
        _owned_cards(connection, owner_id, course, unit, [card_id for card_id, _ in answers])
        scored = score_answers([right for _, right in answers])
        stored = _store_round(connection, owner_id, course=course, unit=unit, length_s=length_s, mode=mode, scored=scored)

        key = (bests.c.owner_id == owner_id, bests.c.course == course, bests.c.unit == unit,
               bests.c.length_s == length_s, bests.c.mode == mode)
        previous = connection.execute(select(bests).where(*key)).mappings().first()
        accuracy = _accuracy(scored["correct"], scored["total"])
        improved = previous is None or scored["score"] > previous["best_score"] or (
            scored["score"] == previous["best_score"] and accuracy > previous["best_accuracy"])
        # A round with nothing right isn't a best worth keeping.
        new_best = improved and scored["score"] > 0
        if new_best:
            values = {"best_score": scored["score"], "best_accuracy": accuracy, "achieved_at": _now()}
            if previous is None:
                connection.execute(bests.insert().values(owner_id=owner_id, course=course, unit=unit,
                                                         length_s=length_s, mode=mode, **values))
            else:
                connection.execute(update(bests).where(*key).values(**values))
        best = connection.execute(select(bests).where(*key)).mappings().first()
    return {
        "round": {key_: value for key_, value in stored.items() if key_ not in ("total_xp", "streak")},
        "xp_earned": stored["xp"], "total_xp": stored["total_xp"], "streak": stored["streak"],
        "new_best": new_best,
        "previous_best": _best_view(previous) if previous is not None and new_best else None,
        "best": _best_view(best) if best is not None else None,
    }


def list_bests(owner_id: str) -> list[dict]:
    init_practice()
    with database.engine().connect() as connection:
        rows = connection.execute(select(bests).where(bests.c.owner_id == owner_id).order_by(
            bests.c.course, bests.c.unit, bests.c.length_s, bests.c.mode)).mappings().all()
    return [_best_view(row) for row in rows]


def list_rounds(owner_id: str, limit: int = 10) -> list[dict]:
    init_practice()
    with database.engine().connect() as connection:
        rows = connection.execute(select(rounds).where(rounds.c.owner_id == owner_id).order_by(
            rounds.c.created_at.desc(), rounds.c.id).limit(max(1, min(limit, 50)))).mappings().all()
    return [_round_view(row) for row in rows]


# --- Challenges -----------------------------------------------------------------------

def _blocked_between(connection, first: str, second: str) -> bool:
    blocks = database.social_blocks
    return connection.execute(select(blocks.c.id).where(or_(
        and_(blocks.c.blocker_id == first, blocks.c.blocked_id == second),
        and_(blocks.c.blocker_id == second, blocks.c.blocked_id == first),
    ))).first() is not None


def _can_challenge(connection, first: str, second: str) -> bool:
    """Accepted friends, or members of at least one study group together."""
    friendships = database.friendships
    if connection.execute(select(friendships.c.id).where(friendships.c.status == "accepted", or_(
        and_(friendships.c.requester_id == first, friendships.c.recipient_id == second),
        and_(friendships.c.requester_id == second, friendships.c.recipient_id == first),
    ))).first():
        return True
    members = database.study_group_members
    mine = select(members.c.group_id).where(members.c.student_id == first)
    return connection.execute(select(members.c.id).where(
        members.c.student_id == second, members.c.group_id.in_(mine),
    ).limit(1)).first() is not None


def _blocked_ids(connection, student_id: str) -> set[str]:
    blocks = database.social_blocks
    ids = set()
    for blocker, blocked in connection.execute(select(blocks.c.blocker_id, blocks.c.blocked_id).where(
        or_(blocks.c.blocker_id == student_id, blocks.c.blocked_id == student_id))).all():
        ids.add(blocked if blocker == student_id else blocker)
    return ids


def _expire_due(connection, student_id: str | None = None) -> None:
    conditions = [challenges.c.status == "pending", challenges.c.expires_at < _now()]
    if student_id is not None:
        conditions.append(or_(challenges.c.from_id == student_id, challenges.c.to_id == student_id))
    connection.execute(update(challenges).where(*conditions).values(status="expired"))


def _names(connection, ids: set[str]) -> dict[str, dict]:
    if not ids:
        return {}
    profiles = database.profiles
    return {row["student_id"]: dict(row) for row in connection.execute(select(
        profiles.c.student_id, profiles.c.username, profiles.c.display_name, profiles.c.avatar_path,
    ).where(profiles.c.student_id.in_(ids))).mappings().all()}


def _challenge_view(row, viewer: str, people: dict[str, dict], include_cards: bool = False) -> dict:
    mine, theirs = ("from", "to") if row["from_id"] == viewer else ("to", "from")
    opponent_id = row[f"{theirs}_id"]
    person = people.get(opponent_id) or {"student_id": opponent_id, "username": "", "display_name": "A bindit student", "avatar_path": ""}
    my_score, their_score = row[f"{mine}_score"], row[f"{theirs}_score"]
    winner = None
    if row["status"] == "completed":
        winner = "tie" if my_score == their_score else ("me" if my_score > their_score else "them")
    view = {
        "id": row["id"], "role": "sent" if mine == "from" else "received",
        "opponent": {key: person.get(key, "") for key in ("student_id", "username", "display_name", "avatar_path")},
        "course": row["course"], "unit": row["unit"], "length_s": row["length_s"], "mode": row["mode"],
        "card_count": len(row["cards"] or []), "status": row["status"],
        "my_score": my_score, "my_correct": row[f"{mine}_correct"], "my_total": row[f"{mine}_total"],
        "their_score": their_score, "their_correct": row[f"{theirs}_correct"], "their_total": row[f"{theirs}_total"],
        "my_turn": row["status"] == "pending" and my_score is None,
        "winner": winner,
        "created_at": _iso(row["created_at"]), "expires_at": _iso(row["expires_at"]), "completed_at": _iso(row["completed_at"]),
    }
    if include_cards:
        view["cards"] = [{"index": index, "front": card.get("front", ""), "back": card.get("back", ""), "unit": card.get("unit", "")}
                         for index, card in enumerate(row["cards"] or [])]
    return view


def _participant_row(connection, student_id: str, challenge_id: str, *, for_update: bool = False):
    query = select(challenges).where(
        challenges.c.id == challenge_id,
        or_(challenges.c.from_id == student_id, challenges.c.to_id == student_id),
    )
    if for_update and connection.dialect.name == "postgresql":
        query = query.with_for_update()
    row = connection.execute(query).mappings().first()
    if row is None:
        raise PracticeError(404, "challenge_not_found", "That challenge isn’t available.")
    other = row["to_id"] if row["from_id"] == student_id else row["from_id"]
    if _blocked_between(connection, student_id, other):
        raise PracticeError(404, "challenge_not_found", "That challenge isn’t available.")
    return row


def _notify(connection, recipient: str, actor: str, kind: str, message: str) -> None:
    connection.execute(database.social_notifications.insert().values(
        recipient_id=recipient, actor_id=actor, kind=kind, message=message[:240], is_read=False, created_at=_now(),
    ))


def _scope_label(course: str, unit: str) -> str:
    return f"{course} · {unit}" if unit else f"{course} (all units)"


def create_challenge(from_id: str, *, to_id: str, course: str, unit: str, length_s: int, mode: str,
                     card_ids: list[str], answers: list[bool] | None = None) -> dict:
    """Snapshot the challenger's cards and send the challenge. answers, when given, are the
    challenger's own results on these cards from the round they just played."""
    init_practice()
    _check_settings(length_s, mode)
    if to_id == from_id:
        raise PracticeError(400, "cannot_challenge_self", "Pick a friend to challenge.")
    if not 1 <= len(card_ids) <= CHALLENGE_MAX_CARDS:
        raise PracticeError(400, "invalid_cards", f"A challenge uses between 1 and {CHALLENGE_MAX_CARDS} cards.")
    if mode == "choice" and len(card_ids) < CHOICE_MIN_CARDS:
        raise PracticeError(400, "invalid_mode", "Multiple choice needs at least 4 cards.")
    if answers is not None and (not answers or len(answers) > len(card_ids) or len(answers) > length_s):
        raise PracticeError(400, "impossible_round", "Those results don’t match the challenge’s cards.")
    now = _now()
    with database.engine().begin() as connection:
        people = _names(connection, {from_id, to_id})
        if from_id not in people:
            raise PracticeError(400, "profile_not_found", "Finish setting up your profile first.")
        if to_id not in people:
            raise PracticeError(404, "person_not_found", "That person couldn’t be found.")
        if _blocked_between(connection, from_id, to_id) or not _can_challenge(connection, from_id, to_id):
            raise PracticeError(403, "not_allowed", "You can only challenge friends and people in your study groups.")
        picked = _owned_cards(connection, from_id, course, unit, card_ids)
        snapshot = [{"front": card["front"][:CARD_FRONT_MAX], "back": card["back"][:CARD_BACK_MAX],
                     "unit": (card["unit"] or "")[:UNIT_MAX]} for card in picked]
        row = {
            "id": uuid.uuid4().hex, "from_id": from_id, "to_id": to_id, "course": course, "unit": unit,
            "length_s": length_s, "mode": mode, "cards": snapshot, "status": "pending",
            "created_at": now, "expires_at": now + timedelta(days=CHALLENGE_DAYS), "completed_at": None,
            "from_score": None, "to_score": None, "from_correct": None, "to_correct": None,
            "from_total": None, "to_total": None,
        }
        if answers is not None:
            scored = score_answers(answers)
            row.update(from_score=scored["score"], from_correct=scored["correct"], from_total=scored["total"])
        connection.execute(challenges.insert().values(**row))
        name = people[from_id]["display_name"]
        minutes = "1 minute" if length_s == 60 else f"{length_s // 60} minutes"
        _notify(connection, to_id, from_id, "practice_challenge",
                f"{name} challenged you to a {minutes} round on {_scope_label(course, unit)}. Open Practice lab to play.")
    return _challenge_view(row, from_id, people)


def list_challenges(student_id: str, limit: int = 50) -> list[dict]:
    """Sent and received challenges: the student's turn first, then other pending ones, then the rest, newest first."""
    init_practice()
    with database.engine().begin() as connection:
        _expire_due(connection, student_id)
        blocked = _blocked_ids(connection, student_id)
        rows = connection.execute(select(challenges).where(
            or_(challenges.c.from_id == student_id, challenges.c.to_id == student_id),
        ).order_by(challenges.c.created_at.desc(), challenges.c.id).limit(200)).mappings().all()
        rows = [row for row in rows if (row["to_id"] if row["from_id"] == student_id else row["from_id"]) not in blocked]
        people = _names(connection, {row["from_id"] for row in rows} | {row["to_id"] for row in rows})
    views = [_challenge_view(row, student_id, people) for row in rows]
    views.sort(key=lambda view: 0 if view["my_turn"] else 1 if view["status"] == "pending" else 2)  # stable: newest first within each
    return views[:limit]


def get_challenge(student_id: str, challenge_id: str) -> dict:
    """One challenge for a participant, with its cards."""
    init_practice()
    with database.engine().begin() as connection:
        _expire_due(connection, student_id)
        row = _participant_row(connection, student_id, challenge_id)
        people = _names(connection, {row["from_id"], row["to_id"]})
    return _challenge_view(row, student_id, people, include_cards=True)


def submit_challenge_result(student_id: str, challenge_id: str, answers: list[bool]) -> dict:
    """A participant's one result. Earns round XP (within the same daily caps)."""
    init_practice()
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"practice:challenge:{challenge_id}")
        _expire_due(connection, student_id)
        row = _participant_row(connection, student_id, challenge_id, for_update=True)
        side = "from" if row["from_id"] == student_id else "to"
        if row["status"] == "expired":
            raise PracticeError(409, "challenge_expired", "This challenge has expired.")
        if row["status"] == "declined":
            raise PracticeError(409, "challenge_declined", "This challenge was declined.")
        if row[f"{side}_score"] is not None or row["status"] != "pending":
            raise PracticeError(409, "already_played", "You’ve already played this challenge.")
        if not answers or len(answers) > len(row["cards"] or []) or len(answers) > row["length_s"]:
            raise PracticeError(400, "impossible_round", "Those results don’t match the challenge’s cards.")
        scored = score_answers(answers)
        stored = _store_round(connection, student_id, course=row["course"], unit=row["unit"], length_s=row["length_s"],
                              mode=row["mode"], scored=scored, challenge_id=row["id"])
        other = "to" if side == "from" else "from"
        values = {f"{side}_score": scored["score"], f"{side}_correct": scored["correct"], f"{side}_total": scored["total"]}
        finished = row[f"{other}_score"] is not None
        if finished:
            values.update(status="completed", completed_at=_now())
        connection.execute(update(challenges).where(challenges.c.id == challenge_id).values(**values))
        updated = connection.execute(select(challenges).where(challenges.c.id == challenge_id)).mappings().one()
        people = _names(connection, {row["from_id"], row["to_id"]})
        name = people.get(student_id, {}).get("display_name", "Your friend")
        if finished:
            _notify(connection, row[f"{other}_id"], student_id, "practice_result",
                    f"{name} finished your challenge: {scored['score']} to {row[f'{other}_score']}. See the result in Practice lab.")
        elif side == "to":
            _notify(connection, row["from_id"], student_id, "practice_result",
                    f"{name} played your challenge. Play your turn in Practice lab.")
    return {"challenge": _challenge_view(updated, student_id, people), "xp_earned": stored["xp"],
            "total_xp": stored["total_xp"], "streak": stored["streak"]}


def decline_challenge(student_id: str, challenge_id: str) -> dict:
    """Only the friend who received it can decline, and only before playing."""
    init_practice()
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"practice:challenge:{challenge_id}")
        _expire_due(connection, student_id)
        row = _participant_row(connection, student_id, challenge_id, for_update=True)
        if row["to_id"] != student_id:
            raise PracticeError(403, "not_allowed", "Only the person you challenged can decline.")
        if row["status"] != "pending" or row["to_score"] is not None:
            raise PracticeError(409, "challenge_closed", "This challenge can’t be declined any more.")
        connection.execute(update(challenges).where(challenges.c.id == challenge_id).values(status="declined", completed_at=_now()))
        updated = connection.execute(select(challenges).where(challenges.c.id == challenge_id)).mappings().one()
        people = _names(connection, {row["from_id"], row["to_id"]})
    return _challenge_view(updated, student_id, people)


# --- Account deletion and tests -----------------------------------------------------------

def delete_for_account_in(connection, student_id: str) -> None:
    """Rounds, bests, and challenges the student sent or received (account deletion)."""
    connection.execute(delete(rounds).where(rounds.c.owner_id == student_id))
    connection.execute(delete(bests).where(bests.c.owner_id == student_id))
    connection.execute(delete(challenges).where(or_(challenges.c.from_id == student_id, challenges.c.to_id == student_id)))


def reset_practice() -> None:
    """Test helper."""
    init_practice()
    with database.engine().begin() as connection:
        connection.execute(delete(rounds))
        connection.execute(delete(bests))
        connection.execute(delete(challenges))
