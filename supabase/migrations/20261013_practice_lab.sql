-- Practice lab and feedback: RLS on and client grants removed for the four tables
-- the backend uses for quick rounds, personal bests, challenges and in-app feedback.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   The tables are created by the backend at runtime (backend/practice.py and
--   backend/feedback.py, through database.create_locked_tables, which creates
--   and locks each table in one transaction), so each step here is guarded with
--   to_regclass and skipped when the table does not exist yet.
--
-- WHY
--   practice_rounds, practice_bests, practice_challenges and feedback are served
--   only through the FastAPI backend, which connects as the table owner and
--   bypasses RLS. practice_challenges holds copies of flashcard text shared with
--   one friend, and feedback holds messages for the bindit team; neither may be
--   readable through PostgREST. With RLS on, no policy, and the default
--   anon/authenticated grants revoked, PostgREST cannot read or write them with
--   the public anon key or a user JWT.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('practice_rounds', 'practice_bests', 'practice_challenges', 'feedback');
--   Every row should show relrowsecurity = true, and
--   select grantee, table_name from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('practice_rounds', 'practice_bests', 'practice_challenges', 'feedback');
--   should return no rows.

do $$
declare
  t text;
begin
  foreach t in array array[
    'practice_rounds',
    'practice_bests',
    'practice_challenges',
    'feedback'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      if exists (select 1 from pg_roles where rolname = 'anon')
         and exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on table public.%I from anon, authenticated', t);
      end if;
    end if;
  end loop;
end
$$;
