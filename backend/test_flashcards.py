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


    # --- Renaming a unit or course moves its notes ------------------------------------

    def _as(self, student='student-1'):
        return patch.object(main.auth, 'authenticated_user', return_value={'id': student})

    def test_renaming_a_unit_moves_its_notes_and_cards(self):
        note = self.add_note('Precalc', 'Trig identities', 'sin squared plus cos squared equals one.')
        main.flashcards.complete('student-1', note['id'], 'Precalc', 'Trig identities',
                                 [{'front': 'What is sin^2 + cos^2?', 'back': 'sin squared plus cos squared equals one', 'topic': 'Trig'}])
        other = self.add_note('Precalc', 'Logs', 'Logarithms undo exponentials and turn products into sums.')
        with self._as():
            moved = main.move_notes(main.NotesMove(course='Precalc', unit='Trig identities', new_course='Precalc', new_unit='Trig Identities'), 'Bearer t')
            listed = main.list_flashcards('Precalc', 'Trig Identities', 'Bearer t')
            old = main.get_notes('Precalc', 'Trig identities', 'Bearer t')
        self.assertEqual(moved, {'moved': 1})
        self.assertEqual([state['note_id'] for state in listed['notes']], [note['id']])
        self.assertEqual(len(listed['cards']), 1)
        self.assertEqual(listed['cards'][0]['unit'], 'Trig Identities')
        self.assertEqual(old, [])
        self.assertEqual(note_store.get_note('student-1', other['id'])['unit'], 'Logs')

    def test_renaming_a_course_moves_every_unit_and_only_the_owners_notes(self):
        self.add_note('Precalc', 'Logs', 'Logarithms undo exponentials and turn products into sums.')
        stranger = note_store.save_note('student-2', 'Precalc', 'Logs', 'n.txt', 'text/plain', 'their notes', 11)
        with self._as():
            main.move_notes(main.NotesMove(course='Precalc ', new_course='Precalculus'), 'Bearer t')
            self.assertEqual(len(main.get_notes('Precalculus', 'Logs', 'Bearer t')), 1)
        self.assertEqual(note_store.get_note('student-2', stranger['id'])['course'], 'Precalc')

    def test_move_rejects_a_new_unit_without_the_old_one(self):
        with self._as(), self.assertRaises(main.HTTPException) as context:
            main.move_notes(main.NotesMove(course='Precalc', new_course='Precalc', new_unit='Logs'), 'Bearer t')
        self.assertEqual(context.exception.status_code, 400)


    # --- Rename vs. card generation race (BE-L4) ---------------------------------------

    def test_move_takes_each_notes_lock_in_sorted_order(self):
        ids = [note_store.save_note('lock-student', 'Lock course', 'Logs', 'n.txt', 'text/plain', f'note {index}', 6)['id']
               for index in range(4)]
        locked = []
        with patch.object(main.flashcards, '_lock_note', side_effect=lambda connection, note_id: locked.append(note_id)):
            main.flashcards.move_notes('lock-student', 'Lock course', None, 'Locked course', None)
        self.assertEqual(locked, sorted(ids))

    def test_cards_finished_after_a_rename_are_stored_under_the_new_name(self):
        text = 'sin squared plus cos squared equals one.'
        note = note_store.save_note('race-student', 'Precalc', 'Trig identities', 'n.txt', 'text/plain', text, len(text))
        card = [{'front': 'What is sin^2 + cos^2?', 'back': 'sin squared plus cos squared equals one', 'topic': 'Trig'}]
        main.flashcards.move_notes('race-student', 'Precalc', 'Trig identities', 'Precalc', 'Trig Identities')
        # The generation started before the rename and still carries the old names.
        stored = main.flashcards.complete('race-student', note['id'], 'Precalc', 'Trig identities', card)
        self.assertEqual(stored[0]['unit'], 'Trig Identities')
        remade = main.flashcards.replace('race-student', note['id'], 'Precalc', 'Trig identities', card, 'h')
        self.assertEqual(remade[0]['unit'], 'Trig Identities')


    # --- GET /api/notes/scopes ----------------------------------------------------------

    def test_note_scopes_lists_each_course_and_unit_newest_first(self):
        from datetime import datetime, timedelta, timezone
        from fastapi.testclient import TestClient
        base = datetime(2026, 10, 1, tzinfo=timezone.utc)
        rows = [('Bio', 'Cells', 0), ('Bio', 'Cells', 3), ('Chem', 'Acids', 2), ('Bio', 'Genes', 1)]
        for course, unit, days in rows:
            note = note_store.save_note('scopes-student', course, unit, 'n.txt', 'text/plain', 'x', 1)
            with main.database.engine().begin() as connection:
                connection.execute(note_store.notes.update().where(note_store.notes.c.id == note['id'])
                                   .values(created_at=base + timedelta(days=days)))
        note_store.save_note('someone-else', 'Secret', 'Unit', 'n.txt', 'text/plain', 'x', 1)
        client = TestClient(main.app)
        with self._as('scopes-student'):
            response = client.get('/api/notes/scopes', headers={'Authorization': 'Bearer t'})
        self.assertEqual(response.status_code, 200, response.text)
        scopes = response.json()['scopes']
        self.assertEqual([(item['course'], item['unit'], item['note_count']) for item in scopes],
                         [('Bio', 'Cells', 2), ('Chem', 'Acids', 1), ('Bio', 'Genes', 1)])
        self.assertEqual(datetime.fromisoformat(scopes[0]['last_added']), base + timedelta(days=3))
        with self._as('nobody'):
            self.assertEqual(client.get('/api/notes/scopes', headers={'Authorization': 'Bearer t'}).json(), {'scopes': []})
        self.assertEqual(client.get('/api/notes/scopes').status_code, 401)


if __name__ == '__main__':
    unittest.main()
