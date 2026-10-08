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

# Owner accounts (OWNER_EMAILS, confirmed email) skip per-student limits; they keep this
# much higher burst cap so a runaway loop still can't spend without bound.
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


def token_is_owner(authorization: str) -> bool:
    """True when auth has verified this exact token and it belongs to an owner account."""
    import auth  # auth imports this module, so import it lazily
    return auth.is_owner_token(authorization)


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
            checks.append((f"ai:{token}", OWNER_AI_PER_MINUTE if token_is_owner(authorization or "") else AI_PER_MINUTE))
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
