-- study_guides, study_guide_cache: study materials Otto makes from a student's own notes
-- (study guides, summaries, cheat sheets, vocabulary lists, practice problems, timelines;
-- POST /api/study-guides and "make me a study guide" in Otto), and a per-student cache of
-- what the AI wrote, so the same notes, kind and preferences never need a second AI call.
--
-- HOW TO APPLY
--   Paste this file into the Supabase SQL editor and run it. It is idempotent and
--   non-destructive: nothing is dropped or deleted, and re-running it is safe. The
--   backend creates the same tables itself at runtime (backend/study_guides.py and
--   backend/database.py, create_locked_tables) inside the transaction that locks them
--   down; this file creates them ahead of time so they never exist unlocked.
--
-- WHY
--   Both tables hold text derived from a student's private notes. They are served only
--   through the FastAPI backend, which connects as the table owner and bypasses RLS and
--   filters every query by the signed-in owner. With RLS on, no policy and the
--   anon/authenticated grants revoked, PostgREST cannot read or write them with the public
--   anon key or a user JWT. Account deletion removes every row of the account
--   (backend/account_deletion.py); a cached guide is also deleted with any note it was
--   made from (cache_refs), and expires after 30 days (ai_cache.RETENTION).
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where oid in ('public.study_guides'::regclass, 'public.study_guide_cache'::regclass);   -- both true
--   select table_name, grantee from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and table_name in ('study_guides', 'study_guide_cache');                             -- no rows

begin;

create table if not exists public.study_guides (
  id varchar(36) primary key,
  owner_id varchar(100) not null,
  course varchar(120) not null,
  unit varchar(160),
  kind varchar(16) not null,
  title varchar(120) not null,
  content json not null,
  instructions varchar(200) not null default '',
  instructions_hash varchar(64) not null default '',
  source_key varchar(64) not null,
  source_note_ids json not null,
  note_count integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists ix_study_guides_owner_id on public.study_guides (owner_id);
create index if not exists ix_study_guides_source_key on public.study_guides (source_key);
create index if not exists ix_study_guides_owner_course_unit on public.study_guides (owner_id, course, unit);

create table if not exists public.study_guide_cache (
  key varchar(64) primary key,
  owner_id varchar(100) not null,
  content json not null,
  created_at timestamptz not null,
  hits integer not null
);

create index if not exists ix_study_guide_cache_owner_id on public.study_guide_cache (owner_id);
create index if not exists ix_study_guide_cache_created_at on public.study_guide_cache (created_at);

alter table public.study_guides enable row level security;
alter table public.study_guide_cache enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.study_guides from anon, authenticated;
    revoke all on table public.study_guide_cache from anon, authenticated;
  end if;
end
$$;

commit;
