-- Friend streaks: study_days and friend_streak_marks, created locked, plus a one-time backfill.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   The tables are created by the backend at runtime (backend/database.py, through
--   database.create_locked_tables, which creates and locks them in one transaction).
--   This file also creates them when they do not exist yet, already locked, so the
--   schema can be prepared before the first deploy; the backend then finds them.
--
-- WHAT
--   study_days: one row per student per day they studied (a correct quiz answer, a
--     Practice lab round with something right, a flashcard review or a finished
--     practice test), on the student's own calendar day. Friend streaks count the
--     consecutive days two friends both studied. The backend prunes rows older than
--     400 days; account deletion removes the account's rows.
--   friend_streak_marks: which friend-streak notifications were already sent (a
--     milestone once per streak, an "at risk" reminder once per day), so none repeats.
--     Pruned after 400 days; account deletion removes rows in both directions.
--
--   Backfill: when study_days is empty, it is seeded from the last 60 days of XP
--   history (UTC days) and each student's last active day, so existing friend streaks
--   don't restart at 0. The backend does the same on first start (guarded the same
--   way). ON CONFLICT DO NOTHING keeps it idempotent.
--
-- WHY LOCKED
--   Both tables are served only through the FastAPI backend, which connects as the
--   table owner and bypasses RLS. With RLS on, no policy, and the default
--   anon/authenticated grants revoked, PostgREST cannot read or write them with the
--   public anon key or a user JWT.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname in ('study_days', 'friend_streak_marks');
--   should show relrowsecurity = true for both, and
--   select grantee, table_name from information_schema.role_table_grants
--   where table_schema = 'public' and table_name in ('study_days', 'friend_streak_marks')
--     and grantee in ('anon', 'authenticated');
--   should return no rows.

begin;

create table if not exists public.study_days (
  student_id varchar(100) not null references public.student_progress (student_id) on delete cascade,
  day date not null,
  primary key (student_id, day)
);

create table if not exists public.friend_streak_marks (
  student_id varchar(100) not null references public.profiles (student_id) on delete cascade,
  friend_id varchar(100) not null references public.profiles (student_id) on delete cascade,
  kind varchar(12) not null,
  mark varchar(32) not null,
  created_at timestamptz not null,
  primary key (student_id, friend_id, kind, mark)
);

do $$
declare
  t text;
begin
  foreach t in array array['study_days', 'friend_streak_marks'] loop
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

do $$
begin
  if not exists (select 1 from public.study_days limit 1) then
    insert into public.study_days (student_id, day)
    select distinct student_id, (created_at at time zone 'UTC')::date
    from public.xp_events
    where created_at >= now() - interval '60 days'
    union
    select student_id, last_active_date
    from public.student_progress
    where last_active_date >= (now() - interval '60 days')::date
    on conflict do nothing;
  end if;
end
$$;

commit;
