import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import database

BACKEND_DIR = Path(__file__).resolve().parent
POOLER_URL = "postgresql://postgres.abcdefgh:s3cret-pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
DB_ENV_VARS = ("VERCEL", "APP_ENV", "DATABASE_URL", "POCKET_TUTOR_DB_PATH")


def clean_env(**values):
    """Environment with every database-related variable removed, then `values` applied."""
    env = {key: value for key, value in os.environ.items() if key not in DB_ENV_VARS}
    env.update(values)
    return env


class DatabaseConfigurationTests(unittest.TestCase):
    def resolve(self, **values):
        with patch.dict(os.environ, clean_env(**values), clear=True):
            return database.database_url()

    def assert_refused(self, **values):
        with self.assertRaises(database.DatabaseConfigurationError) as context:
            self.resolve(**values)
        return str(context.exception)

    # Local development and the test suite keep their SQLite fallback.

    def test_local_dev_without_database_url_uses_sqlite(self):
        self.assertEqual(self.resolve(), f"sqlite:///{database.DEFAULT_DB_PATH}")

    def test_local_test_path_override_uses_sqlite(self):
        self.assertEqual(self.resolve(POCKET_TUTOR_DB_PATH="/tmp/x.db"), "sqlite:////tmp/x.db")

    def test_local_dev_still_normalizes_postgres_url(self):
        self.assertTrue(self.resolve(DATABASE_URL=POOLER_URL).startswith("postgresql+psycopg://"))

    # Production refuses anything that is not a real PostgreSQL URL.

    def test_vercel_without_database_url_refuses(self):
        self.assertIn("DATABASE_URL is not set", self.assert_refused(VERCEL="1"))

    def test_vercel_with_blank_database_url_refuses(self):
        self.assert_refused(VERCEL="1", DATABASE_URL="   ")

    def test_app_env_production_without_database_url_refuses(self):
        self.assert_refused(APP_ENV="production")

    def test_production_rejects_sqlite_path_override(self):
        self.assertIn("POCKET_TUTOR_DB_PATH", self.assert_refused(VERCEL="1", POCKET_TUTOR_DB_PATH="/tmp/x.db", DATABASE_URL=POOLER_URL))

    def test_production_rejects_sqlite_database_url(self):
        self.assertIn("sqlite", self.assert_refused(VERCEL="1", DATABASE_URL="sqlite:////tmp/pocket_tutor.db"))

    def test_production_rejects_unparseable_database_url(self):
        self.assert_refused(VERCEL="1", DATABASE_URL="not a database url")

    def test_production_rejects_postgres_url_without_host(self):
        self.assert_refused(VERCEL="1", DATABASE_URL="postgresql:///postgres")

    def test_production_rejects_postgres_url_without_database(self):
        self.assert_refused(VERCEL="1", DATABASE_URL="postgresql://user:pw@db.example.com:5432")

    def test_production_error_never_leaks_password(self):
        message = self.assert_refused(VERCEL="1", DATABASE_URL="mysql://root:s3cret-pw@db.example.com/app")
        self.assertNotIn("s3cret-pw", message)

    def test_production_accepts_supabase_pooler_url(self):
        url = self.resolve(VERCEL="1", DATABASE_URL=POOLER_URL)
        self.assertTrue(url.startswith("postgresql+psycopg://"))
        self.assertIn("sslmode=require", url)

    def test_production_accepts_pasted_quoted_url(self):
        url = self.resolve(APP_ENV="production", DATABASE_URL=f'DATABASE_URL="{POOLER_URL}"')
        self.assertTrue(url.startswith("postgresql+psycopg://"))

    def test_app_env_other_values_are_not_production(self):
        self.assertTrue(self.resolve(APP_ENV="development").startswith("sqlite:///"))

    # The ASGI app itself must fail to load, not just the first database request.

    def import_app(self, **values):
        return subprocess.run(
            [sys.executable, "-c", "import app"],
            cwd=BACKEND_DIR, env=clean_env(**values), capture_output=True, text=True, timeout=60,
        )

    def test_app_refuses_to_start_on_vercel_without_database_url(self):
        # An explicit empty value stops load_dotenv from filling it in from a developer's backend/.env.
        result = self.import_app(VERCEL="1", DATABASE_URL="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DatabaseConfigurationError", result.stderr)

    def test_app_starts_locally_without_database_url(self):
        result = self.import_app()
        self.assertEqual(result.returncode, 0, result.stderr)


class EngineOptionTests(unittest.TestCase):
    def test_sqlite_keeps_thread_sharing_and_no_pool_sizes(self):
        options = database.engine_options("sqlite:///tmp/test.db", serverless=True)
        self.assertEqual(options["connect_args"], {"check_same_thread": False})
        self.assertNotIn("pool_size", options)

    def test_supabase_transaction_pooler_disables_prepared_statements(self):
        url = database._normalized_database_url(POOLER_URL)
        options = database.engine_options(url, serverless=True)
        self.assertIsNone(options["connect_args"]["prepare_threshold"])
        self.assertTrue(options["pool_pre_ping"])
        self.assertEqual((options["pool_size"], options["max_overflow"]), (2, 2))
        self.assertTrue(options["pool_use_lifo"])
        self.assertLessEqual(options["pool_recycle"], 300)

    def test_direct_postgres_keeps_prepared_statements(self):
        options = database.engine_options("postgresql+psycopg://u:p@db.example.com:5432/app", serverless=False)
        self.assertNotIn("prepare_threshold", options["connect_args"])
        self.assertNotIn("pool_size", options)


if __name__ == "__main__":
    unittest.main()
