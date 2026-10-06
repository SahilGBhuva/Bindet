import os
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi import HTTPException
from fastapi.testclient import TestClient

import database
import main
import rate_limit


class SlidingWindowTests(unittest.TestCase):
    def test_allows_up_to_the_limit_then_reports_the_wait(self):
        window = rate_limit.SlidingWindow()
        self.assertEqual([window.hit("k", 3, 60, now=float(t)) for t in range(3)], [0.0, 0.0, 0.0])
        self.assertAlmostEqual(window.hit("k", 3, 60, now=10.0), 50.0)
        # Once the oldest request leaves the window, the next one is allowed.
        self.assertEqual(window.hit("k", 3, 60, now=60.5), 0.0)

    def test_keys_are_independent(self):
        window = rate_limit.SlidingWindow()
        window.hit("a", 1, 60, now=0.0)
        self.assertGreater(window.hit("a", 1, 60, now=1.0), 0)
        self.assertEqual(window.hit("b", 1, 60, now=1.0), 0.0)


class RequestGuardTests(unittest.TestCase):
    def setUp(self):
        rate_limit.limiter.reset()
        rate_limit.unverified_tokens.reset()

    def test_anonymous_callers_get_the_tighter_budget(self):
        with patch.object(rate_limit, "ANONYMOUS_PER_MINUTE", 2):
            for _ in range(2):
                self.assertEqual(rate_limit.check_request("/api/progress/x", "GET", "1.2.3.4", None), 0.0)
            self.assertGreater(rate_limit.check_request("/api/progress/x", "GET", "1.2.3.4", None), 0)
            # A signed-in student on the same network is unaffected.
            self.assertEqual(rate_limit.check_request("/api/progress/x", "GET", "1.2.3.4", "Bearer abc"), 0.0)

    def test_ai_routes_have_their_own_per_student_budget(self):
        with patch.object(rate_limit, "AI_PER_MINUTE", 1):
            self.assertEqual(rate_limit.check_request("/api/tutor/messages", "POST", "5.5.5.5", "Bearer s1"), 0.0)
            self.assertGreater(rate_limit.check_request("/api/tutor/messages", "POST", "5.5.5.5", "Bearer s1"), 0)
            self.assertEqual(rate_limit.check_request("/api/tasks", "GET", "5.5.5.5", "Bearer s1"), 0.0)
            self.assertEqual(rate_limit.check_request("/api/tutor/messages", "POST", "5.5.5.5", "Bearer s2"), 0.0)

    def test_preflight_health_and_non_api_paths_are_exempt(self):
        with patch.object(rate_limit, "ANONYMOUS_PER_MINUTE", 0), patch.object(rate_limit, "ADDRESS_PER_MINUTE", 0):
            self.assertEqual(rate_limit.check_request("/api/tasks", "OPTIONS", "1.1.1.1", None), 0.0)
            self.assertEqual(rate_limit.check_request("/api/health", "GET", "1.1.1.1", None), 0.0)
            self.assertEqual(rate_limit.check_request("/", "GET", "1.1.1.1", None), 0.0)

    def test_address_prefers_the_platform_header(self):
        headers = {"x-vercel-forwarded-for": "9.9.9.9", "x-forwarded-for": "7.7.7.7, 8.8.8.8"}
        with patch.dict(os.environ, {"VERCEL": "1"}):
            self.assertEqual(rate_limit.address_of(headers, "127.0.0.1"), "9.9.9.9")
            self.assertEqual(rate_limit.address_of({"x-forwarded-for": "7.7.7.7, 8.8.8.8"}, None), "7.7.7.7")
            self.assertEqual(rate_limit.address_of({}, "127.0.0.1"), "127.0.0.1")

    def test_forwarding_headers_are_ignored_off_vercel(self):
        headers = {"x-real-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7", "x-vercel-forwarded-for": "9.9.9.9"}
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VERCEL", None)
            self.assertEqual(rate_limit.address_of(headers, "10.0.0.5"), "10.0.0.5")
            self.assertEqual(rate_limit.address_of(headers, None), "unknown")

    def test_unverified_tokens_have_their_own_budget_counted_per_token(self):
        import auth
        auth.reset_cache()
        try:
            with patch.object(rate_limit, "UNVERIFIED_TOKENS_PER_MINUTE", 3), patch.object(rate_limit, "ANONYMOUS_PER_MINUTE", 1):
                # One fresh token sending many requests before it is verified counts once.
                for _ in range(10):
                    self.assertEqual(rate_limit.check_request("/api/tasks", "GET", "4.4.4.4", "Bearer fresh-0"), 0.0)
                # Distinct made-up tokens are capped, so they can't each mint a fresh budget.
                waits = [rate_limit.check_request("/api/tasks", "GET", "4.4.4.4", f"Bearer fake-{n}") for n in range(3)]
                self.assertEqual(waits[:2], [0.0, 0.0])
                self.assertGreater(waits[2], 0)
                # A refused token is not remembered as counted, so retrying it stays refused.
                self.assertGreater(rate_limit.check_request("/api/tasks", "GET", "4.4.4.4", "Bearer fake-2"), 0)
                # Unverified tokens don't touch the anonymous budget.
                self.assertEqual(rate_limit.check_request("/api/progress/x", "GET", "4.4.4.4", None), 0.0)
                # Another address has its own budget.
                self.assertEqual(rate_limit.check_request("/api/tasks", "GET", "4.4.4.5", "Bearer fake-2"), 0.0)
                # A token auth has verified uses its own per-student budget instead.
                auth._remember(auth._cache_key("Bearer real"), {"id": "real-id"}, "", auth.time.monotonic())
                self.assertEqual(rate_limit.check_request("/api/tasks", "GET", "4.4.4.4", "Bearer real"), 0.0)
                # A token cached as bad is not "verified".
                auth._remember(auth._cache_key("Bearer bad"), None, "nope", auth.time.monotonic())
                self.assertGreater(rate_limit.check_request("/api/tasks", "GET", "4.4.4.4", "Bearer bad"), 0)
        finally:
            auth.reset_cache()

    def test_distinct_tokens_are_counted_again_after_the_window_and_stay_bounded(self):
        seen = rate_limit.DistinctTokens()
        seen.mark("a", "t1", 60, now=0.0)
        self.assertTrue(seen.counted_recently("a", "t1", 60, now=59.0))
        self.assertFalse(seen.counted_recently("a", "t1", 60, now=61.0))
        self.assertFalse(seen.counted_recently("b", "t1", 60, now=1.0))
        with patch.object(rate_limit, "UNVERIFIED_TOKENS_PER_MINUTE", 2):
            for n in range(20):
                seen.mark("a", f"x{n}", 60, now=100.0 + n)
            self.assertLessEqual(len(seen._seen["a"]), 4)
        with patch.object(rate_limit, "MAX_TOKEN_ADDRESSES", 4):
            for n in range(20):
                seen.mark(f"addr{n}", "t", 60, now=200.0 + n)
            self.assertLessEqual(len(seen._seen), 4)

    def test_auth_config_is_never_limited(self):
        with patch.object(rate_limit, "ANONYMOUS_PER_MINUTE", 0), patch.object(rate_limit, "ADDRESS_PER_MINUTE", 0):
            for authorization in (None, "Bearer junk"):
                self.assertEqual(rate_limit.check_request("/api/auth/config", "GET", "2.2.2.2", authorization), 0.0)

    def test_routes_without_sign_in_always_use_the_anonymous_budget(self):
        import auth
        auth.reset_cache()
        auth._remember(auth._cache_key("Bearer real"), {"id": "real-id"}, "", auth.time.monotonic())
        try:
            with patch.object(rate_limit, "ANONYMOUS_PER_MINUTE", 2):
                rate_limit.limiter.reset()
                self.assertEqual(rate_limit.check_request("/api/ai/warm", "POST", "3.3.3.3", "Bearer real"), 0.0)
                self.assertEqual(rate_limit.check_request("/api/ai/warm", "POST", "3.3.3.3", "Bearer real"), 0.0)
                self.assertGreater(rate_limit.check_request("/api/ai/warm", "POST", "3.3.3.3", "Bearer real"), 0)
        finally:
            auth.reset_cache()

    def test_middleware_answers_429_with_retry_after_before_route_work(self):
        client = TestClient(main.app)
        with patch.object(rate_limit, "ANONYMOUS_PER_MINUTE", 1), patch.object(main.database, "get_progress") as progress:
            client.get("/api/progress/someone")
            response = client.get("/api/progress/someone")
        self.assertEqual(response.status_code, 429)
        self.assertGreaterEqual(int(response.headers["Retry-After"]), 1)
        self.assertIn("too quickly", response.json()["detail"])
        self.assertLessEqual(progress.call_count, 1)


class ActionLimitTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        rate_limit.limiter.reset()
        database.onboard_account("alex-id", "alex", "Alex", None)

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def test_durable_limits_return_retry_after(self):
        with patch.object(main.database, "check_social_rate_limit", side_effect=ValueError("social_rate_limited")):
            with self.assertRaises(HTTPException) as caught:
                main.limit_action("alex-id", "anything", 1)
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.headers, {"Retry-After": "60"})

    def test_guest_quiz_questions_are_limited_per_network_address(self):
        token = rate_limit.client_address.set("203.0.113.9")
        try:
            with patch.object(main, "GUEST_QUESTIONS_PER_DAY", 2):
                for name in ("guest-a", "guest-b"):
                    main.generate_question(main.QuestionRequest(topic="addition", student_id=name), None)
                with self.assertRaises(HTTPException) as caught:
                    # A new self-chosen ID does not reset the budget.
                    main.generate_question(main.QuestionRequest(topic="addition", student_id="guest-c"), None)
        finally:
            rate_limit.client_address.reset(token)
        self.assertEqual(caught.exception.status_code, 429)

    def test_profile_updates_are_limited(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "alex-id"}):
            for _ in range(30):
                main.limit_action("alex-id", "profile_update", 30)
            with self.assertRaises(HTTPException) as caught:
                main.update_account_profile(main.AccountProfileUpdate(username="alex", display_name="Alex R"), "Bearer t")
        self.assertEqual(caught.exception.status_code, 429)

    def test_task_creation_is_limited(self):
        with patch.object(main.auth, "authenticated_user", return_value={"id": "alex-id"}), patch.object(main, "TASK_CREATE_LIMIT", 1):
            main.create_task_route(main.TaskCreate(title="One"), "Bearer t")
            with self.assertRaises(HTTPException) as caught:
                main.create_task_route(main.TaskCreate(title="Two"), "Bearer t")
        self.assertEqual(caught.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
