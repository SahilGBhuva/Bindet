# CLAUDE.md

Standing rules for this repository. These apply to every session unless Sahil overrides them explicitly.

## Brand

- The consumer-facing brand is always lowercase **`bindet`** in UI text, even at the start of a sentence. Never "Bindet", "bindit" or "Bindit" (Sahil renamed it from "bindit" on 2026-10-07).
- The AI tutor is **Otto**, the bindet otter ("Ask Otto", "Otto, your tutor").
- Older technical names that still say `bindit` (storage keys such as `bindit:` and `bindit-`, CSS classes such as `bindit-rail`, logger names, image files such as `bindit-mascot-cutout.webp`, events) stay as they are: renaming them would sign people out or lose their saved settings.
- The GitHub repo is named `Bindet`. **Do not rename the repo.**
- Clean up stale **"Numi"** branding in user-facing text and in the Vercel project link where it is safe to do so.
- Do **not** rename technical identifiers, environment variables, database columns, table names, or URLs if renaming risks breaking something. Cosmetic branding fixes must never become a migration.

## Design direction

The whole product (signed-in app, landing page and auth screens) follows the paper-and-ink system documented in **`frontend/DESIGN.md`** (October 2026 redesign). Read it before changing any screen. In short:

- Tokens live in `frontend/src/index.css` (light and dark themes); shared primitives live in `frontend/src/styles/ui.css`. Never hard-code colors in component CSS.
- Neutrals carry the layout; the violet binder thread (`--color-brand`) marks brand, selection and progress; course colors identify courses; status colors carry meaning. No gradients, glows, blobs or glass.
- Instrument Serif for page titles and editorial moments, Inter for the interface.
- One solid-ink primary action per view; sheets with hairline rules instead of floating cards.
- Cached data renders first; skeletons match final layouts; errors offer a recovery action.

**Browser requirement — do not strip:** tints use CSS `color-mix()` and some components use container queries. Both are intentional.

**Mascot:** use the transparent cutout `/bindit-mascot-cutout.webp` (240×288). Only in first-run empty states, achievements/streak moments, the tutor welcome, and a few deliberate landing appearances. Never as decoration in dense screens.

### Logged-out landing page

- The landing page (`frontend/src/components/Landing.tsx` and `components/landing/`) is lazy-loaded by `AuthGate` so signed-in students never download it, and its Three.js hero is loaded only after the page content.
- **Sandboxed demo:** the demo pages run on the in-memory sandbox (`components/demo/demoData.ts`) through `lib/dataSource.ts`. Study pages that appear in the demo must get storage, API, clock and confirm calls from `useData()`. No network requests or visitor storage access from the demo. New controls inside demo pages are locked by default (`components/demo/LivePreview.tsx` allowlist).
- **Honesty:** numbers on the page come from the demo student and say so. No fake testimonials, metrics or partners.
- **Motion** explains the product, uses only transform/opacity/stroke properties, pauses when hidden, and is disabled under `prefers-reduced-motion`.

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
