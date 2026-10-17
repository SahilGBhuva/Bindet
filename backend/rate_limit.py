"""Request rate limits.

Two layers protect the API:

1. A burst guard in front of every /api request (this module). It counts
   requests in memory per signed-in token, per network address, and per
   anonymous visitor, and answers 429 before any sign-in check, database or
   AI work happens. On Vercel each warm function instance keeps its own
   counts, so this layer stops floods and runaway clients rather than
   enforcing exact quotas.
2. Durable per-action limits stored in the database
   (database.check_social_rate_limit). Those hold across every instance and
   cover writes and paid AI work: uploads, tutor messages, quiz generation,
   friend requests, task edits and so on.
"""
from __future__ import annotations

import hashlib
import math
import os
import threading
import time
from collections import deque
from contextvars import ContextVar

# Requests per window. Generous for real study sessions, tight for scripts.
WINDOW_SECONDS = 60
SIGNED_IN_PER_MINUTE = 240      # one student's token
ADDRESS_PER_MINUTE = 1500       # one network address; a school can put hundreds of students behind one
ANONYMOUS_PER_MINUTE = 60       # requests without a sign-in, per address
# Tokens this instance has not verified yet get a budget of their own per address, so
# made-up tokens can't each mint a fresh per-user budget. It counts distinct tokens,
# not requests: a student opening the app sends several requests with one fresh token
# before any of them is verified, and a school can put hundreds of students behind one
# address. Floods of junk tokens are held back by auth's failed-verification budget
# (badauth), which turns every further unknown token from that address into a 429.
UNVERIFIED_TOKENS_PER_MINUTE = 600
AI_PER_MINUTE = 20              # tutor messages, quiz and flashcard generation, grading, note uploads, per student

# Owner accounts (OWNER_EMAILS, confirmed email) and Unlimited accounts skip per-student
# limits; they keep this much higher burst cap so a runaway loop still can't spend without bound.
OWNER_AI_PER_MINUTE = 120

AI_PATHS = ("/api/tutor/messages", "/api/generate-question", "/api/generate-flashcards", "/api/analyze-answer", "/api/notes", "/api/practice-tests",
            "/api/help-bot", "/api/study-guides")
# /api/auth/config only returns public values (the Supabase URL and anon key) and every
# page load asks for it, so it is never limited.
EXEMPT_PATHS = ("/api/health", "/api/auth/config")
# Routes that never verify a token: whatever the caller sends, they use the anonymous budget.
NO_AUTH_PATHS = ("/api/ai/warm",)
MAX_KEYS = 50_000
MAX_TOKEN_ADDRESSES = 10_000

# The caller's network address, for routes that apply per-address limits of their own.
client_address: ContextVar[str] = ContextVar("client_address", default="unknown")


class SlidingWindow:
    """Thread-safe sliding-window counter keyed by an opaque string."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window: float = WINDOW_SECONDS, now: float | None = None) -> float:
        """Record one request. Returns 0 if allowed, else seconds until the next request would be allowed."""
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                if len(self._hits) >= MAX_KEYS:
                    self._evict(now, window)
                hits = self._hits[key] = deque()
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) >= limit:
                return max(1.0, hits[0] + window - now)
            hits.append(now)
            return 0.0

    def is_limited(self, key: str, limit: int, window: float = WINDOW_SECONDS, now: float | None = None) -> bool:
        """True if the key has already used its budget. Records nothing."""
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.get(key)
            return bool(hits) and sum(1 for hit in hits if hit > now - window) >= limit

    def _evict(self, now: float, window: float) -> None:
        stale = [key for key, hits in self._hits.items() if not hits or hits[-1] <= now - window]
        for key in stale:
            del self._hits[key]
        if len(self._hits) >= MAX_KEYS:
            # Still full of active keys: drop the oldest half rather than grow without bound.
            for key in sorted(self._hits, key=lambda item: self._hits[item][-1])[: MAX_KEYS // 2]:
                del self._hits[key]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = SlidingWindow()


class DistinctTokens:
    """Remembers, per address, when each unverified token was last counted.

    Lets the limiter count a token once per window however many requests carry it.
    Bounded: each address keeps at most a couple of windows' worth of counted tokens
    (the limiter caps how many are counted), and the number of addresses is capped.
    """

    def __init__(self) -> None:
        self._seen: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()

    def counted_recently(self, address: str, token: str, window: float = WINDOW_SECONDS, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            last = self._seen.get(address, {}).get(token)
            return last is not None and last > now - window

    def mark(self, address: str, token: str, window: float = WINDOW_SECONDS, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            seen = self._seen.get(address)
            if seen is None:
                if len(self._seen) >= MAX_TOKEN_ADDRESSES:
                    self._evict_addresses(now, window)
                seen = self._seen[address] = {}
            if len(seen) >= 2 * UNVERIFIED_TOKENS_PER_MINUTE:
                for stale in [item for item, last in seen.items() if last <= now - window]:
                    del seen[stale]
                if len(seen) >= 2 * UNVERIFIED_TOKENS_PER_MINUTE:
                    for oldest in sorted(seen, key=seen.__getitem__)[: len(seen) // 2]:
                        del seen[oldest]
            seen[token] = now

    def _evict_addresses(self, now: float, window: float) -> None:
        stale = [address for address, seen in self._seen.items() if not seen or max(seen.values()) <= now - window]
        for address in stale:
            del self._seen[address]
        if len(self._seen) >= MAX_TOKEN_ADDRESSES:
            newest = {address: max(seen.values(), default=0.0) for address, seen in self._seen.items()}
            for address in sorted(newest, key=newest.__getitem__)[: MAX_TOKEN_ADDRESSES // 2]:
                del self._seen[address]

    def reset(self) -> None:
        with self._lock:
            self._seen.clear()


unverified_tokens = DistinctTokens()


def behind_trusted_proxy() -> bool:
    """Vercel sets VERCEL on every deployment, and its edge overwrites the forwarding headers."""
    return bool(os.getenv("VERCEL"))


def address_of(headers, fallback: str | None) -> str:
    """The client address.

    Forwarding headers are only trusted on Vercel, whose edge overwrites them so they
    can't be spoofed. Anywhere else a caller could send any value and pick a fresh
    budget per request, so the socket address is used.
    """
    if not behind_trusted_proxy():
        return fallback or "unknown"
    forwarded = headers.get("x-vercel-forwarded-for") or headers.get("x-real-ip") or headers.get("x-forwarded-for") or ""
    first = forwarded.split(",")[0].strip()
    return first or fallback or "unknown"


def token_is_verified(authorization: str) -> bool:
    """True when auth has already verified this exact token and still has it cached."""
    import auth  # auth imports this module, so import it lazily
    return auth.is_verified(authorization)


# Account ids auth has verified as owners in this process (bounded; refilled on every sign-in check).
_owner_ids: set[str] = set()
_owner_lock = threading.Lock()
MAX_OWNER_IDS = 50


def mark_owner(student_id: str) -> None:
    with _owner_lock:
        if student_id in _owner_ids:
            return
        if len(_owner_ids) >= MAX_OWNER_IDS:
            _owner_ids.clear()
        _owner_ids.add(student_id)


def forget_owner(student_id: str) -> None:
    with _owner_lock:
        _owner_ids.discard(student_id)


def is_owner(student_id: str | None) -> bool:
    if not student_id:
        return False
    with _owner_lock:
        return student_id in _owner_ids


# Plans (plans.py): the plan auth resolved for each verified account, kept briefly so a
# revoked grant ends within PLAN_CACHE_SECONDS on every instance. Refreshed by auth on
# every sign-in check once the entry is stale.
PLAN_CACHE_SECONDS = 120
MAX_PLAN_IDS = 20_000
PRO_AI_MULTIPLIER = 3
# Per-student AI limits Pro multiplies. Everything else (the help bot, friend requests,
# nudges, writes, sign-in and the burst guard) is the same for every plan.
# An AI route's request gate ("*_request", "*_start") must be listed with its AI gate, or
# the un-multiplied request gate caps Pro below 3x (quizzes: question_request 80/day in
# front of ai_question 40/day).
PRO_AI_ACTIONS = frozenset({
    "tutor_message", "tutor_message_day", "tutor_strong", "otto_title", "otto_memory",
    "ai_ocr", "note_upload", "flashcards_note", "ai_flashcards", "question_request", "ai_question", "ai_grading",
    "practice_test", "practice_test_start", "study_guide", "study_guide_request",
    "instant_key_points", "instant_key_points_request",
})
_plans: dict[str, tuple[float, str]] = {}
_plan_lock = threading.Lock()


def mark_plan(student_id: str, plan: str, now: float | None = None) -> None:
    """Remember the plan auth resolved for this account ('free', 'pro' or 'unlimited')."""
    if not student_id:
        return
    now = time.monotonic() if now is None else now
    with _plan_lock:
        if student_id not in _plans and len(_plans) >= MAX_PLAN_IDS:
            for stale in [key for key, (expires, _) in _plans.items() if expires <= now]:
                del _plans[stale]
            if len(_plans) >= MAX_PLAN_IDS:
                _plans.clear()
        _plans[student_id] = (now + PLAN_CACHE_SECONDS, plan)


def mark_pro(student_id: str) -> None:
    mark_plan(student_id, "pro")


def plan_is_fresh(student_id: str, now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    with _plan_lock:
        entry = _plans.get(student_id)
        return entry is not None and entry[0] > now


def plan_of(student_id: str | None, now: float | None = None) -> str:
    """'free' unless auth recently resolved a grant for this account. A stale entry counts as
    free; auth refreshes it on the account's next request."""
    if not student_id:
        return "free"
    now = time.monotonic() if now is None else now
    with _plan_lock:
        entry = _plans.get(student_id)
        return entry[1] if entry is not None and entry[0] > now else "free"


def is_pro(student_id: str | None) -> bool:
    return plan_of(student_id) == "pro"


def is_unlimited(student_id: str | None) -> bool:
    return plan_of(student_id) == "unlimited"


def forget_plans() -> None:
    """Drop every cached plan (after a grant changes), so this instance re-reads them."""
    with _plan_lock:
        _plans.clear()


def skips_student_limits(student_id: str | None) -> bool:
    """Owners and Unlimited accounts have no per-student limits. Unlimited gives no other
    owner power: admin routes and owner-only features check auth.is_owner_user."""
    return is_owner(student_id) or is_unlimited(student_id)


def limit_for(student_id: str | None, action: str, limit: int) -> int:
    """The per-student limit for this account: PRO_AI_MULTIPLIER times higher on Pro for AI actions."""
    if action in PRO_AI_ACTIONS and is_pro(student_id):
        return limit * PRO_AI_MULTIPLIER
    return limit


def token_is_owner(authorization: str) -> bool:
    """True when auth has verified this exact token and it belongs to an owner account."""
    import auth  # auth imports this module, so import it lazily
    return auth.is_owner_token(authorization)


def token_skips_student_limits(authorization: str) -> bool:
    """True when auth has verified this exact token and it belongs to an owner or Unlimited account."""
    import auth  # auth imports this module, so import it lazily
    return auth.is_owner_token(authorization) or auth.is_unlimited_token(authorization)


def token_key(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return hashlib.blake2s(authorization.encode("utf-8"), digest_size=12).hexdigest()


def check_request(path: str, method: str, address: str, authorization: str | None) -> float:
    """Return 0 to allow the request, or the number of seconds to wait."""
    if method == "OPTIONS" or not path.startswith("/api/") or path in EXEMPT_PATHS:
        return 0.0
    checks: list[tuple[str, int]] = [(f"ip:{address}", ADDRESS_PER_MINUTE)]
    token = None if path in NO_AUTH_PATHS else token_key(authorization)
    count_unverified = False
    if token:
        if not token_is_verified(authorization or "") and not unverified_tokens.counted_recently(address, token):
            # A token this instance hasn't verified yet: count it once per window per address.
            count_unverified = True
            checks.append((f"unverified:{address}", UNVERIFIED_TOKENS_PER_MINUTE))
        checks.append((f"user:{token}", SIGNED_IN_PER_MINUTE))
        if method == "POST" and path.startswith(AI_PATHS):
            checks.append((f"ai:{token}", OWNER_AI_PER_MINUTE if token_skips_student_limits(authorization or "") else AI_PER_MINUTE))
    else:
        checks.append((f"anon:{address}", ANONYMOUS_PER_MINUTE))
    for key, limit in checks:
        wait = limiter.hit(key, limit)
        if wait:
            return wait
    if count_unverified:
        # Only once the token was allowed, so a refused token is counted again on retry.
        unverified_tokens.mark(address, token)
    return 0.0


def retry_after(seconds: float) -> str:
    return str(max(1, math.ceil(seconds)))
