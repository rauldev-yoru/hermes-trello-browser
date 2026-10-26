Regenerate with:

```bash
node scripts/render_screenshots.mjs \
  --css <the app's compiled dist/assets/index-*.css> \
  --codicon-font <node_modules/@vscode/codicons/dist/codicon.ttf>
```

`--css` is required (`TRELLO_APP_CSS` also works). The codicon font is optional —
without it the script warns and draws empty icon boxes — but pass it for faithful
images; it has to match the `@vscode/codicons` version the app ships.
`--only <scene>` renders a subset, `--keep-html <dir>` writes the intermediate
pages for debugging. Chromium/Chrome is auto-detected on PATH.

These are renders of the plugin's own test harness (jsdom, no network) styled with
the app's real compiled CSS and its default dark theme, with a pinned clock,
timezone and locale — the same inputs give byte-identical PNGs. All data is
synthetic and matches `scripts/seed_demo_board.py`; nothing here comes from a real
board. The card drawer is taller than the pane because it scrolls inside the app.

Two things differ from the running app. The renders are offline, so each Trello-hosted
`<img>` (which the pane loads by itself) gets a small synthetic picture instead; images from
other hosts are not loaded by the pane until the reader asks, and show as the chips they are.
And `heavy-drawer-checklists-light.png` is the one scene drawn with the stylesheet's own light
theme; every other scene uses the default dark one.
