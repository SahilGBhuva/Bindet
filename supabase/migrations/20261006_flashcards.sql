-- Persistent flashcards: RLS on and client grants removed for the two tables
-- the backend uses to store each note's cards and their generation state.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   Both tables are created by the backend at runtime (backend/flashcards.py),
--   so each step is guarded with to_regclass and skipped when the table does
--   not exist yet. The backend repeats the RLS/revoke step itself when it
--   creates them.
--
-- WHY
--   flashcards and flashcard_jobs are served only through the FastAPI backend,
--   which connects as the table owner and bypasses RLS. With RLS on, no policy,
--   and the default anon/authenticated grants revoked, PostgREST cannot read or
--   write them with the public anon key or a user JWT.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('flashcards', 'flashcard_jobs');
--   Every row should show relrowsecurity = true, and
--   select grantee, table_name from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('flashcards', 'flashcard_jobs');
--   should return no rows.

do $$
declare
  t text;
begin
  foreach t in array array[
    'flashcards',
    'flashcard_jobs'
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
