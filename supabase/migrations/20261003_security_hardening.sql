-- Security hardening: RLS coverage, read-only notes, chat membership checks,
-- typing-state clamping, attachment path binding, and a chat flood limit.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   Tables the backend creates at runtime are guarded with to_regclass.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace and relkind = 'r'
--   order by 1;
--   Every row should show relrowsecurity = true.
--
-- Tables the frontend reaches directly through PostgREST / Realtime with the
-- anon key and a user JWT (frontend/src/lib/chat.ts). Each already has RLS on
-- and its own policies, so the generic RLS loop in section 1 does not change
-- them:
--   * study_group_messages    select + insert (and Realtime INSERT events)
--   * study_group_chat_reads  select + upsert (insert / update)
--   * study_group_chat_typing select + upsert (insert / update)
--   * rpc get_group_chat_unread_counts (security invoker; reads
--     study_group_members, study_group_chat_reads, study_group_messages)
--   * study_group_members     read only inside the policies above, through
--                             "Students read own group memberships"
--   * profiles                embedded as `sender:profiles!...` in the message
--                             select. profiles has had RLS on with no policy
--                             since 20260911, so that embed already comes back
--                             empty and the chat UI takes names from the
--                             backend's member list instead. Nothing changes.
-- Every other public table is backend-only (DATABASE_URL, table owner, which
-- bypasses RLS), so turning RLS on with no policy only closes PostgREST.

-- ---------------------------------------------------------------------------
-- 1. RLS on every public table, and no direct grants on question tables.
-- ---------------------------------------------------------------------------

do $$
declare
  t record;
begin
  -- question_bank is created by backend/questions.py (metadata.create_all) and
  -- was never covered by a migration, so it is exposed with RLS off.
  if to_regclass('public.question_bank') is not null then
    alter table public.question_bank enable row level security;
    revoke all on table public.question_bank from anon, authenticated;
  end if;

  -- generated_questions holds correct answers. RLS is already on (20260911);
  -- remove the default Supabase grants as well.
  if to_regclass('public.generated_questions') is not null then
    alter table public.generated_questions enable row level security;
    revoke all on table public.generated_questions from anon, authenticated;
  end if;

  -- Safety net: any remaining public table with RLS off gets RLS on and no
  -- policy. Tables owned by another role (for example ones an extension
  -- installed) are skipped with a notice instead of failing the migration.
  for t in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
    order by c.relname
  loop
    begin
      execute format('alter table public.%I enable row level security', t.relname);
      raise notice 'Enabled row level security on public.%', t.relname;
    exception
      when insufficient_privilege then
        raise notice 'Skipped public.% (not owner); enable RLS on it manually', t.relname;
    end;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. study_notes: owner may read, never write directly.
-- ---------------------------------------------------------------------------
-- Notes are written only by the backend (note_store.py), which validates size,
-- course and unit. The old FOR ALL policy let a signed-in user insert, edit or
-- delete their notes straight through PostgREST and skip those checks.
--
-- The policy keeps its original name on purpose: 20260913 only creates
-- "Students own study notes" when no policy of that name exists, so re-running
-- it will not bring the FOR ALL version back. student_id is uuid when the
-- migration created the table and varchar when the backend did; the text
-- casts handle both.

do $$
begin
  if to_regclass('public.study_notes') is not null then
    alter table public.study_notes enable row level security;
    drop policy if exists "Students own study notes" on public.study_notes;
    create policy "Students own study notes" on public.study_notes
      for select to authenticated using (auth.uid()::text = student_id::text);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Chat read receipts and typing state: updates require membership.
-- ---------------------------------------------------------------------------
-- The UPDATE policies only checked student_id = auth.uid(), so a user who had
-- left (or been removed from) a group could keep moving their receipt and
-- typing rows there, and an upsert could repoint a row at another group_id.

do $$
begin
  if to_regclass('public.study_group_chat_reads') is not null then
    drop policy if exists "Members change own read state" on public.study_group_chat_reads;
    create policy "Members change own read state" on public.study_group_chat_reads
      for update to authenticated
      using (
        student_id::text = auth.uid()::text
        and exists (
          select 1 from public.study_group_members member
          where member.group_id = study_group_chat_reads.group_id
            and member.student_id::text = auth.uid()::text
        )
      )
      with check (
        student_id::text = auth.uid()::text
        and exists (
          select 1 from public.study_group_members member
          where member.group_id = study_group_chat_reads.group_id
            and member.student_id::text = auth.uid()::text
        )
      );
  end if;

  if to_regclass('public.study_group_chat_typing') is not null then
    drop policy if exists "Members update own typing state" on public.study_group_chat_typing;
    create policy "Members update own typing state" on public.study_group_chat_typing
      for update to authenticated
      using (
        student_id::text = auth.uid()::text
        and exists (
          select 1 from public.study_group_members member
          where member.group_id = study_group_chat_typing.group_id
            and member.student_id::text = auth.uid()::text
        )
      )
      with check (
        student_id::text = auth.uid()::text
        and exists (
          select 1 from public.study_group_members member
          where member.group_id = study_group_chat_typing.group_id
            and member.student_id::text = auth.uid()::text
        )
      );
  end if;
end
$$;

-- Typing state is written by the client, so the server fixes two fields:
--   * typing_until is clamped to at most 15 seconds ahead (the client sends
--     now + 5s), so nobody can show as "typing" for days. now() is not
--     immutable, so this cannot be a CHECK constraint.
--   * display_name comes from the sender's profile, so nobody can appear in
--     the typing line under someone else's name. The client value is kept
--     only if no profile name is found.
-- security definer: profiles has RLS on with no policy, so an invoker-rights
-- function could not read it.
create or replace function public.study_group_chat_typing_sanitize()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_name text;
begin
  if new.typing_until > now() + interval '15 seconds' then
    new.typing_until := now() + interval '15 seconds';
  end if;

  select p.display_name into profile_name
  from public.profiles p
  where p.student_id::text = new.student_id::text;

  new.display_name := left(coalesce(nullif(trim(profile_name), ''), new.display_name, 'Group member'), 80);
  return new;
end
$$;

revoke all on function public.study_group_chat_typing_sanitize() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.study_group_chat_typing') is not null then
    drop trigger if exists study_group_chat_typing_sanitize on public.study_group_chat_typing;
    create trigger study_group_chat_typing_sanitize
      before insert or update on public.study_group_chat_typing
      for each row execute function public.study_group_chat_typing_sanitize();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Chat attachments must live under the message's own group and sender.
-- ---------------------------------------------------------------------------
-- frontend/src/lib/chat.ts uploads to `${groupId}/${session.user.id}/<uuid>-<name>`
-- and the storage policies (20260920_chat_image_attachments.sql) key on the
-- same two folders. Without this check a member could post a message whose
-- attachment_path points at another group's or another user's image.
-- group_id is varchar(32) and sender_id is varchar(100); attachment_path is
-- text. NOT VALID: existing rows are not checked, every new or updated row is.

do $$
begin
  if to_regclass('public.study_group_messages') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'study_group_messages'
        and column_name = 'attachment_path'
    )
    and not exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('public.study_group_messages')
        and conname = 'study_group_messages_attachment_path_owner_check'
    )
  then
    alter table public.study_group_messages
      add constraint study_group_messages_attachment_path_owner_check check (
        attachment_path is null
        or (
          split_part(attachment_path, '/', 1) = group_id::text
          and split_part(attachment_path, '/', 2) = sender_id::text
          and split_part(attachment_path, '/', 3) <> ''
        )
      ) not valid;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Chat flood limit: at most 20 messages per sender per 60 seconds.
-- ---------------------------------------------------------------------------
-- Messages are inserted straight through PostgREST, so the backend's rate
-- limits never see them. The trigger also sets created_at to the server clock:
-- a client-supplied created_at could otherwise backdate messages, reorder the
-- chat, and dodge the window count.
-- security definer: counts every message by this sender, including groups the
-- caller can no longer read under RLS. The advisory lock serialises one
-- sender's concurrent inserts so parallel requests cannot all pass the check.
-- The client reads the error text from PostgREST's `message` field.

create or replace function public.study_group_messages_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  new.created_at := now();

  perform pg_advisory_xact_lock(hashtext('study_group_messages:' || new.sender_id::text));

  select count(*) into recent_count
  from public.study_group_messages m
  where m.sender_id = new.sender_id
    and m.created_at > now() - interval '60 seconds';

  if recent_count >= 20 then
    raise exception 'chat_rate_limited: too many messages, wait a minute and try again'
      using errcode = 'P0001';
  end if;

  return new;
end
$$;

revoke all on function public.study_group_messages_rate_limit() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.study_group_messages') is not null then
    create index if not exists study_group_messages_sender_created_idx
      on public.study_group_messages (sender_id, created_at desc);

    drop trigger if exists study_group_messages_rate_limit on public.study_group_messages;
    create trigger study_group_messages_rate_limit
      before insert on public.study_group_messages
      for each row execute function public.study_group_messages_rate_limit();
  end if;
end
$$;
