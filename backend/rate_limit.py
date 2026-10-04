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
import threading
import time
from collections import deque
from contextvars import ContextVar

# Requests per window. Generous for real study sessions, tight for scripts.
WINDOW_SECONDS = 60
SIGNED_IN_PER_MINUTE = 240      # one student's token
ADDRESS_PER_MINUTE = 1500       # one network address; a school can put hundreds of students behind one
ANONYMOUS_PER_MINUTE = 60       # requests without a sign-in, per address
AI_PER_MINUTE = 20              # tutor messages, quiz and flashcard generation, grading, note uploads, per student

AI_PATHS = ("/api/tutor/messages", "/api/generate-question", "/api/generate-flashcards", "/api/analyze-answer", "/api/notes")
EXEMPT_PATHS = ("/api/health",)
MAX_KEYS = 50_000

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


def address_of(headers, fallback: str | None) -> str:
    """The client address. Vercel overwrites these headers at its edge, so they can't be spoofed there."""
    forwarded = headers.get("x-vercel-forwarded-for") or headers.get("x-real-ip") or headers.get("x-forwarded-for") or ""
    first = forwarded.split(",")[0].strip()
    return first or fallback or "unknown"


def token_key(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return hashlib.blake2s(authorization.encode("utf-8"), digest_size=12).hexdigest()


def check_request(path: str, method: str, address: str, authorization: str | None) -> float:
    """Return 0 to allow the request, or the number of seconds to wait."""
    if method == "OPTIONS" or not path.startswith("/api/") or path in EXEMPT_PATHS:
        return 0.0
    checks: list[tuple[str, int]] = [(f"ip:{address}", ADDRESS_PER_MINUTE)]
    token = token_key(authorization)
    if token:
        checks.append((f"user:{token}", SIGNED_IN_PER_MINUTE))
        if method == "POST" and path.startswith(AI_PATHS):
            checks.append((f"ai:{token}", AI_PER_MINUTE))
    else:
        checks.append((f"anon:{address}", ANONYMOUS_PER_MINUTE))
    for key, limit in checks:
        wait = limiter.hit(key, limit)
        if wait:
            return wait
    return 0.0


def retry_after(seconds: float) -> str:
    return str(max(1, math.ceil(seconds)))
