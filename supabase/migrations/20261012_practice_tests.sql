-- practice_tests, practice_test_items, practice_test_cache: timed practice tests
-- written from a student's notes (POST /api/practice-tests), their questions with
-- answers and the student's graded answers, and a per-student cache of written tests
-- so a retake with the same notes and settings needs no AI call.
--
-- HOW TO APPLY
--   Paste this file into the Supabase SQL editor and run it. It is idempotent and
--   non-destructive: nothing is dropped or deleted, and re-running it is safe. The
--   backend creates the same tables itself at runtime (backend/practice_tests.py and
--   backend/database.py, create_locked_tables) inside the transaction that locks them
--   down; this file creates them ahead of time so they never exist unlocked.
--
-- WHY
--   The items hold every question's answer, and must never reach a browser before
--   the test is submitted. All three tables are served only through the FastAPI
--   backend, which connects as the table owner and bypasses RLS. With RLS on, no
--   policy and the anon/authenticated grants revoked, PostgREST cannot read or write
--   them with the public anon key or a user JWT. Account deletion removes every row
--   of the account (backend/account_deletion.py).
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where oid in ('public.practice_tests'::regclass, 'public.practice_test_items'::regclass,
--                 'public.practice_test_cache'::regclass);                      -- all true
--   select table_name, grantee from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('practice_tests', 'practice_test_items', 'practice_test_cache');  -- no rows

begin;

create table if not exists public.practice_tests (
  id varchar(36) primary key,
  owner_id varchar(100) not null,
  course varchar(120) not null,
  unit varchar(160),
  created_at timestamptz not null,
  started_at timestamptz not null,
  submitted_at timestamptz,
  time_limit_s integer,
  question_count integer not null,
  score integer,
  status varchar(12) not null,
  over_time boolean not null default false,
  xp_awarded integer not null default 0,
  grading_started_at timestamptz,
  grading_token varchar(36)
);

create index if not exists ix_practice_tests_owner_id on public.practice_tests (owner_id);
create index if not exists ix_practice_tests_owner_course_unit on public.practice_tests (owner_id, course, unit);

create table if not exists public.practice_test_items (
  test_id varchar(36) not null references public.practice_tests (id) on delete cascade,
  position integer not null,
  type varchar(16) not null,
  prompt varchar(500) not null,
  choices json,
  answer varchar(300) not null,
  explanation varchar(700) not null,
  topic varchar(60) not null,
  student_answer varchar(500),
  correct boolean,
  grading_source varchar(16),
  feedback varchar(400),
  primary key (test_id, position)
);

create table if not exists public.practice_test_cache (
  key varchar(64) primary key,
  owner_id varchar(100) not null,
  questions json not null,
  created_at timestamptz not null,
  hits integer not null
);

create index if not exists ix_practice_test_cache_owner_id on public.practice_test_cache (owner_id);
create index if not exists ix_practice_test_cache_created_at on public.practice_test_cache (created_at);

alter table public.practice_tests enable row level security;
alter table public.practice_test_items enable row level security;
alter table public.practice_test_cache enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.practice_tests from anon, authenticated;
    revoke all on table public.practice_test_items from anon, authenticated;
    revoke all on table public.practice_test_cache from anon, authenticated;
  end if;
end
$$;

commit;
