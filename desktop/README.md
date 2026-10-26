# Desktop pane (`plugin.js`)

The renderer half of Trello Browser: one plain-ESM file, no build step, no JSX.
It imports only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, and talks
to nothing but this plugin's own backend (`dashboard/plugin_api.py`) through
`ctx.rest()`. The API key and token never reach the renderer.

## Layout

The mode is decided from the pane's own width, measured with a `ResizeObserver`
(never `window.innerWidth`):

| Width | Mode | What you see |
|---|---|---|
| `< 560 px` | list focus | list chips with card counts, one list of cards at a time |
| `>= 560 px` | columns | one lane per list, horizontal scroll, header with the card count |

List mode always starts with a strip of list chips (name + card count, one row, about 42 px,
horizontal scroll; the chips are tabs). Columns mode shows the same strip **only when the lanes
do not fit** the measured pane width (`lanesFit`: lanes x lane width + 10 px gaps + 24 px
padding), so a board of four lanes in a wide pane gets its 42 px back. A click on a chip scrolls
that lane into view and the lanes that are on screen are highlighted (an `IntersectionObserver`
on the lanes).

Cards are built for long lanes: each one carries `content-visibility: auto` with a
`contain-intrinsic-size` estimate, so the browser skips style and layout for cards that are
off screen. Consequences to know about:

- The scrollable height of a lane is an estimate until its cards have been laid out
  (`CARD_ESTIMATED_HEIGHT`: 84 px comfortable, 56 px compact, close to the median card; the
  value handed to CSS is the content box, so `CARD_CHROME_HEIGHT` is subtracted). The
  scrollbar thumb can move a little while you scroll.
- The browser's find-in-page does not see skipped cards.
- `scrollIntoView` on a card that is not laid out yet (keyboard selection, `l`/`h`) works
  through the estimate. jsdom has no layout, so the tests only assert the styles; this
  has to be exercised in the real app.

Cards also have two densities (Settings > Card density): comfortable, and compact (one-line
title, labels as colour bars, meta and avatars on one row). Labels show at most three, avatars
at most three, each with a `+N` chip whose `title` names the rest.

The card's actions (send to agent, open in Trello, move menu) appear on hover, on keyboard focus
and on the selected card, **in the place of the avatars** at the right of the meta row (the row with
the due date, checklist, comment and attachment counts). The meta row is a sibling of the title
button, not inside it. The avatars stay in the flow, hidden, and the actions sit on top of that
same box, so nothing reflows: the card keeps its height, the actions never cover text, and the
slot always reserves room for three buttons. A card with nothing to show in that row (no due
date, counts or people) therefore keeps an empty row about 18 px tall.

Cards, checklist items and Markdown blocks are memoized and receive only the props they use,
so a poll that changes nothing renders no card, and a selection change renders two.

The card drawer opens on the right **inside the pane**, never as a modal over the
chat.

## Card drawer

- **Sections.** A sticky row under the title has one tab per section with its count:
  `Description`, `Checklists 24/60` (done/total over every item), `Comments 12`, `Files 6`,
  `Activity 20`. A click scrolls the drawer's own scroller (`scrollTo` on it, never
  `scrollIntoView`, which would also move the chat around the pane) to the section, below the sticky
  row; while scrolling, the section that has reached the row is highlighted. With a drawer narrower
  than about 400 px the row scrolls sideways.
- **Description.** Clamped to 14 lines with `Show more` / `Show less`. The button exists only when the text
  overflows: measured where there is a layout, estimated from the text length (`estimateLines`)
  where there is none. Headings render by level (`#` to `####`) with different size and weight.
- **Footer.** One row: send to agent, suggest checklist, and a `...` menu with open in Trello, copy link and archive.
- **Checklists.** Each one has a collapse toggle, a progress bar and `done/total`; a checklist whose items are
  all done starts collapsed (decided once, when it first appears: ticking the last item never folds it
  under the pointer). `Pending only` hides the done items but keeps every count. An item ticked
  while it is on stays in the list, struck through, for 1.2 s (`PENDING_SETTLE_MS`, through
  `ctx.setTimeout`) and then leaves, never in the same render. Edit and delete are not drawn at rest: they appear on
  hover, on keyboard focus anywhere in the row, and after a tap on the item text (touch).
  **Delete asks inline first** (`Delete this item?` with Delete / Cancel; focus starts on Cancel, Escape
  cancels). An undo toast was rejected: undo can only re-create the item (new position, ticked state
  lost) and relies on the host showing toasts with actions; asking first loses nothing.
- **Markdown.** Descriptions and comments are parsed by hand into React elements (never an HTML string).
  Blocks: paragraphs (line breaks kept), headings `#`..`######`, fenced code, `>` quotes (up to three
  levels), `---` / `***` rules, GFM tables (header, `:--` `:-:` `--:` alignment, uneven rows padded or cut,
  wide tables scroll on their own) and lists up to two levels deep (the second level indented two or more
  spaces; a third is flattened into it) with task items `- [ ]` / `- [x]` drawn as read-only boxes.
  Inlines: `code`, **bold**, *italic*, ~~strike~~, `[links]()`, bare `https://` URLs, backslash escapes
  and images. Only `http(s)` and `mailto:` links are clickable. Malformed input never throws and the parser
  is linear (marker lookups are memoized; nothing backtracks), which `markdown.test.mjs` checks with 10 000
  characters of every nasty pattern.
- **Images.** `imagePolicy(url)` decides what may load: `null` when the scheme is not http(s); otherwise the
  host and whether it is a Trello host over https (`trello.com`, `trello-attachments.com`,
  `trello-attachments.s3.amazonaws.com` and their subdomains, no credentials in the URL). A Trello-hosted
  image in markdown renders inline (lazy, no referrer, at most 20 rem tall, click opens the original in the OS
  handler). Any other host shows a chip `host + alt` with **Load image** and an *open in browser* link, and
  nothing is requested until the reader presses the button, so a description cannot make the pane call a
  third party by being opened. A picture that fails to load falls back to the chip (markdown) or to the
  icon (attachments). Whether Trello's own picture URLs load without the browser's Trello session depends on
  the board's privacy; that is not something this pane can check, hence the fallbacks.
- **Attachments.** An image Trello made a preview of is a row with a 4 rem thumbnail (the backend's
  `thumb_url`, the smallest preview), name and size; a click opens the original. Other files are an icon, a
  link and a size. An image from a non-Trello host is an icon row plus the same consent chip. Thumbnails are
  `loading="lazy"`, so they are fetched when the row is near the screen.
- **Checklist rows.** Each item is a row of its own (4 px padding, a hairline under it, a tint under the
  pointer or the keyboard focus). The empty box has a 1.5 px border in the theme's ink colour at 54%
  (`--ui-text-tertiary`), so it reads on a dark and on a light theme, a darker one on hover or focus; a ticked
  box keeps the theme accent. A done item is struck through and drawn in the tertiary text colour. Contrast against
  the drawer background (computed from the stylesheet's values): empty box border 5.2:1 dark and 3.8:1 light
  (the SDK box it replaces had a 1.07:1 border on the dark theme); done text 5.2:1 and 3.8:1.
- **Comments.** The composer and the 3 newest comments (newest first by date); `Show N more` reveals the
  rest of what the API already returned, with no new request. A comment longer than 6 lines is
  clamped with its own `Show more`. The backend returns at most 20 comments and cannot say whether
  there were more, so with exactly 20 the drawer adds `Older comments are in Trello` and an
  open-in-Trello action.

## Data and refresh

- All reads and writes use the app's React Query client (`useQuery`,
  `useMutation`); there are no timers or hand-rolled polls.
- `refetchInterval` (default 25 s, configurable, or off) only returns a number
  while `host.paneVisibility('trello-browser:pane')` is true. Queries also refetch on
  window focus, and once when the pane is revealed.
- Optimistic updates, with rollback and an error toast: **checklist toggles** and
  **moving a card**. Everything else waits for the server.
- If a refetch fails, the last good payload stays on screen with a "saved data"
  strip; a 429 shows a quieter rate-limit strip.
- Without credentials the pane shows the connect form (API key + token). The
  values are sent once to `POST /credentials`, then cleared from the form.

## Send to the agent

The block is built by `buildCardBlock()` (pure, covered by `tests/desktop`) and
follows `docs/ARCHITECTURE.md` section 4.1: description capped at 1200 characters,
the latest 3 comments at 300 characters each, at most 40 checklist items (20 per
checklist). Card text is untrusted: control characters are removed and any run of
three or more dashes is collapsed so a card cannot forge the
`--- end card data ---` marker.

| Gesture | Result |
|---|---|
| click `Send to agent` | **insert** into the composer (`insertText`, block mode); no turn is spent |
| `Shift`+click, or setting `Send to agent = Send` | **submit** (`host.composer.submit`) |

If no composer answers, the pane starts a new chat (`host.newChat()`) and retries
against the fresh draft; then it copies the block to the clipboard; if even that
fails it shows the block in a dialog with a copy button. The payload is never
dropped silently.

## `Suggest checklist` (button only)

The drawer button inserts the card block plus a prepared instruction ("Propose a QA
checklist for this card as a list; do not write it to Trello yet."). The user
presses Enter. **No model call happens in the renderer.**

`// TODO(P3): ctx.llm via slash command` marks the place to change: the model call
has to run in the gateway (`ctx.llm` does not exist in the dashboard process), so
P3 registers a plugin slash command and the button runs it with
`host.request('slash.exec', ...)`, previewing the result before anything is
written. The insert-a-prompt behaviour stays as the fallback. See
`docs/ARCHITECTURE.md` sections 4.3 and 5.6.

## Keyboard (pane focused, not while typing)

`j` / `k` move the selection, `h` / `l` jump to the previous / next list (scroll it into view and
select its first card; lists without cards are skipped), `Enter` opens the card, `Esc` closes the
drawer, `s` sends the selected card, `c` copies its link.

## Settings (gear in the header)

Send mode (insert / send), refresh interval (off, 15, 25 or 60 s), card density
(comfortable / compact), default board and the
credentials section below. Values live in `ctx.storage`; the last board is remembered there too.

### Credentials

The **scope** selector decides where the next Connect / Change account / Disconnect acts:
**This profile** (default) or **All profiles**. Switching it never moves or copies anything that
is already stored. The status line always says which account this profile is really using.

| State (from `GET /credentials`) | Shown | Actions |
|---|---|---|
| `source: "env"` | Using environment credentials; selector disabled with a tip | none (remove `TRELLO_API_KEY` / `TRELLO_TOKEN` to configure here) |
| `source: "profile"` | Using credentials for this profile | Change account, Disconnect |
| `source: "app"` | Using credentials for all profiles, or, with This profile chosen, "Using the app-wide account for this profile" | Change account + Disconnect for the chosen scope; if it holds nothing yet, Connect this profile |
| a profile file overriding an app-wide one | also "This profile overrides the app-wide account" | Remove this profile's connection |
| nothing stored | No credentials stored | Connect |

Choosing **All profiles** first asks for confirmation (other profiles without their own connection
will use that account; profiles that have their own keep it) and only persists the choice if you
confirm. **Change account** and **Connect** open the same `ConnectForm` as the empty state in a dialog;
it posts `{api_key, token, scope}` and, on success, resets everything cached from the previous account.

## Transcript directive

The agent can write `::trello{card="<id or short link>"}` as a paragraph of its own and the
chat renders a live chip: card name, list, due date and an "Open in Trello" button
(`ctx.os.openExternal`). The card is loaded with `GET /cards/<id>` only when a directive
appears; while loading the chip is a `Skeleton`. An invalid id, a 404 or any backend error
degrades to a minimal chip holding the (truncated) attribute text, so the message never breaks.

## Errors

Each cause has its own copy: backend not mounted for the active profile (a 404 whose body
says `Plugin not found`), no connection to the backend (network error or a bare 502/503/504),
Trello unreachable (the backend's own 503), rate limiting, and the two credential cases
(`not_connected`, `credentials_rejected`), which show the connect form instead.

## Known limits (v1)

- Card activity shows the last 20 actions the backend returns (created, updated, comments,
  checklist changes), with no pagination.
- No drag and drop between lists (moving uses a menu).

## Tests

```bash
node --test tests/desktop/            # or: node --test tests/desktop/*.test.mjs
```

`helpers.test.mjs` covers the pure logic and static rules over `plugin.js`
(imports, colors, classes, i18n parity). `render.test.mjs` mounts the pane with an
SDK stub and a synthetic in-memory backend: no network, no app. `heavy-board.test.mjs` does
the same with a 207-card board and counts renders per component (a copy of `plugin.js` with a
counting JSX runtime; the plugin itself is never instrumented), and checks the density,
overflow and lane-navigation behaviour. None of them depends on real layout.

The tests need `react`, `react-dom`, `jsdom`, `nanostores` and `@nanostores/react`.
They are looked up in the nearest `node_modules` above the repository, or in
`$TRELLO_TEST_NODE_MODULES`; without them the desktop tests are skipped, not
faked. Install them anywhere with
`npm i --no-save react react-dom jsdom nanostores @nanostores/react`.
