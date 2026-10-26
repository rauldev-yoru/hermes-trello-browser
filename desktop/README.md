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

The card drawer opens on the right **inside the pane**, never as a modal over the
chat.

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

`j` / `k` move the selection, `Enter` opens the card, `Esc` closes the drawer,
`s` sends the selected card, `c` copies its link.

## Settings (gear in the header)

Send mode (insert / send), refresh interval (off, 15, 25 or 60 s), default board,
and **Disconnect** (`DELETE /credentials`). Values live in `ctx.storage`; the last
board is remembered there too.

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
SDK stub and a synthetic in-memory backend: no network, no app.

The tests need `react`, `react-dom`, `jsdom`, `nanostores` and `@nanostores/react`.
They are looked up in the nearest `node_modules` above the repository, or in
`$TRELLO_TEST_NODE_MODULES`; without them the desktop tests are skipped, not
faked. Install them anywhere with
`npm i --no-save react react-dom jsdom nanostores @nanostores/react`.
