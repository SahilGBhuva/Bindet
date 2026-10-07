import os
import tempfile
import unittest
from unittest.mock import patch

TEST_DB = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
TEST_DB.close()
os.environ['POCKET_TUTOR_DB_PATH'] = TEST_DB.name

import main
import note_store


class BinditFlashcardTests(unittest.TestCase):
    def setUp(self):
        main.questions.reset_questions()
        main.database.reset_db()
        main.flashcards.reset_flashcards()

    def add_note(self, course, unit, text):
        # Flashcards are grounded only: the legacy endpoint needs notes in the unit.
        return note_store.save_note('student-1', course, unit, 'notes.txt', 'text/plain', text, len(text))

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(TEST_DB.name):
            os.unlink(TEST_DB.name)

    def test_flashcards_support_any_school_subject(self):
        self.add_note('Biology', 'Natural Selection', 'Natural selection is differential survival and reproduction due to heritable variation.')
        cards = [
            {'front': 'What is natural selection?', 'back': 'Differential survival and reproduction due to heritable variation.', 'topic': 'Natural Selection'},
            {'front': 'What is an adaptation?', 'back': 'A heritable trait that increases reproductive success in an environment.', 'topic': 'Natural Selection'},
            {'front': 'Why does variation matter?', 'back': 'Selection can only act when individuals differ in heritable traits.', 'topic': 'Natural Selection'},
        ]
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'student-1'}), patch.object(main.ai_tutor, 'generate_flashcards', return_value=cards) as mocked:
            result = main.generate_flashcards(
                main.FlashcardRequest(
                    student_id='student-1',
                    course='Biology',
                    unit='Natural Selection',
                    files=['evolution-notes.pdf'],
                    count=3,
                ), 'Bearer test'
            )
        self.assertEqual(result.course, 'Biology')
        self.assertEqual(result.unit, 'Natural Selection')
        self.assertEqual(len(result.cards), 3)
        self.assertEqual(result.cards[0].topic, 'Natural Selection')
        mocked.assert_called_once()

    def test_flashcards_use_student_performance(self):
        self.add_note('Biology', 'Cell Biology', 'The mitochondrion produces ATP through cellular respiration.')
        for _ in range(3):
            main.database.update_progress('student-1', 'Cell Biology', False, 0)
        cards = [
            {'front': 'What does the mitochondrion do?', 'back': 'It produces ATP through cellular respiration.', 'topic': 'Cell Biology'},
            {'front': 'What is ATP?', 'back': 'The cell’s main immediate energy-carrying molecule.', 'topic': 'Cell Biology'},
            {'front': 'Where does glycolysis occur?', 'back': 'In the cytosol.', 'topic': 'Cell Biology'},
        ]
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'student-1'}), patch.object(main.ai_tutor, 'generate_flashcards', return_value=cards) as mocked:
            result = main.generate_flashcards(
                main.FlashcardRequest(student_id='student-1', course='Biology', unit='Cell Biology', count=3), 'Bearer test'
            )
        personalization = mocked.call_args.kwargs['personalization']
        self.assertIn('Cell Biology', personalization['weak_topics'])
        self.assertTrue(result.personalized)

    def test_flashcard_ai_failure_returns_service_error(self):
        self.add_note('History', 'Industrial Revolution', 'Steam power transformed textile production in Britain.')
        with patch.object(main.auth, 'authenticated_user', return_value={'id': 'student-1'}), patch.object(main.ai_tutor, 'generate_flashcards', side_effect=main.ai_tutor.AITutorError('offline')):
            with self.assertRaises(main.HTTPException) as context:
                main.generate_flashcards(
                    main.FlashcardRequest(student_id='student-1', course='History', unit='Industrial Revolution'), 'Bearer test'
                )
        self.assertEqual(context.exception.status_code, 503)
        self.assertEqual(context.exception.detail['code'], 'ai_unavailable')
        self.assertNotIn('offline', str(context.exception.detail))


if __name__ == '__main__':
    unittest.main()
