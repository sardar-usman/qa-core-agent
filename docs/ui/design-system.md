# QA-Core dashboard design system

One calm, consistent system on every page, for CTOs, QA managers and CEOs. Locked by `scripts/smoke-design-system.ts` and CLAUDE.md invariant 68. Layout is not part of this document: pages keep their sections, order and components.

## Type scale

Exactly seven sizes, defined as the whole `theme.fontSize` in `dashboard/tailwind.config.ts` (Tailwind's defaults do not exist). Nothing on screen is below 12px, chart SVG text included.

| Name | Size / line height | Letter spacing | Class |
|---|---|---|---|
| display | 32 / 40 | -0.02em | `text-display` |
| title | 24 / 32 | -0.02em | `text-title` |
| heading | 18 / 26 | -0.01em | `text-heading` |
| subheading | 16 / 24 | 0 | `text-subheading` |
| body | 14 / 22 | 0 | `text-body` |
| small | 13 / 20 | 0 | `text-small` |
| caption | 12 / 16 | 0 | `text-caption` |

Weights: 400 (`font-normal`), 500 (`font-medium`), 600 (`font-semibold`) only. No bold, extrabold, light or `<b>`.

Families: Plus Jakarta Sans for all UI text and numbers (tabular figures on, `.money`); Geist Mono only for run ids, commands and code, at 13px (`.mono`).

The seven names are registered with tailwind-merge in `dashboard/src/lib/utils.ts`, so a size class never knocks out a colour class.

## Role map

Applied by role, never by find-and-replace of class names.

| Role | Size | Weight | Colour |
|---|---|---|---|
| Page headline sentence (Projects) | display | 600 | fg |
| Page title (h1 on every other page, the project name) | title | 600 | fg |
| Key metric number (tiles, the run hero, the card's "tests ready") | title | 600, tabular | fg (violet only for a findings count) |
| Section heading (h2, stage panels, collapsible sections) | heading | 600 | fg |
| Card title, dialog title, findings section title | subheading | 600 | fg |
| Body text, table cells, nav items, buttons, inputs | body | 400 text; 500 nav, buttons, a table's first column | fg |
| Secondary text (URLs, helper text, timestamps, tooltips) | small | 400 | fg-2 |
| Labels, table headers, badges, pills, chart axes, stage status | caption | 500 | fg-2 labels; fg-3 table headers, sentence case |
| Eyebrow (the one uppercase label, Projects) | caption | 500 | brand |

Text colours are fg, fg-2 and fg-3 only. Status colours (pass, rework, reject, finding, neutral) appear only where they mean a status: a verdict, a run status, a finding, a stage status. Brand is for the primary action, the active nav item and links. One filled primary button per view of page content (the sidebar's "Run a test" is the frame's primary and reads as the active destination on its own page). Money is plain text, never a colour: the cost token only fills the cost-split bar.

## Spacing, radius, sizes

- 4px grid. Spacing steps 1, 2, 3, 4, 5, 6, 8, 10, 12, 16 only: no half steps (1.5, 2.5) and no arbitrary values for padding, margin, gap, text, tracking or leading. Layout widths (a sidebar width, a grid template, a column percentage) may stay arbitrary.
- Page padding 32 (16 at 390). Card padding 24. Gap between sections 32.
- Radius: lg 12 (cards), md 8 (buttons, inputs; also the default `rounded`), sm 6 (badges), full for pills. No xl.
- Buttons 36px tall (32 for small). Inputs 36. Table header row 36, body rows at least 44 (12px padding over a 20px line). Numbers right-aligned in tables. Row hover bg-2, no zebra.
- Icons 16 in body, 14 in caption, 20 in page headers (`h-4`, `h-3.5`, `h-5`).
- Shadows only on hover (`card-lift`) and popovers (`shadow-lift`).

## Formatter rules (`dashboard/src/lib/format.ts`)

The one formatter module. It formats the values the server sent and never computes one (standing rule 3). A missing value reads "n/a", never 0 or $0.00 (standing rule 2).

- `formatMoney(v)`: "n/a" for null, undefined or NaN; "<$0.01" above 0 and below 0.005; otherwise 2 decimals ("$6.69"), everywhere, the run hero and the stage view included. The exact value goes in a tooltip through `exactMoney(v)`, which reads "not recorded" for a missing value.
- `formatDate(iso)`: fixed en-GB locale, never the browser's: "5 Oct", "5 Oct 2025" in another year, "Today, 14:05" for today, 24-hour. Missing or invalid reads "n/a". `formatDateTime(iso)` gives the full date and time for a tooltip; `formatTime(iso)` a time of day for an event row.
- `formatCount(n, singular, plural)`: "1 test", "12 tests"; null reads "n/a". Every count on screen goes through it (this is what fixed "1 tests shipped").
- `pct(v)` and `duration(start, end)` as before, except that a missing value reads "n/a". `formatSize(bytes)` for file sizes.
- No `toLocale*` call outside this module.

## Copy that is part of the system

- A last run that is not completed shows the pill "Stopped early" (or "Empty run", "Run failed"); the pill's tooltip carries the full LABEL text ("Last run stopped, checkpoint kept").
- Table headers are sentence case; the only uppercase text is the Projects eyebrow.

## Specimen

`docs/ui/design-system/specimen-light.png` and `specimen-dark.png` show every size and role in both themes, rendered from the built app's own CSS.
