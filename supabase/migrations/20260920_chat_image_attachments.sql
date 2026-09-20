-- Private image attachments for study-group chat.
-- Object paths are: group_id/user_id/random-id-filename.ext

alter table public.study_group_messages
  alter column body drop not null,
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size integer;

alter table public.study_group_messages
  drop constraint if exists study_group_messages_body_check;

alter table public.study_group_messages
  add constraint study_group_messages_content_check check (
    char_length(trim(coalesce(body, ''))) between 1 and 2000
    or attachment_path is not null
  ),
  add constraint study_group_messages_attachment_check check (
    attachment_path is null
    or (
      attachment_name is not null
      and attachment_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      and attachment_size between 1 and 10485760
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study-group-images',
  'study-group-images',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Group members can view chat images" on storage.objects;
create policy "Group members can view chat images"
on storage.objects for select
to authenticated
using (
  bucket_id = 'study-group-images'
  and exists (
    select 1 from public.study_group_members member
    where member.group_id::text = (storage.foldername(name))[1]
      and member.student_id = auth.uid()::text
  )
);

drop policy if exists "Group members can upload chat images" on storage.objects;
create policy "Group members can upload chat images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'study-group-images'
  and (storage.foldername(name))[2] = auth.uid()::text
  and exists (
    select 1 from public.study_group_members member
    where member.group_id::text = (storage.foldername(name))[1]
      and member.student_id = auth.uid()::text
  )
);

drop policy if exists "Uploaders can delete their chat images" on storage.objects;
create policy "Uploaders can delete their chat images"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'study-group-images'
  and (storage.foldername(name))[2] = auth.uid()::text
);
