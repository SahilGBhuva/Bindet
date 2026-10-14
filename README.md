# bindet

**Everything you're learning, bound together.** bindet is a study workspace for high school students. You file your class notes into courses and units, and bindet turns them into flashcards, quizzes, practice tests and study guides. Otto, an AI tutor, has read your notes. Friends keep each other going with shared streaks, a weekly league and study groups.

Live: **https://bindet-learn.vercel.app**

Built by Sahil Bhuva, Bryan Chen, Xingchen Song and Aryaman for the 2026 Congressional App Challenge.

## What it does

| Area | What a student can do |
| --- | --- |
| Notes | Add notes as a photo of handwriting, a PDF, a Word doc or pasted text. Each note is filed under a course and unit. A vision model reads photos and scanned PDFs. |
| Flashcards and review | Every unit builds a deck from its own notes. Spaced review brings back cards you miss sooner. |
| Quizzes and practice tests | Questions are written from the unit's notes. Written answers are graded with an explanation. |
| Otto, the tutor | Ask about a course and unit. Otto answers from your notes first and names the file it used. It guides you through homework instead of handing over answers, and can turn notes into a study guide. |
| Progress | Every unit gets a mastery score from your quiz history, so you can see what is sharp and what is stuck. |
| Friends and groups | Daily streaks, friend streaks, a weekly league, friend quests, and study groups with chat and a shared task board. |

## How it is built

```
Browser (React + TypeScript, Vite)
   │  /api/*  with the student's sign-in token
   ▼
FastAPI backend (Python) ── OpenRouter ── Gemini Flash Lite (text, photos), Mistral OCR (scanned PDFs)
   │
   ▼
Supabase: Postgres database, Auth, Storage, Realtime (group chat)
```

- **Frontend** (`frontend/`):
  - React 19, TypeScript and Vite, with hash routes and no UI framework.
  - Pages are split into chunks that load on demand.
  - The logged-out landing page runs the real app on an in-memory demo student, so visitors can try it without an account.
- **Backend** (`backend/`): a FastAPI app (`main.py`, 103 routes) with one module per feature: `note_ingestion.py`, `flashcards.py`, `review.py`, `practice_tests.py`, `tutor.py`, `otto.py`, `study_guides.py`, `tasks.py` and `help_bot.py`.
- **Database:** Postgres on Supabase in production; SQLite for local development and tests. Schema changes live in `supabase/migrations/`.
- **Hosting:** Vercel serves the frontend and runs the backend as a function (`vercel.json`).

### Design choices worth knowing

- **Answers stay grounded.**
  - Flashcards whose answers don't share enough words with the note are dropped (`ai_tutor.is_grounded`).
  - Otto is given only the student's notes for the chosen unit, each labelled with its file name (`note_store.context_for`).
- **AI cost is controlled.**
  - Results are cached by a hash of the exact input (`ai_cache.py`).
  - Small talk gets a fixed reply without calling a model.
  - Every student has daily limits, and the whole site has a daily budget. One email inbox can use at most 2% of that budget.
  - Temporary-email accounts are refused (`disposable_email.py`).
- **Streaks use the student's own day.** The browser sends its time-zone offset, and the server counts days in that time zone (`database.local_today`).

## Security and privacy

- **Sign-in:** every request is verified with Supabase Auth (`auth.py`), and every query filters by the signed-in student's id.
- **Group chat:** protected by row-level security in Postgres.
- **Keys:** server-only keys (the Supabase service role, OpenRouter) never reach the browser. The browser only ever holds the public Supabase key.
- **Headers:** `vercel.json` sets strict security headers: Content Security Policy, HSTS, `X-Frame-Options: DENY`, and a Permissions-Policy.
- **Uploads:** size-limited, checked by their real bytes, and parsed in a time-limited child process.
- **Account deletion:** students can delete their account and all of its data from Settings.

## Run it locally

You need Python 3.12+ and Node 22+.

```bash
./run-dev.sh
```

This creates the backend virtualenv, installs packages, and starts the API on http://127.0.0.1:8000 and the app on http://127.0.0.1:5173.

To sign in and use the AI features, copy `backend/.env.example` to `backend/.env` and fill in the Supabase and OpenRouter settings. Without them, the landing page and its live demo still work.

## Tests

```bash
cd backend && python -m pytest -q        # about 700 tests
cd frontend && npx tsc -b && npm run lint && npm run build
```

GitHub Actions runs the backend tests and the frontend type check, lint and build on every push (`.github/workflows/ci.yml`).

## Project layout

```
frontend/src/pages        one file per screen (Home, Tools = Study, Tutor = Otto, Goals = Tasks, ...)
frontend/src/components   shared UI, the landing page, the demo sandbox, Otto's chat parts
frontend/src/lib          API client, auth, caching, and small pure helpers
backend/                  FastAPI app, one module per feature, test_*.py beside them
supabase/migrations/      database schema and security policies
```

## How we used AI

We used AI coding tools (Claude Code and OpenAI Codex) for parts of the code, tests and reviews. Inside the app, bindet calls AI models through OpenRouter. Our full disclosure is in our Congressional App Challenge submission.
