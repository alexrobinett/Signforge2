# Proposal: the CMS interface on shadcn/ui

Status: proposal, 2026-11-17. Decided the same day: Geist, and the token change with M3-11, which landed it (`apps/cms/src/styles.css`, checked by `apps/cms/test/tokens.test.ts`). M3-11 also added `--status-needs-you` (red, the triangle) beside the four states, made `--status-offline` grey, and added `--border-strong` for outline buttons and `--primary-disabled`. Direction from the owner: Landing A (navy, product-led) for the marketing page; the app itself neutral white, not paper; shadcn as the base, with our own components where the product needs them.

## Where we are

`apps/cms` already runs shadcn (new-york style, Tailwind 4, Radix, lucide icons, `cssVariables: true`). Eight primitives are installed (`alert`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `label`, `sheet`). The tokens in `src/styles.css` are oklch with a faint blue tint, light and dark, and are checked for 4.5:1. The font is Inter.

shadcn is not a dependency: `pnpm dlx shadcn add` copies a component's source into `src/components/ui/`, and from then on it is our code. So "customising shadcn" happens in three places, from cheapest to most work.

## 1. Tokens (one file, every component follows)

All of the look that can be a variable lives in `src/styles.css`. The changes:

- **Neutral white.** Drop the blue tint from the surfaces: `--background` pure white for panels and a cool neutral near-white (`oklch(0.985 0.002 250)`, about #F7F8FA) for the app canvas; `--border` and `--input` cool greys (about #E4E7EC and #D0D5DD); `--foreground` near-black neutral. The blue stays only where it means something: `--primary`, `--ring`, the active nav item.
- **Field edges at 3:1.** Input and select borders must reach 3:1 against their background (WCAG 1.4.11), so `--input` is about #858FA1, not #D0D5DD (1.5:1). Dividers and card borders stay light (`--border`), since they are not controls.
- **Offline is calm; "needs you" is red.** A screen that is unreachable but playing its latest version is a fact, not an alarm: neutral grey, its own shape, and the line "Unreachable 2 h · still playing Spring menu" (`docs/research/cms-ux.md`, ideas 3 and 4). Red is kept for screens that need a person: behind on version, credential revoked, nothing playable. Decided 2026-11-17.
- **Status tokens.** Signage has four states everywhere: online, updating, asleep, offline. Add `--status-online`, `--status-updating`, `--status-asleep`, `--status-offline`, each with a `-foreground` and a `-muted` (pill background), in both modes, plus `--chart-1` to `--chart-5` for rollout bars and play counts. Every status pairs colour with a word or icon, never colour alone.
- **Sidebar tokens.** shadcn's `sidebar` component reads `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring`; we have only two of them.
- **Type.** Geist and Geist Mono (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`), as the chosen concepts use; mono only for identifiers: codes, ids, hashes, versions, keys, URLs, scopes and tool or model names (#375). Numbers (counts, times, dates, durations, ratios and sizes) are Geist with tabular figures (`tabular-nums`), so a polled count or time does not jiggle; a word is never mono. A badge's figures are tabular. Inter stays the default template font, which keeps "the CMS" and "the screen" visibly apart. Sizes are Tailwind's steps plus three between them (#372): `text-2xs` (11 px, labels on a thumbnail), `text-meta` (13 px, a row's line and other meta) and `text-md` (15 px, large controls and lead text); no `text-[Npx]`. Radii are the `--radius-*` steps, no `rounded-[Npx]`.
- **Grouping.** Inside a card, a form or a dialog, group with space and a heading (or a rule between repeated items, such as display-hours windows), never a bordered box inside the box (#377). A box is for a page's own cards, for controls (a field, a drop zone, a choice), for a data table, whose frame is its edge (a CSV's first rows), and for a status callout whose tint is its meaning, as an alert's (a bound source's Live data, or what screens show instead). A form's repeated items (display-hours windows, a list field's rows) are set apart by a rule, and each is a named group.
- **Surround and toast tokens.** A screen's dark surround (the editors' stage, screen and asset thumbnails, the sign-in picture) is `--stage-*`, the same in both themes; toasts are `--toast-*`. No hex in a class: every colour is a token, checked by `apps/cms/test/tokens.test.ts`.
- **Radius and density.** `--radius` 0.625rem stays. Tables and lists get a compact row height (36 px) as a size variant, not a global change, because the screens table is dense and forms are not.
- **One contrast test.** A test reads `styles.css`, pairs every `X` with `X-foreground`, and fails under 4.5:1 in either mode. The brand kit compiler already has the contrast function (M3-38); reuse it.

Tenant branding does not re-theme the CMS in v1 (decided in `brand-and-editor.md`). The token names are kept close to the template ones (`--sf-*` in templates, shadcn's names here) so a later "org accent in the CMS" is a mapping, not a rewrite.

## 2. Variants on shadcn components (edit the copied source)

| Component | Change |
| --- | --- |
| `badge` | `ui/badge.tsx`, every pill in the CMS (#372): variants `online`, `updating`, `asleep`, `offline`, `needs-you` (the screen states' tints), `agent` (what the agent filled), `outline` (a plain fact, such as Test screen or a scope) and `stage` (a mark on a screen's dark frame, such as a portrait tile's ratio, top-right clear of the Updating to bar; a landscape tile says none, #374); size `lg` for a screen's state, with its glyph first |
| `choice` | `ui/choice.tsx`, the one "selected" look (#373): a tint (`accent`) with the primary edge, for a toggle button (`Choice`, `aria-pressed`) and for a card around a radio or checkbox (`choiceVariants`, `has-checked`): filters, day toggles, view and stage toggles, theme, template and option cards. Not selected, an outline; hover shades without looking chosen, and never a disabled one. On the stage, `tone: "stage"`, the same look in stage tokens; not selected, a stage control's edge is transparent. Without colour, under forced colors, the selected edge is thicker. Focus is a full-strength ring (3:1 on a card, the canvas and the stage) over a transparent outline that forced colors paints |
| `button` | keep the six variants; add `size: "xs"` for table row actions. One filled (`default`) button per view, its one primary action; the rest are outline or ghost (#364). A button says its variant (`data-variant`, set after its props so a caller cannot change it, and kept in production builds), which the e2e checks; a link or label drawn as the filled button (Upload images, the empty fleet's Open a test screen) says `data-slot="button" data-variant="default"` too, so it counts. Alert dialogs' actions are destructive or outline and do not count |
| `table` | `density: compact | comfortable`; sticky header; numeric columns right-aligned with tabular figures |
| `input`, `select`, `textarea` | an `invalid` state wired to the contract's problem messages |
| `sidebar` | the app nav (Screens, Spots, Playlists, Schedules, Brand kits, Audit log) and the settings nav, collapsible to icons; folded to icons by default in a spot's or a playlist's editor, for the stage's room, until the person unfolds it on that visit (#363) |
| `tabs` | an underline variant for the editor (Content, Style, Timing) |

## 3. Our own components (built on shadcn primitives)

These are SignForge's, so no registry has them:

- **`ScreenTile` / `ScreenRow`**: thumbnail, name, location, status badge, last heartbeat. Used by Screens A/B/C and the screen detail page. The thumbnail is the spot's image, else the player's drawing of that very template version (none for another version: the template's name instead); a tile names the template, never its key or a manifest hash (the table keeps the version column). Until the screen reports applying its publish, the thumbnail says "Updating to" what it will play, not that it plays it (#362). Spot and playlist rows lead with the same thumbnail (`SpotThumb`), and an org with no spots sees, under the empty state and its New spot, the template gallery: outlined tiles, each opening New spot with that version picked and taking focus back when it closes. A playlist row says what it starts with.
- **`RolloutBar`**: one publish's screens by state (applied, downloading, asleep, offline), with a legend that names counts.
- **`PendingBar` and `PageSkeleton`** (`components/pending.tsx`, #376): between pages, a bar at the top while the router waits on a navigation's loaders, faded in past 300 ms by CSS (no timer), and a page skeleton (a title, a line, list rows) in place of a page still loading past 300 ms (`defaultPendingMs`), held at least 300 ms so it does not flash. A page's search is not a loader dependency (Audit log's filters, a spot's stage options, Publishes' `?id`): entering the page reads it in the loader, so the skeleton shows, and a change made on the page is read by its suspense query with the search deferred (`useDeferredValue`; the suspense hooks take no `placeholderData`), so the page, its rows and the focus stay until the new read lands, the rows marked busy. Under reduced motion the bar is a still, full-width line and nothing pulses. "Loading the page…" is said by a status that is always there, filled while the router waits.
- **Editor header** (`components/editor.tsx`): back, title, then Save draft and Publish, and last a ⋯ menu (`EditorMoreMenu`, #378) holding Delete…, away from the two buttons a slip would hit. Delete asks first; closing the question gives focus back to ⋯.
- **`PlayerStage`**: the real player in an iframe (M3-36 preview channel), scaled to fit at true resolution, with landscape/portrait and fit/100% toggles. The heart of the editor. Beside the form it fills its column and stays in view as the form scrolls (`STAGE_COLUMN`, the editor's height `--editor-height`); until the player draws it shows the spot's template thumbnail dimmed, with "Drawing…" (#363). It draws only in view (#342). Its colours are the `stage` tokens, a screen's dark surround in light and dark alike.
- **`FieldForm`**: a form generated from a template's `fields` (text, number, boolean, color, select, url, date, datetime, image, list), with the contract's validators giving each field's errors (`validateSpotField`, the per-field part of the publish's `validateSpotData`), said in words by the field's label, as the publish toast says them (`problemWords`, `apps/cms/src/lib/field-words.ts`, #359): "No image for Photo: choose one, or untick Show the photo", never `image field "photo" has no asset`. An empty field's problem shows only once the field is touched (changed, left, or its picker opened) or Publish is pressed, so a spot just made is not a page of errors; a wrong value shows at once. A choice shows its options by a label (Pop, not `pop`; a unit as written). The stage and a playlist's rows give the same words for what they leave out. It draws only the fields a person types, but checks each against all of the template's fields, as a publish does, so an image whose toggle is a live field is checked with it. Built on shadcn `form` patterns.
- **`BrandColorField`**: "Brand accent" or a custom colour, with the contrast check beside it.
- **`AssetPicker`**: the media library in a `dialog` (built with the library page in M3-14). The focal point for portrait crops comes with the spot editor (M3-16).
- **`DataBindingField`**: bind a field to a data source and path, showing the live value and the fallback.
- **`PairingCodeInput`**: shadcn `input-otp`, 6 characters in two groups.
- **`DisplayHoursEditor`**: weekly windows plus dated exceptions (`DisplayHours` in the contract).
- **`AuditEntry`**: actor (person or agent), action, target, time.

## shadcn components to add

`badge`, `table` (with TanStack Table for sorting and paging, which the list tools now return), `tabs`, `select`, `command` (combobox and search), `popover`, `tooltip`, `input-otp`, `sonner` (toasts for publish results), `switch`, `toggle-group`, `slider`, `calendar`, `skeleton`, `breadcrumb`, `sidebar`, `separator`, `scroll-area`, `alert-dialog` (revoke, delete).

## What to decide

1. Geist for the CMS (as the concepts), or keep Inter?
2. Should the component sheet be a board on the design canvas first (every token and variant, light and dark), before any CMS code changes? Recommended: yes, it is the cheapest place to settle the look.
3. When to do the token change: alone now (small, reviewable), or with M3-11, the first screen built on it.
