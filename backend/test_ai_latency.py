import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

import httpx

import ai_tutor
import database
import main
import note_store


class AILatencyTests(unittest.TestCase):
    def test_latency_routing_and_sticky_session_reach_openrouter(self):
        response = {
            "choices": [
                {
                    "message": {
                        "content": '{"question":"Q?","correct_answer":"A","topic":"T"}'
                    }
                }
            ]
        }
        with patch.object(ai_tutor, "_post", return_value=response) as post:
            ai_tutor.generate_question(
                course="Biology",
                unit="Cells",
                source_labels=[],
                focus="mixed",
                difficulty=2,
                personalization={},
                session_id="bindit-stable-session",
            )

        payload = post.call_args.args[0]
        self.assertEqual(payload["provider"]["sort"], "latency")
        self.assertTrue(payload["provider"]["allow_fallbacks"])
        self.assertEqual(payload["session_id"], "bindit-stable-session")

    def test_session_identifier_is_stable_and_does_not_expose_student_id(self):
        first = main.ai_session_id("student@example.com", "Biology", "Cells", "quiz")
        second = main.ai_session_id("student@example.com", "Biology", "Cells", "quiz")
        different = main.ai_session_id("student@example.com", "Biology", "Cells", "flashcards")

        self.assertEqual(first, second)
        self.assertNotEqual(first, different)
        self.assertTrue(first.startswith("bindit-"))
        self.assertNotIn("student", first)
        self.assertNotIn("example.com", first)

    def test_connection_warm_up_is_keyless_throttled_and_optional(self):
        client = MagicMock()
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": ""}), patch.object(ai_tutor, "_client", return_value=client):
            self.assertFalse(ai_tutor.warm_connection(wait=True))
        client.head.assert_not_called()
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch.object(ai_tutor, "_client", return_value=client), \
                patch.object(ai_tutor, "_last_warm", 0.0):
            self.assertTrue(ai_tutor.warm_connection(wait=True))
            self.assertFalse(ai_tutor.warm_connection(wait=True))
            self.assertEqual(main.warm_ai(), {"warming": False})
        client.head.assert_called_once()
        self.assertNotIn("headers", client.head.call_args.kwargs)  # the key is never sent by a warm-up

    def test_warm_up_failures_are_ignored(self):
        client = MagicMock()
        client.head.side_effect = httpx.ConnectError("offline")
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch.object(ai_tutor, "_client", return_value=client), \
                patch.object(ai_tutor, "_last_warm", 0.0):
            self.assertTrue(ai_tutor.warm_connection(wait=True))

    def test_requests_keep_fast_connect_and_pool_budgets(self):
        response = MagicMock()
        response.json.return_value = {"choices": [{"message": {"content": "{}"}}]}
        client = MagicMock()
        client.post.return_value = response
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch.object(ai_tutor, "_client", return_value=client):
            ai_tutor._post({"model": "m"}, timeout=8.0)
        timeout = client.post.call_args.kwargs["timeout"]
        self.assertEqual((timeout.read, timeout.connect, timeout.pool), (8.0, 3.0, 1.0))

    def test_note_context_reads_only_the_excerpt_it_can_use(self):
        note_store.init_notes()
        with database.engine().begin() as connection:
            connection.execute(note_store.notes.delete())
        note_store.save_note("ctx-owner", "Biology", "Cells", "long.txt", "text/plain", "A" * 50_000, 50_000)
        note_store.save_note("ctx-owner", "Biology", "Cells", "short.txt", "text/plain", "Mitochondria make ATP.", 22)
        note_store.save_note("ctx-other", "Biology", "Cells", "other.txt", "text/plain", "Someone else's note", 19)
        labels, text = note_store.context_for("ctx-owner", "Biology", "Cells", limit_chars=1_000)
        self.assertEqual(sorted(labels), ["long.txt", "short.txt"])
        self.assertLessEqual(len(text.replace("SOURCE: long.txt\n", "").replace("SOURCE: short.txt\n", "").replace("\n\n", "")), 1_000)
        self.assertNotIn("Someone else", text)



class LoggingTests(unittest.TestCase):
    def test_ai_events_go_to_stdout(self):
        import sys
        [handler] = ai_tutor.logger.handlers
        self.assertIs(handler.stream, sys.stdout)

    def test_student_hash_is_keyed_by_log_hash_salt_when_set(self):
        with patch.dict(os.environ, {"LOG_HASH_SALT": ""}):
            unsalted = ai_tutor.student_hash("student-1")
        self.assertEqual(unsalted, __import__("hashlib").blake2s(b"student-1", digest_size=5).hexdigest())  # unchanged fallback
        with patch.dict(os.environ, {"LOG_HASH_SALT": "server-secret"}):
            salted = ai_tutor.student_hash("student-1")
            self.assertEqual(salted, ai_tutor.student_hash("student-1"))  # stable
        with patch.dict(os.environ, {"LOG_HASH_SALT": "another-secret"}):
            self.assertNotEqual(ai_tutor.student_hash("student-1"), salted)
        self.assertNotEqual(salted, unsalted)
        self.assertEqual(len(salted), 10)


if __name__ == "__main__":
    unittest.main()
