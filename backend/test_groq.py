"""The Groq client: request shape per model, rate limits, cooldowns and the free-model fallback."""
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

import ai_tutor


def reply(status: int, body: dict | None = None, headers: dict | None = None):
    response = MagicMock(status_code=status, headers=headers or {})
    response.json.return_value = body or {"choices": [{"message": {"content": "{}"}}]}
    return response


class GroqClientTests(unittest.TestCase):
    def setUp(self):
        ai_tutor._cooldowns.clear()
        self.env = patch.dict(os.environ, {"GROQ_API_KEY": "test-key", "AI_FALLBACKS": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(ai_tutor._cooldowns.clear)

    def client(self, *responses):
        client = MagicMock()
        client.send.side_effect = list(responses)
        patcher = patch.object(ai_tutor, "_client", return_value=client)
        patcher.start()
        self.addCleanup(patcher.stop)
        return client

    def sent(self, client, index=0):
        return client.build_request.call_args_list[index].kwargs["json"]

    def test_the_key_is_server_side_and_required(self):
        with patch.dict(os.environ, {"GROQ_API_KEY": ""}):
            with self.assertRaises(ai_tutor.AITutorError):
                ai_tutor._headers()
        self.assertEqual(ai_tutor._headers()["Authorization"], "Bearer test-key")
        self.assertNotIn("OPENROUTER", " ".join(ai_tutor._headers()))

    def test_gpt_oss_hides_reasoning_and_gets_room_to_think(self):
        body = ai_tutor._wire_payload({"model": "openai/gpt-oss-20b", "max_tokens": 200, "temperature": 0})
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertIs(body["include_reasoning"], False)
        self.assertNotIn("max_tokens", body)
        self.assertEqual(body["max_completion_tokens"], 200 + ai_tutor.REASONING_HEADROOM)

    def test_deep_questions_think_harder(self):
        body = ai_tutor._wire_payload({"model": "openai/gpt-oss-120b", "max_tokens": 10, "_effort": "medium"})
        self.assertEqual(body["reasoning_effort"], "medium")
        self.assertNotIn("_effort", body)

    def test_qwen_turns_reasoning_off(self):
        body = ai_tutor._wire_payload({"model": "qwen/qwen3.8-27b", "max_tokens": 50})
        self.assertEqual((body["reasoning_effort"], body["reasoning_format"]), ("none", "hidden"))
        self.assertEqual(body["max_completion_tokens"], 50)

    def test_models_without_structured_outputs_use_json_object_mode(self):
        schema = {"type": "json_schema", "json_schema": {"name": "t", "strict": True, "schema": {}}}
        self.assertEqual(ai_tutor._wire_payload({"model": "llama-3.1-8b-instant", "response_format": schema})["response_format"],
                         {"type": "json_object"})
        self.assertEqual(ai_tutor._wire_payload({"model": "openai/gpt-oss-20b", "response_format": schema})["response_format"], schema)

    def test_a_rate_limited_model_falls_back_once_to_a_free_groq_model(self):
        client = self.client(reply(429, headers={"retry-after": "42"}), reply(200))
        ai_tutor._post({"model": ai_tutor.AI_MODEL, "max_tokens": 10})
        self.assertEqual(self.sent(client, 0)["model"], ai_tutor.AI_MODEL)
        self.assertEqual(self.sent(client, 1)["model"], ai_tutor.AI_LONG_MODEL)
        self.assertTrue(all(call.args[1] == ai_tutor.AI_URL for call in client.build_request.call_args_list))
        self.assertGreater(ai_tutor._cooling(ai_tutor.AI_MODEL), 40)  # Groq's own retry-after

    def test_a_cooling_model_is_not_asked_again(self):
        client = self.client(reply(429, headers={"retry-after": "30"}), reply(200), reply(200))
        ai_tutor._post({"model": ai_tutor.AI_MODEL})
        ai_tutor._post({"model": ai_tutor.AI_MODEL})
        self.assertEqual([self.sent(client, i)["model"] for i in range(3)],
                         [ai_tutor.AI_MODEL, ai_tutor.AI_LONG_MODEL, ai_tutor.AI_LONG_MODEL])

    def test_every_model_busy_raises_rate_limited_with_retry_after(self):
        self.client(reply(429, headers={"retry-after": "20"}), reply(429, headers={"retry-after": "50"}))
        with self.assertRaises(ai_tutor.AIRateLimited) as caught:
            ai_tutor._post({"model": ai_tutor.AI_MODEL})
        self.assertTrue(19 <= caught.exception.retry_after <= 20)
        self.assertIsInstance(caught.exception, ai_tutor.AITutorError)  # existing handlers still catch it

    def test_fallbacks_can_be_turned_off(self):
        client = self.client(reply(429))
        with patch.dict(os.environ, {"AI_FALLBACKS": "off"}), self.assertRaises(ai_tutor.AIRateLimited):
            ai_tutor._post({"model": ai_tutor.AI_MODEL})
        self.assertEqual(client.send.call_count, 1)

    def test_vision_has_no_fallback(self):
        client = self.client(reply(429))
        with self.assertRaises(ai_tutor.AIRateLimited):
            ai_tutor._post({"model": ai_tutor.AI_VISION_MODEL})
        self.assertEqual(client.send.call_count, 1)

    def test_a_removed_model_moves_to_the_fallback(self):
        client = self.client(reply(404), reply(200))
        ai_tutor._post({"model": ai_tutor.AI_CHAT_MODEL})
        self.assertEqual(self.sent(client, 1)["model"], ai_tutor.AI_MODEL)

    def test_other_errors_fail_without_retrying(self):
        client = self.client(reply(400), reply(200))
        with self.assertRaises(ai_tutor.AITutorError) as caught:
            ai_tutor._post({"model": ai_tutor.AI_MODEL})
        self.assertNotIsInstance(caught.exception, ai_tutor.AIRateLimited)
        self.assertEqual(client.send.call_count, 1)

    def test_fallbacks_never_leave_groq(self):
        for model, fallback in ai_tutor._fallbacks().items():
            self.assertIn(fallback, {ai_tutor.AI_MODEL, ai_tutor.AI_LONG_MODEL})
        self.assertTrue(ai_tutor.AI_URL.startswith("https://api.groq.com/"))

    def test_every_tier_has_a_model(self):
        for name in ai_tutor.OPERATIONS:
            self.assertTrue(ai_tutor.model_for_operation(name))


class OcrTests(unittest.TestCase):
    def test_a_scanned_pdf_sends_at_most_three_page_scans_in_one_request(self):
        with patch.object(ai_tutor, "_send", return_value={"choices": [{"message": {"content": "Page text"}}]}) as send:
            text = ai_tutor.extract_pdf_notes(page_images=[b"a", b"b", b"c", b"d"])
        self.assertEqual(text, "Page text")
        payload = send.call_args.args[1]
        self.assertEqual(payload["model"], ai_tutor.AI_VISION_MODEL)
        images = [part for part in payload["messages"][0]["content"] if part["type"] == "image_url"]
        self.assertEqual(len(images), 3)
        self.assertTrue(images[0]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

    def test_a_pdf_without_scans_is_reported_unreadable(self):
        with self.assertRaises(ai_tutor.AITutorError) as caught:
            ai_tutor.extract_pdf_notes(page_images=[])
        self.assertTrue(str(caught.exception).startswith("No readable notes"))


if __name__ == "__main__":
    unittest.main()
