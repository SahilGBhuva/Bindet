-- Rewards: daily quests and chests, earned badges, study activity counts, recap marks and
-- streak freezes. RLS on and client grants removed for every one of them.
--
-- HOW TO APPLY
--   Optional. Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are deleted,
--   no tables or columns are dropped, and re-running it is safe.
--   The tables are created by the backend at runtime (backend/rewards.py and
--   backend/database.py, through database.create_locked_tables, which creates and locks
--   them in one transaction). This file also creates them when they do not exist yet,
--   already locked, so the schema can be prepared before the first deploy.
--
-- WHY
--   These tables are served only through the FastAPI backend (/api/quests/today,
--   /api/badges, /api/recap/last-week, and the `rewards` object on study responses), which
--   connects as the table owner and bypasses RLS. With RLS on, no policy, and the default
--   anon/authenticated grants revoked, PostgREST cannot read or write them with the public
--   anon key or a user JWT, so nobody can award themselves quests, badges or freezes.
--   Account deletion removes every row (backend/account_deletion.py).
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('daily_quests', 'daily_chests', 'earned_badges', 'study_activity',
--                     'reward_marks', 'streak_freezes');
--   should show relrowsecurity = true for all six, and
--   select table_name, grantee from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('daily_quests', 'daily_chests', 'earned_badges', 'study_activity',
--                        'reward_marks', 'streak_freezes');
--   should return no rows.

begin;

create table if not exists public.daily_quests (
  student_id varchar(100) not null,
  day date not null,
  slot integer not null,
  quest_id varchar(24) not null,
  progress integer not null,
  target integer not null,
  completed_at timestamptz,
  xp_awarded integer not null,
  primary key (student_id, day, slot)
);

create table if not exists public.daily_chests (
  student_id varchar(100) not null,
  day date not null,
  xp integer not null,
  opened_at timestamptz not null,
  primary key (student_id, day)
);

create table if not exists public.earned_badges (
  student_id varchar(100) not null,
  badge_id varchar(32) not null,
  earned_at timestamptz not null,
  primary key (student_id, badge_id)
);

create table if not exists public.study_activity (
  student_id varchar(100) not null,
  day date not null,
  kind varchar(16) not null,
  count integer not null,
  primary key (student_id, day, kind)
);

create table if not exists public.reward_marks (
  student_id varchar(100) not null,
  kind varchar(24) not null,
  mark varchar(32) not null,
  created_at timestamptz not null,
  primary key (student_id, kind, mark)
);

do $$
begin
  if to_regclass('public.student_progress') is not null then
    create table if not exists public.streak_freezes (
      student_id varchar(100) primary key references public.student_progress (student_id) on delete cascade,
      banked integer not null,
      granted_week date,
      used_total integer not null,
      saved_streak integer,
      saved_on date,
      updated_at timestamptz not null
    );
  end if;
end
$$;

alter table public.daily_quests enable row level security;
alter table public.daily_chests enable row level security;
alter table public.earned_badges enable row level security;
alter table public.study_activity enable row level security;
alter table public.reward_marks enable row level security;

do $$
begin
  if to_regclass('public.streak_freezes') is not null then
    alter table public.streak_freezes enable row level security;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.daily_quests from anon, authenticated;
    revoke all on table public.daily_chests from anon, authenticated;
    revoke all on table public.earned_badges from anon, authenticated;
    revoke all on table public.study_activity from anon, authenticated;
    revoke all on table public.reward_marks from anon, authenticated;
    if to_regclass('public.streak_freezes') is not null then
      revoke all on table public.streak_freezes from anon, authenticated;
    end if;
  end if;
end
$$;

commit;
