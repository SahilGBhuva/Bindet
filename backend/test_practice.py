import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update

import auth
import database
import feedback
import flashcards
import main
import practice
import rate_limit

ALEX, SAM, EVE, ZOE = "alex-id", "sam-id", "eve-id", "zoe-id"
USERS = {"Bearer alex": ALEX, "Bearer sam": SAM, "Bearer eve": EVE, "Bearer zoe": ZOE}


def fake_user(authorization):
    if authorization not in USERS:
        raise main.HTTPException(status_code=401, detail="Sign in required")
    return {"id": USERS[authorization], "email": f"{USERS[authorization][:-3]}@example.com", "email_confirmed_at": "2026-01-01T00:00:00Z"}


def headers(who: str) -> dict:
    return {"Authorization": f"Bearer {who}"}


def tearDownModule():
    if os.path.exists(TEST_DB.name):
        os.unlink(TEST_DB.name)


class PracticeTestCase(unittest.TestCase):
    def setUp(self):
        database.reset_db()
        flashcards.reset_flashcards()
        practice.reset_practice()
        feedback.reset_feedback()
        rate_limit.limiter.reset()
        auth.reset_cache()
        for person in (ALEX, SAM, EVE, ZOE):
            database.onboard_account(person, person[:-3], person[:-3].title(), None)
        # Alex has 6 cards in Bio/Cells and 2 in Bio/Genes; Sam has 2 in Bio/Cells.
        self.alex_cells = self.add_cards(ALEX, "Bio", "Cells", 6)
        self.alex_genes = self.add_cards(ALEX, "Bio", "Genes", 2)
        self.sam_cells = self.add_cards(SAM, "Bio", "Cells", 2)
        self.client = TestClient(main.app)
        self.auth = patch.object(auth, "authenticated_user", side_effect=fake_user)
        self.auth.start()
        self.addCleanup(self.auth.stop)

    def add_cards(self, owner, course, unit, count):
        now = datetime.now(timezone.utc)
        ids = []
        with database.engine().begin() as connection:
            for index in range(count):
                card_id = f"{owner[:3]}-{unit}-{index}"
                connection.execute(insert(flashcards.cards).values(
                    id=card_id, owner_id=owner, note_id=f"note-{owner}-{unit}", course=course, unit=unit,
                    front=f"{unit} question {index}", back=f"{unit} answer {index}", topic=unit.lower(),
                    front_key=card_id, position=index, created_at=now))
                ids.append(card_id)
        return ids

    def befriend(self, first, second):
        code = database.get_profile(second)["friend_code"]
        request = database.send_friend_request(first, code)
        database.respond_to_friend_request(request["request_id"], second, True)

    def round(self, who="alex", answers=None, **overrides):
        body = {"course": "Bio", "unit": "Cells", "length_s": 60, "mode": "self",
                "answers": answers if answers is not None else [{"card_id": card, "correct": True} for card in self.alex_cells[:3]]}
        body.update(overrides)
        return self.client.post("/api/practice/rounds", json=body, headers=headers(who))

    def challenge(self, who="alex", to=SAM, **overrides):
        body = {"to_id": to, "course": "Bio", "unit": "Cells", "length_s": 60, "mode": "self", "card_ids": self.alex_cells[:5]}
        body.update(overrides)
        return self.client.post("/api/practice/challenges", json=body, headers=headers(who))


class ScoringTests(PracticeTestCase):
    def test_score_counts_right_answers_and_doubles_long_streaks(self):
        self.assertEqual(practice.score_answers([True, True, False, True]), {"score": 3, "correct": 3, "total": 4, "best_streak": 2})
        # The 5th and 6th right answers in a row count double.
        self.assertEqual(practice.score_answers([True] * 6)["score"], 8)
        self.assertEqual(practice.score_answers([False, False])["score"], 0)

    def test_cards_and_scopes_are_the_owners_only(self):
        scopes = self.client.get("/api/practice/scopes", headers=headers("alex")).json()["scopes"]
        self.assertEqual(scopes, [{"course": "Bio", "unit": "Cells", "card_count": 6}, {"course": "Bio", "unit": "Genes", "card_count": 2}])
        cards = self.client.get("/api/practice/cards", params={"course": "Bio", "unit": "Cells"}, headers=headers("sam")).json()["cards"]
        self.assertEqual([card["id"] for card in cards], self.sam_cells)
        every_unit = self.client.get("/api/practice/cards", params={"course": "Bio"}, headers=headers("alex")).json()["cards"]
        self.assertEqual(len(every_unit), 8)
        self.assertEqual(self.client.get("/api/practice/scopes").status_code, 401)


class RoundValidationTests(PracticeTestCase):
    def test_server_derives_the_score(self):
        response = self.round(answers=[{"card_id": self.alex_cells[0], "correct": True}, {"card_id": self.alex_cells[1], "correct": False}])
        self.assertEqual(response.status_code, 201, response.text)
        body = response.json()
        self.assertEqual((body["round"]["score"], body["round"]["correct"], body["round"]["total"], body["round"]["accuracy"]), (1, 1, 2, 50))
        self.assertEqual(body["xp_earned"], 1)

    def test_impossible_rounds_are_refused(self):
        cases = [
            # A card that isn't Alex's (Sam's card).
            ([{"card_id": self.sam_cells[0], "correct": True}], {}, "invalid_cards"),
            # A card from another unit than the round's.
            ([{"card_id": self.alex_genes[0], "correct": True}], {}, "invalid_cards"),
            # The same card twice, so total would exceed the cards available.
            ([{"card_id": self.alex_cells[0], "correct": True}] * 2, {}, "invalid_cards"),
            # A card that doesn't exist.
            ([{"card_id": "made-up", "correct": True}], {}, "invalid_cards"),
            (None, {"length_s": 90}, "invalid_length"),
            (None, {"mode": "speedrun"}, "invalid_mode"),
            # Multiple choice needs 4 cards in scope; Genes has 2.
            ([{"card_id": self.alex_genes[0], "correct": True}], {"unit": "Genes", "mode": "choice"}, "invalid_mode"),
        ]
        for answers, overrides, code in cases:
            with self.subTest(code=code, overrides=overrides):
                response = self.round(answers=answers, **overrides)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["detail"]["code"], code)
                self.assertIn("message", response.json()["detail"])
        self.assertEqual(self.round(answers=[]).status_code, 422)
        self.assertEqual(practice.list_rounds(ALEX), [])

    def test_more_answers_than_seconds_is_refused(self):
        many = self.add_cards(ALEX, "Bio", "Big", 70)
        response = self.round(answers=[{"card_id": card, "correct": True} for card in many], unit="Big")
        self.assertEqual(response.json()["detail"]["code"], "impossible_round")
        self.assertEqual(self.round(answers=[{"card_id": card, "correct": True} for card in many], unit="Big", length_s=120).status_code, 201)

    def test_all_units_round_uses_every_unit_of_the_course(self):
        answers = [{"card_id": card, "correct": True} for card in self.alex_cells[:2] + self.alex_genes]
        response = self.round(answers=answers, unit="")
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["round"]["unit"], "")


class XpTests(PracticeTestCase):
    def test_xp_is_capped_per_round(self):
        many = self.add_cards(ALEX, "Bio", "Big", 40)
        body = self.round(answers=[{"card_id": card, "correct": True} for card in many], unit="Big").json()
        self.assertEqual(body["xp_earned"], practice.ROUND_XP_MAX)
        self.assertEqual(database.get_progress(ALEX)["total_xp"], practice.ROUND_XP_MAX)

    def test_rounds_xp_is_capped_per_day(self):
        many = self.add_cards(ALEX, "Bio", "Big", 15)
        earned = [self.round(answers=[{"card_id": card, "correct": True} for card in many], unit="Big").json()["xp_earned"]
                  for _ in range(5)]
        self.assertEqual(earned, [15, 15, 15, 5, 0])
        self.assertEqual(database.get_progress(ALEX)["total_xp"], practice.ROUNDS_XP_PER_DAY)
        # Rounds don't count as quiz attempts.
        self.assertEqual(database.get_progress(ALEX)["attempts"], 0)

    def test_global_daily_cap_still_applies(self):
        database.update_progress(ALEX, "addition", True, database.DAILY_XP_CAP - 2)
        body = self.round().json()
        self.assertEqual(body["xp_earned"], 2)
        self.assertEqual(body["round"]["xp"], 2)


class BestTests(PracticeTestCase):
    def answers(self, pattern):
        return [{"card_id": card, "correct": right} for card, right in zip(self.alex_cells, pattern)]

    def test_bests_update_only_on_improvement(self):
        first = self.round(answers=self.answers([True, True, False])).json()
        self.assertTrue(first["new_best"])
        self.assertEqual(first["best"]["best_score"], 2)
        worse = self.round(answers=self.answers([True, False, False])).json()
        self.assertFalse(worse["new_best"])
        self.assertEqual(worse["best"]["best_score"], 2)
        # Same score, better accuracy: an improvement.
        tidier = self.round(answers=self.answers([True, True])).json()
        self.assertTrue(tidier["new_best"])
        self.assertEqual((tidier["best"]["best_score"], tidier["best"]["best_accuracy"]), (2, 100))
        self.assertEqual(tidier["previous_best"]["best_accuracy"], 67)
        better = self.round(answers=self.answers([True, True, True, False])).json()
        self.assertTrue(better["new_best"])
        bests = self.client.get("/api/practice/bests", headers=headers("alex")).json()["bests"]
        self.assertEqual([(best["unit"], best["length_s"], best["mode"], best["best_score"]) for best in bests], [("Cells", 60, "self", 3)])

    def test_bests_are_kept_per_length_and_mode(self):
        self.round(answers=self.answers([True]))
        self.round(answers=self.answers([True, True]), length_s=120)
        self.round(answers=self.answers([True, True, True]), mode="choice")
        self.assertEqual(len(practice.list_bests(ALEX)), 3)

    def test_a_round_with_nothing_right_is_not_a_best(self):
        body = self.round(answers=self.answers([False, False])).json()
        self.assertFalse(body["new_best"])
        self.assertIsNone(body["best"])

    def test_recent_rounds_are_the_owners_newest_first(self):
        self.round(answers=self.answers([True]))
        self.round(answers=self.answers([True, True]))
        self.round("sam", answers=[{"card_id": self.sam_cells[0], "correct": True}])
        rounds = self.client.get("/api/practice/rounds", params={"limit": 5}, headers=headers("alex")).json()["rounds"]
        self.assertEqual([item["total"] for item in rounds], [2, 1])
        self.assertEqual(self.client.get("/api/practice/rounds", params={"limit": 500}, headers=headers("alex")).status_code, 422)


class ChallengeTests(PracticeTestCase):
    def test_friends_can_challenge_and_both_see_the_result(self):
        self.befriend(ALEX, SAM)
        response = self.challenge(answers=[True, True, False])
        self.assertEqual(response.status_code, 201, response.text)
        created = response.json()
        self.assertEqual((created["role"], created["status"], created["my_score"], created["card_count"]), ("sent", "pending", 2, 5))
        self.assertNotIn("cards", created)
        # Sam was notified and sees the identical snapshot of Alex's cards, in order.
        self.assertTrue(any(item["kind"] == "practice_challenge" for item in database.notifications_for(SAM)))
        inbox = self.client.get("/api/practice/challenges", headers=headers("sam")).json()["challenges"]
        self.assertEqual((inbox[0]["role"], inbox[0]["my_turn"], inbox[0]["opponent"]["student_id"]), ("received", True, ALEX))
        detail = self.client.get(f"/api/practice/challenges/{created['id']}", headers=headers("sam")).json()
        self.assertEqual([card["front"] for card in detail["cards"]], [f"Cells question {index}" for index in range(5)])
        result = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True, False]}, headers=headers("sam"))
        self.assertEqual(result.status_code, 200, result.text)
        sam_view = result.json()["challenge"]
        self.assertEqual((sam_view["status"], sam_view["my_score"], sam_view["their_score"], sam_view["winner"]), ("completed", 1, 2, "them"))
        self.assertEqual(result.json()["xp_earned"], 1)
        alex_view = self.client.get("/api/practice/challenges", headers=headers("alex")).json()["challenges"][0]
        self.assertEqual((alex_view["winner"], alex_view["their_correct"], alex_view["their_total"]), ("me", 1, 2))
        self.assertTrue(any(item["kind"] == "practice_result" for item in database.notifications_for(ALEX)))
        # A challenge play earns XP but never touches personal bests.
        self.assertEqual(practice.list_bests(SAM), [])

    def test_the_challenger_can_play_later(self):
        self.befriend(ALEX, SAM)
        created = self.challenge().json()
        self.assertTrue(created["my_turn"])
        self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True]}, headers=headers("sam"))
        done = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True, True]}, headers=headers("alex")).json()
        self.assertEqual((done["challenge"]["status"], done["challenge"]["winner"]), ("completed", "me"))

    def test_group_members_can_challenge_each_other(self):
        group = database.create_study_group(ALEX, "Bio crew")
        database.join_study_group(EVE, group["invite_code"])
        self.assertEqual(self.challenge(to=EVE).status_code, 201)

    def test_non_friends_and_blocked_people_cannot_challenge(self):
        response = self.challenge(to=ZOE)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "not_allowed")
        # Friends in a shared group, then one blocks the other: refused both ways.
        group = database.create_study_group(ALEX, "Bio crew")
        database.join_study_group(SAM, group["invite_code"])
        self.befriend(ALEX, SAM)
        database.block_person(SAM, ALEX)
        self.assertEqual(self.challenge(to=SAM).status_code, 403)
        self.assertEqual(self.client.post("/api/practice/challenges", json={
            "to_id": ALEX, "course": "Bio", "unit": "Cells", "length_s": 60, "mode": "self", "card_ids": self.sam_cells,
        }, headers=headers("sam")).status_code, 403)
        self.assertEqual(self.challenge(to=ALEX).json()["detail"]["code"], "cannot_challenge_self")
        self.assertEqual(self.challenge(to="nobody").status_code, 404)

    def test_cards_must_be_the_challengers_own(self):
        self.befriend(ALEX, SAM)
        for card_ids in ([self.sam_cells[0]], [self.alex_genes[0]], ["made-up"], [self.alex_cells[0]] * 2):
            with self.subTest(card_ids=card_ids):
                response = self.challenge(card_ids=card_ids)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["detail"]["code"], "invalid_cards")
        too_many = self.add_cards(ALEX, "Bio", "Big", 31)
        self.assertEqual(self.challenge(unit="Big", card_ids=too_many).status_code, 422)
        self.assertEqual(self.challenge(answers=[True] * 6).json()["detail"]["code"], "impossible_round")
        self.assertEqual(self.challenge(mode="choice", card_ids=self.alex_cells[:3]).json()["detail"]["code"], "invalid_mode")

    def test_snapshot_fields_are_length_capped(self):
        self.befriend(ALEX, SAM)
        with database.engine().begin() as connection:
            connection.execute(update(flashcards.cards).where(flashcards.cards.c.id == self.alex_cells[0]).values(back="x" * 900))
        created = self.challenge().json()
        stored = practice.get_challenge(SAM, created["id"])["cards"][0]
        self.assertEqual(len(stored["back"]), practice.CARD_BACK_MAX)

    def test_only_participants_can_see_or_play(self):
        self.befriend(ALEX, SAM)
        created = self.challenge().json()
        for method, path, body in (("GET", f"/api/practice/challenges/{created['id']}", None),
                                   ("POST", f"/api/practice/challenges/{created['id']}/result", {"answers": [True]}),
                                   ("POST", f"/api/practice/challenges/{created['id']}/decline", None)):
            with self.subTest(path=path):
                response = self.client.request(method, path, json=body, headers=headers("eve"))
                self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get("/api/practice/challenges", headers=headers("eve")).json()["challenges"], [])
        self.assertEqual(self.client.get("/api/practice/challenges/not-an-id", headers=headers("sam")).status_code, 422)

    def test_a_second_result_is_a_409(self):
        self.befriend(ALEX, SAM)
        created = self.challenge(answers=[True]).json()
        first = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True]}, headers=headers("sam"))
        self.assertEqual(first.status_code, 200)
        again = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True]}, headers=headers("sam"))
        self.assertEqual(again.status_code, 409)
        self.assertEqual(again.json()["detail"]["code"], "already_played")
        mine = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True]}, headers=headers("alex"))
        self.assertEqual(mine.status_code, 409)
        too_many = self.challenge().json()
        response = self.client.post(f"/api/practice/challenges/{too_many['id']}/result", json={"answers": [True] * 6}, headers=headers("sam"))
        self.assertEqual(response.json()["detail"]["code"], "impossible_round")

    def test_challenges_expire_after_seven_days(self):
        self.befriend(ALEX, SAM)
        created = self.challenge().json()
        expires = datetime.fromisoformat(created["expires_at"])
        self.assertAlmostEqual((expires - datetime.now(timezone.utc)).total_seconds(), 7 * 86400, delta=60)
        with database.engine().begin() as connection:
            connection.execute(update(practice.challenges).values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
        response = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True]}, headers=headers("sam"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "challenge_expired")
        self.assertEqual(practice.list_challenges(SAM)[0]["status"], "expired")

    def test_only_the_recipient_can_decline(self):
        self.befriend(ALEX, SAM)
        created = self.challenge().json()
        self.assertEqual(self.client.post(f"/api/practice/challenges/{created['id']}/decline", headers=headers("alex")).status_code, 403)
        declined = self.client.post(f"/api/practice/challenges/{created['id']}/decline", headers=headers("sam"))
        self.assertEqual(declined.json()["status"], "declined")
        play = self.client.post(f"/api/practice/challenges/{created['id']}/result", json={"answers": [True]}, headers=headers("sam"))
        self.assertEqual(play.json()["detail"]["code"], "challenge_declined")
        self.assertEqual(self.client.post(f"/api/practice/challenges/{created['id']}/decline", headers=headers("sam")).status_code, 409)

    def test_blocking_hides_existing_challenges(self):
        self.befriend(ALEX, SAM)
        created = self.challenge().json()
        database.block_person(SAM, ALEX)
        self.assertEqual(practice.list_challenges(SAM), [])
        self.assertEqual(self.client.get(f"/api/practice/challenges/{created['id']}", headers=headers("sam")).status_code, 404)

    def test_pending_challenges_come_first(self):
        self.befriend(ALEX, SAM)
        done = self.challenge(answers=[True]).json()
        practice.submit_challenge_result(SAM, done["id"], [True])
        waiting = self.challenge(answers=[True]).json()
        mine = self.client.post("/api/practice/challenges", json={
            "to_id": ALEX, "course": "Bio", "unit": "Cells", "length_s": 60, "mode": "self", "card_ids": self.sam_cells,
        }, headers=headers("sam")).json()
        order = [item["id"] for item in practice.list_challenges(ALEX)]
        self.assertEqual(order, [mine["id"], waiting["id"], done["id"]])


class LimitTests(PracticeTestCase):
    def test_rounds_are_rate_limited(self):
        with patch.object(main, "PRACTICE_ROUNDS_PER_HOUR", 2):
            self.assertEqual(self.round().status_code, 201)
            self.assertEqual(self.round().status_code, 201)
            limited = self.round()
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()["detail"]["code"], "rate_limited")
        self.assertIn("Retry-After", limited.headers)

    def test_twenty_challenges_a_day(self):
        self.befriend(ALEX, SAM)
        for _ in range(main.PRACTICE_CHALLENGES_PER_DAY):
            self.assertEqual(self.challenge().status_code, 201)
        limited = self.challenge()
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()["detail"]["code"], "rate_limited")


class FeedbackTests(PracticeTestCase):
    def send(self, who="alex", **overrides):
        body = {"category": "bug", "message": "The timer froze on the last card."}
        body.update(overrides)
        return self.client.post("/api/feedback", json=body, headers=headers(who) if who else {})

    def test_feedback_is_stored_with_device_info_only_when_sent(self):
        self.assertEqual(self.send().status_code, 201)
        self.assertEqual(self.send(category="idea", device={"browser": "Safari 18", "os": "iOS 18", "screen": "390x844", "viewport": "390x664"},
                                   page="games").status_code, 201)
        latest = feedback.latest()
        self.assertEqual(latest[0]["device"], {"browser": "Safari 18", "os": "iOS 18", "screen": "390x844", "viewport": "390x664"})
        self.assertEqual(latest[0]["page"], "games")
        self.assertIsNone(latest[1]["device"])
        self.assertEqual(latest[1]["page"], "")

    def test_feedback_is_validated(self):
        self.assertEqual(self.send(who=None).status_code, 401)
        self.assertEqual(self.send(category="rant").status_code, 422)
        self.assertEqual(self.send(message="x" * 2001).status_code, 422)
        self.assertEqual(self.send(message="   ").json()["detail"]["code"], "empty_feedback")
        self.assertEqual(self.send(page="https://evil.example").status_code, 422)
        self.assertEqual(self.send(device={"browser": "x" * 61}).status_code, 422)

    def test_feedback_is_limited_per_hour_and_day(self):
        for _ in range(main.FEEDBACK_PER_HOUR):
            self.assertEqual(self.send().status_code, 201)
        self.assertEqual(self.send().status_code, 429)
        self.assertEqual(self.send(who="sam").status_code, 201)
        with patch.object(main, "FEEDBACK_PER_HOUR", 100):
            for _ in range(main.FEEDBACK_PER_DAY):
                self.assertEqual(self.send(who="eve").status_code, 201)
            self.assertEqual(self.send(who="eve").status_code, 429)


class AdminTests(PracticeTestCase):
    def test_admin_feedback_is_hidden_without_config(self):
        feedback.save(ALEX, "bug", "Hello", None, "")
        with patch.dict(os.environ, {"ADMIN_EMAILS": ""}):
            self.assertEqual(self.client.get("/api/admin/feedback", headers=headers("alex")).status_code, 404)
        with patch.dict(os.environ, {"ADMIN_EMAILS": "sam@example.com"}):
            self.assertEqual(self.client.get("/api/admin/feedback", headers=headers("alex")).status_code, 404)
            self.assertEqual(self.client.get("/api/admin/feedback").status_code, 404)
            self.assertEqual(self.client.get("/api/admin/feedback", headers={"Authorization": "Bearer junk"}).status_code, 404)
        with patch.dict(os.environ, {"ADMIN_EMAILS": " other@example.com, ALEX@example.com "}):
            response = self.client.get("/api/admin/feedback", headers=headers("alex"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["feedback"][0]["message"], "Hello")
        self.assertEqual(response.json()["feedback"][0]["username"], "alex")

    def test_an_unconfirmed_email_is_not_an_admin(self):
        with patch.dict(os.environ, {"ADMIN_EMAILS": "alex@example.com"}), \
                patch.object(auth, "authenticated_user", return_value={"id": ALEX, "email": "alex@example.com"}):
            self.assertEqual(self.client.get("/api/admin/feedback", headers=headers("alex")).status_code, 404)


class LockdownTests(unittest.TestCase):
    def test_new_tables_are_locked_down(self):
        for table in (*practice.PRACTICE_TABLES, *feedback.FEEDBACK_TABLES):
            self.assertIn(table, database.RLS_TABLES)
            self.assertIn(table, database.CLIENT_REVOKED_TABLES)

    def test_migration_covers_the_new_tables(self):
        path = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "20261013_practice_lab.sql")
        with open(path, encoding="utf-8") as handle:
            sql = handle.read()
        for table in (*practice.PRACTICE_TABLES, *feedback.FEEDBACK_TABLES):
            self.assertIn(f"'{table}'", sql)
        self.assertIn("to_regclass", sql)
        self.assertNotIn("drop table", sql.lower())


if __name__ == "__main__":
    unittest.main()
