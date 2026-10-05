import os
import tempfile
import unittest
from unittest.mock import patch

from pydantic import ValidationError

TEST_DB = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
TEST_DB.close()
os.environ['POCKET_TUTOR_DB_PATH'] = TEST_DB.name

import main


class BinditBackendTests(unittest.TestCase):
    def setUp(self):
        main.questions.reset_questions()
        main.database.reset_db()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def save_math_question(self, student_id='student-1'):
        return main.questions.save_question(student_id, 'What is 2 + 2?', '4', 'addition', 1)

    def test_yes_no_and_filename_answers(self):
        self.assertTrue(main.answers_match('Yes', 'yes'))
        self.assertTrue(main.answers_match('Y', 'true'))
        self.assertTrue(main.answers_match('mendel', 'mendel.pdf'))

    def test_mistake_classification(self):
        self.assertEqual(main.classify_mistake('5', '4'), 'off_by_one')
        self.assertEqual(main.classify_mistake('-4', '4'), 'sign_error')
        self.assertEqual(main.classify_mistake('40', '4'), 'place_value_error')
        self.assertEqual(main.classify_mistake('', '4'), 'blank_answer')

    def test_question_generation(self):
        for topic in ('addition', 'subtraction', 'multiplication', 'division', 'mixed'):
            question = main.generate_math_question(topic, 2)
            self.assertTrue(question.question)
            self.assertTrue(question.correct_answer)
            self.assertIn(question.topic, ('addition', 'subtraction', 'multiplication', 'division'))

    def test_notes_question_tracks_unit_as_topic(self):
        question = main.generate_notes_question(
            main.NoteContext(course='Biology', unit='Heredity', files=['mendel.pdf', 'dna.txt']),
            2,
        )
        self.assertTrue(question.question)
        self.assertTrue(question.correct_answer)
        self.assertEqual(question.topic, 'Heredity')

    def test_public_question_hides_answer_for_guest(self):
        response = main.generate_question(
            main.QuestionRequest(topic='addition', difficulty=1, student_id='guest-1')
        )
        self.assertTrue(response.question_id)
        self.assertFalse(hasattr(response, 'correct_answer'))
        stored = main.questions.get_question(main.guest_student_id('guest-1'), response.question_id)
        self.assertIsNotNone(stored)
        self.assertTrue(stored['correct_answer'])

    def test_public_question_hides_answer_for_authenticated_user(self):
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'account-1'}):
            response = main.generate_question(
                main.QuestionRequest(topic='addition', difficulty=1, student_id='spoofed'),
                'Bearer test',
            )
        self.assertIsNone(main.questions.get_question('spoofed', response.question_id))
        self.assertIsNotNone(main.questions.get_question('account-1', response.question_id))

    def test_client_cannot_submit_its_own_correct_answer(self):
        with self.assertRaises(ValidationError):
            main.AnswerRequest(
                question_id='a' * 32,
                student_answer='999',
                student_id='student-1',
                correct_answer='999',
            )

    def test_guest_answer_updates_guest_progress(self):
        question_id = self.save_math_question(main.guest_student_id('guest-1'))
        result = main.analyze_answer(
            main.AnswerRequest(question_id=question_id, student_answer='4', student_id='guest-1')
        )
        progress = main.database.get_progress(main.guest_student_id('guest-1'))
        self.assertTrue(result.correct)
        self.assertEqual(result.score, 100)
        self.assertEqual(result.grading_source, 'deterministic')
        self.assertEqual(result.xp_earned, 10)
        self.assertEqual(progress['total_xp'], 10)

    def test_ai_grades_non_exact_answer(self):
        question_id = self.save_math_question('guest-1')
        ai_result = {
            'correct': False,
            'score': 50,
            'mistake_type': 'calculation_error',
            'misconception': 'Added one too many.',
            'explanation': 'Your setup is close, but 2 + 2 equals 4.',
            'hint': 'Count two more from 2.',
        }
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'guest-1'}), patch.object(main.ai_tutor, 'grade_answer', return_value=ai_result):
            result = main.analyze_answer(
                main.AnswerRequest(question_id=question_id, student_answer='two plus two is five', student_id='guest-1'), 'Bearer test'
            )
        self.assertFalse(result.correct)
        self.assertEqual(result.score, 50)
        self.assertEqual(result.grading_source, 'ai')
        self.assertEqual(result.mistake_type, 'calculation_error')
        self.assertEqual(result.misconception, 'Added one too many.')

    def test_ai_failure_falls_back_safely(self):
        question_id = main.questions.save_question(main.guest_student_id('guest-1'), 'Which organelle makes ATP?', 'Mitochondria', 'Cells', 1)
        with patch.object(main.ai_tutor, 'grade_answer', side_effect=main.ai_tutor.AITutorError('offline')):
            result = main.analyze_answer(
                main.AnswerRequest(question_id=question_id, student_answer='the nucleus', student_id='guest-1')
            )
        self.assertFalse(result.correct)
        self.assertEqual(result.score, 0)
        self.assertEqual(result.grading_source, 'fallback')
        self.assertEqual(result.mistake_type, 'concept_or_format_error')
        self.assertTrue(result.hint)

    def test_wrong_arithmetic_is_graded_without_ai(self):
        question_id = self.save_math_question('student-ai')
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'student-ai'}), \
                patch.object(main.ai_tutor, 'grade_answer') as grader, \
                patch.object(main.database, 'check_social_rate_limit') as limit:
            result = main.analyze_answer(main.AnswerRequest(question_id=question_id, student_answer='5'), 'Bearer test')
        grader.assert_not_called()
        limit.assert_not_called()  # no AI call, so no AI grading quota is spent
        self.assertFalse(result.correct)
        self.assertEqual(result.grading_source, 'deterministic')
        self.assertEqual(result.mistake_type, 'off_by_one')
        self.assertTrue(result.hint)

    def test_equivalent_answers_are_correct_without_ai(self):
        cases = [
            ('Mitochondria', 'the mitochondria.'),
            ('Mitochondria', '  MITOCHONDRIA '),
            ('0.5', '1/2'),
            ('1/3', '0.33'),
            ('3.14159', '3.14'),
            ('40%', '0.4'),
            ('40%', '40'),
            ('12 cm', '12'),
            ('12 cm', '12cm'),
            ('1,000', '1000'),
            ('7', 'seven'),
            ('−3', '-3'),
            ('true', 'Yes'),
        ]
        for reference, answer in cases:
            with self.subTest(reference=reference, answer=answer):
                self.assertIs(main.deterministic_verdict(answer, reference, 'Cells'), True)

    def test_uncertain_answers_still_go_to_the_ai_grader(self):
        cases = [
            ('Two pyruvate molecules', '2 pyruvates'),
            ('3.14159', '3.1'),       # one decimal place is too coarse to accept automatically
            ('1789', '1798'),         # a wrong number on a notes question still earns an explanation
            ('100 cm', '1 m'),        # different units need judgement
            ('f(-x)', '-f(x)'),       # symbols matter
            ('true', 'false'),
        ]
        for reference, answer in cases:
            with self.subTest(reference=reference, answer=answer):
                self.assertIsNone(main.deterministic_verdict(answer, reference, 'Cells'))
        self.assertIs(main.deterministic_verdict('   ', 'Mitochondria', 'Cells'), False)
        self.assertIs(main.deterministic_verdict('5', '4', 'addition'), False)

    def test_numbers_never_match_a_longer_answer_by_file_stem(self):
        self.assertFalse(main.answers_match('3', '3.7 cm'))
        self.assertFalse(main.answers_match('3', '3.5'))
        self.assertTrue(main.answers_match('mendel', 'mendel.pdf'))

    def test_authenticated_identity_overrides_spoofed_student_id(self):
        question_id = self.save_math_question('account-1')
        request = main.AnswerRequest(question_id=question_id, student_answer='4', student_id='spoofed')
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'account-1'}):
            result = main.analyze_answer(request, 'Bearer test')
        self.assertTrue(result.correct)
        self.assertIsNone(main.database.get_progress('spoofed'))
        self.assertEqual(main.database.get_progress('account-1')['total_xp'], 10)

    def test_question_is_bound_to_identity(self):
        question_id = self.save_math_question('account-1')
        request = main.AnswerRequest(question_id=question_id, student_answer='4', student_id='spoofed')
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'account-2'}):
            with self.assertRaises(main.HTTPException) as context:
                main.analyze_answer(request, 'Bearer test')
        self.assertEqual(context.exception.status_code, 404)
        self.assertIsNone(main.database.get_progress('account-2'))

    def test_wrong_answer_can_be_retried(self):
        question_id = self.save_math_question(main.guest_student_id('guest-1'))
        with patch.object(main.ai_tutor, 'grade_answer', side_effect=main.ai_tutor.AITutorError('offline')):
            wrong = main.analyze_answer(main.AnswerRequest(question_id=question_id, student_answer='5', student_id='guest-1'))
        correct = main.analyze_answer(main.AnswerRequest(question_id=question_id, student_answer='4', student_id='guest-1'))
        progress = main.database.get_progress(main.guest_student_id('guest-1'))
        self.assertFalse(wrong.correct)
        self.assertTrue(correct.correct)
        self.assertEqual(progress['attempts'], 2)
        # A retry after a wrong answer earns reduced XP.
        self.assertEqual(correct.xp_earned, main.RETRY_XP)
        self.assertEqual(progress['total_xp'], main.RETRY_XP)

    def test_completed_question_cannot_award_xp_twice(self):
        question_id = self.save_math_question(main.guest_student_id('guest-1'))
        request = main.AnswerRequest(question_id=question_id, student_answer='4', student_id='guest-1')
        main.analyze_answer(request)
        with self.assertRaises(main.HTTPException) as context:
            main.analyze_answer(request)
        self.assertEqual(context.exception.status_code, 409)
        progress = main.database.get_progress(main.guest_student_id('guest-1'))
        self.assertEqual(progress['total_xp'], 10)
        self.assertEqual(progress['attempts'], 1)

    def test_unverified_guest_progress_is_not_claimed_by_account(self):
        main.database.update_progress('guest-1', 'addition', True, 10)
        main.database.update_progress('guest-1', 'addition', False, 0)
        profile = main.database.onboard_account('account-1', 'bindit_learner', 'bindit Learner', 'guest-1')
        first = main.database.get_progress('account-1')
        main.database.onboard_account('account-1', 'bindit_learner', 'bindit Learner', 'guest-1')
        second = main.database.get_progress('account-1')
        self.assertEqual(profile['username'], 'bindit_learner')
        self.assertTrue(profile['friend_code'])
        self.assertEqual(first['total_xp'], 0)
        self.assertEqual(first['attempts'], 0)
        self.assertEqual(first, second)

    def test_guest_progress_cannot_be_stolen_from_existing_account(self):
        main.database.onboard_account('real-account', 'real_user', 'Real')
        main.database.update_progress('real-account', 'addition', True, 10)
        thief = main.database.onboard_account('thief-account', 'thief_user', 'Thief', 'real-account')
        self.assertEqual(thief['total_xp'], 0)

    def test_account_profile_requires_token(self):
        with self.assertRaises(main.HTTPException) as context:
            main.get_account_profile(None)
        self.assertEqual(context.exception.status_code, 401)

    def test_daily_login_streak_increments_once_per_day(self):
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'login-student'}):
            first = main.daily_login(main.DailyLoginRequest(), 'Bearer test')
            second = main.daily_login(main.DailyLoginRequest(), 'Bearer test')
        self.assertEqual(first.login_streak, 1)
        self.assertEqual(second.login_streak, 1)
        self.assertEqual(first.best_login_streak, 1)

    def test_unit_accuracy_is_returned_per_topic(self):
        token = 'Bearer test'
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'unit-student'}):
            q1 = self.save_math_question('unit-student')
            with patch.object(main.ai_tutor, 'grade_answer', side_effect=main.ai_tutor.AITutorError('offline')):
                main.analyze_answer(main.AnswerRequest(question_id=q1, student_answer='5'), token)
            q2 = self.save_math_question('unit-student')
            main.analyze_answer(main.AnswerRequest(question_id=q2, student_answer='4'), token)
            progress = main.get_progress('unit-student', token)
        self.assertEqual(len(progress.topics), 1)
        self.assertEqual(progress.topics[0].topic, 'addition')
        self.assertEqual(progress.topics[0].attempts, 2)
        self.assertEqual(progress.topics[0].correct_answers, 1)
        self.assertEqual(progress.topics[0].accuracy, 50.0)

    def test_progress_requires_token(self):
        main.database.update_progress('victim-account', 'addition', True, 10)
        with self.assertRaises(main.HTTPException) as context:
            main.get_progress('victim-account')
        self.assertEqual(context.exception.status_code, 401)

    def test_progress_rejects_another_users_id(self):
        main.database.update_progress('victim-account', 'addition', True, 10)
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'attacker-account'}):
            with self.assertRaises(main.HTTPException) as context:
                main.get_progress('victim-account', 'Bearer test')
        self.assertEqual(context.exception.status_code, 403)

    def test_daily_login_requires_token(self):
        with self.assertRaises(main.HTTPException) as context:
            main.daily_login(main.DailyLoginRequest(student_id='victim-account'))
        self.assertEqual(context.exception.status_code, 401)
        self.assertIsNone(main.database.get_progress('victim-account'))

    def test_daily_login_ignores_client_supplied_id(self):
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'attacker-account'}):
            result = main.daily_login(main.DailyLoginRequest(student_id='victim-account'), 'Bearer test')
        self.assertEqual(result.student_id, 'attacker-account')
        self.assertIsNone(main.database.get_progress('victim-account'))

    def test_guest_cannot_earn_xp_for_a_real_account(self):
        main.database.onboard_account('victim-account', 'victim', 'Victim')
        question = main.generate_question(main.QuestionRequest(topic='addition', difficulty=1, student_id='victim-account'))
        stored = main.questions.get_question(main.guest_student_id('victim-account'), question.question_id)
        main.analyze_answer(main.AnswerRequest(
            question_id=question.question_id, student_answer=stored['correct_answer'], student_id='victim-account',
        ))
        self.assertIsNone(main.questions.get_question('victim-account', question.question_id))
        self.assertEqual(main.database.get_progress('victim-account')['total_xp'], 0)
        self.assertEqual(main.database.get_progress(main.guest_student_id('victim-account'))['total_xp'], 10)


class HealthTests(unittest.TestCase):
    def setUp(self):
        main._health_db_probe.update(at=float("-inf"), result=None)

    def test_plain_health_does_no_database_work(self):
        with patch.object(main.database, "engine", side_effect=AssertionError("no db")):
            self.assertEqual(main.health(), {"status": "healthy"})

    def test_db_probe_reports_and_caches(self):
        body = main.health(db=True)
        self.assertEqual(body["status"], "healthy")
        self.assertTrue(body["database"]["ok"])
        with patch.object(main.database, "engine", side_effect=AssertionError("cached")):
            self.assertTrue(main.health(db=True)["database"]["ok"])

    def test_db_probe_failure_is_503_without_details(self):
        with patch.object(main.database, "engine", side_effect=RuntimeError("postgresql://user:secret@host")):
            response = main.health(db=True)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(b"secret", response.body)


if __name__ == '__main__':
    unittest.main()
