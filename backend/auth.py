from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import os
import threading
import time
import httpx
from fastapi import HTTPException

import rate_limit

# Verification results are cached briefly per token, so repeated requests and
# junk tokens don't each cost a round trip to Supabase. A successful result is kept
# for at most VERIFY_CACHE_SECONDS and never past the token's own `exp`.
VERIFY_CACHE_SECONDS = 60
VERIFY_CACHE_MAX = 10_000
# Failed verifications allowed per network address per minute before answering 429.
FAILED_AUTH_PER_MINUTE = 30

_verify_cache: dict[str, tuple[float, dict | None, str]] = {}
_verify_lock = threading.Lock()


def public_settings() -> tuple[str, str]:
    url = os.getenv('SUPABASE_URL', '').rstrip('/')
    anon_key = os.getenv('SUPABASE_ANON_KEY', '')
    if not url or not anon_key:
        raise HTTPException(status_code=503, detail='Accounts are not configured yet')
    return url, anon_key


def account_deletion_enabled() -> bool:
    """True when the server can fully delete an account, including its Supabase login.

    Removing the login needs the service-role key; without it the Settings page offers
    deletion by email instead, so nobody is left with half an account."""
    return bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip() and os.getenv("SUPABASE_URL", "").strip())


def google_enabled() -> bool:
    """True once the owner has configured the Google provider in Supabase and set AUTH_GOOGLE_ENABLED.

    Off by default, so the "Continue with Google" button never appears before the
    provider exists (it would only lead to a Supabase error page).
    """
    return os.getenv('AUTH_GOOGLE_ENABLED', '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _cache_key(authorization: str) -> str:
    return hashlib.blake2s(authorization.encode('utf-8'), digest_size=16).hexdigest()


def _cached(key: str, now: float) -> tuple[dict | None, str] | None:
    with _verify_lock:
        entry = _verify_cache.get(key)
        if entry is None:
            return None
        expires, user, detail = entry
        if expires <= now:
            del _verify_cache[key]
            return None
        return copy.deepcopy(user), detail


def token_expiry(authorization: str) -> float | None:
    """The token's `exp` (Unix seconds) read from its payload, or None if unreadable.

    The signature is not checked here; Supabase already verified the token. This
    only bounds how long the verification may be reused.
    """
    token = authorization.split(' ', 1)[1].strip() if ' ' in authorization else ''
    parts = token.split('.')
    if len(parts) != 3 or len(parts[1]) > 8192:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        expiry = payload.get('exp') if isinstance(payload, dict) else None
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if isinstance(expiry, bool) or not isinstance(expiry, (int, float)):
        return None
    return float(expiry)


def _token_payload(authorization: str | None) -> dict | None:
    """The JWT payload, unverified. Only call this after authenticated_user() accepted
    the same token: Supabase has then checked its signature."""
    token = authorization.split(' ', 1)[1].strip() if authorization and ' ' in authorization else ''
    parts = token.split('.')
    if len(parts) != 3 or len(parts[1]) > 8192:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def signed_in_at(authorization: str | None) -> float | None:
    """When this session last signed in (Unix seconds), from the verified token, or None.

    Supabase puts each sign-in method and its time in the `amr` claim, and that time is
    kept when the access token is refreshed, so it is the real sign-in time. `iat` is
    when this access token was issued, which a background refresh (about hourly) moves
    forward; it is only used when the token carries no `amr` times.
    """
    payload = _token_payload(authorization)
    if payload is None:
        return None
    amr = payload.get('amr')
    if isinstance(amr, list):
        times = [_number(item.get('timestamp')) for item in amr if isinstance(item, dict)]
        times = [value for value in times if value is not None]
        if times:
            return max(times)
    return _number(payload.get('iat'))


def forget(authorization: str | None) -> None:
    """Drop a cached verification (after the account behind it was deleted)."""
    if not authorization:
        return
    with _verify_lock:
        _verify_cache.pop(_cache_key(authorization), None)


def delete_auth_user(user_id: str) -> bool:
    """Delete the Supabase Auth user with the admin API. True when it is gone (a 404 means
    an earlier attempt already deleted it). Needs SUPABASE_SERVICE_ROLE_KEY, which is sent
    only to Supabase and never logged; without it this returns False."""
    url = os.getenv('SUPABASE_URL', '').rstrip('/')
    service_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')
    if not url or not service_key or not user_id or '/' in user_id:
        return False
    try:
        response = httpx.delete(
            f'{url}/auth/v1/admin/users/{user_id}',
            headers={'apikey': service_key, 'Authorization': f'Bearer {service_key}'},
            timeout=10,
        )
    except httpx.RequestError:
        return False
    return response.status_code in (200, 204, 404)


def _cache_seconds(authorization: str) -> float:
    """Reuse a successful verification for at most a minute, and never past the token's exp."""
    expiry = token_expiry(authorization)
    if expiry is None:
        return 0.0
    return max(0.0, min(VERIFY_CACHE_SECONDS, expiry - time.time()))


def _remember(key: str, user: dict | None, detail: str, now: float, seconds: float = VERIFY_CACHE_SECONDS) -> None:
    if seconds <= 0:
        return
    with _verify_lock:
        if len(_verify_cache) >= VERIFY_CACHE_MAX:
            for stale in [item for item, entry in _verify_cache.items() if entry[0] <= now]:
                del _verify_cache[stale]
            if len(_verify_cache) >= VERIFY_CACHE_MAX:
                # Still full of live entries: drop the oldest half rather than grow without bound.
                for oldest in sorted(_verify_cache, key=lambda item: _verify_cache[item][0])[: VERIFY_CACHE_MAX // 2]:
                    del _verify_cache[oldest]
        _verify_cache[key] = (now + seconds, copy.deepcopy(user), detail)


def is_verified(authorization: str | None) -> bool:
    """True when this token was verified as a real account and the result is still cached.

    Read-only: the rate limiter uses it to tell verified tokens from unknown ones.
    """
    if not authorization:
        return False
    key = _cache_key(authorization)
    now = time.monotonic()
    with _verify_lock:
        entry = _verify_cache.get(key)
        return entry is not None and entry[0] > now and entry[1] is not None


def reset_cache() -> None:
    with _verify_lock:
        _verify_cache.clear()


def _too_many_failures() -> HTTPException:
    return HTTPException(
        status_code=429,
        detail='Too many failed sign-in attempts. Wait a minute and try again.',
        headers={'Retry-After': '60'},
    )


def _reject(detail: str) -> HTTPException:
    """Count a failed verification against the caller's address; past the budget it becomes a 429."""
    if rate_limit.limiter.hit(f'badauth:{rate_limit.client_address.get()}', FAILED_AUTH_PER_MINUTE):
        return _too_many_failures()
    return HTTPException(status_code=401, detail=detail)


def authenticated_user(authorization: str | None) -> dict:
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='Sign in required')
    now = time.monotonic()
    key = _cache_key(authorization)
    cached = _cached(key, now)
    if cached is not None:
        user, detail = cached
        if user is None:
            raise _reject(detail)
        return user
    if rate_limit.limiter.is_limited(f'badauth:{rate_limit.client_address.get()}', FAILED_AUTH_PER_MINUTE):
        # This address keeps sending bad tokens; don't spend a Supabase call on another one.
        raise _too_many_failures()
    url, anon_key = public_settings()
    try:
        response = httpx.get(f'{url}/auth/v1/user', headers={'apikey': anon_key, 'Authorization': authorization}, timeout=10)
    except httpx.RequestError as error:
        raise HTTPException(status_code=503, detail='Could not verify account') from error
    if response.status_code == 429 or response.status_code >= 500:
        # Supabase trouble says nothing about the token, so it is neither cached nor counted.
        raise HTTPException(status_code=401, detail='Your sign-in has expired')
    if response.status_code != 200:
        _remember(key, None, 'Your sign-in has expired', now)
        raise _reject('Your sign-in has expired')
    user = response.json()
    if not user.get('id'):
        _remember(key, None, 'Invalid account', now)
        raise _reject('Invalid account')
    _remember(key, user, '', now, _cache_seconds(authorization))
    return user
