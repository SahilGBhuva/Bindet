# bindet backend

The FastAPI service behind bindet: notes, flashcards, review, quizzes and practice tests, Otto the tutor, study guides, friends, groups and tasks. It runs as a Vercel function in production and with uvicorn locally.

## Start locally

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # fill in Supabase and OpenRouter settings
uvicorn main:app --reload
```

API: http://127.0.0.1:8000. Interactive docs are at `/docs` locally; they are turned off in production.

Without `DATABASE_URL` the backend uses a local SQLite file (`BINDIT_DB_PATH`, default `backend/bindit.db`). Production refuses to start without a PostgreSQL `DATABASE_URL`, because a SQLite file on serverless storage loses its writes.

## Modules

| File | What it does |
| --- | --- |
| `main.py` | Routes, request limits, the AI budget and the time-zone middleware |
| `auth.py` | Verifies Supabase sign-in tokens, owner and admin checks, temporary-email refusal |
| `database.py` | Tables, progress, XP, streaks, friends, rate limits |
| `note_ingestion.py`, `note_store.py` | Reading uploaded files and storing notes per course and unit |
| `ai_tutor.py` | Every model call: prompts, streaming, grounding checks |
| `ai_cache.py` | Caches AI results by a hash of the exact input |
| `flashcards.py`, `review.py` | Flashcard decks and spaced review |
| `practice.py`, `practice_tests.py`, `questions.py` | Practice lab rounds, timed tests, the question bank |
| `tutor.py`, `otto.py` | Otto conversations, memory and personality |
| `study_guides.py` | Study guides written from a unit's notes |
| `tasks.py` | Personal and group tasks, milestones, group statistics |
| `help_bot.py` | The in-app help bot with strict limits |
| `account_deletion.py` | Deletes a student's data, images and login |

## Tests

```bash
python -m pytest -q
```

Each module has a `test_*.py` beside it. Tests run on SQLite with the AI faked, so they need no keys.
