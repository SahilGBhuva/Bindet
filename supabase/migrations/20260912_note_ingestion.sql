-- Uploaded study notes. The backend (backend/note_store.py) also creates this
-- table on first start, with the same column types as below: id varchar(36)
-- and student_id varchar(100). student_id holds a Supabase user id or a guest
-- id, so it is not a foreign key to auth.users.
--
-- Notes are written only by the backend, which validates size, course and
-- unit. The owner may read their own notes through the API; nothing else.
-- The text casts work whether student_id is varchar (backend-created) or
-- uuid (created by an older copy of this file).
--
-- Safe to re-run.

create table if not exists study_notes (
  id varchar(36) primary key,
  student_id varchar(100) not null,
  course varchar(120) not null,
  unit varchar(160) not null,
  file_name varchar(255) not null,
  content_type varchar(100) not null default '',
  text text not null,
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists study_notes_student_unit_idx
  on study_notes (student_id, course, unit, created_at desc);

alter table study_notes enable row level security;

drop policy if exists "Students own study notes" on study_notes;
create policy "Students own study notes" on study_notes
  for select to authenticated using (auth.uid()::text = student_id::text);
