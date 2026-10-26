# UI review: heavy boards

Diagnosis and proposals for boards with many lanes, long lanes, and cards with a lot of content. **Nothing in this
document is implemented.** The pane, the drawer and the tests are exactly as before; this review only adds a heavy
synthetic fixture, four new screenshots (`heavy-columns`, `heavy-list`, `heavy-drawer`, and the same drawer scrolled
to its checklists) and a measurement mode to `scripts/render_screenshots.mjs`.

The base layout works. What follows are the places where volume, not design, makes it fall short, each with a
measurement, and a menu of proposals to pick from.

## How the numbers were produced

Everything is synthetic (`applyHeavyFixture` in `scripts/render_screenshots.mjs`, seeded PRNG, fixed clock) and
reproducible:

```bash
node scripts/render_screenshots.mjs --css <app index.css> --codicon-font <codicon.ttf> --measure [--measure-out numbers.json]
node scripts/render_screenshots.mjs --css <app index.css> --codicon-font <codicon.ttf>        # screenshots
```

**Fixture contract** (printed by `--measure`, not assumed): 10 lanes, 207 cards, the first lane with 80. Titles
from 8 to 120 characters (29 cards with 8, 20 with 120, median 43). 88 cards without a due date, 50 without
labels, up to 4 labels and up to 5 members per card. The heavy card ("Release 4.2") has a 1,983-character markdown
description (headings, lists, code, links), 3 checklists × 20 items (24 done), 12 comments of 179–585 characters,
6 attachments, 4 labels, 2 members, a due date 3 days overdue and 20 activity rows (the backend returns at most 20).

Three kinds of measurement, and the tables say which one each number is:

| Kind | Where | What transfers to a browser | What does not |
|---|---|---|---|
| **DOM + render counts** | jsdom, React 19.2.7 *development* build, the plugin copied unchanged with a counting `jsx-runtime` shim and a `React.Profiler` around the pane (the plugin is not instrumented) | node counts, how many times each component renders, ratios between scenes | absolute milliseconds (dev build, jsdom DOM) |
| **Layout** | real Chromium 147 on the serialized pages the screenshots use (same real CSS, same fonts) | element sizes, scroll extents, style + layout time of the DOM as a document | React work, event handlers, paint/compositing, scroll frame rate |
| **Payload** | JSON byte size of the fixture responses | order of magnitude | real Trello latency |

Mount times are the mean of 3 mounts after a discarded warm-up mount, and the table reports the worst of the 3.
Interaction steps are 5 runs (median and worst), except open / toggle / close, which are single runs. Run-to-run
noise on this machine: about ±10% on mounts, up to 2× on single steps under 15 ms; **counts are exact,
milliseconds are not**. Peak memory of the measurement run: 554,520 kB RSS (`/usr/bin/time -v`; the script itself
reports 543 MB peak RSS) and an 863 MB cgroup peak, which includes Chromium and page cache.

One harness detail worth knowing: React's development build logs a user-timing measure for every component render
and `structuredClone`s the props into it (the whole board view, for every card). A CPU profile of the measurement run
put 1.5 s of 26 s there, and without the workaround the same run peaked at 1.72 GB RSS instead of 0.55 GB. It does
not exist in production builds, so the harness turns it off before React loads.

**What could not be measured honestly** (so no number is given):

- React's cost in a real browser (production build, real layout). jsdom has no layout; the Chromium pages have no React.
- Scroll/paint frame rate, input latency, GPU. Headless Chromium here has neither a real compositor nor a display.
- The real SDK components (tooltips, Radix checkbox). Node counts use the class-faithful visual SDK; render counts
  use the test stub. Tooltip fibres per icon button are not modelled.
- The commit count of a poll under the real React Query. The stub, with the response held back like a real round
  trip, gives 2 commits (`isFetching` flips on start and on end, and `Workspace` reads it). The app's React Query
  should do the same by reading the code, but this was not observed in the app.
- First-load time against the real Trello API (parallel requests, latency). Nothing about skeletons is measured.
- A real board. The fixture is a stand-in; the member/label/due distributions are invented.

## A. Findings

### A1. Volume per lane

The columns layout renders **every card of every lane**: 207 cards are 2,229 DOM nodes in the pane (84 are chrome,
the cards are ~10.4 nodes each: median 11, range 4–16; lane-diff method: 80-card lane minus 5-card lane, over the
75 extra cards). Nothing is deferred or windowed.

| Scene (jsdom, dev React) | Cards | Pane nodes | `mount()` worst / mean ms | Render phase worst ms | list→columns switch worst ms |
|---|---|---|---|---|---|
| baseline columns (6 cards) | 6 | 99 | 35.7 / 33.6 | 20.2 | 19.8 |
| 5-card first lane | 132 | 1,455 | 248.9 / 224.9 | 229.8 | 201.7 |
| **heavy columns (80-card first lane)** | **207** | **2,229** | **312.8 / 292.0** | **291.6** | **297.1** |
| baseline list (1 card) | 1 | 33 | 21.2 / 20.4 | 6.8 | — |
| 5-card lane, list mode | 5 | 98 | 29.6 / 26.5 | 12.0 | — |
| **heavy list (80-card lane)** | **80** | **875** | **126.7 / 116.6** | **110.3** | — |

Mount cost is linear in cards: about 0.9 ms per card between the 132- and 207-card boards, 1.3 ms per card against
the baseline (dev build in jsdom; treat as relative). Dragging the pane across the 560 px threshold pays the
switch cost again (~300 ms here), and `laneWidth` changes with every width tick up to 300 px, so a drag re-renders
the board repeatedly.

What the user sees (real Chromium, `docs/screenshots/heavy-columns.png`, 1280×720):

| | baseline (4 lanes, 6 cards) | heavy (10 lanes, 207 cards) |
|---|---|---|
| Lane 1 scroll height / viewport | 332 / 332 px (1 screen) | **7,744 / 622 px (12.5 screens)** |
| Cards of lane 1 fully visible | 1 of 1 | **6 of 80** |
| "Add card" position in lane 1 | — | after 7,716 px of scroll |
| Full style + layout pass (median of 20) | 1.8 ms | **21.7 ms (12×)** |
| Style recalculation at load | 3.4 ms | 12.0 ms |

The initial `LayoutDuration` is ~30 ms for both pages: it is dominated by a fixed cost (the 395 KB stylesheet and the
icon font), so it is not used as evidence. The forced full relayout is the number that scales with the DOM.

The list layout (`heavy-list.png`, 480×760) has the same shape: 7,065 px of cards in a 681 px viewport (10.4 screens),
7 cards fully visible of 80, 890 nodes in the page, 8.7 ms per full relayout.

### A2. Re-rendering is board-wide for every event

Every interaction re-renders every card, whether or not its data changed. Counts are exact (render counter in a copy
of the plugin; one commit = one React commit; 207 cards):

| Step | Commits | `CardRow` renders (207 cards) | Max per card | `ItemRow` renders | All component calls | Render ms median (worst), dev jsdom |
|---|---|---|---|---|---|---|
| Poll, data unchanged | 2 | **414** | 2 | 0 | 2,530 | 22.3 (25.4) |
| Poll, one card changed | 2 | 414 | 2 | 0 | 2,530 | 21.8 (45.3) |
| Select next card (`j`) | 1 | **207** (2 cards change) | 1 | 0 | 1,229 | 11.2 (33.9) |
| Open the heavy drawer | 2 | 207 | 1 | 60 | 2,082 | 33.5 |
| Poll while the drawer is open | 2 | 414 | 2 | 120 | 4,064 | 29.5 (30.1) |
| **Toggle one checklist item** | **3** | **621** | 3 | **180** | **6,096** | 45.4 |
| Close the drawer | 1 | 207 | 1 | 0 | 1,287 | 11.0 |
| *Same steps, 6-card baseline: poll / select / toggle* | 2 / 1 / 3 | *12 / 6 / 18* | | *0 / 0 / 12* | *142 / 47 / 576* | *3.9 / 1.5 / 8.4* |

Causes, from the code: `CardRow` is not memoized; every `CardRow` subscribes to the selected-card store; the
`view` object is passed whole to each card; `Workspace` reads `viewQ.isFetching`, so each poll re-renders the board
when the fetch starts and when it ends. Toggling one item writes the card and the board view caches optimistically
and then `onSettled` invalidates both, so the whole drawer and every card render three times in the harness
(including 13 `Markdown` blocks: the description and the 12 comments are parsed again each time, 39 parses for one
tick of a checkbox).

At 207 cards a poll costs about 22 ms of dev-mode render phase per 25 s. That is not a visible stall by itself; it
scales linearly with cards (the backend allows up to 1,000), and it lands on top of whatever the user is doing
(scrolling a lane, typing a comment).

### A3. Card density

Measured on the 207 cards of `heavy-columns.png` (real Chromium):

- Card height: median **83.5 px**, range 59.5–123. The title is only **34%** of the card's height; the label rows
  take **14%**.
- **5 markers per card** at the median (labels, due date, checklist, comments, attachments, avatars), up to 10.
  Cards show a median of 2 labels, up to 4.
- 9 cards have a label row that wraps onto a second line; 43 label chips are cut by the 8 rem ellipsis (the board's
  `customer-escalation-needed` label is the usual one); 20 titles are clamped at two lines.
- **28 member avatars are hidden without any indicator** across 20 cards: `Avatars` shows at most 3 and drops the
  rest silently.
- The selected card grows from 83.5 to **113.5 px (+30 px)** because the action row appears under it, so selecting
  with `j`/`k` shifts every card below it.
- The pane never shows more than 6 of the 80 cards of lane 1; a compact card would show more, but the layout has no
  second density.

### A4. The drawer with long content

`heavy-drawer.png` shows what opens; `heavy-drawer-checklists.png` is the same drawer scrolled to where the
checklists start.

| Measure | Heavy drawer | 4-item baseline drawer |
|---|---|---|
| Drawer DOM nodes | **871** (description 79, checklists 518, comments 90, attachments 26, activity 123) | 139 |
| Buttons in the drawer | **200** (2 icon buttons on each of 60 items) | 24 |
| Nodes per checklist item / comment | 8.2 / 7 | 8.5 / 7 |
| Scroll height / visible height | **6,695 / 966 px (6.9 screens)** | 946 / 946 |
| Fixed header + footer | 134 px (63 + 71; the footer wraps to two rows) | 134 |
| Description (top / height) | 100 / **1,044 px** | 100 / 105 |
| Checklists (top / height) | 1,158 / **2,239 px** (33% of the drawer) | 219 / 229 |
| Comments (top / height) | **3,411** / 2,184 px (median comment 168 px) | 462 / 224 |
| Attachments (top / height) | 5,608 / 163 px | 700 / 35 |
| Activity (top / height) | 5,785 / 910 px | 749 / 182 |
| Open: worst of 3, wall / render phase | 106.9 / 88.2 ms | 43.4 / 27.9 ms |
| Full relayout, median | 23.2 ms | 5.0 ms |

- Reaching the comments takes **3,411 px of scrolling** (3.5 screens); the attachments, 5,608 px. There is no way to
  jump to a section.
- Markdown headings are all drawn the same (bold, same size), whatever their level: the `#` title and the `##`
  sections are indistinguishable (see `heavy-drawer.png`). A 2,000-character description is 1,044 px of that.
- Checklists show a text count only (`8/20`), no progress bar, no collapse, no way to hide the finished items
  (36 of the 60 are pending: 12 per checklist). Every item permanently carries an edit and a trash button, and the
  trash button deletes with one click, without confirmation or undo.
- Comments: all of the (at most 20) comments the backend returns are rendered in full. If a card has more than 20,
  the drawer neither says so nor links to the rest.

### A5. Navigating between many columns

- In columns mode a 300 px lane is fixed: **10 lanes need 3,114 px, a 1,280 px pane shows 4 fully (a fifth is
  cut)**. The rest is reached with the horizontal scrollbar, or with the mouse wheel once a lane has reached the end
  of its own scroll. There is no overview of the lanes, no jump to a lane, no indication of how many are off screen.
- Keyboard: `j`/`k` walk one flat list through every lane. Reaching the first card of a lane takes this many `j`
  presses: Triage **81**, Ready 101, QA 143, **Done 168**. There is no lane-to-lane key.
- List mode has the chip bar: 10 chips are 1,149 px wide in a 480 px pane (4 fully visible); it scrolls sideways,
  without an overflow menu or search.
- With many lanes there is nothing to find a card either: no text filter, no member/label/due filter. In the
  fixture, filtering to overdue would leave 44 of 207 cards (20 of the 80 in lane 1); due within 48 h, 18; label
  `bug`, 55.

### A6. Visual noise

Measured in A3. A card mixes five kinds of marker (labels, a due-date outline, `☑ n/m`, `💬 n` and `📎 n`, avatars)
with up to four label chips of up to 8 rem. Labels and avatars carry no overflow rule, so they either wrap
(9 cards), cut (43 chips) or vanish (28 avatars). The selected card, and the hovered one, add a three-button row
(30 px on the selected card).

### A7. Loading states with a big board

`BodySkeleton` is four grey bars (3.5 rem) in a single column for every mode and every board size: a 10-lane board
replaces it with a layout that has nothing in common with it. **No evidence for a measured problem**: first-load
latency depends on the Trello API, which the harness cannot reach, and a poll never shows the skeleton (stale data
stays on screen). The poll payload is not a problem either: the heavy `/view` is 103,693 bytes (491 B per card; the
baseline is 3,673 B) every 25 s, and the heavy card detail is 19,068 B.

### Adjacent, outside the UI (not touched)

- `board_view` asks Trello for at most 1,000 open cards and the pane never calls the paged route
  (`GET /boards/<id>/cards?before=…`), so a board with more than 1,000 open cards would be shown truncated without a notice.
- Card detail fetches the newest 20 comments only (`limit=20`).

## B. Proposals

Impact is 1–5 against the pain measured in part A (5 = blocks use at this volume, 3 = measurable, 1 = polish);
effort is S/M/L. The score is impact ÷ effort (S=1, M=2, L=4); the order below is by score, ties broken by impact.
Impact is a judgment; the other numbers are measurements.

| # | Proposal | Impact | Effort | Score |
|---|---|---|---|---|
| P1 | `content-visibility` on cards | 3 | S | 3.0 |
| P2 | Render isolation: memoized cards, narrow props, per-card selection | 3 | S | 3.0 |
| P3 | Comments: latest three + "show more", clamped long comments | 3 | S | 3.0 |
| P4 | Lane strip and lane-jump keys | 5 | M | 2.5 |
| P5 | Density: comfortable / compact | 5 | M | 2.5 |
| P6 | Board filters | 5 | M | 2.5 |
| P7 | Drawer section tabs, description "show more", heading levels | 4 | M | 2.0 |
| P8 | Checklists: progress, collapse, "pending only", hover actions | 4 | M | 2.0 |
| P9 | Label and avatar overflow (`+N`) | 2 | S | 2.0 |
| P10 | Virtualized lanes | 3 | L | 0.75 |

### P1 — `content-visibility` on cards
- Estado: implementado en c9db144. Measured (`--measure`, serialized page, median of 5 loads): full relayout of the 80-card lane 21.7 → 9.4 ms in columns (content-visibility forced off in the same build: 22.5 ms), 8.2 → 3.3 ms in list. `contain-intrinsic-size` is the content box, so the estimate is 84 px outer (66 + 18 chrome) comfortable and 56 px (42 + 14) compact. Lane 1 scroll height 7,455 px as rendered vs 7,674 px with every card laid out (−2.9%); compact 4,814 vs 4,838 px. `scrollIntoView` on a skipped card is not covered by jsdom.
- Síntoma: every card of every lane is laid out and styled although at most 6 of 80 are on screen (medición: full relayout 21.7 ms vs 1.8 ms for the 6-card board; 12.5 screens in lane 1).
- Propuesta: set `contentVisibility: 'auto'` and `containIntrinsicSize: 'auto 84px'` in the existing inline style of `CardRow` (and the same in list mode). CSS only: no new dependency, no markup change, the DOM and the keyboard model stay as they are.
- Mejora esperada: measured on the serialized heavy page: full relayout 22.0 → 9.1 ms (−59%) in columns and 8.7 → 3.5 ms (−60%) in list; style recalculation 12.1 → 9.0 ms (−25%). Adding the same rule on lanes changes nothing (9.3 ms). It does **not** reduce nodes (2,229) or React work.
- Esfuerzo: S
- Riesgo: the scrollable height becomes an estimate until cards are rendered: +11% with an 84 px estimate (7,744 → 8,603 px) and +24% with 100 px (9,611 px), so the scrollbar thumb can jump; browser find-in-page does not see skipped cards; `scrollIntoView` on a selected off-screen card must be exercised in the real app. If P5 lands, the estimate must follow the density (a compact card is about a third shorter).
- Evidencia: `heavy-columns.png`, `heavy-list.png`; `--measure` section "content-visibility experiment" (CSS injected into the serialized page; React not involved).

### P2 — Render isolation
- Estado: implementado en c9db144. Measured with 207 cards: `CardRow` renders per unchanged poll 414 → 0; per poll with one card changed 414 → 1; per selection move 207 → 2; per checklist toggle 621 → 1; `ItemRow` per toggle 180 → 1; `Markdown` per toggle 39 → 0; `Workspace` + `BoardBody` renders per poll 4 → 0. Cost: +42 DOM nodes (the lane strip) and jsdom mount 300 → 332 ms (dev React, ±10%).
- Síntoma: a poll, a selection or a checkbox toggle re-renders every card (medición: 414 `CardRow` renders per poll of 207 cards, 207 per `j` press, 621 and 180 `ItemRow` renders per checkbox toggle).
- Propuesta: wrap `CardRow` and `ItemRow` in `React.memo`; pass `CardRow` the pieces it needs (`card`, `labels`, `members`, `lists` only for the menu) instead of the whole `view`; replace the per-card subscription to the selected-card store with one boolean selector per card (`useStore(selected)` compared to `card.id` inside a selector, or a derived `isSelected` atom); read `viewQ.isFetching` in `Header` instead of `Workspace`, so a fetch start does not re-render the board; memoize `Markdown` by text.
- Mejora esperada: with unchanged data, `CardRow` renders per poll 414 → 0; per `j` press 207 → 2; per toggle 621 → ≈3 (only the card whose counter changes); `Markdown` parses per toggle 39 → 0. Render time per event should fall toward the 6-card board's floor (1.5–4 ms in the same harness). Estimate, not measured after a change.
- Esfuerzo: S
- Riesgo: a memoized card with a stale prop is a bug that hides (optimistic moves, label edits, due edits all patch the cached view). It only helps if the React Query data keeps stable references for unchanged cards (its structural sharing does; the test stub does not, so the render tests need a stub that does the same). `RT.store.selected` is also read by the keyboard handler.
- Evidencia: `--measure` section "Renders per interaction" (counts are exact; the stub's 2 commits per poll should be confirmed in the real app before relying on the 414).

### P3 — Comments: latest three, expandable, long ones clamped
- Estado: implementado en 4719c73. Measured (`--measure`, heavy card, 12 comments): comments section 2,184 → 627 px (−71%); `Markdown` blocks rendered when the drawer opens 13 → 4 (description + 3 comments); a comment over 6 lines is clamped with its own `Show more`; `Show 9 more` reveals the rest with no request; with exactly 20 comments a line says older ones are in Trello with an open-in-Trello action. The post button now appears once there is text.
- Síntoma: all comments are drawn in full: 2,184 px for 12 (medición: median 168 px each, max 585 characters), and a card with more than 20 shows 20 with no hint.
- Propuesta: show the composer and the newest 3 comments, then a button "Show 9 more"; clamp a comment to ~6 lines with "Show more"; when exactly 20 came back, add "Open in Trello for older comments" using the existing open-in-Trello action.
- Mejora esperada: comments section 2,184 → ≈650 px (−70%, three comments plus composer plus button, from the measured 168 px median), 90 → ≈30 nodes, and the `Markdown` blocks per drawer render from 13 to 4.
- Esfuerzo: S
- Riesgo: hiding information that the user expected to see; the "20 returned" heuristic cannot tell "exactly 20 comments" from "more than 20" (the backend does not say). The comment tests count comment elements after posting one.
- Evidencia: `--measure` drawer table (comments 3,411 / 2,184 px); `heavy-drawer-checklists.png` shows the drawer's density up to the comment section's start.

### P4 — Lane strip and lane-jump keys
- Estado: implementado en c9db144. Measured: strip 42.5 px in columns mode (5.9% of 720), 10 chips matching the 10 lanes; presses to the last lane 168 (`j`) → 9 (`l` from a card in lane 1; 10 from nothing selected). The `IntersectionObserver` highlight and the lane scroll are tested with a stubbed observer and stubbed rects (jsdom has no layout).
- Síntoma: with 10 lanes only 4 are visible at 1,280 px, the rest hide behind a scroll with no overview; reaching the last lane by keyboard takes 168 presses (medición: board 3,114 / 1,280 px; `j` presses 81 to Triage, 168 to Done).
- Propuesta: in columns mode, show the same lane chips the list mode already has (name + count, one row, ~42 px) above the board; clicking a chip scrolls that lane into view and a lane that is on screen is highlighted. Add `h` / `l` (previous / next lane: scroll into view and select the lane's first card); `j`/`k` keep their meaning. The chip component is already in `ListFocus`; it gets shared.
- Mejora esperada: lanes reachable without touching the horizontal scroll 4 → 10 (the 10 chips measure 1,149 px, they fit 1,280); presses to reach any lane 168 → 1 click or ≤9 key presses; cost 42 px of vertical space (6% of a 720 px pane). With "decenas" of lanes the strip itself scrolls, as it already does in list mode: the improvement then is the click-to-jump and the counts, not that all fit.
- Esfuerzo: M
- Riesgo: the strip duplicates the lane headers; scroll-sync (highlighting visible lanes) needs an `IntersectionObserver`; `h`/`l` must not clash with the existing `j k s c` keys or text inputs (`isTypingTarget`). `visibleCardIds` and its tests do not change.
- Evidencia: `heavy-columns.png` (4 lanes and a cut fifth), `heavy-list.png` (chip bar cut at the fifth chip); `--measure` "Keyboard" and layout tables.

### P5 — Density: comfortable / compact
- Estado: implementado en c9db144. Measured (real Chromium, every card laid out): median card height comfortable 83.5 px, compact 56 px; cards fully visible in the 80-card lane at 1,280×720: 6 → 9 compact (comfortable 6 → 5 because the new 42.5 px strip takes its room); lane 1 scroll height 7,674 → 4,838 px compact; selecting a card moves the next one 30 → 0 px (the actions are an absolutely positioned overlay in both densities).
- Síntoma: a card is 83.5 px at the median and only 34% of it is title; 6 of 80 cards fit on screen (medición: 5 markers per card, label rows 14% of the height, selected card +30 px).
- Propuesta: a `density` setting (`comfortable` = today, `compact`), a segmented control in the settings popover, persisted with the other settings, English and Spanish strings. Compact: title on one line (clamp 1), labels as colour bars without text (the unnamed-label bar already exists; the name goes in `title`), due/checklist/comments/attachments inline on the same row as the avatars (max 3 + `+N`), 6 px padding. The card actions row becomes an overlay on hover/selection that takes no height, so selecting no longer shifts the list in either density.
- Mejora esperada: median card ~83.5 → ~56 px (estimate: title 1 line + one meta row + padding, from the measured parts). Cards fully visible in lane 1: 6 → ~9; lane 1 height 12.5 → ~8–9 screens; no layout shift on selection (113.5 → 83.5 px). A later extension, "auto" (compact only for lanes above N cards, 25 by default), would give the 80-card lane density while the 6-card lanes keep their comfortable look; that is a third value of the same setting, not a different feature.
- Esfuerzo: M
- Riesgo: losing label text on the card (needs the tooltip and a legend in the drawer); contrast of bars; the card DOM contract used by the tests (`card-open` span, `label-chip`, due/checklist markers) must be kept; switching density re-renders every card (cheap only after P2).
- Evidencia: `heavy-columns.png`, `heavy-list.png`; `--measure` "Visual density per card" and card-height rows.

### P6 — Board filters
- Síntoma: in a board of 207 cards there is no way to narrow down (medición: overdue 44 of 207 cards, 20 of lane 1's 80; due within 48 h 18; label `bug` 55).
- Propuesta: a filter bar under the header (collapsed to a button until used): free text on title, member, label, "overdue" / "due within 48 h". Client-side only, over the `view` already in memory. The lane headers show `matches / total`; lanes without matches are dimmed, not removed, so the layout stays; `visibleCardIds` and `j`/`k` follow the filtered order; Escape clears.
- Mejora esperada: overdue filter leaves 20 cards in the 80-card lane (≈2.9 screens at the measured 90 px per card, vs 12.5); poll payload and backend unchanged.
- Esfuerzo: M
- Riesgo: filter state vs. polling and optimistic moves (a card moved out of the filter must not vanish under the cursor); `visibleCardIds` is used by the keyboard tests; selection must be dropped when the selected card is filtered out; member filters depend on `view.members` being complete.
- Evidencia: `--measure` fixture line `filters:`; `heavy-columns.png`.

### P7 — Drawer section tabs, description "show more", heading levels
- Estado: implementado en 4719c73. Measured: px of manual scrolling to reach the comments 3,411 → 0 (one tab click; the comments start 2,319 px into a drawer that went from 6,695 to 4,020 px); description section 1,044 → 321 px; fixed chrome (header + footer) 134 → 100 px (−34: the footer is one row, 71 → 37 px; open-in-Trello, copy link and archive moved to a menu); the sticky tabs cost 36.5 px of the scroller. Heading levels render with different size and weight. The scroll target and the active-tab logic are tested with stubbed geometry; the real `scrollTo` is not exercised (jsdom has no layout, the render is a static page).
- Síntoma: the drawer is 6.9 screens tall with fixed sections and no way to jump (medición: description 1,044 px, comments start at 3,411 px, attachments at 5,608 px); headings of every level look the same.
- Propuesta: a sticky row of section tabs with counts under the title (`Description`, `Checklists 24/60`, `Comments 12`, `Files 6`, `Activity 20`) that scrolls the drawer's own scroller; clamp the description to ~14 lines with a "Show more" button; render heading levels with distinct sizes (the parser already keeps `level`, only the renderer ignores it).
- Mejora esperada: scrolling to reach the comments 3,411 px → 0 (one click); description 1,044 → ≈320 px (−69%, −10% of the whole drawer); the title and the `##` sections become distinguishable. The sticky row costs ~34 px of the 966 px scroller (3.5%).
- Esfuerzo: M
- Riesgo: sticky element inside the drawer's scroller must not cover the section it jumps to; the 134 px of fixed chrome (header + two-row footer) already take 12% of a 1,100 px pane, so the footer should lose a row at the same time (for instance "Open in Trello" and copy-link moved into an overflow menu); drawer tests look sections up by `data-trello`.
- Evidencia: `heavy-drawer.png` (flat headings, description only), `heavy-drawer-checklists.png`; `--measure` drawer table.

### P8 — Checklists: progress, collapse, "pending only", hover actions
- Estado: implementado en 4719c73. Measured: with `Pending only`, item rows 60 → 36 and the checklists section 2,239 → 1,206 px (default view: 1,830 px, rows are 24 px instead of ~31); drawer nodes 871 → 587; drawer buttons 200 → 80 (60 of them are the item checkboxes, which the app draws as buttons); renders per toggle stay at 1 `CardRow`, 1 `ItemRow`, 0 `Markdown`. Edit and delete appear on hover, keyboard focus or a tap on the text. Delete asks inline (Delete / Cancel, focus on Cancel, Escape cancels) instead of an undo toast: an undo can only re-create the item (new position, ticked state lost) and needs toasts with actions. A ticked item stays struck through for 1.2 s under `Pending only`, then leaves.
- Síntoma: 60 items are 2,239 px, 518 nodes (60% of the drawer's nodes) and 120 permanent icon buttons; finished items take as much room as pending ones; trash is one click (medición: 36 of 60 pending, 200 buttons in the drawer).
- Propuesta: per checklist, a collapse toggle and a progress bar next to `8/20`; a drawer-level "Pending only" switch (completed items hidden, the count stays); item edit/trash shown on hover or keyboard focus (with a visible focus state, and a kebab on touch) and trash with an undo toast instead of a silent delete; checklists with every item done start collapsed.
- Mejora esperada: with "pending only", 60 → 36 rows: section ≈2,239 → ≈1,480 px (−34%, from the measured ~31 px average row); hiding the two icon buttons at rest: drawer buttons 200 → ≈80, drawer nodes 871 → ≈630 (−28%, 4 nodes per item). Estimates from measured row height and node counts.
- Esfuerzo: M
- Riesgo: hover-only controls are invisible to touch and must be reachable by keyboard; the optimistic toggle updates the item list while a filter is active (an item must not disappear under the pointer the moment it is ticked, so it leaves the list after a short delay or on next render); rename/delete tests click the icon buttons by their labels; a delete with undo needs a re-create call the backend already has (`addItem`) but ordering is lost.
- Evidencia: `heavy-drawer-checklists.png`; `--measure` drawer table (checklists 2,239 px, 518 nodes, 60 items, 200 buttons).

### P9 — Label and avatar overflow (`+N`)
- Estado: implementado en c9db144. Measured: avatars hidden without a `+N` 28 → 0; label rows wrapped to two lines 9 → 0; truncated label chips without a `title` 43 → 0; meta rows overflowing a card 0 → 0 (both densities).
- Síntoma: information is lost silently on the card (medición: 28 avatars hidden across 20 cards, 43 label chips truncated, 9 label rows wrapped to a second line).
- Propuesta: avatars: show 3 and a `+N` chip with the remaining names in its `title`; labels: show up to 3 chips (max width 5 rem so three fit a 300 px lane on one line) and a `+N` chip with the rest in the `title`; give every truncated chip a `title`.
- Mejora esperada: hidden avatars 28 → 0 (counted instead of dropped); wrapped label rows 9 → 0; card height variance shrinks (range 59.5–123 px today). Truncated chips will go **up** with a narrower chip: the `title` and the drawer carry the full name.
- Esfuerzo: S
- Riesgo: label identity at a glance (colour plus the first characters); the 5 rem width is a guess for 3 chips in 262 px of card content; tests count `label-chip` elements on cards.
- Evidencia: `heavy-columns.png` (the `customer-escalation…` chips cut by the ellipsis, the first card's label row wrapped onto a second line); `--measure` "Visual density per card" and fixture line (28 hidden avatars on 20 cards).

### P10 — Virtualized lanes
- Síntoma: 2,229 nodes and 313 ms of dev-mode mount for 207 cards; cost grows linearly to the backend's 1,000-card limit (medición: 0.9–1.3 ms per card to mount, 10.4 nodes per card).
- Propuesta: render only the cards in (and a little around) each lane's viewport, and only the lanes near the horizontal viewport, using a hand-written windowing hook on the lane scroller with measured heights (cards range 59.5–123 px). No dependency may be added.
- Mejora esperada: nodes 2,229 → ≈700 (≈5 lanes × ≈12 cards plus chrome; estimate), mount ≈313 → ≈100 ms (same estimate), memory in proportion.
- Esfuerzo: L
- Riesgo: high. Variable-height windowing without a library is easy to get subtly wrong; `scrollIntoView` for `j`/`k` on a card that is not mounted, the sticky lane header, find-in-page, selection and the open drawer must all survive; keyboard and focus order change. Every existing layout test queries cards that would no longer exist.
- Evidencia: `--measure` DOM table; the cost only matters at much larger boards than the fixture, which is why it is last.

### How the proposals relate

**Mutually exclusive**

- **P1 and P10.** Both answer "too many cards laid out", by different means: P1 is a CSS rule that keeps every node, P10 removes nodes and costs a windowing implementation. Do P1; revisit P10 only if boards reach several hundred cards per lane **after** P2, or if profiling in the real app shows mount time, not layout, is the pain.

**Better done together**

- **P5 + P9.** Compact mode needs the same overflow rules (avatars `+N`, labels as bars), and P1's `containIntrinsicSize` has to follow the density (84 px comfortable, ~56 px compact) or the scroll extent is wrong by about 35%.
- **P2 first, then P5.** Switching density re-renders every card; with the current board-wide re-render that is 207 cards at ~25–30 ms (dev), after P2 the switch stays cheap and memoization must include `density` in the card's props.
- **P4 + P6.** The lane strip is the natural place for `matches / total` per lane; a filter hides cards, the strip tells where the matches are.
- **P7 + P8 + P3.** All three edit the drawer: the section tabs carry the counts (`Checklists 24/60`, `Comments 12`), "pending only" and the comment window change what those counts mean, and the footer's second row is shared space.

**Independent**: P1, P2, P3 and P9 touch separate pieces and can be taken in any order.

**Suggested waves** (judgment, not a measurement): A = P1 + P2 (no visible change, safe); B = P4 + P5 + P9 (navigation and density: what the user asked for); C = P7 + P8 + P3 (drawer); D = P6 (filters). P10 stays on the shelf.

**Not proposed**: new skeletons for big boards (A7: no measured pain); collapsible lanes as a separate item (P4's strip covers jumping, P6's filters cover narrowing; a collapse-to-rail can be added to P4 if wanted); paging the board view (backend concern, noted above).
