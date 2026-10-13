-- Storage and chat hardening. Safe to run more than once; nothing is deleted.
--
-- 1. The backend stores avatars and private images in `student-images` with the service
--    role and only ever hands out short-lived signed links (backend/storage.py). Declare
--    the bucket here and make sure it is private, so its contents can't be fetched by path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-images', 'student-images', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = false;

-- 2. Chat attachment names are shown as alt text to every group member; cap their length.
--    NOT VALID skips checking old rows, so this can't fail on existing data.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'study_group_messages_attachment_name_len'
  ) then
    alter table public.study_group_messages
      add constraint study_group_messages_attachment_name_len
      check (attachment_name is null or char_length(attachment_name) <= 255) not valid;
  end if;
end $$;
