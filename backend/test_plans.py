import base64
import json
import os
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

from fastapi.testclient import TestClient

import auth
import database
import main
import plans
import rate_limit

CONFIRMED = "2026-01-01T00:00:00Z"
OWNER = {"id": "owner-1", "email": "owner@example.com", "email_confirmed_at": CONFIRMED}
ADMIN = {"id": "admin-1", "email": "admin@example.com", "email_confirmed_at": CONFIRMED}
PRO = {"id": "pro-1", "email": "Pro.Student+school@example.com", "email_confirmed_at": CONFIRMED}
FREE = {"id": "free-1", "email": "free@example.com", "email_confirmed_at": CONFIRMED}
TESTER = {"id": "tester-1", "email": "tester@example.com", "email_confirmed_at": CONFIRMED}
UNCONFIRMED = {"id": "unconfirmed-1", "email": "pro.student@example.com", "email_confirmed_at": None}

EXP = int(time.time()) + 3600


def jwt(name: str) -> str:
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")  # noqa: E731
    return f"Bearer {part({'alg': 'HS256'})}.{part({'sub': name, 'exp': EXP})}.sig"


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"OWNER_EMAILS": "owner@example.com", "ADMIN_EMAILS": "admin@example.com",
                                           "SUPABASE_URL": "http://sb.test", "SUPABASE_ANON_KEY": "anon"})
        self.env.start()
        self.addCleanup(self.env.stop)
        database.reset_db()
        plans.reset_plans()
        auth.reset_cache()
        rate_limit.limiter.reset()
        rate_limit.forget_plans()
        self.addCleanup(rate_limit.forget_plans)
        self.addCleanup(rate_limit._owner_ids.clear)
        self.users: dict[str, dict] = {}
        self.client = TestClient(main.app)

    # --- helpers ------------------------------------------------------------------

    def _supabase_get(self, url, headers=None, **_):
        user = self.users.get(headers["Authorization"])
        response = MagicMock(status_code=200 if user else 401)
        response.json.return_value = dict(user or {})
        return response

    def token(self, user: dict) -> str:
        authorization = jwt(user["id"])
        self.users[authorization] = user
        return authorization

    def sign_in(self, user: dict) -> dict:
        with patch.object(auth.httpx, "get", side_effect=self._supabase_get):
            return auth.authenticated_user(self.token(user))

    def call(self, method: str, path: str, user: dict | None, **kwargs):
        headers = {"Authorization": self.token(user)} if user else {}
        with patch.object(auth.httpx, "get", side_effect=self._supabase_get):
            return self.client.request(method, path, headers=headers, **kwargs)

    def allowed(self, student_id: str, action: str, limit: int, tries: int) -> int:
        count = 0
        for _ in range(tries):
            try:
                database.check_social_rate_limit(student_id, action, limit, 1440)
                count += 1
            except ValueError:
                pass
        return count

    # --- admin routes -------------------------------------------------------------

    def test_owner_grants_lists_and_revokes(self):
        made = self.call("POST", "/api/admin/plans", OWNER, json={"email": " Pro.Student+school@Example.com ", "note": "beta tester"})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(made.json()["email"], "pro.student@example.com")
        self.assertEqual(made.json()["plan"], "pro")
        listed = self.call("GET", "/api/admin/plans", OWNER).json()["grants"]
        self.assertEqual([(g["email"], g["plan"], g["note"]) for g in listed], [("pro.student@example.com", "pro", "beta tester")])
        removed = self.call("DELETE", "/api/admin/plans/pro.student@example.com", OWNER)
        self.assertEqual(removed.json(), {"removed": True})
        self.assertEqual(self.call("GET", "/api/admin/plans", OWNER).json()["grants"], [])
        self.assertEqual(self.call("DELETE", "/api/admin/plans/pro.student@example.com", OWNER).json(), {"removed": False})

    def test_admin_emails_may_grant_too(self):
        made = self.call("POST", "/api/admin/plans", ADMIN, json={"email": "tester@example.com", "plan": "unlimited"})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(plans.list_grants()[0]["plan"], "unlimited")

    def test_everyone_else_gets_404(self):
        plans.grant("tester@example.com", "unlimited", "owner-1")
        unconfirmed_owner = {**OWNER, "id": "owner-2", "email_confirmed_at": None}
        for user in (None, FREE, TESTER, unconfirmed_owner):
            for method, path, body in (("GET", "/api/admin/plans", None), ("GET", "/api/admin/access", None),
                                       ("POST", "/api/admin/plans", {"email": "x@example.com"}),
                                       ("DELETE", "/api/admin/plans/tester@example.com", None)):
                response = self.call(method, path, user, json=body)
                self.assertEqual(response.status_code, 404, (user, method, path))
        self.assertEqual(len(plans.list_grants()), 1)

    def test_unlimited_account_cannot_reach_feedback_either(self):
        plans.grant("tester@example.com", "unlimited", "owner-1")
        self.assertEqual(self.call("GET", "/api/admin/feedback", TESTER).status_code, 404)

    def test_owner_not_in_admin_emails_opens_admin_page_for_plans_only(self):
        access = self.call("GET", "/api/admin/access", OWNER)
        self.assertEqual(access.status_code, 200)
        self.assertEqual(access.json(), {"feedback": False, "plans": True})
        self.assertEqual(self.call("GET", "/api/admin/feedback", OWNER).status_code, 404)
        self.assertEqual(self.call("GET", "/api/admin/access", ADMIN).json(), {"feedback": True, "plans": True})

    def test_grant_validates_email_and_refuses_disposable_domains(self):
        for email in ("not-an-email", "a@b", "two@@example.com", "spaces in@example.com"):
            response = self.call("POST", "/api/admin/plans", OWNER, json={"email": email})
            self.assertEqual(response.status_code, 400, email)
            self.assertEqual(response.json()["detail"]["code"], "invalid_email")
        response = self.call("POST", "/api/admin/plans", OWNER, json={"email": "kid@mailinator.com"})
        self.assertEqual(response.json()["detail"]["code"], "disposable_email")
        self.assertEqual(self.call("POST", "/api/admin/plans", OWNER, json={"email": "a@example.com", "plan": "owner"}).status_code, 422)
        self.assertEqual(plans.list_grants(), [])

    def test_admin_routes_are_lightly_rate_limited(self):
        with patch.object(main, "PLAN_ADMIN_PER_MINUTE", 2):
            codes = [self.call("GET", "/api/admin/plans", OWNER).status_code for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])

    # --- resolving the plan -------------------------------------------------------

    def test_plan_follows_the_confirmed_inbox(self):
        plans.grant("pro.student@example.com", "pro", "owner-1")
        self.sign_in(PRO)  # pro.student+school@example.com is the same inbox
        self.assertEqual(rate_limit.plan_of("pro-1"), "pro")
        self.sign_in(UNCONFIRMED)  # the same email, never confirmed
        self.assertEqual(rate_limit.plan_of("unconfirmed-1"), "free")
        self.sign_in({**UNCONFIRMED, "id": "anon-1", "is_anonymous": True, "email_confirmed_at": CONFIRMED})
        self.assertEqual(rate_limit.plan_of("anon-1"), "free")
        self.sign_in(FREE)
        self.assertEqual(rate_limit.plan_of("free-1"), "free")

    def test_profile_reports_the_plan(self):
        plans.grant("pro.student@example.com", "pro", "owner-1")
        plans.grant("tester@example.com", "unlimited", "owner-1")
        for user, name in ((PRO, "pro"), (FREE, "free"), (TESTER, "tester")):
            database.onboard_account(user["id"], name + "user", name.title(), None)
        self.assertEqual(self.call("GET", "/api/account/profile", PRO).json()["plan"], "pro")
        self.assertEqual(self.call("GET", "/api/account/profile", FREE).json()["plan"], "free")
        self.assertEqual(self.call("GET", "/api/account/profile", TESTER).json()["plan"], "unlimited")

    def test_owner_sees_unlimited_on_their_profile(self):
        database.onboard_account(OWNER["id"], "owneruser", "Owner", None)
        self.assertEqual(self.call("GET", "/api/account/profile", OWNER).json()["plan"], "unlimited")
        unconfirmed = {**OWNER, "id": "owner-3", "email_confirmed_at": None}
        database.onboard_account("owner-3", "owneruser3", "Owner", None)
        self.assertEqual(self.call("GET", "/api/account/profile", unconfirmed).json()["plan"], "free")

    def test_revoking_ends_pro_at_the_next_sign_in_check(self):
        plans.grant("pro.student@example.com", "pro", "owner-1")
        self.sign_in(PRO)
        self.assertTrue(rate_limit.is_pro("pro-1"))
        self.assertEqual(self.call("DELETE", "/api/admin/plans/pro.student@example.com", OWNER).status_code, 200)
        self.sign_in(PRO)  # served from the verified-token cache; the plan is re-read
        self.assertFalse(rate_limit.is_pro("pro-1"))

    def test_other_instances_drop_a_revoked_plan_within_the_cache_window(self):
        rate_limit.mark_plan("pro-1", "pro", now=1000.0)
        self.assertEqual(rate_limit.plan_of("pro-1", now=1000.0 + rate_limit.PLAN_CACHE_SECONDS - 1), "pro")
        self.assertEqual(rate_limit.plan_of("pro-1", now=1000.0 + rate_limit.PLAN_CACHE_SECONDS + 1), "free")
        self.assertLessEqual(rate_limit.PLAN_CACHE_SECONDS, 300)

    # --- limits -------------------------------------------------------------------

    def test_pro_gets_three_times_the_ai_limits_and_free_does_not(self):
        plans.grant("pro.student@example.com", "pro", "owner-1")
        self.sign_in(PRO)
        self.sign_in(FREE)
        for action in ("ai_question", "tutor_message_day", "flashcards_note", "practice_test", "study_guide", "ai_ocr", "otto_memory"):
            self.assertEqual(self.allowed("pro-1", action, 2, 10), 6, action)
            self.assertEqual(self.allowed("free-1", action, 2, 10), 2, action)

    def test_pro_keeps_social_and_help_bot_limits(self):
        plans.grant("pro.student@example.com", "pro", "owner-1")
        self.sign_in(PRO)
        for action in ("friend_request", "nudge", "help_bot_hour", "task_write", "daily_login"):
            self.assertEqual(self.allowed("pro-1", action, 2, 10), 2, action)

    def test_pro_share_of_the_global_budget_is_six_percent(self):
        plans.grant("pro.student@example.com", "pro", "owner-1")
        self.sign_in(PRO)
        self.sign_in(FREE)
        with patch.object(main, "ai_daily_global_limit", return_value=10_000):
            self.assertEqual(main.ai_account_daily_limit("pro-1"), 600)
            self.assertEqual(main.ai_account_daily_limit("free-1"), 200)
            self.assertEqual(main.ai_account_daily_limit(), 200)

    def test_unlimited_skips_per_student_limits_and_share(self):
        plans.grant("tester@example.com", "unlimited", "owner-1")
        self.sign_in(TESTER)
        self.assertEqual(self.allowed("tester-1", "ai_question", 2, 10), 10)
        self.assertEqual(self.allowed("tester-1", "friend_request", 2, 10), 10)
        with patch.object(main, "ai_account_daily_limit", return_value=1):
            self.assertTrue(all(main.account_ai_share_available("tester-1") for _ in range(5)))

    def test_unlimited_is_still_stopped_by_the_global_cap(self):
        plans.grant("tester@example.com", "unlimited", "owner-1")
        self.sign_in(TESTER)
        with patch.object(main, "ai_daily_global_limit", return_value=2):
            results = [main.global_ai_available("tester-1") for _ in range(4)]
        self.assertEqual(results, [True, True, False, False])

    def test_unlimited_keeps_the_owner_burst_cap(self):
        plans.grant("tester@example.com", "unlimited", "owner-1")
        tester = self.token(TESTER)
        free = self.token(FREE)
        with patch.object(auth.httpx, "get", side_effect=self._supabase_get):
            auth.authenticated_user(tester)
            auth.authenticated_user(free)
        allowed = lambda authorization, n: sum(  # noqa: E731
            rate_limit.check_request("/api/generate-question", "POST", f"10.0.1.{n}", authorization) == 0
            for _ in range(rate_limit.OWNER_AI_PER_MINUTE + 5)
        )
        self.assertEqual(allowed(free, 1), rate_limit.AI_PER_MINUTE)
        self.assertEqual(allowed(tester, 2), rate_limit.OWNER_AI_PER_MINUTE)

    def test_unlimited_gives_no_owner_powers(self):
        plans.grant("tester@example.com", "unlimited", "owner-1")
        self.sign_in(TESTER)
        self.assertFalse(rate_limit.is_owner("tester-1"))
        self.assertFalse(auth.is_owner_user(TESTER))

    def test_free_limit_messages_mention_pro_briefly(self):
        self.sign_in(FREE)
        plans.grant("pro.student@example.com", "pro", "owner-1")
        self.sign_in(PRO)
        self.assertIn("Pro", main.pro_hint("free-1"))
        self.assertEqual(main.pro_hint("pro-1"), "")

    def test_table_is_locked_like_the_others(self):
        self.assertIn("account_plans", database.RLS_TABLES)
        self.assertIn("account_plans", database.CLIENT_REVOKED_TABLES)
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261022_account_plans.sql")
        with open(path) as handle:
            sql = handle.read().lower()
        self.assertIn("alter table public.account_plans enable row level security", sql)
        self.assertIn("revoke all on table public.account_plans from anon, authenticated", sql)
        self.assertNotIn("drop ", sql)


if __name__ == "__main__":
    unittest.main()
