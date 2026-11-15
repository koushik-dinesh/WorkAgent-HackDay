# WorkAgent — UI/UX redesign audit and plan

Status of each phase is tracked in the [Progress log](#progress-log) at the end of this file.

## 1. Current state (before the redesign)

**Stack.** React 19, React Router 8, Tailwind CSS v4 (Vite plugin, no config file), Vitest + Testing Library.
No icon library, no chart library, no font — system UI font, glyph characters (`☰ ☀ ☾ ✕ × 🎙 ⚠ ↗ ←`) used as icons.
No lint script exists in `frontend/package.json`.

**Baseline.** `npm test`: 19 files, 156 tests passing. `npm run build`: passing.

**Routes (39).**

| Area | Routes |
| --- | --- |
| Public | `/login`, `/accept-invitation` |
| Admin only | `/admin`, `/admin/meetings`, `/admin/meetings/new`, `/admin/meetings/:id`, `/admin/users`, `/admin/integrations`, `/admin/integrations/teams-mock`, `/admin/integrations/:id`, `/admin/operations`, `/admin/kpi`, `/actions/settings`, `/integrations/:provider/setup` |
| Employee + manager | `/my/tasks`, `/my/tasks/:id` |
| Admin + manager | `/suggestions` |
| Every role | `/projects`, `/projects/:id`, `/teams`, `/activity`, `/records/:id`, `/search`, `/insights`, `/notifications`, `/profile`, `/assistant`, `/assistant/:id`, `/meetings/schedule`, `/meetings/scheduled`, `/meetings/scheduled/:id`, `/groups`, `/duplicates`, `/duplicates/:id`, `/my/kpi`, `/kpi/teams/:id`, `/kpi/hr`, `/digests`, `/digests/:id`, `/actions`, `/actions/:id`, `/approvals` |

**Shared components.** `components/ui.jsx` (Button, Field, ErrorAlert, SuccessAlert, Loading, Card, StatusBadge, `inputClass`),
`EmptyState`, `AppShell`, `AssistantDock`, `NotificationBell`, `records.jsx` (ProviderBadge, RecordLink, SourceLink),
`actions/labels.jsx` (LifecycleBadge), `tasks/TaskStatus.jsx`, `ActivityList`, `RelatedRecords`.

**Theme.** Light theme is raw Tailwind `slate-*` utilities in every file. Dark theme is a block of
`html.dark .bg-white { … }` overrides in `index.css` that re-maps individual utility classes one by one.

## 2. Problems found

### Design system
- No tokens: colours are literal `slate/red/amber/emerald/sky/violet` utilities repeated in ~60 files. Dark mode works only for the
  classes someone remembered to override; any new utility (e.g. `bg-violet-50`, `bg-rose-100`, `bg-sky-50`) is unthemed in dark mode.
- No typeface, no type scale: page titles are `text-2xl` on most pages but `text-xl` on Notifications, Profile, Login.
- Status badges are re-implemented at least 9 times with different padding, weight and casing
  (`StatusBadge`, `LifecycleBadge`, `TaskStatusBadge`, `PlanBadge`, `KindBadge`, `ProviderBadge`, two local `Badge`s, inline spans).
- Stat tiles are re-implemented 4 times (`Insights`, `MyTasks`, `IntegrationCards`, `VexaCard`).
- Tab bars are re-implemented 5 times (Action Center, Approvals, Search, Groups, Teams mock), with three different ARIA patterns.
- Primary buttons are sometimes `<Button>`, sometimes hand-written `<Link className="rounded-md bg-slate-900 …">`.

### Shell
- Top bar holds brand, search, theme, notifications, name/role and logout in one row; it wraps on small laptops.
- Sidebar is plain text links, no icons, no collapse, hidden below `lg`; mobile menu is an unstyled list pushed under the header.
- No breadcrumbs: detail pages each hand-roll a `← Parent` link.
- No profile menu; "Log out" is a permanent header button.
- Navigation groups ("Work / Intelligence / Tools") don't match how the product is described.
- Assistant dock is a text pill; its panel has glyph controls.

### Pages
- **Dashboard** (`/admin`) is the Insights page with a different title. It reports on projects; it does not answer "what needs my attention".
  Managers and employees have no overview at all.
- **Action Center**: seven unlabeled filter controls in a grid, wrapping tab row, table with no priority or source affordance,
  due dates as raw ISO strings, no skeleton, selection bar pushes content down.
- **Action detail**: evidence, work state, executions and history are equal-weight stacked cards; history is an unstyled list;
  reject uses `window.prompt`.
- **Approvals**: each plan is a card whose title is a button; what will happen, where and by whom is in one grey sentence.
- **Assistant**: grey/black bubbles, "Try:" list of underlined links, emoji mic button, confirmation card is a 2px black box.
- **Meetings**: status is a single generic badge; no visual distinction between scheduled / joining / recording / processing / failed.
- **Integrations**: three different presentations on one page (Vexa card, Figma/Teams cards, a plain list for everything else);
  only Figma, Teams and Vexa have a logo.
- **Insights**: six stat tiles of equal weight, then eight cards; the trend "chart" is a table of 2px bars with a `a / b / c / d` legend.
- **My tasks**: five equal stat tiles, then one flat list; nothing separates overdue / today / upcoming.
- **Notifications**: flat list, unread shown by a sky background and a text "Unread" pill, no grouping by day.
- **Profile**: three cards on one screen, no sections.
- **Login / Accept invitation**: bare centred card, no brand.

### Responsive
- Sidebar disappears below 1024px and is replaced by a text menu.
- Wide tables rely on `overflow-x-auto` only; filter grids collapse to one very long column.
- Assistant dock panel overlaps the content on phones with no full-height mode.

### Accessibility
- Focus styles are browser default on links and custom buttons; inputs use a faint slate ring.
- Icon-only controls are glyph characters (announced as "multiplication sign", "black sun with rays").
- `prefers-reduced-motion` is not considered (there is also no motion).
- Dark-mode contrast for several status colours is unverified because they fall outside the override list.

### Existing bugs and risks (documented, not changed)
- `ActionCenter` search input is uncontrolled (`defaultValue`) and only applies on Enter; clearing a filter elsewhere does not clear the box.
- `ActionDetail` evidence links always point to `/admin/meetings/:id`, which non-admins cannot open (they are redirected home).
- `ActionDetail` reject swallows the busy state (no `setBusy`), so the button can be double-clicked.
- `VexaCard` says "next {24} hours" with a hard-coded 24.
- `window.confirm` / `window.prompt` are used for 24 confirmations. Tests spy on `window.confirm`, so these are kept as they are;
  replacing them with an in-app dialog is listed under remaining work.
- No frontend lint configuration exists.

## 3. Design system

### Principles
Neutral first, one accent, colour only for meaning. Dense but calm: 13–14px body, 1px hairline borders, 6–8px radii, almost no shadow.
Icons are Lucide at 16px (14px inside badges, 18px in the header). Motion is 150–200ms ease-out and disabled under `prefers-reduced-motion`.

### Tokens (`src/index.css`)
All colours are CSS custom properties. Tailwind's `slate`, status and `accent` scales are re-pointed at these tokens in `@theme`,
so every existing utility class picks up the new palette, and dark mode is one block of variable overrides instead of per-class rules.

| Token | Light | Dark |
| --- | --- | --- |
| Canvas | warm off-white `#fafaf8` | charcoal `#111214` |
| Sidebar | `#f4f4f1` | `#0c0d0f` |
| Surface (cards) | `#ffffff` | `#18191c` |
| Raised surface | `#ffffff` + shadow | `#1f2125` |
| Border / strong border | `#e7e6e1` / `#d6d5cf` | `#26282d` / `#33363d` |
| Text / secondary / muted | `#1b1b1f` / `#5c5c66` / `#8a8a94` | `#ededf0` / `#a4a6b0` / `#70727c` |
| Accent (indigo) | `#4f4fdc` | `#8286f1` text, `#5b5be0` fill |
| Success / warning / danger / info | restrained green / amber / red / blue, 50-100 tints for fills | translucent tints, light text |

Type: Inter Variable (self-hosted through `@fontsource-variable/inter`), `font-feature-settings: 'cv11','ss01'`, tabular numerals for figures.
Scale: page title 20/28 semibold, section title 14/20 semibold, body 14/20, secondary 13/18, caption 12/16, overline 11/16 medium uppercase.

Spacing: 4px base; page gutter 24px (16px on phones); card padding 20px; section gap 24px; control height 32px (36px on touch).

Radius: 6px controls, 8px cards, 12px dialogs, full for pills/avatars. Shadows: none on cards, `shadow-pop` for menus/dialogs only.

### Shared primitives (`src/components/ui.jsx`, `src/components/icons.jsx`)
`PageHeader`, `Card`, `StatCard`, `SectionHeader`, `Badge`, `StatusBadge`, `Tabs`, `Button` / `ButtonLink` / `IconButton`, `Field`,
`SearchInput`, `FilterBar` / `FilterSelect`, `tableClass` helpers (`DataTable`), `EmptyState`, `Loading` (skeleton), `Skeleton`,
`Avatar`, `Menu`, `Dialog`, `Tooltip`, `Kbd`, `ErrorAlert` / `SuccessAlert` / `Callout`, `Meter`, `IntegrationIcon`, `SourceIcon`,
`ActivityTimeline`, `CommandPalette`, `Breadcrumbs`.

## 4. Page-by-page plan

| Page | Plan |
| --- | --- |
| Shell | Fixed left sidebar (240px, collapsible to 56px with tooltips, drawer on mobile), grouped per the product areas, Lucide icons, role-based items unchanged. 52px header: breadcrumbs, search trigger opening a command palette (`⌘K`), notifications, theme, profile menu. |
| Overview (new, `/admin` and `/overview`) | "What needs my attention": greeting, attention KPIs (pending review, overdue, awaiting approval, awaiting execution — all from `/actions/summary`, `/insights`, `/actions/execution/plans`), approvals waiting, overdue work, upcoming meetings, team workload, highlights, recent activity. Every section reads a live endpoint and has its own loading/empty/error state. |
| Action Center | Underline tabs with counts, compact filter bar (search + labelled selects), dense table with source icon, priority marker, owner avatar, relative due date, lifecycle badge; sticky bulk-action bar. |
| Action detail | Header with badges and meta; two-column: description, review, evidence (quoted, source icon), work state, executions, history timeline; properties rail. |
| Approvals | Plan rows with provider icon, requester, write count, status; expanded view shows preview, permissions note, cancel window, executions table, audit timeline. |
| My tasks | Segmented overview (overdue / due today / upcoming / no date / completed), compact stat strip, task rows with status and priority. |
| Assistant | Conversation rail + workspace; empty state with suggested prompts as cards; assistant/user message styling; typing indicator; execution preview card with provider icon, fields and warnings. Dock becomes an icon launcher with a proper panel (full-height sheet on phones). |
| Meetings | Table with status pill + icon per state (draft, bot joining, recording, processing, review, approved, sent, failed); detail header with meta row; bot panel status with icon. |
| Integrations | Featured Vexa panel, then a categorised grid (Meetings & calendar, Communication, Engineering, Design) with brand marks, status, last sync, configure link; connections and people matching below. |
| Insights / KPIs | Stat strip with tone, highlights, project health table, two-column lists, SVG trend chart with legend. |
| Digests, Duplicates, Activity, Search, Suggestions, Records | PageHeader, tabs/filters, table/list primitives, source icons. |
| Teams, Groups, Projects, Scheduling | PageHeader, cards/tables via primitives, avatars for members, progress meters where data exists. |
| Notifications | Grouped by day, unread dot, mark-read on hover, filter toggle. |
| Profile / Settings / Users / Operations | Sectioned settings layout (section nav on the left where the page has several concerns). |
| Login / Accept invitation | Branded split layout. |

## Progress log

_Updated as each phase lands._
