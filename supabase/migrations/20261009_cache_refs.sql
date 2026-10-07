-- cache_refs: which owner and source (a note, a tutor conversation, or none) produced
-- or used each AI cache entry, so deleting a note, a tutor conversation or an
-- account also deletes the cached AI output made from it.
--
-- HOW TO APPLY
--   Paste this file into the Supabase SQL editor and run it. It is idempotent and
--   non-destructive: nothing is dropped or deleted, and re-running it is safe.
--   The backend creates the same table itself at runtime (backend/database.py,
--   create_locked_tables) inside the transaction that locks it down; this file
--   creates it ahead of time so it never exists unlocked.
--
-- WHY
--   The AI caches (flashcard_cache, extraction_cache, grading_cache,
--   tutor_reply_cache, question_bank) are keyed by hashes, but their outputs can
--   contain student content (text read from an uploaded file, cards and tutor
--   replies quoting notes, grade explanations quoting answers). Each row here ties
--   an entry to its owner and source. A shared entry (flashcards, OCR text) is
--   deleted when its last reference is removed, i.e. when no other note of any
--   user references it. Backend-only: RLS on, no policy, client grants revoked.
--   note_id holds the note ID, 'conversation:<id>' for a tutor reply, or '' when
--   the entry belongs to the account only (grades, private question banks).
--
-- VERIFY AFTERWARDS
--   select relrowsecurity from pg_class where oid = 'public.cache_refs'::regclass;  -- true
--   select grantee from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'cache_refs' and grantee in ('anon', 'authenticated');  -- no rows

begin;

create table if not exists public.cache_refs (
  cache_table varchar(32) not null,
  key varchar(64) not null,
  owner_id varchar(100) not null,
  note_id varchar(80) not null default '',
  created_at timestamptz not null,
  primary key (cache_table, key, owner_id, note_id)
);

create index if not exists ix_cache_refs_owner_note on public.cache_refs (owner_id, note_id);
create index if not exists ix_cache_refs_table_key on public.cache_refs (cache_table, key);

alter table public.cache_refs enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.cache_refs from anon, authenticated;
  end if;
end
$$;

commit;
