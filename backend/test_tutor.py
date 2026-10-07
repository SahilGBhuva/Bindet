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
        # Notes travel in a delimited data block in the student's turn, never in the system prompt.
        system = captured["messages"][0]["content"]
        turn = captured["messages"][-1]["content"]
        self.assertNotIn("Mitochondria make ATP.", system)
        self.assertIn("Mitochondria make ATP.", turn.split("<<<NOTES>>>", 1)[1].split("<<<END NOTES>>>", 1)[0])
        self.assertTrue(turn.endswith("And respiration?"))
        self.assertNotIn("Sam's private note", system + turn)
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

    def test_meta_arrives_before_the_saved_turn_and_the_reply(self):
        events, _ = self.send("alex")
        names = [name for name, _ in events]
        self.assertEqual(names[:3], ["meta", "user", "delta"])
        self.assertEqual(events[1][1]["user_message"]["content"], "What is photosynthesis?")
        self.assertTrue(events[1][1]["user_message"]["id"])

    def test_retrying_after_a_failed_reply_does_not_duplicate_the_turn(self):
        def failing(**_):
            raise ai_tutor.AITutorError("down")
            yield ""  # pragma: no cover

        with self.as_user("alex"), patch.object(ai_tutor, "stream_tutor_reply", side_effect=failing):
            first = parse_events(main.send_tutor_message(main.TutorMessageRequest(content="hello"), "Bearer t"))
        conversation_id = first[0][1]["conversation"]["id"]
        self.assertEqual(first[-1][0], "error")
        events, captured = self.send("alex", content="hello", conversation_id=conversation_id)
        stored = tutor.list_messages("alex", conversation_id)
        self.assertEqual([item["role"] for item in stored], ["user", "assistant"])
        self.assertEqual([message["role"] for message in captured["messages"]], ["system", "user"])
        self.assertEqual(events[1][1]["user_message"]["id"], stored[0]["id"])

    def test_a_turn_that_cannot_be_saved_asks_to_resend(self):
        with patch.object(tutor, "add_message", side_effect=RuntimeError("database down")):
            events, _ = self.send("alex")
        self.assertEqual(events[-1][0], "error")
        self.assertNotIn("delta", [name for name, _ in events])

    def test_tutor_messages_are_rate_limited(self):
        with patch.object(main, "TUTOR_HOURLY_LIMIT", 1):
            self.send("alex")
            with self.assertRaises(HTTPException) as caught:
                self.send("alex")
        self.assertEqual(caught.exception.status_code, 429)

    def test_tutor_messages_have_a_daily_cap(self):
        with patch.object(main, "TUTOR_DAILY_LIMIT", 2):
            self.send("alex")
            self.send("alex")
            with self.assertRaises(HTTPException) as caught:
                self.send("alex")
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.detail, main.TUTOR_DAILY_LIMITED)

    def test_history_sent_to_the_model_is_capped_by_characters(self):
        events, _ = self.send("alex")
        conversation_id = events[0][1]["conversation"]["id"]
        for index in range(12):
            tutor.add_message("alex", conversation_id, "user" if index % 2 == 0 else "assistant", f"{index}:" + "x" * 3000)
        _, captured = self.send("alex", conversation_id=conversation_id, content="And then?")
        history = captured["messages"][1:-1]
        self.assertLessEqual(sum(len(item["content"]) for item in history), main.TUTOR_HISTORY_MAX_CHARS)
        self.assertTrue(history[-1]["content"].startswith("11:"))  # the newest turns are the ones kept
        self.assertEqual(main.trim_history([{"role": "user", "content": "a" * 10}, {"role": "assistant", "content": "b" * 5}], 6),
                         [{"role": "assistant", "content": "b" * 5}])

    def test_strong_model_is_used_a_limited_number_of_times_a_day(self):
        hard = "Explain why the derivative of sin x is cos x and prove it step by step using the limit definition, " * 2
        # The reply cache would answer Alex's repeated question without any model; this test is about the quota.
        with patch.object(ai_tutor, "OPENROUTER_TUTOR_STRONG_MODEL", "strong/model"), patch.object(main, "TUTOR_STRONG_PER_DAY", 1), \
                patch.dict(os.environ, {"AI_CACHE_ENABLED": "0"}):
            _, first = self.send("alex", content=hard)
            _, second = self.send("alex", content=hard)
            _, other = self.send("sam", content=hard)
        self.assertEqual(first["route"]["model"], "strong/model")
        self.assertEqual(second["route"]["model"], ai_tutor.OPENROUTER_MODEL)
        self.assertEqual(second["route"]["tier"], "deep")
        self.assertEqual(other["route"]["model"], "strong/model")

    def test_global_daily_ai_budget_pauses_ai_with_a_503(self):
        with patch.dict(os.environ, {"AI_DAILY_GLOBAL_LIMIT": "1"}):
            self.send("alex")
            with self.assertRaises(HTTPException) as caught:
                self.send("sam")
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, main.AI_PAUSED)
        # Counted durably, under one shared id.
        with database.engine().connect() as connection:
            count = connection.execute(database.select(database.func.count()).select_from(database.social_action_events).where(
                database.social_action_events.c.student_id == main.GLOBAL_AI_BUDGET_ID)).scalar_one()
        self.assertEqual(count, 1)
        # A refused request does not hold a stream slot.
        self.assertIsNotNone(main.tutor_streams.acquire("sam", 1))
        main.tutor_streams.reset()

    def test_each_account_streams_at_most_two_replies_at_once(self):
        main.tutor_streams.reset()
        with self.as_user("alex"), patch.object(ai_tutor, "stream_tutor_reply", side_effect=lambda **_: iter(["Hi"])):
            request = main.TutorMessageRequest(content="What is a cell?")
            first = main.send_tutor_message(request, "Bearer t")
            second = main.send_tutor_message(request, "Bearer t")
            with self.assertRaises(HTTPException) as caught:
                main.send_tutor_message(request, "Bearer t")
            self.assertEqual(caught.exception.status_code, 429)
            parse_events(first)  # finishing one frees its slot
            third = main.send_tutor_message(request, "Bearer t")
            parse_events(second)
            parse_events(third)
        self.assertEqual(main.tutor_streams._slots, {})
        # A stream that never started gives its slot back after a while.
        slots = main.StreamSlots()
        self.assertIsNotNone(slots.acquire("x", 1, now=0.0))
        self.assertIsNone(slots.acquire("x", 1, now=1.0))
        self.assertIsNotNone(slots.acquire("x", 1, now=main.TUTOR_STREAM_SLOT_SECONDS + 1))

    def test_a_client_leaving_at_the_first_event_releases_its_stream_slot(self):
        main.tutor_streams.reset()
        with self.as_user("alex"), patch.object(ai_tutor, "stream_tutor_reply", side_effect=lambda **_: iter(["Hi"])), \
                patch.object(main, "StreamingResponse", side_effect=lambda content, **_: content):
            events = main.send_tutor_message(main.TutorMessageRequest(content="What is a cell?"), "Bearer t")
            self.assertTrue(next(events).startswith("event: meta"))
            self.assertIn("alex", main.tutor_streams._slots)
            events.close()  # what the server does when the client disconnects
        self.assertEqual(main.tutor_streams._slots, {})

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
