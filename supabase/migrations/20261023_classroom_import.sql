-- Google Classroom calendar import: classroom_feeds and classroom_items, RLS on and
-- client grants removed.
--
-- HOW TO APPLY
--   Optional. Paste this whole file into the Supabase SQL editor and run it. It is
--   idempotent and non-destructive: no rows are deleted, no tables or columns are
--   dropped, and re-running it is safe. The backend creates both tables at runtime
--   (backend/classroom_store.py, through database.create_locked_tables, which creates
--   and locks them in one transaction); this file only lets the schema be prepared
--   before the first deploy.
--
-- WHY
--   classroom_feeds holds each student's connected class calendars, including the
--   secret iCal address (a credential: anyone with it can read the calendar).
--   classroom_items links imported calendar events to the tasks and notes they became.
--   Both are served only through the FastAPI backend (/api/classroom/*), which connects
--   as the table owner and bypasses RLS. With RLS on, no policy, and the anon /
--   authenticated grants revoked, PostgREST cannot read or write them with the public
--   anon key or a user JWT. Account deletion removes the account's rows
--   (backend/account_deletion.py).
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname in ('classroom_feeds', 'classroom_items');
--   should show relrowsecurity = true for both, and
--   select table_name, grantee from information_schema.role_table_grants
--   where table_schema = 'public' and table_name in ('classroom_feeds', 'classroom_items')
--     and grantee in ('anon', 'authenticated');
--   should return no rows.

begin;

create table if not exists public.classroom_feeds (
  id varchar(32) primary key,
  owner_id varchar(100) not null,
  course varchar(120) not null,
  calendar_url text not null,
  url_hash varchar(64) not null,
  tz varchar(64) not null,
  save_notes boolean not null,
  last_status varchar(16) not null,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null,
  constraint uq_classroom_feed_owner_url unique (owner_id, url_hash)
);
create index if not exists ix_classroom_feeds_owner_id on public.classroom_feeds (owner_id);

create table if not exists public.classroom_items (
  id serial primary key,
  owner_id varchar(100) not null,
  feed_id varchar(32) not null,
  uid_hash varchar(64) not null,
  task_id varchar(32),
  synced_title varchar(140) not null,
  synced_due_date date,
  synced_due_time varchar(5),
  synced_priority varchar(8),
  title_locked boolean not null,
  due_locked boolean not null,
  priority_locked boolean not null,
  cancelled boolean not null,
  note_id varchar(36),
  note_hash varchar(64),
  note_dismissed boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint uq_classroom_item unique (owner_id, feed_id, uid_hash)
);
create index if not exists ix_classroom_items_owner_id on public.classroom_items (owner_id);
create index if not exists ix_classroom_items_feed_id on public.classroom_items (feed_id);
create index if not exists ix_classroom_items_task_id on public.classroom_items (task_id);

alter table public.classroom_feeds enable row level security;
alter table public.classroom_items enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.classroom_feeds from anon, authenticated;
    revoke all on table public.classroom_items from anon, authenticated;
  end if;
end
$$;

commit;
