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
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'biology-student', 'email_confirmed_at': '2026-01-01T00:00:00Z'}), patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked:
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
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student, 'email_confirmed_at': '2026-01-01T00:00:00Z'}), patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked:
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
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student, 'email_confirmed_at': '2026-01-01T00:00:00Z'}), patch.object(main.ai_tutor, 'generate_question', return_value=generated) as mocked:
            response = main.generate_question(request, 'Bearer test')

        self.assertEqual(response.difficulty, 1)
        self.assertEqual(mocked.call_args.kwargs['personalization']['weak_topics'], [])

    def test_only_private_note_grounded_questions_are_personalized(self):
        student = 'notes-student'
        main.database.update_progress(student, 'Photosynthesis', False, 0)
        main.database.update_progress(student, 'Photosynthesis', False, 0)
        request = main.QuestionRequest(topic='mixed', difficulty=2, notes=main.NoteContext(course='Biology', unit='Photosynthesis'))
        generated = {'question': 'What gas do plants take in?', 'correct_answer': 'Carbon dioxide', 'topic': 'Photosynthesis'}
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student, 'email_confirmed_at': '2026-01-01T00:00:00Z'}), \
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
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'history-student', 'email_confirmed_at': '2026-01-01T00:00:00Z'}), patch.object(main.ai_tutor, 'generate_question', side_effect=main.ai_tutor.AITutorError('offline')):
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
        with patch.object(main.auth, 'authenticated_user', side_effect=[{'id': 'student-a', 'email_confirmed_at': '2026-01-01T00:00:00Z'}, {'id': 'student-b', 'email_confirmed_at': '2026-01-01T00:00:00Z'}]), patch.object(
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
        with patch.object(main.auth, 'authenticated_user', return_value={'id': student, 'email_confirmed_at': '2026-01-01T00:00:00Z'}):
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

    def test_private_prompt_avoids_the_students_questions_from_this_unit_only(self):
        note_store = main.note_store
        note_store.save_note('noter', 'Biology', 'Cell Cycle', 'n.txt', 'text/plain', 'Mitosis has four phases.', 24)
        main.questions.mark_seen('noter', main.questions.question_scope('Biology', 'Cell Cycle'), 'A question from this unit?')
        main.questions.mark_seen('noter', main.questions.question_scope('Biology', 'Genetics'), 'A question from another unit?')
        main.questions.save_question('noter', 'What is 2 + 2?', '4', 'addition', 1)
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What are the phases of mitosis?')) as ai:
            self._ask('noter')
        self.assertEqual(ai.call_args.kwargs['avoid'], ['A question from this unit?'])

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


    # --- Non-Latin questions (AI-F1) ---------------------------------------------------

    def test_non_latin_questions_have_distinct_fingerprints(self):
        texts = ['什么是光合作用？', '细胞核的功能是什么？', 'Что такое фотосинтез?', 'Что такое митоз?',
                 'Τι είναι η φωτοσύνθεση;', 'Τι είναι η μίτωση;']
        prints = [main.questions.question_fingerprint(text) for text in texts]
        self.assertTrue(all(prints))
        self.assertEqual(len(set(prints)), len(texts))
        # Case and width still fold, in any script.
        self.assertEqual(main.questions.question_fingerprint('ЧТО ТАКОЕ МИТОЗ'), main.questions.question_fingerprint('что такое митоз?'))

    def test_empty_fingerprint_is_never_a_repeat(self):
        self.assertEqual(main.questions.question_fingerprint('?? !!'), '')
        self.assertFalse(main.questions.same_question('', {''}))
        self.assertEqual(main.questions.fingerprints(['???', '']), set())

    def test_chinese_course_serves_a_new_chinese_question(self):
        with patch.object(main.ai_tutor, 'generate_question', side_effect=[
            self._q('什么是光合作用？'), self._q('细胞核的功能是什么？'),
        ]) as ai:
            self._ask('zh', unit='第一单元')
            second = self._ask('zh', unit='第二单元')
        self.assertEqual(second.question, '细胞核的功能是什么？')
        self.assertEqual(ai.call_count, 2)

    def test_banked_among_returns_the_bank_wording_not_the_students(self):
        key = main.question_cache_key('a', 'Biology', 'Cell Cycle', 'mixed', 1, '')
        main.questions.save_to_bank(key, 'What is mitosis?', 'Cell division', 'Cell Cycle', 1)
        result = main.questions.banked_among(key, ['  WHAT is mitosis!!  ', 'my private diary question'])
        self.assertEqual(result, ['What is mitosis?'])

    def test_private_non_latin_question_never_reaches_a_shared_prompt(self):
        # Another student banks a shared Chinese question for this scope.
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('水的化学式是什么？')):
            self._ask('other', unit='第三单元')
        main.questions.save_question('zh2', '张伟的诊断是什么？', '抑郁症', '私人', 1)
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('氧气的化学式是什么？')) as ai, \
                patch.object(main.questions, 'cached_question', return_value=None):
            self._ask('zh2', unit='第三单元')
        avoid = ai.call_args.kwargs['avoid']
        self.assertNotIn('张伟的诊断是什么？', avoid)
        self.assertTrue(all('张伟' not in text for text in avoid))


    # --- no_new_question is rare (S1) ---------------------------------------------------

    def test_repeating_model_falls_back_to_the_question_seen_longest_ago(self):
        older = self._q('What is cytokinesis?')
        newer = self._q('What is G1 for?')
        with patch.object(main.ai_tutor, 'generate_question', side_effect=[older, newer, older, older]):
            self._ask('fallback')
            self._ask('fallback')
            third = self._ask('fallback')
        self.assertEqual(third.question, 'What is cytokinesis?')
        self.assertTrue(third.repeat)

    def test_repeating_model_falls_back_to_an_unseen_banked_question_first(self):
        unit_key = main.question_cache_key('x', 'Biology', 'Cell Cycle', 'mixed', 1, '')
        main.questions.save_to_bank(unit_key, 'What is a spindle fibre?', 'A protein structure', 'Cell Cycle', 1)
        main.questions.mark_seen('nocache', main.questions.question_scope('Biology', 'Cell Cycle'), 'What is cytokinesis?')
        with patch.dict(os.environ, {'AI_CACHE_ENABLED': '0'}), \
                patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What is cytokinesis?')):
            response = self._ask('nocache')
        self.assertEqual(response.question, 'What is a spindle fibre?')
        self.assertFalse(response.repeat)

    def test_fresh_questions_are_not_flagged_as_repeats(self):
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What is interphase?')):
            self.assertFalse(self._ask('fresh').repeat)

    def test_private_prompt_avoids_the_whole_repeat_window(self):
        main.note_store.save_note('window', 'Biology', 'Cell Cycle', 'n.txt', 'text/plain', 'Mitosis has four phases.', 24)
        scope = main.questions.question_scope('Biology', 'Cell Cycle')
        for index in range(main.questions.RECENT_WINDOW + 5):
            main.questions.mark_seen('window', scope, f'Earlier question number {index}?')
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What are the phases of mitosis?')) as ai:
            self._ask('window')
        self.assertEqual(len(ai.call_args.kwargs['avoid']), main.questions.RECENT_WINDOW)
        self.assertEqual(main.questions.AVOID_IN_PROMPT, main.questions.RECENT_WINDOW)

    def test_avoid_list_dedupes_without_dropping_entries(self):
        texts = [f'Question {index}?' for index in range(main.questions.RECENT_WINDOW)]
        merged = main.quiz_avoid_list(['Question 3 ?', 'A new repeat?', *texts])
        self.assertEqual(len(merged), main.questions.RECENT_WINDOW + 1)
        self.assertEqual(merged[:2], ['Question 3 ?', 'A new repeat?'])
        self.assertLessEqual(len(merged), main.ai_tutor.AVOID_QUESTIONS_MAX)

    def test_prompt_carries_every_avoid_entry(self):
        captured = {}

        def fake_send(op, payload, **kwargs):
            captured.update(payload)
            return {'choices': [{'message': {'content': '{"question":"Q?","correct_answer":"A","topic":"T"}'}}]}

        avoid = [f'Question {index}?' for index in range(main.questions.RECENT_WINDOW + 2)]
        with patch.object(main.ai_tutor, '_send', side_effect=fake_send):
            main.ai_tutor.generate_question(course='Bio', unit='Cells', source_labels=[], focus='mixed', difficulty=1,
                                            personalization={}, avoid=avoid)
        settings = main.json.loads(captured['messages'][1]['content'].split('Quiz settings: ', 1)[1].split('\n')[0])
        self.assertEqual(settings['avoid'], avoid)


    # --- No repeats within a course and unit for SEEN_DAYS ------------------------------

    def _bank(self, texts, unit='Cell Cycle'):
        key = main.question_cache_key('x', 'Biology', unit, 'mixed', 1, '')
        for text in texts:
            main.questions.save_to_bank(key, text, 'x', unit, 1)
        return key

    def test_a_bank_bigger_than_the_old_window_still_asks_for_new_questions(self):
        # Every banked question has been served to this student: the model writes a new one
        # instead of the student cycling through the same bank.
        banked = [f'Banked question number {index}?' for index in range(main.questions.RECENT_WINDOW + 5)]
        self._bank(banked)
        scope = main.questions.question_scope('Biology', 'Cell Cycle')
        for text in banked:
            main.questions.mark_seen('cycler', scope, text)
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What is a kinetochore?')) as ai:
            response = self._ask('cycler')
        ai.assert_called_once()
        self.assertEqual(response.question, 'What is a kinetochore?')
        self.assertFalse(response.repeat)

    def test_bank_serves_the_unseen_question_past_the_old_window(self):
        banked = [f'Banked question number {index}?' for index in range(main.questions.RECENT_WINDOW + 10)]
        self._bank(banked)
        scope = main.questions.question_scope('Biology', 'Cell Cycle')
        for text in banked[:-1]:
            main.questions.mark_seen('almost', scope, text)
        with patch.object(main.ai_tutor, 'generate_question') as ai:
            response = self._ask('almost')
        ai.assert_not_called()
        self.assertEqual(response.question, banked[-1])

    def test_a_student_never_sees_a_unit_question_twice_while_new_ones_can_be_made(self):
        made = iter(f'New question number {index}?' for index in range(100))
        with patch.object(main.ai_tutor, 'generate_question', side_effect=lambda **_: self._q(next(made))):
            served = [self._ask('long-run').question for _ in range(main.questions.RECENT_WINDOW * 2)]
        self.assertEqual(len(set(served)), len(served))

    def test_other_units_and_math_do_not_push_questions_out_of_a_units_history(self):
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What is cytokinesis?')):
            self._ask('busy')
        made = iter(f'Genetics question number {index}?' for index in range(100))
        with patch.object(main.ai_tutor, 'generate_question', side_effect=lambda **_: self._q(next(made))):
            for _ in range(main.questions.RECENT_WINDOW + 5):
                self._ask('busy', unit='Genetics')
        for index in range(main.questions.RECENT_WINDOW + 5):
            main.questions.save_question('busy', f'What is {index} + 1?', str(index + 1), 'addition', 1)
        # Back in Cell Cycle, the bank's only question is one this student has seen.
        with patch.object(main.ai_tutor, 'generate_question', return_value=self._q('What is G1 for?')) as ai:
            response = self._ask('busy')
        self.assertEqual(response.question, 'What is G1 for?')
        self.assertIn('What is cytokinesis?', ai.call_args.kwargs['avoid'])

    def test_out_of_ai_questions_serves_a_flagged_repeat_instead_of_an_error(self):
        with patch.object(main.ai_tutor, 'generate_question', side_effect=[self._q('What is cytokinesis?'), self._q('What is G1 for?')]):
            self._ask('limited')
            self._ask('limited')
        with patch.object(main, '_rate_limited', side_effect=lambda student, action, *rest: (
                    (_ for _ in ()).throw(main.HTTPException(status_code=429, detail='limit')) if action == 'ai_question' else None)), \
                patch.object(main.ai_tutor, 'generate_question') as ai:
            response = self._ask('limited')
        ai.assert_not_called()
        self.assertEqual(response.question, 'What is cytokinesis?')
        self.assertTrue(response.repeat)

    def test_seen_history_is_capped_per_scope_and_expires(self):
        scope = main.questions.question_scope('Biology', 'Cell Cycle')
        with patch.object(main.questions, 'SEEN_PER_SCOPE', 3):
            for index in range(5):
                main.questions.mark_seen('capped', scope, f'Question {index}?')
            self.assertEqual(main.questions.seen_in_scope('capped', scope), ['Question 4?', 'Question 3?', 'Question 2?'])
        # Seeing a question again moves it to the front instead of adding a copy.
        main.questions.mark_seen('capped', scope, 'question 2')
        self.assertEqual(main.questions.seen_in_scope('capped', scope)[0], 'question 2')
        self.assertEqual(len(main.questions.seen_in_scope('capped', scope)), 3)
        old = main.questions.datetime.now(main.questions.timezone.utc) - main.questions.timedelta(days=main.questions.SEEN_DAYS + 1)
        with main.database.engine().begin() as connection:
            connection.execute(main.questions.seen_questions.update().values(seen_at=old))
        self.assertEqual(main.questions.seen_in_scope('capped', scope), [])

    def test_scope_ignores_case_and_spacing(self):
        self.assertEqual(main.questions.question_scope('Biology ', ' cell  cycle'), main.questions.question_scope('biology', 'Cell Cycle'))
        self.assertNotEqual(main.questions.question_scope('Biology', 'Genetics'), main.questions.question_scope('Biology', 'Cell Cycle'))


if __name__ == '__main__':
    unittest.main()
