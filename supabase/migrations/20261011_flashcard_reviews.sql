-- flashcard_reviews: spaced-repetition state for each student's saved flashcards
-- (when a card is next due, its interval, ease, reps and lapses). One row per
-- (owner_id, card_id); card_id references flashcards(id) ON DELETE CASCADE, so
-- deleting a note or remaking its cards removes their review state.
--
-- HOW TO APPLY
--   Paste this file into the Supabase SQL editor and run it. It is idempotent and
--   non-destructive: nothing is dropped or deleted. The backend creates the table
--   itself (backend/flashcards.py, with its foreign key and the (owner_id, due_at)
--   index) and repeats the RLS/revoke step in the same transaction when it does,
--   so this file only guarantees the lock-down. Each step is skipped while the
--   table does not exist yet.
--
-- WHY
--   Served only through the FastAPI backend (/api/review/*), which connects as the
--   table owner and bypasses RLS. With RLS on, no policy and the anon/authenticated
--   grants revoked, PostgREST cannot read or write it with the public anon key or a
--   user JWT.
--
-- VERIFY AFTERWARDS
--   select relrowsecurity from pg_class where oid = to_regclass('public.flashcard_reviews');
--   -- true
--   select grantee from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'flashcard_reviews'
--     and grantee in ('anon', 'authenticated');
--   -- no rows

do $$
begin
  if to_regclass('public.flashcard_reviews') is not null then
    alter table public.flashcard_reviews enable row level security;
    if exists (select 1 from pg_roles where rolname = 'anon')
       and exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on table public.flashcard_reviews from anon, authenticated;
    end if;
  end if;
end
$$;
