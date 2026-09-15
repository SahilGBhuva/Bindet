# CLAUDE.md

Standing rules for this repository. These apply to every session unless Sahil overrides them explicitly.

## Brand

- The consumer-facing brand is always lowercase **`bindit`** in UI text. Never "Bindit", "BindIt", or "Bindet".
- The GitHub repo is named `Bindet`. **Do not rename the repo.**
- Clean up stale **"Numi"** branding in user-facing text and in the Vercel project link where it is safe to do so.
- Do **not** rename technical identifiers, environment variables, database columns, table names, or URLs if renaming risks breaking something. Cosmetic branding fixes must never become a migration.

## Design direction

The authenticated app (dashboard, courses, notes, flashcards, quizzes, friends, groups) uses a **light, colorful, friendly** visual style. It replaces the earlier dark, minimal direction entirely. Color is used to **tell things apart** (courses, stats, card types, people), not to decorate at random.

Tokens live in `frontend/src/index.css`; shared components live in `frontend/src/styles/ui.css`. Reuse them rather than hard-coding colors.

- **Base:** near-white page background, white bordered cards, dark navy text. Body text stays plain navy.
- **Primary blue** (`--color-accent`) is for links, active states, and the main action.
- **Color system:** seven hues (blue, violet, green, orange, pink, teal, amber). Each hue has three tokens:
  - `--color-<hue>` for fills: meters, borders, and badges behind white text.
  - `--color-<hue>-text` for text and icons. It is at least 4.7:1 on its tint and on white.
  - `--color-<hue>-tint` for light backgrounds.
  - Apply a hue to a component with the `ui-tone--<hue>` classes, which set `--tone`, `--tone-text` and `--tone-tint`.
- **Contrast:** text on any tinted background must stay at least 4.5:1, or 3:1 for large text. Check it when adding a tint or changing a shade.
- **Page titles:** blue-to-violet gradient text (`--gradient-brand`), with a navy fallback.
- **Progress and quest bars:** filled with the same blue-to-violet gradient.
- **Stat cards:** each stat is its own tinted card with a colored icon and a colored value.
  - Daily goal and level: blue.
  - Streak: orange with a flame icon.
  - XP: violet.
  - Accuracy: green at 70% or above, amber below.
  - Friends: pink.
- **Courses:** every course has a saturated color from `COURSE_TONES` in `frontend/src/lib/session.ts`. These colors are dark enough for white text.
  - Show a course with a colored initial badge (`ui-course-mark`), not a tiny dot.
  - Mark course rows with a colored left edge (`ui-course-row`) or a light tint of the course color.
  - Flashcards are tinted in their course's color, with the Question/Answer label in that color.
- **Card icons:** feature cards (Goals, Games, More and similar) put a 48px icon above the heading. Each card gets its own hue on a matching tint (`ui-icon` inside a `ui-tone--<hue>` card). Don't give every card the same color.
- **People:** avatars get a stable color per name (`toneForName` in `frontend/src/lib/tones.ts`).
- **Buttons:** pill-shaped, with white text.
  - Primary: solid blue with a soft blue shadow.
  - Secondary: solid dark.
  - Ghost: only for low-emphasis actions inside dense lists (Remove, Decline, Clear).
- **Cards:** bordered, generous padding, moderate corner radius (not full pills). A small icon or short label sits above a heading and description.
- **Icons:** welcome where they clarify meaning. Keep them simple line icons in a single color (the tone color).
- **Typography:** bold, large headings. Clean, readable, never condensed.
- **Density:** this is a study tool, not a one-page marketing site. Navigation, tables and lists stay information-dense; color adds energy without changing layout.

**Browser requirement — do not strip:** tints are built with CSS `color-mix()` (Chrome 111+, Safari 16.2+, Firefox 113+). Gradient titles use `background-clip: text` inside an `@supports` block. Both are intentional. Older browsers fall back to untinted surfaces and navy titles. Don't replace them with hard-coded hex values or remove them as "unsupported".

**Mascot:** preserve the bindit mascot and use it deliberately. Use the transparent cutout `/bindit-mascot-cutout.webp` (240×288, generated from `bindit-mascot.webp`, which has a white background). Don't go back to the white-background file, and don't use `mix-blend-mode` tricks.
- **Empty states:** full figure at 120px wide (`ui-empty__mascot`) for no courses, no notes, and no friends.
- **Streaks:** a small 36px cheering mascot (`ui-mascot-cheer`) on the streak card when a streak reaches 7+ days.
- **Elsewhere in the app:** only the small brand mark in the sidebar.
- **Landing and auth screens:** larger uses are fine there (see below).

### Logged-out landing page and auth screens

The landing page (`frontend/src/components/Landing.tsx` / `Landing.css`) and the sign-in, sign-up and confirm screens (`AuthGate.tsx` / `GuestAuth.css`) are **expressive, animated, gradient-heavy, and more energetic than the app**. The old dark/cinematic style is retired. They use the same light theme and color tokens, turned up.

- **Hero:** full-viewport, with a huge headline in a seven-color spectrum gradient and a large floating mascot over soft drifting color blobs. Two pill CTAs: a gradient primary and an outlined secondary.
- **Live demo:** the real Home, Tools, Progress and Profile pages, in a browser frame with a colored shadow and a desktop scroll tilt. It's interactive on screens wider than 860px and a static render on phones.
  - **Sandboxed data:** the pages run on an in-memory sandbox (`components/demo/demoData.ts`) provided through the data source (`lib/dataSource.ts`). Study pages must get storage, API, clock and confirm calls from `useData()`, never import them directly, or the demo will leak.
  - **Isolation rule:** no network requests and no reads or writes of the visitor's storage from the demo.
  - **Allowed interactions:** `components/demo/LivePreview.tsx` allowlists safe controls (navigation, course/unit/view switching, flashcards, quiz choices, Progress controls, group tabs). Every other control (create, upload, rename, delete, share, settings) opens sign-up with the action as the reason.
  - **When adding controls:** a new control inside these pages is locked by default. Add it to the allowlist only if it can't create, change or send anything.
  - **Keep it real:** keep the demo the real components; don't replace it with a screenshot or a fake mockup.
- **Sections:** colored feature cards that lift with a matching glow, a stats band with gradient count-up numbers, how-it-works steps on a gradient line, and a full-width gradient final CTA.
- **Stats honesty:** the stats band shows the demo student's numbers and says so. Don't present made-up usage numbers as real.
- **Motion:** entrance and scroll-reveal animations use only `transform` and `opacity`. Blobs move by `transform` only, with no `filter: blur`.
  - Everything is disabled under `prefers-reduced-motion`.
  - Keep Lighthouse performance above 80 on mobile.
- **Auth screens:** same light theme, gradient heading, blob background, and a small mascot on the card corner.

The landing page's louder treatment stays on the logged-out pages. The authenticated app keeps the calmer rules above.

## Security

- **Never commit secrets.**
- **Never** put server-only keys in frontend code. This specifically includes `SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY`. Frontend may only ever hold the Supabase anon/publishable key.

## Git and deployment

- **Do not push, force-push, merge, or deploy without explicit approval from Sahil in this session.**
- Work on a feature branch, not directly on `main`, unless told otherwise.
- Commit after each completed fix, with a clear message.

## Database

- **Do not run destructive Supabase migrations or delete data without explicit approval from Sahil.**

## Working style

- Prefer incremental fixes over rewrites.
- Before changing a shared component or a schema, find **every** place that uses it first.
