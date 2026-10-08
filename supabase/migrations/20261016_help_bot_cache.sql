-- Help bot answer cache: RLS on and client grants removed for help_bot_cache.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   The table is created by the backend at runtime (backend/help_bot.py, through
--   database.create_locked_tables, which creates and locks it in one transaction),
--   so the step is guarded with to_regclass and skipped when it does not exist yet.
--
-- WHY
--   help_bot_cache holds answers to "how do I use bindet" questions, keyed by a
--   hash of the normalized question. It stores no account IDs and no question text,
--   and is served only through the FastAPI backend, which connects as the table
--   owner and bypasses RLS. With RLS on, no policy, and the default
--   anon/authenticated grants revoked, PostgREST cannot read or write it with the
--   public anon key or a user JWT.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname = 'help_bot_cache';
--   should show relrowsecurity = true, and
--   select grantee, table_name from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name = 'help_bot_cache';
--   should return no rows.

do $$
begin
  if to_regclass('public.help_bot_cache') is not null then
    alter table public.help_bot_cache enable row level security;
    if exists (select 1 from pg_roles where rolname = 'anon')
       and exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on table public.help_bot_cache from anon, authenticated;
    end if;
  end if;
end
$$;
