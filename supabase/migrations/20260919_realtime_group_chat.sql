create table if not exists public.study_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id varchar(32) not null references public.study_groups(id) on delete cascade,
  sender_id varchar(100) not null references public.profiles(student_id) on delete cascade,
  body varchar(2000) not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists study_group_messages_group_created_idx
  on public.study_group_messages (group_id, created_at desc);

alter table public.study_group_messages enable row level security;

drop policy if exists "Members read group messages" on public.study_group_messages;
create policy "Members read group messages" on public.study_group_messages
  for select to authenticated using (
    exists (
      select 1 from public.study_group_members m
      where m.group_id = study_group_messages.group_id
        and m.student_id::text = auth.uid()::text
    )
  );

drop policy if exists "Members send group messages" on public.study_group_messages;
create policy "Members send group messages" on public.study_group_messages
  for insert to authenticated with check (
    sender_id::text = auth.uid()::text
    and exists (
      select 1 from public.study_group_members m
      where m.group_id = study_group_messages.group_id
        and m.student_id::text = auth.uid()::text
    )
  );

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.study_group_messages;
    exception
      when duplicate_object then null;
    end;
  end if;
end
$$;
