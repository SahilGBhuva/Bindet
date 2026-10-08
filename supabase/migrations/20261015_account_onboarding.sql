-- First-run setup state: RLS on and client grants removed for account_onboarding.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   The table is created by the backend at runtime (backend/onboarding.py, through
--   database.create_locked_tables, which creates and locks it in one transaction).
--   This file also creates it when it does not exist yet, already locked, so the
--   schema can be prepared before the first deploy; the backend then finds it.
--
-- WHY
--   account_onboarding holds, per account, when the welcome setup was finished or
--   skipped and when the "Get started" checklist was hidden. It is served only
--   through the FastAPI backend (GET/PUT /api/account/onboarding), which connects
--   as the table owner and bypasses RLS. With RLS on, no policy, and the default
--   anon/authenticated grants revoked, PostgREST cannot read or write it with the
--   public anon key or a user JWT. Account deletion removes the account's row
--   (backend/account_deletion.py).
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname = 'account_onboarding';
--   should show relrowsecurity = true, and
--   select grantee from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'account_onboarding'
--     and grantee in ('anon', 'authenticated');
--   should return no rows.

begin;

create table if not exists public.account_onboarding (
  student_id varchar(100) primary key,
  setup_done_at timestamptz,
  checklist_dismissed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

alter table public.account_onboarding enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.account_onboarding from anon, authenticated;
  end if;
end
$$;

commit;
