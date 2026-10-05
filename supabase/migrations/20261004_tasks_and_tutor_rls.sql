-- Task system and AI tutor tables: RLS on, client grants removed, and the
-- indexes the task, analytics, friends and notification reads rely on.
--
-- HOW TO APPLY
--   Paste this whole file into the Supabase SQL editor and run it. It is not
--   applied by the backend. It is idempotent and non-destructive: no rows are
--   deleted, no tables or columns are dropped, and re-running it is safe.
--   Every table here is created by the backend at runtime
--   (backend/tasks.py, backend/tutor.py, backend/database.py), so each step is
--   guarded with to_regclass and skipped when the table does not exist yet.
--   The backend repeats the RLS/revoke step itself when it creates them.
--
-- WHY
--   These tables are served only through the FastAPI backend, which connects
--   as the table owner and bypasses RLS. With RLS on, no policy, and the
--   default anon/authenticated grants revoked, PostgREST cannot read or write
--   them with the public anon key or a user JWT.
--
-- VERIFY AFTERWARDS
--   select relname, relrowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname like any (array['workspace_%', 'tutor_%']);
--   Every row should show relrowsecurity = true, and
--   select grantee, table_name from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--     and (table_name like 'workspace_%' or table_name like 'tutor_%');
--   should return no rows.

-- ---------------------------------------------------------------------------
-- 1. RLS on, client grants off.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'workspace_tasks',
    'workspace_task_assignees',
    'workspace_task_checklist',
    'workspace_task_comments',
    'workspace_task_activity',
    'workspace_task_attachments',
    'workspace_group_milestones',
    'tutor_conversations',
    'tutor_messages'
  ]
  loop
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

-- ---------------------------------------------------------------------------
-- 2. Indexes (same names as the SQLAlchemy Table definitions, so the backend's
--    create_all and this file never create duplicates).
-- ---------------------------------------------------------------------------

do $$
begin
  -- Group task analytics: recent activity per group, newest first.
  if to_regclass('public.workspace_task_activity') is not null then
    create index if not exists ix_workspace_task_activity_group_created
      on public.workspace_task_activity (group_id, created_at);
  end if;

  -- Personal task list: owner's tasks that are not in a group.
  if to_regclass('public.workspace_tasks') is not null then
    create index if not exists ix_workspace_tasks_owner_group
      on public.workspace_tasks (owner_id, group_id);
  end if;

  -- Weekly XP, shared streaks, group activity and analytics all filter
  -- xp_events by student and time.
  if to_regclass('public.xp_events') is not null then
    create index if not exists ix_xp_events_student_created
      on public.xp_events (student_id, created_at);
  end if;

  -- Notification list: newest 30 for one recipient.
  if to_regclass('public.social_notifications') is not null then
    create index if not exists ix_social_notifications_recipient_created
      on public.social_notifications (recipient_id, created_at);
  end if;

  -- Friend lists and pending requests look up the recipient side; the unique
  -- constraint already covers (requester_id, recipient_id).
  if to_regclass('public.friendships') is not null then
    create index if not exists ix_friendships_recipient_status
      on public.friendships (recipient_id, status);
  end if;

  -- Blocks are read in both directions.
  if to_regclass('public.social_blocks') is not null then
    create index if not exists ix_social_blocks_blocked
      on public.social_blocks (blocked_id);
  end if;

  -- Social rate limits count one student's recent actions of one kind.
  if to_regclass('public.social_action_events') is not null then
    create index if not exists ix_social_action_events_student_action_created
      on public.social_action_events (student_id, action, created_at);
  end if;

  -- Friend quests are listed for either participant; friend_quests_members_idx
  -- (20260912) already leads with creator_id, so only the partner side is new.
  if to_regclass('public.friend_quests') is not null then
    create index if not exists ix_friend_quests_partner
      on public.friend_quests (partner_id);
  end if;

  -- Tutor sidebar: one owner's conversations, most recently updated first.
  if to_regclass('public.tutor_conversations') is not null then
    create index if not exists ix_tutor_conversations_owner_updated
      on public.tutor_conversations (owner_id, updated_at);
  end if;
end
$$;
