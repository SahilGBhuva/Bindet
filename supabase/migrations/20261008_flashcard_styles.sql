-- flashcard_styles: which student instructions a note's current flashcards were
-- made with (a hash only, never the instructions themselves). Lets
-- POST /api/notes/{id}/flashcards/remake answer a repeat with the stored cards.
--
-- HOW TO APPLY
--   Paste this file into the Supabase SQL editor and run it. It is idempotent and
--   non-destructive: nothing is dropped or deleted. The backend creates the table
--   itself (backend/flashcards.py) and repeats the RLS/revoke step when it does,
--   so this file only guarantees the lock-down. Each step is skipped while the
--   table does not exist yet.
--
-- WHY
--   Served only through the FastAPI backend, which connects as the table owner and
--   bypasses RLS. With RLS on, no policy and the anon/authenticated grants revoked,
--   PostgREST cannot read or write it with the public anon key or a user JWT.

do $$
begin
  if to_regclass('public.flashcard_styles') is not null then
    alter table public.flashcard_styles enable row level security;
    if exists (select 1 from pg_roles where rolname = 'anon')
       and exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on table public.flashcard_styles from anon, authenticated;
    end if;
  end if;
end
$$;
