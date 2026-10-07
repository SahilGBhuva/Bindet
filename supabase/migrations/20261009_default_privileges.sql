-- Stop new public tables, sequences and functions from being exposed to Supabase
-- clients by default.
--
-- HOW TO APPLY
--   Paste this file into the Supabase SQL editor and run it (as the postgres role,
--   which is what the SQL editor uses). It is idempotent and non-destructive:
--   nothing is dropped or deleted, and re-running it is safe. On a Postgres
--   without Supabase's anon/authenticated roles it does nothing.
--
-- WHY
--   Supabase's default privileges grant anon and authenticated full access to
--   every table, sequence and function created in public. The backend creates its
--   own tables at runtime (backend/database.py create_locked_tables), so for a
--   moment each new table would be reachable through PostgREST with the public
--   anon key until RLS was enabled and the grants revoked. The backend now does
--   all of that in one transaction; this migration also removes the default
--   grants themselves, so a table created by any other path starts closed.
--
-- WHAT IT DOES NOT CHANGE
--   ALTER DEFAULT PRIVILEGES only affects objects created AFTER it runs, by the
--   role running it (postgres here, which is also the role DATABASE_URL uses).
--   Every grant that already exists is untouched, including the client-facing
--   chat tables, sequences and functions (study_group_messages, chat presence and
--   receipts, get_group_chat_unread_counts, ...) and their RLS policies.
--   A FUTURE migration that adds a client-facing table, sequence or function must
--   grant access explicitly, e.g.
--     grant select, insert on table public.new_table to authenticated;
--     grant usage on sequence public.new_table_id_seq to authenticated;
--     grant execute on function public.new_function() to authenticated;
--   (Postgres itself still grants EXECUTE on new functions to PUBLIC; revoke that
--   per function where needed, as the existing migrations already do.)
--
-- VERIFY AFTERWARDS
--   select defaclrole::regrole, defaclobjtype, defaclacl
--   from pg_default_acl
--   where defaclnamespace = 'public'::regnamespace;
--   The rows for postgres should no longer list anon= or authenticated=.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end
$$;
