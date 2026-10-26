Regenerate with `node scripts/render_screenshots.mjs --css <compiled app index.css>` (also needs Chromium and the codicon font: `--codicon-font <codicon.ttf>`, or set `TRELLO_APP_CSS` / `TRELLO_CODICON_FONT`; see the script header).
These are renders of the plugin's own test harness (jsdom, no network) styled with the app's real compiled CSS and default dark theme, with a pinned clock, timezone and locale: the same inputs give byte-identical PNGs.
All data is synthetic (the same cards as `scripts/seed_demo_board.py`); the card drawer is taller than the pane because it scrolls in the app.
