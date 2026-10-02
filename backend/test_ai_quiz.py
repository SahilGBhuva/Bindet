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
        self.assertEqual(kwargs['personalization']['current_topic_accuracy'], 100.0)

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
        self.assertIn('Photosynthesis', mocked.call_args.kwargs['personalization']['weak_topics'])

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


if __name__ == '__main__':
    unittest.main()
