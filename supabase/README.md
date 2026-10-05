# Supabase database

The backend (`backend/`) creates most tables itself the first time it starts
(`metadata.create_all` in `database.py`, `questions.py`, `tasks.py`,
`tutor.py` and `note_store.py`). The files in `migrations/` add what the
backend does not: row level security policies, chat tables, triggers, storage
policies and grant changes. They are not applied automatically.

## Apply order

1. Start the backend once against the database (`DATABASE_URL`), so its tables
   exist.
2. In the Supabase SQL editor, run every file in `migrations/` in filename
   order, oldest first. Each file is idempotent and safe to re-run.

Migrations do not work on an empty database: `20260911` needs
`student_progress`, and the chat migrations (`20260919`, `20260920_*`) need
`study_groups` and `study_group_members`, which only the backend creates.
`schema.sql` is not enough on its own for the same reason.

When the backend later creates a new table, Supabase gives it the default
`anon` / `authenticated` grants. Re-run the migrations (at least
`20261003` onwards) after any backend release that adds tables. Always run
through to the newest file: re-running `20260920_chat_presence_and_receipts.sql`
on its own adds the read-receipt and typing tables back to Realtime, and
`20261005` removes them again.

### Newest migrations

- `20261003_security_hardening.sql`: RLS on every public table, read-only
  notes, chat membership checks, typing-state clamping, chat flood limit.
- `20261004_tasks_and_tutor_rls.sql`: task and tutor tables closed to the
  API; indexes.
- `20261005_security_hardening_2.sql` (new): strict chat attachment paths,
  rate-limit trigger that cannot be used to probe other users, Realtime
  limited to chat messages, and client grants trimmed to what
  `frontend/src/lib/chat.ts` uses.

## Verify

Every public table should have RLS on:

```sql
select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1;
```

After `20261005`, only these client grants should remain (no `anon` rows):

```sql
select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
group by 1, 2 order by 1, 2;
```

| table | authenticated |
| --- | --- |
| `profiles` | SELECT |
| `study_group_chat_reads` | INSERT, SELECT, UPDATE |
| `study_group_chat_typing` | INSERT, SELECT, UPDATE |
| `study_group_members` | SELECT |
| `study_group_messages` | INSERT, SELECT |
