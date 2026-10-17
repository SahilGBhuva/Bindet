"""Otto makes flashcards and inline quizzes from the conversation: intent detection, the source
note in the unit, the no-course path, limits, caches, and checking quiz answers one at a time.
Every AI call is faked at ai_tutor._post, so the operation registry checks still run."""
import asyncio
import json
import os
import re
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ.setdefault("POCKET_TUTOR_DB_PATH", TEST_DB.name)

from fastapi.testclient import TestClient
from sqlalchemy import delete

import ai_cache
import ai_tutor
import database
import flashcards
import main
import note_store
import otto
import otto_make
import practice_tests
import rate_limit
import study_guides
import tutor

STUDENT = "alex"
QUESTION = "How does mitosis work?"
EXPLANATION = (
    "Mitosis is how one cell divides into two identical daughter cells. In prophase the chromosomes condense and the "
    "nuclear membrane breaks down. In metaphase the chromosomes line up along the middle of the cell, attached to "
    "spindle fibers. In anaphase the sister chromatids are pulled apart to opposite poles of the cell. In telophase "
    "two new nuclei form around each set of chromosomes, and cytokinesis then splits the cytoplasm into two cells. "
    "The centromere holds the two sister chromatids together until anaphase begins."
)
UNIT_NOTES = (
    "Cell cycle notes.\n\nInterphase is the longest stage of the cell cycle, when the cell grows and copies its DNA "
    "before mitosis starts.\n\nThe Krebs cycle happens in the mitochondrial matrix and releases carbon dioxide."
)
PHASES = ("prophase", "metaphase", "anaphase", "telophase")
FACTS = [
    ("chromosomes condense and the nuclear membrane breaks down", "prophase"),
    ("chromosomes line up along the middle of the cell", "metaphase"),
    ("sister chromatids are pulled apart to opposite poles", "anaphase"),
    ("two new nuclei form around each set of chromosomes", "telophase"),
]


def model_reply(content: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(content)}}]}


class FakeModel:
    """OpenRouter at ai_tutor._post: decks, practice tests and grades, grounded in the chat."""

    def __init__(self):
        self.calls: list[dict] = []
        self.grade_correct = True

    def __call__(self, payload, timeout=None):
        self.calls.append(payload)
        schema = payload["response_format"]["json_schema"]["name"]
        if schema == "flashcard_deck":
            return model_reply({"cards": [
                {"front": f"What happens in {phase}?", "back": f"In {phase} the {fact}.", "topic": "Mitosis"} for fact, phase in FACTS
            ]})
        if schema == "practice_test":
            count = int(re.search(r"exactly (\d+) questions", payload["messages"][1]["content"]).group(1))
            round_ = len(self.tests())
            questions = []
            for index in range(count - 1):
                fact, phase = FACTS[index % 4]
                questions.append({"type": "multiple_choice", "prompt": f"Round {round_} question {index + 1}: in which phase do the {fact}?",
                                  "choices": list(PHASES), "answer": phase, "explanation": f"In {phase} the {fact}.", "topic": "Mitosis phases"})
            questions.append({"type": "short_answer", "prompt": f"Round {round_}: what holds the two sister chromatids together?",
                              "choices": [], "answer": "the centromere", "explanation": "The centromere holds the sister chromatids together.",
                              "topic": "Chromosomes"})
            return model_reply({"questions": questions})
        if schema == "practice_grades":
            items = json.loads(payload["messages"][1]["content"])["items"]
            return model_reply({"grades": [{"id": item["id"], "correct": self.grade_correct, "feedback": "Same idea as the centromere."} for item in items]})
        if schema in ("conversation_title", "memory_ops"):
            return model_reply({"title": "Mitosis"} if schema == "conversation_title" else {"ops": []})
        raise AssertionError(f"unexpected call {schema}")

    def of(self, schema):
        return [call for call in self.calls if call["response_format"]["json_schema"]["name"] == schema]

    def decks(self):
        return self.of("flashcard_deck")

    def tests(self):
        return self.of("practice_test")


def stream_events(response) -> list[tuple[str, dict]]:
    async def drain():
        return "".join([chunk if isinstance(chunk, str) else chunk.decode() async for chunk in response.body_iterator])

    events = []
    for block in asyncio.run(drain()).strip().split("\n\n"):
        if block.startswith(":"):
            continue
        name, data = block.split("\n", 1)
        events.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return events


def tearDownModule():
    if os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


class IntentTests(unittest.TestCase):
    def test_requests_for_flashcards_and_quizzes(self):
        cases = {
            "make flashcards on this": ("flashcards", "", None),
            "Turn this into flashcards": ("flashcards", "", None),
            "flashcards for mitosis": ("flashcards", "mitosis", None),
            "Make me some flash cards about the Calvin cycle!": ("flashcards", "Calvin cycle", None),
            "can you make a deck of flashcards on cell division?": ("flashcards", "cell division", None),
            "flashcards please": ("flashcards", "", None),
            "quiz me": ("quiz", "", None),
            "Quiz me on mitosis": ("quiz", "mitosis", None),
            "make a practice test": ("quiz", "", None),
            "test me on this": ("quiz", "", None),
            "give me a practice test on what we talked about": ("quiz", "", None),
            "quiz me with 5 questions": ("quiz", "", 5),
            "Quiz me with twelve questions on Photosynthesis": ("quiz", "Photosynthesis", 12),
            "turn this into a quiz": ("quiz", "", None),
            # One typo per key word is fine.
            "make flashcrads on this": ("flashcards", "", None),
            "make a practise tset": None,  # two typos in a row is too far
            "make a practise test": ("quiz", "", None),
            "quizz me": ("quiz", "", None),
        }
        for text, expected in cases.items():
            intent = otto_make.detect_intent(text)
            if expected is None:
                self.assertIsNone(intent, text)
                continue
            self.assertIsNotNone(intent, text)
            self.assertEqual((intent.kind, intent.target, intent.count), expected, text)

    def test_questions_about_flashcards_and_longer_requests_get_a_normal_answer(self):
        for text in ("what are flashcards?", "how do I make flashcards", "are practice tests helpful?", "do flashcards work",
                     "I have a test on mitosis tomorrow", "what is a quiz", "explain flashcards", "test",
                     "Quiz me on that with 3 quick questions. Ask one at a time and wait for my answer before the next.",
                     "make me a study guide for cells", "give me practice problems on derivatives",
                     "make flashcards on this " + "and also explain how mitochondria work in detail " * 4):
            self.assertIsNone(otto_make.detect_intent(text), text)

    def test_study_guide_requests_stay_study_guides(self):
        self.assertIsNotNone(study_guides.detect_intent("make me a study guide for cells"))
        self.assertIsNone(study_guides.detect_intent("quiz me on cells"))

    def test_topic_comes_from_the_target_or_a_question_style_title(self):
        self.assertEqual(otto_make.topic_title("What is apoptosis?", "", "Cell death"), "Apoptosis")
        self.assertEqual(otto_make.topic_title("How does mitosis work?", "", "Cells"), "Mitosis")
        self.assertEqual(otto_make.topic_title("Mitosis phases", "", "Cells"), "Mitosis phases")
        self.assertEqual(otto_make.topic_title("Mitosis phases", "meiosis", "Cells"), "meiosis")
        self.assertEqual(otto_make.topic_title("New conversation", "", "Cells"), "Cells")

    def test_quiz_length_is_clamped(self):
        self.assertEqual([otto_make.quiz_count(value) for value in (None, 3, 8, 12, 40)], [8, 5, 8, 12, 15])

    def test_chat_source_keeps_the_explanations_and_drops_fixed_replies(self):
        turns = [
            {"role": "user", "content": "hi", "model_tier": ""},
            {"role": "assistant", "content": "Hey! What are we studying?", "model_tier": "small_talk"},
            {"role": "user", "content": QUESTION, "model_tier": ""},
            {"role": "assistant", "content": "## Mitosis\n**Mitosis** splits a cell.", "model_tier": "fast"},
            {"role": "user", "content": "make flashcards on this", "model_tier": ""},
            {"role": "assistant", "content": "Done — I made 4 flashcards.", "model_tier": "otto_make"},
            {"role": "user", "content": "What about meiosis?", "model_tier": ""},
            {"role": "assistant", "content": "Meiosis makes four gametes.", "model_tier": "fast"},
        ]
        source = otto_make.chat_source(turns)
        self.assertEqual(source, f"Question: {QUESTION}\n\nMitosis\nMitosis splits a cell.\n\nQuestion: What about meiosis?\n\nMeiosis makes four gametes.")
        self.assertEqual(otto_make.chat_source(turns, "meiosis"), "Question: What about meiosis?\n\nMeiosis makes four gametes.")


class MakeTestCase(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        note_store.init_notes()
        tutor.reset_tutor()
        otto.reset_otto()
        practice_tests.reset_practice()
        ai_cache.reset_caches()
        rate_limit.limiter.reset()
        main.tutor_streams.reset()
        flashcards.reset_flashcards()
        with database.engine().begin() as connection:
            connection.execute(delete(note_store.notes))
        self.client = TestClient(main.app)
        self.model = FakeModel()
        self.model_patch = patch.object(ai_tutor, "_post", side_effect=self.model)
        self.model_patch.start()
        self.addCleanup(self.model_patch.stop)

    def conversation(self, course="Biology", unit="Cell division", explanation=EXPLANATION, title="Mitosis phases"):
        conversation = tutor.start_conversation(STUDENT, QUESTION, course, unit)
        tutor.rename_conversation(STUDENT, conversation["id"], title)
        tutor.add_message(STUDENT, conversation["id"], "user", QUESTION)
        tutor.add_message(STUDENT, conversation["id"], "assistant", explanation, model_tier="fast")
        return conversation["id"]

    def send(self, content, conversation_id=None, course="", unit=""):
        streamed = []

        def fake_stream(*, messages, route, session_id=None):
            streamed.append(messages)
            yield "A normal answer."
            return {"finish_reason": "stop", "done": True}

        request = main.TutorMessageRequest(content=content, conversation_id=conversation_id, course=course, unit=unit)
        with patch.object(main.auth, "authenticated_user", return_value={"id": STUDENT, "email_confirmed_at": "2026-01-01T00:00:00Z"}), \
                patch.object(ai_tutor, "stream_tutor_reply", side_effect=fake_stream):
            events = stream_events(main.send_tutor_message(request, "Bearer t"))
        self.assertEqual(streamed, [])  # Otto's chat model is never called for these
        return events

    def done(self, events):
        return next(payload for name, payload in events if name == "done")["message"]

    def call(self, method, path, **kwargs):
        with patch.object(main.auth, "authenticated_user", return_value={"id": STUDENT, "email_confirmed_at": "2026-01-01T00:00:00Z"}):
            return self.client.request(method, path, headers={"Authorization": "Bearer t"}, **kwargs)

    def otto_notes(self, course="Biology", unit="Cell division"):
        return [note for note in note_store.list_notes(STUDENT, course, unit) if note["file_name"].startswith(otto_make.NOTE_PREFIX)]


class DeckTests(MakeTestCase):
    def test_a_deck_from_the_conversation_is_saved_to_the_unit(self):
        conversation_id = self.conversation()
        events = self.send("make flashcards on this", conversation_id)
        making = next(payload for name, payload in events if name == "making")
        self.assertEqual(making["kind"], "flashcards")
        self.assertGreater(making["count"], 0)
        message = self.done(events)
        self.assertEqual(message["model_tier"], "otto_make")
        [attachment] = message["attachments"]
        self.assertTrue(attachment.startswith("deck:"))
        note_id = attachment.split(":")[1]
        [note] = self.otto_notes()
        self.assertEqual((note["id"], note["file_name"]), (note_id, "From Otto: Mitosis phases"))
        self.assertIn(EXPLANATION, note["text"])
        self.assertIn(f"Question: {QUESTION}", note["text"])
        count = len(flashcards.note_cards(STUDENT, note_id))
        self.assertEqual(count, ai_tutor.flashcard_target(note["text"]))  # sized to the material, like any note
        self.assertIn(f"{count} flashcards on Mitosis phases", message["content"])
        # One flashcard call, and the chat itself was the notes block it got.
        [deck_call] = self.model.decks()
        self.assertIn("anaphase the sister chromatids", deck_call["messages"][1]["content"])
        # The card shows the deck: name, unit and its cards.
        deck = self.call("GET", f"/api/tutor/decks/{note_id}").json()
        self.assertEqual((deck["title"], deck["unit"], len(deck["cards"])), ("From Otto: Mitosis phases", "Cell division", count))
        # Stored with the reply, so the card is there when the chat opens again.
        self.assertEqual(tutor.list_messages(STUDENT, conversation_id)[-1]["attachments"], [attachment])

    def test_asking_again_reuses_the_note_and_its_cards(self):
        conversation_id = self.conversation()
        first = self.done(self.send("make flashcards on this", conversation_id))
        again = self.done(self.send("turn this into flashcards", conversation_id))
        self.assertEqual(first["attachments"], again["attachments"])
        self.assertEqual(len(self.otto_notes()), 1)
        self.assertEqual(len(self.model.decks()), 1)

    def test_the_same_material_in_another_chat_reuses_the_saved_deck(self):
        first = self.done(self.send("make flashcards on this", self.conversation()))
        second = self.done(self.send("make flashcards on this", self.conversation()))
        self.assertEqual(first["attachments"], second["attachments"])
        self.assertEqual((len(self.otto_notes()), len(self.model.decks())), (1, 1))

    def test_new_material_with_the_same_title_gets_its_own_numbered_note(self):
        self.done(self.send("make flashcards on this", self.conversation()))
        other = self.conversation(explanation=EXPLANATION + " Cytokinesis in plant cells builds a cell plate between the two new cells.")
        self.done(self.send("make flashcards on this", other))
        self.assertEqual(sorted(note["file_name"] for note in self.otto_notes()), ["From Otto: Mitosis phases", "From Otto: Mitosis phases (2)"])

    def test_matching_unit_notes_are_added_to_the_source(self):
        note_store.save_note(STUDENT, "Biology", "Cell division", "cycle.txt", "text/plain", UNIT_NOTES, len(UNIT_NOTES))
        conversation_id = self.conversation()
        self.done(self.send("flashcards for mitosis", conversation_id))
        [note] = self.otto_notes()
        self.assertEqual(note["file_name"], "From Otto: mitosis")
        self.assertIn("From your notes:", note["text"])
        self.assertIn("Interphase is the longest stage", note["text"])
        self.assertNotIn("Krebs cycle", note["text"])  # not about the topic

    def test_without_a_course_or_unit_otto_asks_where_to_save_then_makes_it(self):
        conversation_id = self.conversation(course="", unit="")
        message = self.done(self.send("make flashcards on this", conversation_id))
        self.assertEqual(message["attachments"], ["pick:flashcards"])
        self.assertIn("Which course and unit", message["content"])
        self.assertEqual(self.model.calls, [])
        response = self.call("POST", f"/api/tutor/conversations/{conversation_id}/make",
                             json={"kind": "flashcards", "course": "Biology", "unit": "Cell division", "message_id": message["id"]})
        self.assertEqual(response.status_code, 200, response.text)
        made = response.json()
        self.assertEqual(made["id"], message["id"])  # the question became the deck
        self.assertTrue(made["attachments"][0].startswith("deck:"))
        self.assertEqual(len(self.otto_notes()), 1)
        self.assertEqual(tutor.list_messages(STUDENT, conversation_id)[-1]["attachments"], made["attachments"])
        # Only Otto's "which unit?" replies can be answered this way.
        response = self.call("POST", f"/api/tutor/conversations/{conversation_id}/make",
                             json={"kind": "flashcards", "course": "Biology", "unit": "Cell division", "message_id": message["id"]})
        self.assertEqual(response.status_code, 404)

    def test_too_little_material_gets_the_friendly_message_and_no_ai(self):
        conversation_id = self.conversation(explanation="Mitosis splits a cell.")
        message = self.done(self.send("make flashcards on this", conversation_id))
        self.assertIn("Talk through the topic a bit more, or add notes, and try again", message["content"])
        self.assertEqual((message["attachments"], self.model.calls, self.otto_notes()), ([], [], []))

    def test_the_daily_flashcard_limit_is_explained(self):
        conversation_id = self.conversation()
        with patch.object(main, "FLASHCARD_NOTES_PER_DAY", 0):
            message = self.done(self.send("make flashcards on this", conversation_id))
        self.assertIn("You’ve made a lot of flashcards today", message["content"])
        self.assertEqual((message["attachments"], self.model.decks()), ([], []))

    def test_the_ai_budget_is_respected(self):
        conversation_id = self.conversation()
        with patch.object(main, "global_ai_available", return_value=False):
            message = self.done(self.send("make flashcards on this", conversation_id))
        self.assertEqual((message["attachments"], self.model.decks()), ([], []))
        self.assertTrue(message["content"])

    def test_an_ai_failure_never_leaves_a_hanging_reply(self):
        conversation_id = self.conversation()
        with patch.object(ai_tutor, "_post", side_effect=ai_tutor.AITutorError("down")):
            message = self.done(self.send("make flashcards on this", conversation_id))
        self.assertEqual(message["attachments"], [])
        self.assertIn("Try again", message["content"])


class QuizTests(MakeTestCase):
    def quiz(self, text="quiz me"):
        conversation_id = self.conversation()
        events = self.send(text, conversation_id)
        message = self.done(events)
        [attachment] = message["attachments"]
        _, test_id, note_id = attachment.split(":")
        return conversation_id, events, message, test_id, note_id

    def test_a_quiz_from_the_conversation_is_an_untimed_practice_test(self):
        _, events, message, test_id, note_id = self.quiz()
        self.assertEqual(next(payload for name, payload in events if name == "making"), {"kind": "quiz", "count": 8})
        test = self.call("GET", f"/api/practice-tests/{test_id}").json()
        self.assertEqual((test["question_count"], test["time_limit_s"], test["unit"]), (8, None, "Cell division"))
        self.assertNotIn("answer", test["items"][0])  # nothing is given away before it is checked
        self.assertEqual(test["items"][0]["hint"], "This one is about Mitosis phases.")
        self.assertIn("Here’s an 8-question quiz on Mitosis phases", message["content"])
        self.assertEqual(self.otto_notes()[0]["id"], note_id)
        self.assertIn("anaphase the sister chromatids", self.model.tests()[0]["messages"][1]["content"])

    def test_the_question_count_comes_from_the_request(self):
        _, _, _, test_id, _ = self.quiz("quiz me with 5 questions")
        self.assertEqual(self.call("GET", f"/api/practice-tests/{test_id}").json()["question_count"], 5)

    def test_asking_again_retakes_from_the_cache(self):
        conversation_id, _, first, _, _ = self.quiz()
        again = self.done(self.send("give me a practice test on what we talked about", conversation_id))
        self.assertNotEqual(first["attachments"], again["attachments"])  # a new test to take
        self.assertEqual(len(self.model.tests()), 1)  # but no new model call

    def test_new_quiz_on_this_uses_the_avoid_list(self):
        conversation_id, _, _, _, note_id = self.quiz()
        response = self.call("POST", f"/api/tutor/conversations/{conversation_id}/make", json={"kind": "quiz", "note_id": note_id, "count": 5})
        self.assertEqual(response.status_code, 200, response.text)
        message = response.json()
        self.assertTrue(message["attachments"][0].startswith("quiz:"))
        self.assertIn("new 5-question quiz", message["content"])
        self.assertEqual(len(self.model.tests()), 2)
        self.assertIn("Earlier questions (data)", self.model.tests()[1]["messages"][1]["content"])

    def test_the_daily_practice_test_limit_is_explained(self):
        conversation_id = self.conversation()
        with patch.object(main, "PRACTICE_TESTS_PER_DAY", 0):
            message = self.done(self.send("quiz me", conversation_id))
        self.assertIn("You’ve made a lot of practice tests today", message["content"])
        self.assertEqual((message["attachments"], self.model.tests()), ([], []))

    def test_without_a_unit_otto_asks_and_keeps_the_count(self):
        conversation_id = self.conversation(course="Biology", unit="")
        message = self.done(self.send("quiz me with 12 questions", conversation_id))
        self.assertEqual(message["attachments"], ["pick:quiz:12"])
        made = self.call("POST", f"/api/tutor/conversations/{conversation_id}/make",
                         json={"kind": "quiz", "course": "Biology", "unit": "Cell division", "message_id": message["id"], "count": 12}).json()
        test_id = made["attachments"][0].split(":")[1]
        self.assertEqual(self.call("GET", f"/api/practice-tests/{test_id}").json()["question_count"], 12)

    def test_answers_are_checked_one_at_a_time_and_the_submit_reuses_them(self):
        _, _, _, test_id, _ = self.quiz("quiz me with 5 questions")
        test = self.call("GET", f"/api/practice-tests/{test_id}").json()
        graded = practice_tests.graded_items(STUDENT, test_id)[1]
        first, short = graded[0], graded[-1]
        wrong = next(choice for choice in first["choices"] if choice != first["answer"])
        result = self.call("POST", f"/api/practice-tests/{test_id}/check", json={"position": 0, "answer": wrong}).json()
        self.assertEqual((result["correct"], result["answer"], result["student_answer"]), (False, first["answer"], wrong))
        self.assertTrue(result["explanation"])
        # Locked: a second try doesn't change it.
        again = self.call("POST", f"/api/practice-tests/{test_id}/check", json={"position": 0, "answer": first["answer"]}).json()
        self.assertFalse(again["correct"])
        for row in graded[1:-1]:
            self.assertTrue(self.call("POST", f"/api/practice-tests/{test_id}/check", json={"position": row["position"], "answer": row["answer"]}).json()["correct"])
        # A short answer the checks can't judge goes to the grader once, then the student's cache.
        answer = {"position": short["position"], "answer": "it's the centromere region"}
        checked = self.call("POST", f"/api/practice-tests/{test_id}/check", json=answer).json()
        self.assertTrue(checked["correct"])
        self.assertEqual(len(self.model.of("practice_grades")), 1)
        self.assertTrue(main.ai_cache.cached_grade(main.practice_grade_key(STUDENT, short, "it's the centromere region")))
        # Reopening the chat shows what was checked.
        reopened = self.call("GET", f"/api/practice-tests/{test_id}").json()
        self.assertTrue(all(item.get("checked") for item in reopened["items"]))
        self.assertEqual(test["status"], "in_progress")
        # Submitting grades nothing again and awards XP through the practice-test path.
        submitted = self.call("POST", f"/api/practice-tests/{test_id}/submit", json={"answers": []}).json()
        self.assertEqual((submitted["status"], submitted["score"]), ("submitted", 4))
        self.assertEqual(submitted["xp_earned"], 4 * practice_tests.XP_PER_CORRECT)
        self.assertEqual(len(self.model.of("practice_grades")), 1)
        late = self.call("POST", f"/api/practice-tests/{test_id}/check", json={"position": 1, "answer": "anything"})
        self.assertEqual(late.json()["position"], 1)  # already checked: the stored result

    def test_checks_are_owner_scoped(self):
        _, _, _, test_id, _ = self.quiz()
        with patch.object(main.auth, "authenticated_user", return_value={"id": "sam", "email_confirmed_at": "2026-01-01T00:00:00Z"}):
            response = self.client.post(f"/api/practice-tests/{test_id}/check", json={"position": 0, "answer": "x"}, headers={"Authorization": "Bearer t"})
        self.assertEqual(response.status_code, 404)

    def test_a_cached_short_answer_grade_costs_no_ai(self):
        _, _, _, test_id, _ = self.quiz("quiz me with 5 questions")
        short = practice_tests.graded_items(STUDENT, test_id)[1][-1]
        main.ai_cache.store_grade(main.practice_grade_key(STUDENT, short, "the centro bit"), {
            "correct": False, "score": 0, "mistake_type": None, "explanation": "Not quite.", "hint": None, "misconception": None})
        result = self.call("POST", f"/api/practice-tests/{test_id}/check", json={"position": short["position"], "answer": "the centro bit"}).json()
        self.assertEqual((result["correct"], result["feedback"]), (False, "Not quite."))
        self.assertEqual(self.model.of("practice_grades"), [])


if __name__ == "__main__":
    unittest.main()
