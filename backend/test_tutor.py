import asyncio
import base64
import json
import os
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi import HTTPException

import ai_tutor
import database
import main
import note_store
import tutor

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


def parse_events(response) -> list[tuple[str, dict]]:
    async def drain():
        return "".join([chunk if isinstance(chunk, str) else chunk.decode() async for chunk in response.body_iterator])

    events = []
    for block in asyncio.run(drain()).strip().split("\n\n"):
        name, data = block.split("\n", 1)
        events.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return events


class TutorTests(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        tutor.reset_tutor()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def as_user(self, student_id):
        return patch.object(main.auth, "authenticated_user", return_value={"id": student_id})

    def send(self, student_id, chunks=("Photo", "synthesis ", "stores energy."), **fields):
        captured = {}

        def fake_stream(*, messages, route, session_id=None):
            captured.update(messages=messages, route=route, session_id=session_id)
            yield from chunks

        with self.as_user(student_id), patch.object(ai_tutor, "stream_tutor_reply", side_effect=fake_stream):
            response = main.send_tutor_message(main.TutorMessageRequest(content=fields.pop("content", "What is photosynthesis?"), **fields), "Bearer t")
            events = parse_events(response)
        return events, captured

    def test_streams_reply_and_persists_both_messages(self):
        events, _ = self.send("alex")
        names = [name for name, _ in events]
        self.assertEqual(names[0], "meta")
        self.assertEqual(names[-1], "done")
        self.assertEqual("".join(data["text"] for name, data in events if name == "delta"), "Photosynthesis stores energy.")
        conversation_id = events[0][1]["conversation"]["id"]
        stored = tutor.list_messages("alex", conversation_id)
        self.assertEqual([(item["role"], item["content"]) for item in stored], [("user", "What is photosynthesis?"), ("assistant", "Photosynthesis stores energy.")])
        self.assertEqual(tutor.list_conversations("alex")[0]["title"], "What is photosynthesis?")

    def test_conversations_are_private_to_their_owner(self):
        events, _ = self.send("alex")
        conversation_id = events[0][1]["conversation"]["id"]
        with self.as_user("sam"):
            self.assertEqual(main.tutor_conversations("Bearer t"), [])
            with self.assertRaises(HTTPException) as caught:
                main.tutor_messages(conversation_id, None, "Bearer t")
            self.assertEqual(caught.exception.status_code, 404)
            with self.assertRaises(HTTPException):
                main.delete_tutor_conversation(conversation_id, "Bearer t")
            with self.assertRaises(HTTPException) as caught:
                main.send_tutor_message(main.TutorMessageRequest(content="hi", conversation_id=conversation_id), "Bearer t")
            self.assertEqual(caught.exception.status_code, 404)

    def test_follow_up_includes_history_and_only_owner_notes(self):
        note_store.save_note("alex", "Biology", "Cells", "alex-cells.pdf", "text/plain", "Mitochondria make ATP.", 20)
        note_store.save_note("sam", "Biology", "Cells", "sam-secret.pdf", "text/plain", "Sam's private note.", 20)
        first, _ = self.send("alex", course="Biology", unit="Cells")
        conversation_id = first[0][1]["conversation"]["id"]
        self.assertEqual(first[0][1]["grounded_in"], ["alex-cells.pdf"])
        _, captured = self.send("alex", content="And respiration?", conversation_id=conversation_id)
        system = captured["messages"][0]["content"]
        self.assertIn("Mitochondria make ATP.", system)
        self.assertNotIn("Sam's private note", system)
        roles = [message["role"] for message in captured["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "user"])
        self.assertNotIn("alex", captured["session_id"])

    def test_images_are_validated_and_never_stored(self):
        events, captured = self.send("alex", images=[main.TutorImage(name="diagram.png", data_url=PNG)])
        self.assertEqual(captured["route"]["tier"], "vision")
        self.assertEqual(captured["messages"][-1]["content"][1]["type"], "image_url")
        stored = tutor.list_messages("alex", events[0][1]["conversation"]["id"])[0]
        self.assertEqual(stored["attachments"], ["diagram.png"])
        self.assertNotIn("base64", json.dumps(stored, default=str))
        for bad, status in (("data:text/html;base64,PGI+", 415), ("data:image/png;base64,***", 400)):
            with self.as_user("alex"), self.assertRaises(HTTPException) as caught:
                main.send_tutor_message(main.TutorMessageRequest(content="look", images=[main.TutorImage(data_url=bad)]), "Bearer t")
            self.assertEqual(caught.exception.status_code, status)
        too_big = "data:image/png;base64," + base64.b64encode(b"0" * (main.TUTOR_IMAGE_MAX_BYTES + 1)).decode()
        with self.as_user("alex"), self.assertRaises(HTTPException) as caught:
            main.send_tutor_message(main.TutorMessageRequest(content="look", images=[main.TutorImage(data_url=too_big)]), "Bearer t")
        self.assertEqual(caught.exception.status_code, 413)

    def test_failure_before_any_text_reports_an_error(self):
        def failing(**_):
            raise ai_tutor.AITutorError("down")
            yield ""  # pragma: no cover

        with self.as_user("alex"), patch.object(ai_tutor, "stream_tutor_reply", side_effect=failing):
            events = parse_events(main.send_tutor_message(main.TutorMessageRequest(content="hello"), "Bearer t"))
        self.assertEqual(events[-1][0], "error")
        stored = tutor.list_messages("alex", events[0][1]["conversation"]["id"])
        self.assertEqual([item["role"] for item in stored], ["user"])

    def test_partial_reply_is_kept_when_stream_breaks(self):
        def breaking(**_):
            yield "Half an "
            raise ai_tutor.AITutorError("lost")

        with self.as_user("alex"), patch.object(ai_tutor, "stream_tutor_reply", side_effect=breaking):
            events = parse_events(main.send_tutor_message(main.TutorMessageRequest(content="hello"), "Bearer t"))
        self.assertTrue(events[-1][1]["partial"])
        self.assertIn("Half an", tutor.list_messages("alex", events[0][1]["conversation"]["id"])[-1]["content"])

    def test_tutor_messages_are_rate_limited(self):
        with patch.object(main, "TUTOR_HOURLY_LIMIT", 1):
            self.send("alex")
            with self.assertRaises(HTTPException) as caught:
                self.send("alex")
        self.assertEqual(caught.exception.status_code, 429)

    def test_routing_uses_fast_model_for_simple_questions(self):
        self.assertEqual(ai_tutor.tutor_route("What is a cell?", False)["tier"], "fast")
        hard = "Explain why the derivative of sin x is cos x and prove it step by step using the limit definition, " * 2
        self.assertEqual(ai_tutor.tutor_route(hard, False)["tier"], "deep")
        self.assertEqual(ai_tutor.tutor_route("What is this?", True)["tier"], "vision")

    def test_stream_parser_reads_openrouter_events(self):
        lines = [
            'data: {"choices":[{"delta":{"content":"Hel"}}]}',
            ": keep-alive",
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            "data: [DONE]",
        ]

        class FakeResponse:
            status_code = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def iter_lines(self): return iter(lines)

        class FakeClient:
            def stream(self, *args, **kwargs):
                self.payload = kwargs["json"]
                return FakeResponse()

        client = FakeClient()
        with patch.object(ai_tutor, "_client", return_value=client), patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"}):
            text = "".join(ai_tutor.stream_tutor_reply(messages=[{"role": "user", "content": "hi"}], route=ai_tutor.tutor_route("hi", False)))
        self.assertEqual(text, "Hello")
        self.assertTrue(client.payload["stream"])
        self.assertEqual(client.payload["reasoning"]["effort"], "minimal")


if __name__ == "__main__":
    unittest.main()
