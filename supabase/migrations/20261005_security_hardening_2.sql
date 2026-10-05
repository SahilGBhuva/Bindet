-- Security hardening, part 2: stricter chat attachment paths, a chat rate
-- limit that cannot be used to probe other users, Realtime limited to chat
-- messages, and table privileges trimmed to what the browser actually uses.
--
-- HOW TO APPLY
--   Run after every earlier migration (see supabase/README.md). Paste this
--   whole file into the Supabase SQL editor and run it. It is idempotent and
--   non-destructive: no rows are deleted, no tables or columns are dropped,
--   and re-running it is safe. Tables the backend creates at runtime are
--   guarded with to_regclass and skipped when missing.
--
-- WHAT THE BROWSER USES DIRECTLY (frontend/src/lib/chat.ts, signed-in user JWT)
--   * study_group_messages    select (+ Realtime INSERT events) and insert
--   * study_group_chat_reads  select and upsert (insert / update)
--   * study_group_chat_typing select and upsert (insert / update)
--   * rpc get_group_chat_unread_counts (security invoker)
--   * study_group_members     only inside RLS policies, the RPC and the
--                             storage policies on study-group-images, which
--                             run as the caller and so need SELECT
--   * profiles                only through the `sender:profiles!...` embed
--                             in the message select; PostgREST needs SELECT
--                             for the embed (RLS still hides every row)
--   No request is made with the bare anon key against public tables.
-- Every other public table is backend-only: the backend connects through
-- DATABASE_URL as the table owner and is unaffected by any grant below.
--
-- VERIFY AFTERWARDS
--   select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type)
--   from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--   group by 1, 2 order by 1, 2;
--   Expect no anon rows, and authenticated only on the five tables above.

-- ---------------------------------------------------------------------------
-- 1. Chat attachment paths: exactly group_id/sender_id/<safe file name>.
-- ---------------------------------------------------------------------------
-- 20261003 only compared the first two path segments, so a path with extra
-- segments, `..`, or odd characters in the file name still passed. The
-- frontend uploads to `${groupId}/${userId}/${uuid}-${safeName}` where
-- safeName is limited to [a-zA-Z0-9._-], which this pattern accepts.
-- The new check is added NOT VALID (new and updated rows are checked at
-- once), then validated against existing rows. If an old row does not match,
-- validation is skipped with a notice and the constraint stays NOT VALID;
-- re-run this file after fixing those rows to validate it.

do $$
declare
  current_def text;
begin
  if to_regclass('public.study_group_messages') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'study_group_messages'
        and column_name = 'attachment_path'
    )
  then
    return;
  end if;

  select pg_get_constraintdef(c.oid) into current_def
  from pg_constraint c
  where c.conrelid = to_regclass('public.study_group_messages')
    and c.conname = 'study_group_messages_attachment_path_owner_check';

  -- Replace the 20261003 version; keep the new one if it is already there.
  if current_def is not null and position('[A-Za-z0-9._-]' in current_def) = 0 then
    alter table public.study_group_messages
      drop constraint study_group_messages_attachment_path_owner_check;
    current_def := null;
  end if;

  if current_def is null then
    alter table public.study_group_messages
      add constraint study_group_messages_attachment_path_owner_check check (
        attachment_path is null
        or (
          attachment_path ~ '^[^/]+/[^/]+/[A-Za-z0-9][A-Za-z0-9._-]*$'
          and split_part(attachment_path, '/', 1) = group_id::text
          and split_part(attachment_path, '/', 2) = sender_id::text
        )
      ) not valid;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.study_group_messages')
      and conname = 'study_group_messages_attachment_path_owner_check'
      and not convalidated
  ) then
    begin
      alter table public.study_group_messages
        validate constraint study_group_messages_attachment_path_owner_check;
    exception
      when check_violation then
        raise notice 'study_group_messages_attachment_path_owner_check left NOT VALID: existing rows do not match. New rows are still checked.';
    end;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Chat rate limit: let RLS reject impersonation before counting anything.
-- ---------------------------------------------------------------------------
-- BEFORE triggers run before the RLS WITH CHECK on INSERT. The 20261003
-- version counted messages for whatever sender_id the request named, so a
-- caller could send rows with another user's id and learn from the
-- "chat_rate_limited" error whether that user had been chatting in the last
-- minute (and could hold that user's advisory lock). Rows whose sender is not
-- the caller now go straight to the RLS check, which rejects them. Trusted
-- inserts by the table owner (no JWT) are not rate limited.
-- created_at is still pinned to the server clock for every row.

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

  if new.sender_id::text is distinct from auth.uid()::text then
    return new;
  end if;

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
    -- Recreate the trigger in case 20261003 ran before the table existed.
    create index if not exists study_group_messages_sender_created_idx
      on public.study_group_messages (sender_id, created_at desc);
    drop trigger if exists study_group_messages_rate_limit on public.study_group_messages;
    create trigger study_group_messages_rate_limit
      before insert on public.study_group_messages
      for each row execute function public.study_group_messages_rate_limit();

    revoke insert on public.study_group_messages from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Realtime: only chat messages are broadcast.
-- ---------------------------------------------------------------------------
-- The frontend subscribes to INSERTs on study_group_messages only, and polls
-- read receipts and typing state over REST. Publishing those two tables just
-- streams every change to the Realtime server for nothing.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['study_group_chat_reads', 'study_group_chat_typing']
  loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Table privileges: only what the browser needs.
-- ---------------------------------------------------------------------------
-- RLS already blocks these tables; removing the default Supabase grants is a
-- second wall in case a policy is ever added or RLS is switched off by
-- mistake. Nothing here grants anything new.

do $$
declare
  t record;
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated')
  then
    raise notice 'anon/authenticated roles not found; skipping privilege changes';
    return;
  end if;

  -- No client ever needs these on any public table.
  revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

  -- The browser never uses the bare anon key against public tables.
  revoke all on all tables in schema public from anon;
  revoke all on all sequences in schema public from anon;

  -- Backend-only tables: no direct client access at all.
  for t in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and c.relname not in (
        'study_group_messages',
        'study_group_chat_reads',
        'study_group_chat_typing',
        'study_group_members',
        'profiles'
      )
    order by c.relname
  loop
    execute format('revoke all on table public.%I from authenticated', t.relname);
  end loop;

  -- Tables the browser does use: drop the operations it never performs.
  if to_regclass('public.study_group_messages') is not null then
    revoke update, delete on public.study_group_messages from authenticated;
  end if;
  if to_regclass('public.study_group_chat_reads') is not null then
    revoke delete on public.study_group_chat_reads from authenticated;
  end if;
  if to_regclass('public.study_group_chat_typing') is not null then
    revoke delete on public.study_group_chat_typing from authenticated;
  end if;
  -- Read only inside policies, the unread RPC and the profiles embed.
  if to_regclass('public.study_group_members') is not null then
    revoke insert, update, delete on public.study_group_members from authenticated;
  end if;
  if to_regclass('public.profiles') is not null then
    revoke insert, update, delete on public.profiles from authenticated;
  end if;

  -- The unread-count RPC is for signed-in users only.
  if to_regprocedure('public.get_group_chat_unread_counts()') is not null then
    revoke execute on function public.get_group_chat_unread_counts() from public, anon;
  end if;
end
$$;
