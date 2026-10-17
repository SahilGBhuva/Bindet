-- Practice test levels: practice_tests.difficulty and practice_tests.test_mode.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   The backend also adds both columns at startup when they are missing
--   (backend/practice_tests.py, ADDED_COLUMNS), so this file only lets the
--   schema be prepared before the deploy.
--
-- WHAT
--   difficulty: easy | medium | hard, chosen on the setup screen. Nullable: tests made
--   before levels existed read as medium (the original behavior).
--   test_mode: exam conditions in the runner (strict timer, no hints). Nullable: off.
--   RLS and the revoked client grants on practice_tests are unchanged.
--
-- VERIFY AFTERWARDS
--   select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'practice_tests' and column_name in ('difficulty', 'test_mode');
--   should show character varying YES, and boolean YES.

alter table public.practice_tests add column if not exists difficulty varchar(8);
alter table public.practice_tests add column if not exists test_mode boolean;
