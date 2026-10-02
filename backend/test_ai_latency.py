import unittest
from unittest.mock import patch

import ai_tutor
import main


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


if __name__ == "__main__":
    unittest.main()
