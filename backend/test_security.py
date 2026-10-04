import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

TEST_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TEST_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = TEST_DB.name

import database
import main
import questions


class QuestionTableLockdownTests(unittest.TestCase):
    def test_question_tables_are_in_the_rls_list(self):
        self.assertIn("question_bank", database.RLS_TABLES)
        self.assertIn("generated_questions", database.RLS_TABLES)

    def test_postgres_init_enables_rls_and_revokes_client_grants(self):
        fake_engine = MagicMock()
        fake_engine.dialect.name = "postgresql"
        connection = fake_engine.begin.return_value.__enter__.return_value
        with patch.object(questions.metadata, "create_all"):
            questions._init_question_tables.__wrapped__(fake_engine)
        statements = [call.args[0] for call in connection.exec_driver_sql.call_args_list]
        self.assertIn("ALTER TABLE IF EXISTS question_bank ENABLE ROW LEVEL SECURITY", statements)
        self.assertIn("ALTER TABLE IF EXISTS generated_questions ENABLE ROW LEVEL SECURITY", statements)
        revoke = [statement for statement in statements if "REVOKE" in statement]
        self.assertEqual(len(revoke), 1)
        self.assertIn("public.question_bank", revoke[0])
        # Guarded so a Postgres without Supabase's roles does not fail.
        self.assertIn("pg_roles", revoke[0])


class XpFarmingTests(unittest.TestCase):
    def setUp(self):
        questions.reset_questions()
        database.reset_db()

    def test_daily_xp_cap_still_records_answers(self):
        with patch.object(database, "DAILY_XP_CAP", 25):
            first = database.update_progress("farmer", "addition", True, 10)
            second = database.update_progress("farmer", "addition", True, 10)
            third = database.update_progress("farmer", "addition", True, 10)
            fourth = database.update_progress("farmer", "addition", True, 10)
        self.assertEqual([first["xp_awarded"], second["xp_awarded"], third["xp_awarded"], fourth["xp_awarded"]], [10, 10, 5, 0])
        self.assertEqual(fourth["total_xp"], 25)
        self.assertEqual(fourth["attempts"], 4)
        self.assertEqual(fourth["correct_answers"], 4)

    def test_signed_in_math_questions_have_a_daily_limit(self):
        request = main.QuestionRequest(topic="addition", difficulty=1)
        with patch.object(main.auth, "authenticated_user", return_value={"id": "math-student"}), \
                patch.object(main, "MATH_QUESTIONS_PER_DAY", 2):
            main.generate_question(request, "Bearer test")
            main.generate_question(request, "Bearer test")
            with self.assertRaises(main.HTTPException) as context:
                main.generate_question(request, "Bearer test")
        self.assertEqual(context.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
