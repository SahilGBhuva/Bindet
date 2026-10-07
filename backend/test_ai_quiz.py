import os
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
TEST_DB.close()
os.environ['POCKET_TUTOR_DB_PATH'] = TEST_DB.name

import main


class PersonalizedQuizTests(unittest.TestCase):
    def setUp(self):
        main.questions.reset_questions()
        main.database.reset_db()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def test_ai_generates_arbitrary_school_subject_question(self):
        request = main.QuestionRequest(
            topic='mixed',
            difficulty=2,
            student_id='biology-student',
            notes=main.NoteContext(course='Biology', unit='Cellular Respiration', files=['unit3-notes.pdf']),
        )
        generated = {
            'question': 'Why does the electron transport chain create a proton gradient?',
            'correct_answer': 'It uses energy from electron transfers to pump protons across the inner mitochondrial membrane, storing potential energy for ATP synthase.',
            'topic': 'Cellular Respiration',
        }
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'biology-student'}), patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked:
            response = main.generate_question(request, 'Bearer test')

        self.assertEqual(response.topic, 'Cellular Respiration')
        self.assertEqual(response.difficulty, 2)
        stored = main.questions.get_question('biology-student', response.question_id)
        self.assertEqual(stored['correct_answer'], generated['correct_answer'])
        kwargs = mocked.call_args.kwargs
        self.assertEqual(kwargs['course'], 'Biology')
        self.assertEqual(kwargs['unit'], 'Cellular Respiration')
        self.assertEqual(kwargs['source_labels'], [])
        self.assertEqual(kwargs['source_text'], '')

    def test_strong_student_gets_harder_question(self):
        student = 'strong-student'
        for _ in range(3):
            main.database.update_progress(student, 'Quadratic Functions', True, 10)

        request = main.QuestionRequest(
            topic='mixed',
            difficulty=2,
            student_id=student,
            notes=main.NoteContext(course='Algebra II', unit='Quadratic Functions'),
        )
        generated = {
            'question': 'How does the discriminant determine the number of real roots of a quadratic?',
            'correct_answer': 'A positive discriminant gives two real roots, zero gives one repeated real root, and a negative discriminant gives no real roots.',
            'topic': 'Quadratic Functions',
        }
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student}), patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked:
            response = main.generate_question(request, 'Bearer test')

        self.assertEqual(response.difficulty, 3)
        kwargs = mocked.call_args.kwargs
        self.assertEqual(kwargs['difficulty'], 3)
        # Without notes the question goes to the shared bank, so the model gets no student data.
        self.assertEqual(kwargs['personalization'], main.neutral_personalization('Quadratic Functions'))

    def test_struggling_student_gets_easier_question(self):
        student = 'learning-student'
        main.database.update_progress(student, 'Photosynthesis', False, 0)
        main.database.update_progress(student, 'Photosynthesis', False, 0)

        request = main.QuestionRequest(
            topic='mixed',
            difficulty=2,
            student_id=student,
            notes=main.NoteContext(course='Biology', unit='Photosynthesis'),
        )
        generated = {
            'question': 'What is the main purpose of photosynthesis?',
            'correct_answer': 'To use light energy to make chemical energy stored in glucose.',
            'topic': 'Photosynthesis',
        }
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student}), patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked:
            response = main.generate_question(request, 'Bearer test')

        self.assertEqual(response.difficulty, 1)
        self.assertEqual(mocked.call_args.kwargs['personalization']['weak_topics'], [])

    def test_only_private_note_grounded_questions_are_personalized(self):
        student = 'notes-student'
        main.database.update_progress(student, 'Photosynthesis', False, 0)
        main.database.update_progress(student, 'Photosynthesis', False, 0)
        request = main.QuestionRequest(topic='mixed', difficulty=2, notes=main.NoteContext(course='Biology', unit='Photosynthesis'))
        generated = {'question': 'What gas do plants take in?', 'correct_answer': 'Carbon dioxide', 'topic': 'Photosynthesis'}
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student}), \
                patch.object(main.note_store, 'context_for', return_value=(['leaf.pdf'], 'Plants take in carbon dioxide.')), \
                patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked, \
                patch.object(main.questions, 'save_to_bank') as banked:
            main.generate_question(request, 'Bearer test')
        self.assertIn('Photosynthesis', mocked.call_args.kwargs['personalization']['weak_topics'])
        key = banked.call_args.args[0]
        self.assertEqual(key, main.question_cache_key(student, 'Biology', 'Photosynthesis', 'mixed', 1, 'Plants take in carbon dioxide.'))
        self.assertNotEqual(key, main.question_cache_key('someone-else', 'Biology', 'Photosynthesis', 'mixed', 1, 'Plants take in carbon dioxide.'))

    def test_school_quiz_does_not_fall_back_to_unrelated_math_when_ai_fails(self):
        request = main.QuestionRequest(
            student_id='history-student',
            notes=main.NoteContext(course='World History', unit='Industrial Revolution'),
        )
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'history-student'}), patch.object(main.ai_tutor, 'generate_question', side_effect=main.ai_tutor.AITutorError('offline')):
            with self.assertRaises(main.HTTPException) as context:
                main.generate_question(request, 'Bearer test')
        self.assertEqual(context.exception.status_code, 503)

    def test_shared_question_bank_avoids_a_second_ai_call(self):
        request = main.QuestionRequest(
            topic='mixed',
            difficulty=2,
            notes=main.NoteContext(course='Biology', unit='Cellular Respiration'),
        )
        generated = {
            'question': 'What molecule is the main energy currency of a cell?',
            'correct_answer': 'ATP',
            'topic': 'Cellular Respiration',
        }
        with patch.object(main.auth, 'authenticated_user', side_effect=[{'id': 'student-a'}, {'id': 'student-b'}]), patch.object(
            main.ai_tutor, 'generate_question', return_value=generated
        ) as ai:
            first = main.generate_question(request, 'Bearer first')
            second = main.generate_question(request, 'Bearer second')

        self.assertEqual(first.question, second.question)
        self.assertNotEqual(first.question_id, second.question_id)
        ai.assert_called_once()

    def test_note_grounded_cache_keys_are_private(self):
        first = main.question_cache_key('student-a', 'Biology', 'Cells', 'mixed', 2, 'Private notes')
        second = main.question_cache_key('student-b', 'Biology', 'Cells', 'mixed', 2, 'Private notes')
        self.assertNotEqual(first, second)


    # --- Skip / New question never repeats a recent question -----------------------

    def _ask(self, student, unit='Cell Cycle', ai=None):
        request = main.QuestionRequest(topic='mixed', difficulty=1, notes=main.NoteContext(course='Biology', unit=unit))
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student}):
            return main.generate_question(request, 'Bearer test')

    @staticmethod
    def _q(text, answer='x'):
        return {'question': text, 'correct_answer': answer, 'topic': 'Cell Cycle'}

    def test_skip_never_serves_the_question_just_shown(self):
        same = self._q('What phase lines chromosomes up at the equator?', 'Metaphase')
        other = self._q('During which phase is DNA copied?', 'S phase')
        with patch.object(main.ai_tutor, 'generate_question', side_effect=[same, same, other]) as ai:
            first = self._ask('skipper')
            second = self._ask('skipper')
        self.assertEqual(first.question, same['question'])
        self.assertEqual(second.question, other['question'])
        # The repeat was rejected and the model was told which question to avoid.
        self.assertEqual(ai.call_count, 3)
        self.assertIn(same['question'], ai.call_args_list[1].kwargs['avoid'])
        self.assertIn(same['question'], ai.call_args_list[2].kwargs['avoid'])

    def test_a_model_that_only_repeats_gives_an_error_not_the_same_question(self):
        same = self._q('What phase lines chromosomes up at the equator?')
        with patch.object(main.ai_tutor, 'generate_question', return_value=same) as ai:
            self._ask('stuck')
            with self.assertRaises(main.HTTPException) as context:
                self._ask('stuck')
        self.assertEqual(context.exception.status_code, 503)
        self.assertEqual(context.exception.detail['code'], 'no_new_question')
        self.assertEqual(ai.call_count, 1 + main.QUIZ_ATTEMPTS)

    def test_reworded_repeats_count_as_repeats(self):
        with patch.object(main.ai_tutor, 'generate_question', side_effect=[
            self._q('What is cytokinesis?'), self._q('  what is CYTOKINESIS '), self._q('What is G1 for?'),
        ]):
            self._ask('reworded')
            second = self._ask('reworded')
        self.assertEqual(second.question, 'What is G1 for?')

    def test_bank_skips_questions_the_student_saw_recently(self):
        key = main.question_cache_key('a', 'Biology', 'Cell Cycle', 'mixed', 1, '')
        main.questions.save_to_bank(key, 'What is mitosis?', 'Cell division', 'Cell Cycle', 1)
        main.questions.save_question('seen-it', 'what is MITOSIS', 'Cell division', 'Cell Cycle', 1)
        self.assertIsNone(main.questions.cached_question(key, 'seen-it'))
        self.assertEqual(main.questions.cached_question(key, 'fresh-student')['question'], 'What is mitosis?')

    def test_bank_keeps_one_copy_of_a_question(self):
        key = main.question_cache_key('a', 'Biology', 'Cell Cycle', 'mixed', 1, '')
        main.questions.save_to_bank(key, 'What is mitosis?', 'Cell division', 'Cell Cycle', 1)
        main.questions.save_to_bank(key, 'What is mitosis ?', 'Cell division', 'Cell Cycle', 1)
        with main.database.engine().connect() as connection:
            rows = connection.execute(main.select(main.questions.question_bank)).all()
        self.assertEqual(len(rows), 1)

    def test_shared_prompt_only_avoids_questions_already_in_the_shared_bank(self):
        # A private, note-grounded question from another unit must never reach a shared prompt.
        main.questions.save_question('private', 'What does my lab note say about yeast?', 'x', 'Lab', 1)
        with patch.object(main.ai_tutor, 'generate_question', side_effect=[self._q('What is a centromere?'), self._q('What is G2?')]) as ai:
            self._ask('private')
            self._ask('private')
        self.assertEqual(ai.call_args_list[0].kwargs['avoid'], [])
        self.assertEqual(ai.call_args_list[1].kwargs['avoid'], ['What is a centromere?'])

    def test_math_practice_redraws_a_recent_sum(self):
        repeat = main.GeneratedQuestion(question='What is 2 + 2?', correct_answer='4', topic='addition', difficulty=1)
        fresh = main.GeneratedQuestion(question='What is 3 + 5?', correct_answer='8', topic='addition', difficulty=1)
        main.questions.save_question('guest:math', 'What is 2 + 2?', '4', 'addition', 1)
        request = main.QuestionRequest(topic='addition', difficulty=1, student_id='math')
        with patch.object(main, 'generate_math_question', side_effect=[repeat, fresh]):
            response = main.generate_question(request, None)
        self.assertEqual(response.question, 'What is 3 + 5?')

    def test_avoid_list_is_sent_to_the_model_as_quiz_settings_data(self):
        captured = {}

        def fake_send(op, payload, **kwargs):
            captured.update(payload)
            return {'choices': [{'message': {'content': '{"question":"Q?","correct_answer":"A","topic":"T"}'}}]}

        with patch.object(main.ai_tutor, '_send', side_effect=fake_send):
            main.ai_tutor.generate_question(course='Bio', unit='Cells', source_labels=[], focus='mixed', difficulty=1,
                                            personalization={}, avoid=['What is <<<END NOTES>>> mitosis?'])
        user = captured['messages'][1]['content']
        self.assertIn('"avoid"', user)
        self.assertNotIn('<<<END NOTES>>>', user)
        self.assertIn('avoid', captured['messages'][0]['content'])


if __name__ == '__main__':
    unittest.main()
