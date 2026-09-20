-- Cross-device unread counts, read receipts, and short-lived typing state.

create table if not exists public.study_group_chat_reads (
  group_id varchar(32) not null references public.study_groups(id) on delete cascade,
  student_id varchar(100) not null references public.profiles(student_id) on delete cascade,
  last_read_at timestamptz not null default timezone('utc', now()),
  primary key (group_id, student_id)
);

create table if not exists public.study_group_chat_typing (
  group_id varchar(32) not null references public.study_groups(id) on delete cascade,
  student_id varchar(100) not null references public.profiles(student_id) on delete cascade,
  display_name varchar(80) not null default 'Group member',
  typing_until timestamptz not null,
  primary key (group_id, student_id)
);

alter table public.study_group_chat_reads enable row level security;
alter table public.study_group_chat_typing enable row level security;

drop policy if exists "Members view group read state" on public.study_group_chat_reads;
create policy "Members view group read state" on public.study_group_chat_reads
  for select to authenticated using (
    exists (
      select 1 from public.study_group_members member
      where member.group_id = study_group_chat_reads.group_id
        and member.student_id::text = auth.uid()::text
    )
  );

drop policy if exists "Members update own read state" on public.study_group_chat_reads;
create policy "Members update own read state" on public.study_group_chat_reads
  for insert to authenticated with check (
    student_id::text = auth.uid()::text
    and exists (
      select 1 from public.study_group_members member
      where member.group_id = study_group_chat_reads.group_id
        and member.student_id::text = auth.uid()::text
    )
  );

drop policy if exists "Members change own read state" on public.study_group_chat_reads;
create policy "Members change own read state" on public.study_group_chat_reads
  for update to authenticated using (student_id::text = auth.uid()::text)
  with check (student_id::text = auth.uid()::text);

drop policy if exists "Members view group typing state" on public.study_group_chat_typing;
create policy "Members view group typing state" on public.study_group_chat_typing
  for select to authenticated using (
    exists (
      select 1 from public.study_group_members member
      where member.group_id = study_group_chat_typing.group_id
        and member.student_id::text = auth.uid()::text
    )
  );

drop policy if exists "Members insert own typing state" on public.study_group_chat_typing;
create policy "Members insert own typing state" on public.study_group_chat_typing
  for insert to authenticated with check (
    student_id::text = auth.uid()::text
    and exists (
      select 1 from public.study_group_members member
      where member.group_id = study_group_chat_typing.group_id
        and member.student_id::text = auth.uid()::text
    )
  );

drop policy if exists "Members update own typing state" on public.study_group_chat_typing;
create policy "Members update own typing state" on public.study_group_chat_typing
  for update to authenticated using (student_id::text = auth.uid()::text)
  with check (student_id::text = auth.uid()::text);

create or replace function public.get_group_chat_unread_counts()
returns table (group_id varchar, unread_count bigint, last_message_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select
    membership.group_id,
    count(message.id) filter (
      where message.sender_id::text <> auth.uid()::text
        and message.created_at > coalesce(read_state.last_read_at, to_timestamp(0))
    ) as unread_count,
    max(message.created_at) as last_message_at
  from public.study_group_members membership
  left join public.study_group_chat_reads read_state
    on read_state.group_id = membership.group_id
   and read_state.student_id = membership.student_id
  left join public.study_group_messages message
    on message.group_id = membership.group_id
  where membership.student_id::text = auth.uid()::text
  group by membership.group_id, read_state.last_read_at;
$$;

grant execute on function public.get_group_chat_unread_counts() to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.study_group_chat_reads;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.study_group_chat_typing;
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
