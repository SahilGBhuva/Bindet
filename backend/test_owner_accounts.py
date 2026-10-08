import base64
import json
import os
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

import auth
import database
import rate_limit

OWNER = {"id": "owner-1", "email": "Owner@Example.com", "email_confirmed_at": "2026-01-01T00:00:00Z"}
STUDENT = {"id": "student-1", "email": "student@example.com", "email_confirmed_at": "2026-01-01T00:00:00Z"}


EXP = int(time.time()) + 3600  # fixed, so the same name always gives the same token


def jwt(name):
    """A token shaped like Supabase's, so auth caches its verification until exp."""
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")  # noqa: E731
    return f"{part({'alg': 'HS256'})}.{part({'sub': name, 'exp': EXP})}.sig"


def supabase_returns(user):
    response = MagicMock(status_code=200)
    response.json.return_value = dict(user)
    return response


class OwnerAccountTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"OWNER_EMAILS": " owner@example.com , second@example.com "})
        self.env.start()
        self.addCleanup(self.env.stop)
        with auth._verify_lock:
            auth._verify_cache.clear()
        self.addCleanup(rate_limit._owner_ids.clear)

    def sign_in(self, user, token):
        with patch.object(auth, "public_settings", return_value=("http://sb.test", "anon")), \
                patch.object(auth.httpx, "get", return_value=supabase_returns(user)):
            return auth.authenticated_user(f"Bearer {jwt(token)}")

    def test_owner_needs_a_listed_and_confirmed_email(self):
        self.assertTrue(auth.is_owner_user(OWNER))
        self.assertFalse(auth.is_owner_user(STUDENT))
        self.assertFalse(auth.is_owner_user({**OWNER, "email_confirmed_at": None}))
        # confirmed_at is also set by a confirmed phone number: only a confirmed email counts.
        self.assertFalse(auth.is_owner_user({**OWNER, "email_confirmed_at": None, "confirmed_at": "2026-01-01T00:00:00Z"}))
        with patch.dict(os.environ, {"OWNER_EMAILS": ""}):
            self.assertFalse(auth.is_owner_user(OWNER))

    def test_owner_skips_per_student_limits_and_students_do_not(self):
        self.sign_in(OWNER, "owner-token")
        self.sign_in(STUDENT, "student-token")
        for _ in range(5):
            database.check_social_rate_limit("owner-1", "ai_question", 2, 1440)
        database.check_social_rate_limit("student-1", "ai_question", 2, 1440)
        database.check_social_rate_limit("student-1", "ai_question", 2, 1440)
        with self.assertRaises(ValueError):
            database.check_social_rate_limit("student-1", "ai_question", 2, 1440)

    def test_owner_gets_a_higher_but_finite_burst_cap(self):
        self.sign_in(OWNER, "owner-burst")
        self.sign_in(STUDENT, "student-burst")
        fresh = patch.object(rate_limit, "limiter", rate_limit.SlidingWindow())
        fresh.start()
        self.addCleanup(fresh.stop)
        allowed = lambda token, n: sum(  # noqa: E731
            rate_limit.check_request("/api/generate-question", "POST", f"10.0.0.{n}", f"Bearer {jwt(token)}") == 0
            for _ in range(rate_limit.OWNER_AI_PER_MINUTE + 5)
        )
        self.assertEqual(allowed("student-burst", 1), rate_limit.AI_PER_MINUTE)
        self.assertEqual(allowed("owner-burst", 2), rate_limit.OWNER_AI_PER_MINUTE)

    def test_removing_an_email_ends_owner_status_at_the_next_sign_in_check(self):
        self.sign_in(OWNER, "owner-revoke")
        self.assertTrue(rate_limit.is_owner("owner-1"))
        with patch.dict(os.environ, {"OWNER_EMAILS": "someone-else@example.com"}):
            auth.authenticated_user(f"Bearer {jwt('owner-revoke')}")  # served from the verified-token cache
        self.assertFalse(rate_limit.is_owner("owner-1"))


if __name__ == "__main__":
    unittest.main()
