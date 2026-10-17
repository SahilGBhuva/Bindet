-- Plan grants (Pro and Unlimited): RLS on and client grants removed for account_plans.
--
-- HOW TO APPLY
--   Optional. Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are deleted,
--   no tables or columns are dropped, and re-running it is safe.
--   The table is created by the backend at runtime (backend/plans.py, through
--   database.create_locked_tables, which creates and locks it in one transaction).
--   This file also creates it when it does not exist yet, already locked, so the
--   schema can be prepared before the first deploy; the backend then finds it.
--
-- WHY
--   account_plans holds one row per email the owner granted a plan: the normalized
--   inbox (primary key), the plan ('pro' or 'unlimited'), who granted it, when, and an
--   optional short note. It is served only through the FastAPI backend
--   (/api/admin/plans, and the plan on /api/account/profile), which connects as the
--   table owner and bypasses RLS. With RLS on, no policy, and the default
--   anon/authenticated grants revoked, PostgREST cannot read or write it with the
--   public anon key or a user JWT, so nobody can grant themselves a plan. Account
--   deletion removes the grant for the account's own email (backend/account_deletion.py).
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname = 'account_plans';
--   should show relrowsecurity = true, and
--   select grantee from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'account_plans'
--     and grantee in ('anon', 'authenticated');
--   should return no rows.

begin;

create table if not exists public.account_plans (
  email varchar(320) primary key,
  plan varchar(16) not null,
  granted_by varchar(100) not null,
  granted_at timestamptz not null,
  note varchar(200)
);

alter table public.account_plans enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.account_plans from anon, authenticated;
  end if;
end
$$;

commit;
