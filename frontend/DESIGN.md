# bindit design system

bindit binds scattered schoolwork into one connected system. The interface should feel like
good paper and a well-made binder: calm, precise, editorial, and fast. Speed and clarity come
before spectacle everywhere except the public landing hero.

## Principles

- **One sheet, one job.** Each screen has one obvious primary action (solid ink). Everything
  else is secondary (outlined) or ghost. Group related information in one sheet divided by
  hairline rules instead of many floating cards.
- **Color tells things apart.** Neutrals carry the layout. The violet "binder thread"
  (`--color-brand`) marks brand, selection, progress, and links. Course colors identify courses.
  Status colors (positive, warning, danger) carry meaning and always come with a word or icon.
  Nothing else is colored. No gradients, glows, blobs, or glass.
- **Editorial type.** Instrument Serif (`--font-serif`) for page titles, empty-state titles and
  a few statements. Inter for everything else. Serif is never used below 22px.
- **Quiet elevation.** Sheets use a 1px `--color-border` rule and no shadow. Only floating
  layers (menus, dialogs, drawers, toasts) cast `--shadow-popover`.
- **Modest shapes.** Radii: `--radius-xs` 4, `--radius-sm` 6 (small controls), `--radius-md` 8
  (buttons, inputs), `--radius-lg` 12 (sheets). Pills only for counts and tiny status chips.
- **Both themes.** Never hard-code a color in a component stylesheet; use tokens from
  `src/index.css`. If a token is missing, add it there for both `:root` and
  `:root[data-theme="dark"]`. Check every screen in both themes.
- **Real data only.** No fake metrics, testimonials, or placeholder numbers in the app.

## Tokens (src/index.css)

Surfaces: `--color-bg` (page ground), `--color-surface` (sheets), `--color-surface-raised`
(popovers), `--color-surface-sunken` (wells, skeletons, inset areas), `--color-surface-hover`,
`--color-surface-active`.
Rules: `--color-border`, `--color-border-strong` (inputs, hover).
Ink: `--color-text`, `--color-text-secondary`, `--color-text-tertiary`.
Action: `--color-accent` / `--color-accent-hover` / `--color-on-accent` (solid ink buttons).
Brand: `--color-brand`, `--color-brand-text`, `--color-brand-tint`, `--color-focus`.
Palette for identity: `--color-{blue,violet,green,orange,pink,teal,amber}` with `-text` and
`-tint`; apply with `.ui-tone--<hue>`, which sets `--tone`, `--tone-text`, `--tone-tint`.
Status: `--color-positive(-subtle)`, `--color-warning(-subtle)`, `--color-danger(-subtle)`.
Type scale: `--text-2xs` 11 · `--text-xs` 12 · `--text-sm` 13 · `--text-base` 14 · `--text-md` 15 ·
`--text-lg` 18 · `--text-xl` 22 · `--text-display` (page titles).
Motion: `--duration-instant` 80ms · `--duration-fast` 140ms · `--duration-base` 220ms with
`--ease-standard` / `--ease-out`. Animate only `opacity` and `transform` (and colors on hover).

## Primitives (src/styles/ui.css)

Page frame `.ui-page`, `.ui-page-header` (title block + primary action, ruled underneath),
`.ui-eyebrow`, `.ui-page-title` (serif), `.ui-page-subtitle`.
Sheets `.ui-panel`, `.ui-card`; rows `.ui-list` / `.ui-row`.
Buttons `.ui-button` (secondary), `--primary` (ink, once per view), `--ghost`, `--danger`, `--sm`,
`.is-busy`. Links `.ui-link`.
Fields `.ui-field`, `.ui-input`, `.ui-select`, `.ui-textarea`, `.ui-checkbox`.
Navigation `.ui-tabs` / `.ui-tab`, `.ui-segmented` / `.ui-segmented__item` (use `aria-selected`
or `aria-pressed`).
Feedback `.ui-skeleton`, `.ui-spinner` (inline only, never full-page), `.ui-alert`
(error with a recovery button), `.app-toast` (transient status, optional Undo).
Data `.ui-stats` / `.ui-stat` (one ruled sheet), `.ui-meter`, `.ui-badge(--tone|--course|...)`,
`.ui-avatar`, `.ui-course-mark` (set `--course` inline), `.ui-course-row`.
Empty states `.ui-empty`, `.ui-empty__mascot`, `.ui-empty__title` (serif), `.ui-empty__copy`.

## States

- **Loading:** skeletons shaped like the final layout. Render cached data first and refresh in
  the background. Never block a page on secondary data. No full-page spinners.
- **Empty:** say what the area is for and give the one action that fills it. The otter mascot
  appears only in first-run empty states, achievements and streak celebrations.
- **Error:** say what failed in plain words and offer a recovery action (Try again, Undo).
- **Success:** a short toast; prefer Undo over confirmation dialogs. Confirm only truly
  destructive, non-undoable actions.
- **Optimistic updates** where a failure can be rolled back; on failure restore the previous
  value and say so.

## Layout

Desktop: 236px navigation rail + content up to 1240px. Phones (≤860px): top bar, bottom tab bar
(Home, Study, Tasks, Tutor, Menu) and a menu sheet. Leave 64px + safe-area at the bottom of
pages on phones. Never force tiny horizontal columns on a phone; switch to one column, a
segmented picker, or a stacked list. Use container queries for components that sit beside
other panels.

## Accessibility

Semantic landmarks and headings, a visible `:focus-visible` ring on everything interactive,
labels on every control (visible or `aria-label`), text contrast ≥ 4.5:1 in both themes,
keyboard access for every action (drag and drop always has a button alternative), and
`prefers-reduced-motion` respected (global rule in index.css).

## The landing page

The public landing page is the one place for spectacle: the Three.js "knowledge constellation"
in `components/landing/Constellation*`. It is lazy-loaded, paused when hidden, reduced on weak
devices, replaced by a static SVG under reduced motion or without WebGL, and never imported by
the signed-in app.
