# Trello Browser for Hermes

Boards, lists and cards in a Hermes Desktop pane — and a button that hands a card
to the agent, which then reads and updates it through tools.

- Pane beside the chat: board picker, lists, cards, card detail (description,
  checklists, comments, attachments, activity).
- Writes from the pane: move, comment, create, check items, due, labels, archive.
- Handoff: one click puts a compact card context block in the composer
  (`Shift` sends it straight away); the agent works with the plugin's `trello_*`
  tools and the pane reflects the change.
- Credentials stay in the backend process; the renderer never sees them.

Status: **pre-alpha**, under active development.

Design and scope: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Install

```bash
hermes plugins install rauldev-yoru/hermes-trello-browser --enable
```

Then open the pane from the command palette and paste a Trello **API key** and
**token** (Power-Up admin → *Trello Auth* → generate key → *Token*). Both are
required: a token is only valid with the key that issued it.

MIT licensed.
