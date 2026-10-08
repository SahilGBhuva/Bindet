-- Tutor conversation extras: RLS on and client grants removed for the two tables the
-- backend uses for pinned conversations, study modes and thumbs up/down on replies.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   The tables are created by the backend at runtime (backend/tutor.py, through
--   database.create_locked_tables, which creates and locks each table in one
--   transaction), so each step here is guarded with to_regclass and skipped when
--   the table does not exist yet.
--
-- WHY
--   tutor_conversation_settings holds whether a student pinned a tutor conversation
--   and its study mode ("explain" or "guide"); tutor_message_ratings holds the thumbs
--   up/down a student gave a tutor reply. Both are served only through the FastAPI
--   backend, which connects as the table owner and bypasses RLS. With RLS on, no
--   policy, and the default anon/authenticated grants revoked, PostgREST cannot read
--   or write them with the public anon key or a user JWT.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('tutor_conversation_settings', 'tutor_message_ratings');
--   Every row should show relrowsecurity = true, and
--   select grantee, table_name from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('tutor_conversation_settings', 'tutor_message_ratings');
--   should return no rows.

do $$
declare
  t text;
begin
  foreach t in array array[
    'tutor_conversation_settings',
    'tutor_message_ratings'
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
