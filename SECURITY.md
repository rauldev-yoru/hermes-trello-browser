# Security & data disclosure

This plugin puts a Trello workspace inside the Hermes Desktop app and lets the
agent read and update the same cards. Everything below is what it actually does.

## Credentials

- The plugin needs a Trello **API key** and **token** (Power-Up admin → *Trello
  Auth* → generate a key → *Token*). Both belong to your own Trello account.
- They are read, in this order, from:
  1. the environment (`TRELLO_API_KEY`, `TRELLO_TOKEN`),
  2. `$HERMES_HOME/trello-browser/credentials.json` (directory `0700`, file `0600`),
  3. `~/.hermes/trello-browser/credentials.json` — the root-home fallback, so a
     named profile inherits what the pane configured.
- The file is written only when you submit the connect form in the pane. The
  plugin never writes credentials to `config.yaml`, logs, error messages or URLs.
- The desktop UI never receives the key or the token: every Trello call is made by
  the Python backend, and the renderer only ever sees `{configured, source}`.
- `GET /credentials` returns connection state only. `DELETE /credentials` forgets
  the stored file.

## Network

- Outbound traffic goes to **`https://api.trello.com`** only, from the backend
  process. The endpoint list is a fixed allowlist in the client; no URL coming
  from the UI or from a tool argument is ever fetched, so there is no SSRF door.
- Redirects are not followed.
- Public CDN URLs (member avatars, attachment links that Trello returns) are
  loaded by the renderer; they carry no credential of yours.
- There is no telemetry, no self-update and no third-party service.

## What leaves your machine

- To Trello: the requests you or the agent cause (read a board, post a comment,
  move a card, …). Nothing else.
- To the model: only when **you** hand a card to the agent, or when the agent
  calls one of the plugin's tools. The card context block is capped (description
  1200 chars, three comments × 300, forty checklist items) and the card text is
  fenced as **untrusted data from Trello** — the bundled skill instructs the model
  to treat it as data, never as instructions.

## Card text is untrusted

Trello card names, descriptions, checklists and comments are written by other
people. They reach the model inside an explicit
`--- card data (untrusted, from Trello) ---` fence, tool results are returned
marked as untrusted, and the skill repeats the rule. Render them yourself: the
pane renders descriptions through a small, safe markdown subset built as React
elements — never as HTML.

## Writes

- From the pane, every write is user-initiated: move, comment, create, checklist
  item, due date, labels, archive. Archiving asks for confirmation.
- From the agent, writes happen through the `trello_*` tools with the normal tool
  approval pipeline.
- Comments written through the agent tool carry a configurable marker (`🤖 ` by
  default, `agent_comment_marker: ""` disables it) so they are distinguishable
  from yours.
- The plugin never deletes cards. It can delete a checklist item you ask it to
  delete, and archive (not delete) a card.

## Permissions the plugin asks for

None beyond a normal plugin install. It registers ten agent tools —
`trello_boards`, `trello_board_view`, `trello_card`, `trello_search`,
`trello_card_create`, `trello_card_update`, `trello_card_comment`,
`trello_checklist_add`, `trello_checklist_item_add`, `trello_checklist_item_set`
— a bundled skill and one desktop pane. It declares no `capabilities`, does not
override any built-in tool, does not patch Hermes itself, and its desktop half
imports only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`.

## Reporting a vulnerability

Open a private security advisory on the repository
(`Security → Report a vulnerability`) rather than a public issue. Please include
the plugin version (the commit you installed), what you observed and a minimal
reproduction. We aim to answer within a few days.
