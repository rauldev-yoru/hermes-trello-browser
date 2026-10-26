#!/usr/bin/env node
// Render the README screenshots (docs/screenshots/*.png) from the plugin's own render harness.
//
//   node scripts/render_screenshots.mjs --css <path-to-compiled-app-index.css>
//
// How it works: the real pane (desktop/plugin.js) is mounted in jsdom against the harness's synthetic backend
// (no network), the DOM is serialized into a static page together with the app's compiled stylesheet and the
// default dark theme variables, and headless Chromium takes the screenshot. Every datum is synthetic and the
// clock, timezone and locale are pinned, so the same inputs always produce the same images.
//
// The browser is driven over the DevTools protocol (a pipe, no sockets) instead of `--screenshot --window-size`:
// headless Chromium enforces a minimum window width and reserves part of the window height for its own chrome,
// so the page would be laid out in a smaller viewport than requested and the image cropped. With a metrics
// override the viewport is exactly the requested size.
//
// Inputs (flag, then environment variable):
//   --css <file>            TRELLO_APP_CSS        compiled app stylesheet (required)
//   --chromium <file>       TRELLO_CHROMIUM       Chromium/Chrome binary (default: first of chromium-browser,
//                                                 chromium, google-chrome(-stable), chrome found on PATH)
//   --codicon-font <file>   TRELLO_CODICON_FONT   codicon.ttf matching the app's @vscode/codicons version. Also
//                                                 looked up next to the CSS and in node_modules/@vscode/codicons
//   --out <dir>             (default docs/screenshots)
//   --only <name>[,<name>]  render a subset: pane-list, pane-columns, card-drawer, directive-chip, connect, stress,
//                           heavy-columns, heavy-compact, heavy-list, heavy-drawer, heavy-drawer-checklists
//   --keep-html <dir>       also write the intermediate HTML pages there (debugging)
//   --allow-missing-font    continue without the icon font (icons render as empty boxes)
//   --measure               do not write images: measure DOM size, render counts, drawer cost and real-Chromium
//                           layout on the heavy fixture, print tables (see docs/UI-REVIEW.md)
//   --measure-out <file>    with --measure: also write the raw numbers as JSON
//   --report-memory         print this process' peak RSS and the cgroup's memory.peak when done
//
// Exit codes: 0 ok, 2 bad usage / CSS missing, 3 Chromium missing, 4 test dependencies missing,
// 5 icon font missing, 6 Chromium produced no usable image.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// Pin timezone and locale before anything formats a date: Node reads them at startup, so re-run once.
if (process.env.TRELLO_SHOTS_CHILD !== '1') {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, TRELLO_SHOTS_CHILD: '1', TZ: 'UTC', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', LANGUAGE: 'en_US' },
    stdio: 'inherit'
  })

  process.exit(run.status ?? 1)
}

const fail = (code, message) => {
  console.error(`render_screenshots: ${message}`)
  process.exit(code)
}

// -- arguments ----------------------------------------------------------------

function parseArgs(argv) {
  const out = { help: false, allowMissingFont: false }
  const takes = new Set(['--css', '--chromium', '--codicon-font', '--out', '--only', '--keep-html', '--measure-out'])

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') {
      out.help = true
    } else    if (arg === '--allow-missing-font') {
      out.allowMissingFont = true
    } else if (arg === '--require-font') {
      out.requireFont = true
    } else if (arg === '--measure') {
      out.measure = true
    } else if (arg === '--report-memory') {
      out.reportMemory = true
    } else if (takes.has(arg)) {
      if (i + 1 >= argv.length) {
        fail(2, `${arg} needs a value`)
      }

      out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[(i += 1)]
    } else {
      fail(2, `unknown argument: ${arg}`)
    }
  }

  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
  process.exit(0)
}

// -- scenes -------------------------------------------------------------------

const SCENES = [
  // heights are cropped to the content: a pane screenshot should end where the board ends
  { name: 'pane-list', width: 480, height: 442 },
  // 4 lanes of 300 px + gaps + padding need 1254 px; at 1200 the last lane would be cut by the horizontal scroll
  { name: 'pane-columns', width: 1280, height: 430 },
  // the drawer scrolls inside a 780 px pane; description + checklist + comments + activity need about 1075 px
  { name: 'card-drawer', width: 480, height: 1080 },
  { name: 'directive-chip', width: 560, height: 140 },
  { name: 'connect', width: 480, height: 560 },
  // scroll stress: a tall lane must scroll, and 12 lanes must scroll sideways
  { name: 'stress', width: 900, height: 600 },
  // heavy work board (UI review): 10 lanes with 80 cards in the first, and a card with a very long drawer
  { name: 'heavy-columns', width: 1280, height: 720 },
  { name: 'heavy-list', width: 480, height: 760 },
  // the same board in compact density (Settings > Card density)
  { name: 'heavy-compact', width: 1280, height: 720 },
  { name: 'heavy-drawer', width: 520, height: 1100 },
  // the same drawer scrolled to where the checklists start: 60 items, what the owner scrolls through
  { name: 'heavy-drawer-checklists', width: 520, height: 1100, scrollTo: '[data-trello="checklists"]' }
]

const only = args.only ? new Set(args.only.split(',').map(s => s.trim()).filter(Boolean)) : null

if (only) {
  const unknown = [...only].filter(n => !SCENES.some(s => s.name === n))

  if (unknown.length) {
    fail(2, `unknown scene(s): ${unknown.join(', ')}`)
  }
}

// -- preflight ----------------------------------------------------------------

const cssPath = args.css || process.env.TRELLO_APP_CSS

if (!cssPath) {
  fail(2, 'the compiled app stylesheet is required: pass --css <file> or set TRELLO_APP_CSS')
}

if (!fs.existsSync(cssPath) || !fs.statSync(cssPath).isFile()) {
  fail(2, `stylesheet not found: ${cssPath}`)
}

function findOnPath(names) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name)

      try {
        fs.accessSync(candidate, fs.constants.X_OK)

        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        // not here
      }
    }
  }

  return null
}

const chromium = args.chromium || process.env.TRELLO_CHROMIUM || findOnPath(['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome', 'chrome'])

if (!chromium || !fs.existsSync(chromium)) {
  fail(3, 'Chromium not found: install it, or pass --chromium <file> / set TRELLO_CHROMIUM')
}

const { findNodeModules, SKIP_REASON, makeBackend, makeCtx, setupDom, oid, COUNT_SHIM, applyHeavyFixture: heavyFixture } = await import(pathToFileURL(path.join(ROOT, 'tests', 'desktop', 'harness.mjs')).href)
const modules = findNodeModules()

if (!modules) {
  fail(4, SKIP_REASON)
}

const css = fs.readFileSync(cssPath, 'utf8')

function findCodiconFont() {
  const explicit = args.codiconFont || process.env.TRELLO_CODICON_FONT

  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null
  }

  const candidates = []
  const declared = /@font-face\{[^}]*font-family:codicon[^}]*url\(([^)?]+)/.exec(css)

  if (declared) {
    candidates.push(path.resolve(path.dirname(cssPath), declared[1].replace(/^['"]|['"]$/g, '')))
  }

  for (const start of [process.cwd(), ROOT, path.dirname(modules)]) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      candidates.push(path.join(dir, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf'))

      if (path.dirname(dir) === dir) {
        break
      }
    }
  }

  return candidates.find(c => fs.existsSync(c)) || null
}

const fontPath = findCodiconFont()
let fontCss = ''

if (fontPath) {
  const bytes = fs.readFileSync(fontPath)
  const magic = bytes.subarray(0, 4).toString('latin1')

  if (!['\u0000\u0001\u0000\u0000', 'true', 'OTTO'].includes(magic)) {
    fail(5, `not a TrueType font: ${fontPath}`)
  }

  fontCss = `@font-face{font-family:codicon;font-display:block;src:url(data:font/ttf;base64,${bytes.toString('base64')}) format("truetype")}`
} else if (args.requireFont) {
  fail(5, 'icon font not found. The pane draws its icons with the codicon font, which is not part of the stylesheet. Pass --codicon-font <codicon.ttf> (same @vscode/codicons version as the app) or set TRELLO_CODICON_FONT')
} else {
  console.warn('warning: icon font not found — icons render as empty boxes. Pass --codicon-font <codicon.ttf> (same @vscode/codicons version as the app) for faithful screenshots.  [--require-font makes this fatal]')
}

// -- fixed clock (installed before anything reads the time) -------------------

const NOW = Date.parse('2026-10-26T15:00:00.000Z')
const RealDate = Date

class FixedDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) {
      super(NOW)
    } else {
      super(...a)
    }
  }

  static now() {
    return NOW
  }
}

globalThis.Date = FixedDate

// -- load the pane against the visual SDK -------------------------------------

/**
 * Load a private copy of the pane against an SDK: `sdk-visual.mjs` (class-faithful markup, the screenshots)
 * or `sdk-stub.mjs` (the one the tests use; its checkboxes really toggle). `count` adds the render counter.
 */
async function loadVisualPlugin({ sdkFile = 'sdk-visual.mjs', count = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-shots-'))
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir')
  fs.copyFileSync(path.join(ROOT, 'tests', 'desktop', 'sdk-stub.mjs'), path.join(dir, 'sdk-stub.mjs'))
  fs.copyFileSync(path.join(HERE, 'screenshots', 'sdk-visual.mjs'), path.join(dir, 'sdk-visual.mjs'))

  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'plugin.js'), 'utf8')
  let rewritten = source.replace("from '@hermes/plugin-sdk'", `from './${sdkFile}'`)

  if (rewritten === source) {
    fail(4, 'desktop/plugin.js no longer imports from @hermes/plugin-sdk')
  }

  if (count) {
    const counted = rewritten.replace("from 'react/jsx-runtime'", "from './jsx-count.mjs'")

    if (counted === rewritten) {
      fail(4, "desktop/plugin.js no longer imports from 'react/jsx-runtime'")
    }

    rewritten = counted
    fs.writeFileSync(path.join(dir, 'jsx-count.mjs'), COUNT_SHIM)
  }

  fs.writeFileSync(path.join(dir, 'plugin.mjs'), rewritten)

  return {
    dir,
    plugin: await import(pathToFileURL(path.join(dir, 'plugin.mjs')).href),
    sdk: await import(pathToFileURL(path.join(dir, sdkFile)).href)
  }
}

// -- synthetic fixture (names and content mirror scripts/seed_demo_board.py) ---

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const iso = offsetMs => new RealDate(NOW + offsetMs).toISOString()

function applyFixture(backend) {
  const { state } = backend
  const B1 = backend.ids.B1
  const M1 = backend.ids.M1
  const M2 = oid(21)
  const L = backend.ids.L
  const lab = { bug: oid(31), onboarding: oid(32), copy: oid(33), design: oid(34), a11y: oid(35) }

  state.boards = [
    { id: B1, name: 'Trello Browser Demo', url: 'https://trello.com/b/dEmO0001', closed: false, starred: true },
    { id: oid(9), name: 'Sandbox', url: 'https://trello.com/b/sNdB0002', closed: false, starred: false }
  ]

  const lists = [
    { id: L.backlog, name: 'Backlog', pos: 1, closed: false },
    { id: L.doing, name: 'In progress', pos: 2, closed: false },
    { id: L.review, name: 'Review', pos: 3, closed: false },
    { id: L.done, name: 'Done', pos: 4, closed: false }
  ]

  const labels = [
    { id: lab.bug, name: 'bug', color: 'red' },
    { id: lab.onboarding, name: 'onboarding', color: 'blue' },
    { id: lab.copy, name: 'copy', color: 'yellow' },
    { id: lab.design, name: 'design', color: 'purple' },
    { id: lab.a11y, name: 'a11y', color: 'green' }
  ]

  const make = (n, short, name, list, names, extra) => ({
    id: oid(100 + n), name, id_list: list, due: null, due_complete: false,
    labels: names, label_ids: names.map(x => lab[x]), id_members: [],
    short_link: short, url: `https://trello.com/c/${short}`,
    comment_count: 0, attachment_count: 0, checklist: { total: 0, done: 0 }, last_activity: iso(-2 * HOUR), ...extra
  })

  const cards = [
    make(1, 'aB3xK9mQ', 'Onboarding — step 2 has no way out when cancelling', L.doing, ['bug', 'onboarding'], { due: iso(20 * HOUR), id_members: [M1, M2], comment_count: 2, checklist: { total: 4, done: 2 }, last_activity: iso(-25 * 60 * 1000) }),
    make(2, 'pQ7wZ2nL', 'Search empty state has no copy', L.doing, ['copy'], { due: iso(-1 * DAY), id_members: [M2], checklist: { total: 3, done: 3 } }),
    make(3, 'xR4tY8vC', 'Export the report to CSV', L.backlog, ['design'], { comment_count: 1, last_activity: iso(-1 * DAY) }),
    make(4, 'kM2dF6sH', 'Migrate tooltips to the new component', L.doing, ['design', 'copy'], { due: iso(7 * DAY), id_members: [M1], checklist: { total: 4, done: 0 } }),
    make(5, 'hN9bG3uJ', 'AA contrast on the secondary button', L.review, ['a11y'], { comment_count: 2, id_members: [M2] }),
    make(6, 'cT5eV1oW', 'Unify date formatting', L.done, [], { due: iso(-2 * DAY), due_complete: true, checklist: { total: 3, done: 3 }, comment_count: 1, last_activity: iso(-2 * DAY) })
  ]

  state.view = {
    board: { ...state.boards[0], closed: false },
    lists,
    cards,
    members: [
      { id: M1, username: 'ada', full_name: 'Ada Demo', initials: 'AD', avatar_url: null },
      { id: M2, username: 'lin', full_name: 'Lin Demo', initials: 'LD', avatar_url: null }
    ],
    labels
  }

  const first = cards[0]

  state.details = {
    [first.id]: {
      card: first,
      desc: 'Pressing **Cancel** on step 2 closes the modal but leaves the session half-done.\n\nReproducible on Safari; on Chrome only after navigating back.',
      list: { id: L.doing, name: 'In progress' },
      board: { id: B1, name: 'Trello Browser Demo' },
      checklists: [
        {
          id: oid(40), name: 'QA',
          items: [
            { id: oid(41), name: 'Reproduce on Safari', state: 'complete' },
            { id: oid(42), name: 'Inspect the cancel handler', state: 'complete' },
            { id: oid(43), name: 'Reset the session state', state: 'incomplete' },
            { id: oid(44), name: 'Add a regression test', state: 'incomplete' }
          ]
        }
      ],
      comments: [
        { id: oid(61), author: 'Ada Demo', text: 'Looking into it today', date: iso(-1 * HOUR) },
        { id: oid(62), author: 'Lin Demo', text: 'Still failing on build 3.4', date: iso(-3 * HOUR) }
      ],
      attachments: [],
      activity: [
        { id: oid(120), type: 'updateCard', author: 'Ada Demo', date: iso(-25 * 60 * 1000), text: 'moved from Backlog to In progress' },
        { id: oid(121), type: 'commentCard', author: 'Ada Demo', date: iso(-1 * HOUR), text: 'Looking into it today' },
        { id: oid(122), type: 'updateCheckItemStateOnCard', author: 'Lin Demo', date: iso(-3 * HOUR), text: 'completed Inspect the cancel handler' },
        { id: oid(123), type: 'createCard', author: 'Lin Demo', date: iso(-2 * DAY), text: 'created this card in Backlog' }
      ]
    }
  }
}

// -- page wrapper ---------------------------------------------------------------

// Default dark theme ("nous"): colors from apps/shared/src/theme-presets.ts (darkColors), mapped to CSS
// variables the way themes/context.tsx applyTheme() does. The compiled stylesheet derives every --ui-* from them.
const THEME_VARS = {
  '--theme-foreground': '#e6edf3',
  '--theme-primary': '#4a84fe',
  '--theme-secondary': '#1d2e4f',
  '--theme-accent-soft': '#17243a',
  '--theme-midground': '#4a84fe',
  '--theme-warm': '#4a84fe',
  '--theme-background-seed': '#0d1117',
  '--theme-sidebar-seed': '#010409',
  '--theme-card-seed': '#010409',
  '--theme-elevated-seed': '#161b22',
  '--theme-bubble-seed': '#07162c',
  '--theme-mix-chrome': '74%',
  '--theme-mix-sidebar': '100%',
  '--theme-mix-card': '38%',
  '--theme-mix-elevated': '46%',
  '--theme-mix-bubble': '46%',
  '--dt-primary-foreground': '#161616',
  '--dt-secondary-foreground': '#e6edf3',
  '--dt-accent-foreground': '#e6edf3',
  '--dt-border': '#30363d',
  '--dt-input': '#0d1117',
  '--dt-ring': '#4a84fe',
  '--dt-muted': '#1a1e24',
  '--dt-midground-foreground': '#161616',
  '--dt-composer-ring': '#4a84fe',
  '--dt-destructive': '#f85149',
  '--dt-destructive-foreground': '#ffffff',
  '--dt-sidebar-border': '#30363d',
  '--dt-user-bubble-border': '#30363d',
  '--noise-opacity-mul': 'calc(0.04 / 0.21)'
}

// The stylesheet's @font-face rules point at files that are not shipped with it; drop them (the codicon font
// is re-added inline) so Chromium never goes looking for them.
const appCss = css.replace(/@font-face\{[^}]*\}/g, '') + fontCss

function page({ width, height, body, extraCss = '' }) {
  const vars = Object.entries(THEME_VARS).map(([k, v]) => `${k}:${v}`).join(';')

  return `<!doctype html>
<html lang="en" class="dark" data-hermes-theme="nous" data-hermes-mode="dark" style="color-scheme:dark;${vars}">
<head><meta charset="utf-8"><title>screenshot</title><style>${appCss}</style>${extraCss ? `<style>${extraCss}</style>` : ''}</head>
<body><div id="root"><div style="width:${width}px;height:${height}px;overflow:hidden;position:relative">${body}</div></div></body>
</html>
`
}

// -- drive the pane -------------------------------------------------------------

const { plugin, sdk, dir: loadDir } = await loadVisualPlugin()

if (args.measure) {
  // React's development build logs a user-timing measure for every component render (from the passive-effects
  // phase, diffing and structuredClone()ing the props: the whole `view` for every card) when performance.measure
  // exists at load time. A CPU profile of this script put 1.5 s of 26 s there and its peak RSS went from 0.5 to
  // 1.7 GB. Production builds do not log it, so it would only inflate every number; react-dom reads the flag when
  // it loads, which happens inside setupDom().
  performance.measure = undefined
}

const env = await setupDom()

const $ = (root, selector) => root.querySelector(selector)
const $$ = (root, selector) => [...root.querySelectorAll(selector)]
const text = el => (el.textContent || '').replace(/\s+/g, ' ').trim()

async function withPane(width, drive, { connected = true, fixture = applyFixture, settings = null } = {}) {
  sdk.queryClient.reset()
  sdk.host.paneVisible.set(true)

  const backend = makeBackend({ connected })
  if (connected) fixture(backend)
  const ctx = makeCtx(sdk, backend)

  if (settings) {
    ctx.store.set('settings', settings)
  }

  plugin.default.register(ctx)

  const ui = await env.mount(env.React.createElement(plugin.PaneRoot))

  try {
    await env.resizeTo(width)
    await showLanesOnScreen(ui.container, width)
    await drive({ root: ui.container, ctx, backend })

    return ui.container.innerHTML
  } finally {
    await ui.unmount()
  }
}

/**
 * The page is static, so nothing would tell the lane strip which lanes are on screen. Do what the browser's
 * IntersectionObserver does at scroll position 0: the lanes that fit the pane width are the visible ones.
 */
async function showLanesOnScreen(root, width) {
  const lanes = $$(root, '[data-trello="lane"]')

  if (!lanes.length || typeof env.intersect !== 'function') {
    return
  }

  const laneWidth = Number(lanes[0].dataset.laneWidth)
  const fit = Math.max(1, Math.floor((width - 24 + 10) / (laneWidth + 10)))

  await env.intersect(lanes.slice(0, fit))
}

/** Many lanes and a lane with many cards: the two cases a real work board hits. */
function applyStressFixture(backend) {
  const { state } = backend
  const B1 = backend.ids.B1
  const lists = Array.from({ length: 12 }, (_, i) => ({ id: oid(200 + i), name: `Lane ${i + 1}`, pos: i + 1, closed: false }))
  const card = (n, list) => ({
    id: oid(400 + n), name: `Card ${String(n).padStart(2, '0')} — a reasonably long title that wraps`, id_list: list,
    due: null, due_complete: false, labels: [], label_ids: [], id_members: [],
    short_link: `Str${String(n).padStart(5, '0')}`, url: `https://trello.com/c/Str${String(n).padStart(5, '0')}`,
    comment_count: n % 3, attachment_count: 0, checklist: { total: n % 4, done: n % 2 }, last_activity: iso(-2 * HOUR)
  })
  const cards = []
  for (let n = 1; n <= 30; n += 1) cards.push(card(n, lists[0].id))
  for (let i = 1; i < lists.length; i += 1) {
    for (let n = 0; n < 3; n += 1) cards.push(card(100 + i * 10 + n, lists[i].id))
  }
  state.boards = [{ id: B1, name: 'Stress board', url: 'https://trello.com/b/strEss01', closed: false, starred: true }]
  state.view = { board: state.boards[0], lists, cards, members: [], labels: [] }
  state.details = {}
}

// The heavy fixture lives in tests/desktop/harness.mjs (the render-count tests use it too); here it gets the fixed clock.
const applyHeavyFixture = (backend, options = {}) => heavyFixture(backend, { now: NOW, ...options })

const goToList = async (root, name) => {
  const chip = $$(root, '[data-trello="chip"]').find(el => text(el).startsWith(name))

  if (!chip) {
    throw new Error(`list chip not found: ${name}`)
  }

  await env.click(chip)
}

const RENDERERS = {
  'pane-list': () =>
    withPane(480, async ({ root }) => {
      await goToList(root, 'In progress')
      await env.key($(root, '[data-trello="workspace"]'), 'j')
    }),

  'pane-columns': () => withPane(1280, async () => {}),

  stress: () => withPane(900, async () => {}, { fixture: applyStressFixture }),

  'heavy-columns': () => withPane(1280, async () => {}, { fixture: applyHeavyFixture }),

  'heavy-compact': () => withPane(1280, async () => {}, { fixture: applyHeavyFixture, settings: { density: 'compact' } }),

  // the first lane is the active one in list mode; 'j' selects its first card, as in the pane-list scene
  'heavy-list': () =>
    withPane(480, async ({ root }) => {
      await env.key($(root, '[data-trello="workspace"]'), 'j')
    }, { fixture: applyHeavyFixture }),

  'heavy-drawer': () =>
    withPane(520, async ({ root }) => {
      await goToList(root, 'In progress')
      const card = $$(root, '[data-trello="card"]').find(el => text(el).includes('Release 4.2'))
      await env.click($(card, '[data-trello="card-open"]'))

      if (!$(root, '[data-trello="drawer"]') || $$(root, '[data-trello="item"]').length !== 60) {
        throw new Error('the heavy drawer did not open with its 60 checklist items')
      }
    }, { fixture: applyHeavyFixture }),

  'heavy-drawer-checklists': () => RENDERERS['heavy-drawer'](),

  connect: () =>
    withPane(480, async ({ root }) => {
      if (!$(root, '[data-trello="connect"]')) {
        throw new Error('the connect form did not render')
      }
    }, { connected: false }),

  'card-drawer': () =>
    withPane(480, async ({ root }) => {
      await goToList(root, 'In progress')
      const card = $$(root, '[data-trello="card"]').find(el => text(el).includes('Onboarding'))
      await env.click($(card, '[data-trello="card-open"]'))

      if (!$(root, '[data-trello="drawer"]')) {
        throw new Error('the card drawer did not open')
      }
    }),

  'directive-chip': async () => {
    sdk.queryClient.reset()
    const backend = makeBackend()
    applyFixture(backend)
    const ctx = makeCtx(sdk, backend)
    plugin.default.register(ctx)

    const directive = ctx.registered.find(c => c.area === 'transcript.directives')
    const React = env.React

    const message = React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem', fontSize: 'var(--conversation-text-font-size)', lineHeight: 'var(--conversation-line-height)', color: 'var(--ui-text-primary)' } },
      React.createElement('div', null, 'The search empty state is still waiting for its copy:'),
      directive.data.render({ attrs: { card: 'pQ7wZ2nL' }, source: '::trello{card="pQ7wZ2nL"}', streaming: false })
    )

    const ui = await env.mount(message)

    try {
      if (!$(ui.container, '[data-trello="chip"]')) {
        throw new Error('the directive chip did not resolve')
      }

      return ui.container.innerHTML
    } finally {
      await ui.unmount()
    }
  }
}

// -- Chromium over the DevTools protocol (pipe transport) ---------------------

function startBrowser(binary, profileDir) {
  const child = spawn(
    binary,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=en-US',
      '--force-device-scale-factor=1', '--font-render-hinting=none', '--disable-lcd-text',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-pipe', `--user-data-dir=${profileDir}`, 'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
  )

  const toBrowser = child.stdio[3]
  const fromBrowser = child.stdio[4]
  let stderr = ''
  let buffer = Buffer.alloc(0)
  let nextId = 1
  let closed = false
  const pending = new Map()
  const waiters = []

  child.stderr.on('data', d => {
    stderr = (stderr + d.toString()).slice(-2000)
  })

  const rejectAll = reason => {
    closed = true

    for (const { reject } of pending.values()) {
      reject(new Error(reason))
    }

    pending.clear()
  }

  child.on('error', err => rejectAll(`could not start Chromium: ${err.message}`))
  child.on('exit', code => rejectAll(`Chromium exited early (code ${code}): ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`))

  fromBrowser.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])

    for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
      const message = JSON.parse(buffer.subarray(0, end).toString('utf8'))
      buffer = buffer.subarray(end + 1)

      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        message.error ? reject(new Error(`${message.error.message}`)) : resolve(message.result || {})
      } else if (message.method) {
        for (const w of [...waiters]) {
          if (w.method === message.method && w.sessionId === message.sessionId) {
            waiters.splice(waiters.indexOf(w), 1)
            w.resolve(message.params)
          }
        }
      }
    }
  })

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('Chromium is not running'))

        return
      }

      const id = nextId++
      pending.set(id, { resolve, reject })
      toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })

  const once = (method, sessionId) => new Promise(resolve => waiters.push({ method, sessionId, resolve }))

  return { send, once, close: () => child.kill('SIGKILL') }
}

async function capture(browser, { width, height, file, scrollTo = null }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => browser.send(method, params, sessionId)

  try {
    await call('Page.enable')
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

    const loaded = browser.once('Page.loadEventFired', sessionId)
    await call('Page.navigate', { url: pathToFileURL(file).href })
    await loaded

    // wait for the icon font and two frames, so the capture never shows a half-loaded page
    await call('Runtime.evaluate', {
      awaitPromise: true,
      expression: 'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))'
    })

    if (scrollTo) {
      // scroll the drawer's own scroller so that `scrollTo` sits at its top edge (the static page has no script)
      const scrolled = await call('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(() => {
          const target = document.querySelector(${JSON.stringify(scrollTo)})
          const scroller = [...document.querySelectorAll('[data-trello="drawer"] *')].find(e => getComputedStyle(e).overflowY === 'auto')
          if (!target || !scroller) return false
          scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
          return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
        })()`
      })

      if (!scrolled.result || scrolled.result.value !== true) {
        throw new Error(`could not scroll to ${scrollTo}`)
      }
    }

    const { data } = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false })

    return Buffer.from(data, 'base64')
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

// -- measurements (--measure) -------------------------------------------------------
//
// Numbers for docs/UI-REVIEW.md. Two kinds, and the report keeps them apart:
//   * jsdom (React dev build, no layout): DOM node counts, how many times components render, React Profiler
//     render-phase time. Ratios and counts transfer to the browser; absolute milliseconds do not.
//   * real Chromium on the serialized pages the screenshots use: element sizes, scroll extents, style/layout time.
//     No React and no event handlers there, so this is the cost of the DOM *as a document*, not of React.
// The plugin is never instrumented: the render counter lives in a copy of plugin.js (see COUNT_SHIM).

const round = (x, digits = 1) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits)
const sumOf = xs => xs.reduce((a, b) => a + b, 0)

function summarize(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length

  return n ? { n, min: s[0], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, max: s[n - 1], mean: sumOf(s) / n } : null
}

function mdTable(headers, rows) {
  const line = cells => `| ${cells.map(c => (c === null || c === undefined ? '—' : String(c))).join(' | ')} |`

  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

const countAll = el => el.querySelectorAll('*').length

/**
 * Mount the pane against a synthetic backend, measuring mount(). jsdom has no layout, so the pane would read a width
 * of 0 and mount in list mode before a resize switches it; the real app measures its width in the first effect,
 * before the board renders. The harness therefore answers getBoundingClientRect() for the pane root with the
 * requested width, and the pane mounts straight into its final mode.
 */
async function boot(M, { width, fixture, settings = null }) {
  M.sdk.queryClient.reset()
  M.sdk.host.paneVisible.set(true)

  const backend = makeBackend({ connected: true })
  fixture(backend)
  const ctx = makeCtx(M.sdk, backend)

  if (settings) {
    ctx.store.set('settings', settings)
  }

  M.plugin.default.register(ctx)

  const prof = { commits: 0, ms: 0 }
  const tree = env.React.createElement(
    env.React.Profiler,
    { id: 'pane', onRender: (_id, _phase, actual) => { prof.commits += 1; prof.ms += actual } },
    env.React.createElement(M.plugin.PaneRoot)
  )

  const proto = env.window.Element.prototype
  const original = proto.getBoundingClientRect

  proto.getBoundingClientRect = function () {
    return this.hasAttribute && this.hasAttribute('data-trello-pane')
      ? { width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON: () => ({}) }
      : original.call(this)
  }

  let ui
  const t0 = performance.now()

  try {
    ui = await env.mount(tree)
  } finally {
    proto.getBoundingClientRect = original
  }

  const mountMs = performance.now() - t0

  return { ui, backend, prof, root: ui.container, mountMs, bootRenderMs: prof.ms, bootCommits: prof.commits }
}

/** Run `fn` with the render counter on; returns what rendered and how long it took. */
async function counted(b, fn) {
  const G = globalThis.__TRELLO_COUNT__
  G.calls.clear(); G.byCard.clear(); G.byItem.clear(); G.total = 0
  b.prof.commits = 0
  b.prof.ms = 0
  G.on = true
  const t0 = performance.now()

  try {
    await fn()
  } finally {
    G.on = false
  }

  const wallMs = performance.now() - t0
  const perCard = [...G.byCard.values()]
  const perItem = [...G.byItem.values()]

  return {
    wallMs,
    renderMs: b.prof.ms,
    commits: b.prof.commits,
    componentCalls: G.total,
    cardRenders: sumOf(perCard),
    cardsRendered: perCard.length,
    maxRendersPerCard: perCard.length ? Math.max(...perCard) : 0,
    itemRenders: sumOf(perItem),
    itemsRendered: perItem.length,
    maxRendersPerItem: perItem.length ? Math.max(...perItem) : 0,
    byComponent: Object.fromEntries(['Workspace', 'BoardBody', 'Columns', 'ListFocus', 'CardRow', 'Drawer', 'ChecklistSection', 'ItemRow', 'CommentsSection', 'Markdown'].map(k => [k, G.calls.get(k) || 0]))
  }
}

/**
 * Information a card drops without telling: members beyond the avatars it draws that have no `+N`, and labels
 * beyond the marks it draws that have no `+N`. Read from the rendered DOM against the backend's data.
 */
function overflowAudit(b) {
  const byId = new Map(b.backend.state.view.cards.map(c => [c.id, c]))
  const out = { avatarsHiddenSilently: 0, avatarOverflowChips: 0, labelsHiddenSilently: 0, labelOverflowChips: 0 }

  for (const el of $$(b.root, '[data-trello="card"]')) {
    const card = byId.get(el.dataset.cardId)
    // the avatar group carries a data attribute now; before, it was the span pushed to the right edge of the meta row
    const avatars = $(el, '[data-trello="avatars"]') || $$(el, 'span').find(x => x.style.marginLeft === 'auto')
    const more = $(el, '[data-trello="avatars-more"]')
    const drawnAvatars = avatars ? [...avatars.children].filter(c => c !== more).length : 0
    const moreCount = more ? Number(/\d+/.exec(more.textContent)[0]) : 0
    const known = card.id_members.filter(id => b.backend.state.view.members.some(m => m.id === id)).length

    out.avatarsHiddenSilently += Math.max(0, known - drawnAvatars - moreCount)
    out.avatarOverflowChips += more ? 1 : 0

    const marks = $$(el, '[data-trello="label-chip"], [data-trello="label-bar"]').length
    const labelMore = $(el, '[data-trello="label-more"]')
    const labelMoreCount = labelMore ? Number(/\d+/.exec(labelMore.textContent)[0]) : 0

    out.labelsHiddenSilently += Math.max(0, card.labels.length - marks - labelMoreCount)
    out.labelOverflowChips += labelMore ? 1 : 0
  }

  return out
}

const REPS = 3
const INTERACTION_REPS = 5
async function measureMountAndDom(V) {
  const defs = [
    { id: 'baseline-columns', width: 1280, fixture: applyFixture },
    { id: 'lane5-columns', width: 1280, fixture: b => applyHeavyFixture(b, { firstLane: 5 }) },
    { id: 'heavy-columns', width: 1280, fixture: applyHeavyFixture },
    { id: 'heavy-compact', width: 1280, fixture: applyHeavyFixture, settings: { density: 'compact' } },
    { id: 'baseline-list', width: 480, fixture: applyFixture },
    { id: 'lane5-list', width: 480, fixture: b => applyHeavyFixture(b, { firstLane: 5 }) },
    { id: 'heavy-list', width: 480, fixture: applyHeavyFixture }
  ]

  const out = {}

  // one discarded boot: the first mount in a process pays for JIT warm-up and would pollute the first scene's worst case
  await (await boot(V, defs[0])).ui.unmount()

  for (const def of defs) {
    const reps = []
    let dom = null

    for (let rep = 0; rep < REPS; rep += 1) {
      const b = await boot(V, def)
      const entry = { mountMs: b.mountMs, renderMs: b.bootRenderMs, commits: b.bootCommits, switchMs: null, switchRenderMs: null }

      if (def.width >= 560) {
        // the user drags the pane narrower and wider again: what the switch back to columns costs
        await env.resizeTo(480)
        b.prof.ms = 0
        const t0 = performance.now()
        await env.resizeTo(def.width)
        entry.switchMs = performance.now() - t0
        entry.switchRenderMs = b.prof.ms
      }

      reps.push(entry)

      if (rep === 0) {
        const cards = $$(b.root, '[data-trello="card"]')
        const container = cards.length ? cards[0].parentElement : null
        const perCard = cards.map(c => 1 + countAll(c))
        dom = {
          paneNodes: countAll(b.root),
          cards: cards.length,
          cardNodes: summarize(perCard),
          cardNodesTotal: sumOf(perCard),
          firstLaneNodes: container ? countAll(container) : null,
          firstLaneCards: container ? $$(container, '[data-trello="card"]').length : null,
          chromeNodes: countAll(b.root) - sumOf(perCard),
          overflow: overflowAudit(b)
        }
      }

      await b.ui.unmount()
    }

    const worst = key => (reps.some(r => r[key] === null) ? null : Math.max(...reps.map(r => r[key])))
    const mean = key => (reps.some(r => r[key] === null) ? null : sumOf(reps.map(r => r[key])) / reps.length)

    out[def.id] = { ...dom, reps, worstMountMs: worst('mountMs'), meanMountMs: mean('mountMs'), worstRenderMs: worst('renderMs'), meanRenderMs: mean('renderMs'), worstSwitchMs: worst('switchMs'), worstSwitchRenderMs: worst('switchRenderMs') }
    out[def.id].rssMB = round(process.memoryUsage().rss / 1048576, 0)
  }

  const a = out['lane5-columns']
  const c = out['heavy-columns']
  const al = out['lane5-list']
  const cl = out['heavy-list']

  out.nodesPerCard = {
    columns: round((c.firstLaneNodes - a.firstLaneNodes) / (c.firstLaneCards - a.firstLaneCards), 2),
    list: round((cl.firstLaneNodes - al.firstLaneNodes) / (cl.firstLaneCards - al.firstLaneCards), 2),
    method: 'nodes inside the first lane container with 80 cards minus with 5 cards, divided by the 75 extra cards (the 5 are the first 5 of the 80)'
  }

  return out
}

async function measureInteractions(S, label, fixture, { drawer = null } = {}) {
  const b = await boot(S, { width: 1280, fixture })
  const boardId = b.backend.ids.B1
  const workspace = $(b.root, '[data-trello="workspace"]')
  const K = S.plugin.K
  const out = { cards: $$(b.root, '[data-trello="card"]').length }

  // A poll is two commits in the app: `isFetching` flips when the request starts and again when it ends, and the
  // pane reads it. Hold the response so the stub commits the first one before the second, like a real round trip.
  const poll = (...keys) => async () => {
    const release = b.backend.hold(() => true)

    await env.act(async () => {
      for (const queryKey of keys) {
        S.sdk.queryClient.invalidateQueries({ queryKey })
      }
    })
    await env.settle(2)
    release()
    await env.settle(4)
  }

  const repeat = async (fn, times) => {
    const runs = []

    for (let i = 0; i < times; i += 1) {
      runs.push(await counted(b, fn))
    }

    const median = key => summarize(runs.map(r => r[key])).median

    // counts are identical between runs; time is reported as median and worst run
    return { ...runs[0], renderMs: Math.max(...runs.map(r => r.renderMs)), renderMedianMs: median('renderMs'), wallMs: Math.max(...runs.map(r => r.wallMs)), wallMedianMs: median('wallMs'), runs: runs.length }
  }

  const once = async fn => {
    const run = await counted(b, fn)

    return { ...run, renderMedianMs: run.renderMs, wallMedianMs: run.wallMs, runs: 1 }
  }

  out.pollUnchanged = await repeat(poll(K.view(boardId)), INTERACTION_REPS)

  out.pollOneCardChanged = await repeat(async () => {
    const card = b.backend.state.view.cards[3]
    card.name = `${card.name.replace(/ \(edited \d+\)$/, '')} (edited ${Math.floor(performance.now())})`
    await poll(K.view(boardId))()
  }, INTERACTION_REPS)

  await env.key(workspace, 'j') // the first press selects from nothing; count the steady state (old card -> new card)
  out.selectNext = await repeat(async () => { await env.key(workspace, 'j') }, INTERACTION_REPS)

  if (drawer) {
    const target = $$(b.root, '[data-trello="card"]').find(el => text(el).includes(drawer.match))

    if (!target) {
      throw new Error(`${label}: drawer card not found (${drawer.match})`)
    }

    out.openDrawer = await once(async () => { await env.click($(target, '[data-trello="card-open"]')) })

    if (!$(b.root, '[data-trello="drawer"]')) {
      throw new Error(`${label}: the drawer did not open`)
    }

    out.drawerItems = $$(b.root, '[data-trello="item"]').length
    out.pollWithDrawer = await repeat(poll(K.view(boardId), K.card(drawer.cardId)), INTERACTION_REPS)

    const box = $(b.root, '[data-trello="item"][data-state="incomplete"] input[type="checkbox"]')
    out.toggleItem = await once(async () => { await env.click(box) })
    out.closeDrawer = await once(async () => { await env.key(workspace, 'Escape') })
  }

  await b.ui.unmount()

  return out
}

async function measureDrawerCost(V, label, { width, fixture, open }) {
  const reps = []
  let shape = null

  for (let rep = 0; rep < REPS; rep += 1) {
    const b = await boot(V, { width, fixture })
    const nodesBefore = countAll(b.root)

    b.prof.ms = 0
    b.prof.commits = 0
    const t0 = performance.now()
    await open(b)
    const wallMs = performance.now() - t0
    const drawer = $(b.root, '[data-trello="drawer"]')

    if (!drawer) {
      throw new Error(`${label}: the drawer did not open`)
    }

    reps.push({ wallMs, renderMs: b.prof.ms, commits: b.prof.commits })

    if (rep === 0) {
      const section = name => { const el = $(drawer, `[data-trello="${name}"]`); return el ? countAll(el) + 1 : 0 }

      shape = {
        paneNodesBefore: nodesBefore,
        paneNodesAfter: countAll(b.root),
        drawerNodes: countAll(drawer) + 1,
        sections: { description: section('description'), checklists: section('checklists'), comments: section('comments'), attachments: section('attachments'), activity: section('activity') },
        items: $$(drawer, '[data-trello="item"]').length,
        comments: $$(drawer, '[data-trello="comment"]').length,
        nodesPerItem: $$(drawer, '[data-trello="item"]').length ? round(sumOf($$(drawer, '[data-trello="item"]').map(el => 1 + countAll(el))) / $$(drawer, '[data-trello="item"]').length, 2) : null,
        nodesPerComment: $$(drawer, '[data-trello="comment"]').length ? round(sumOf($$(drawer, '[data-trello="comment"]').map(el => 1 + countAll(el))) / $$(drawer, '[data-trello="comment"]').length, 2) : null,
        buttons: $$(drawer, 'button').length,
        inputs: $$(drawer, 'input, textarea').length
      }
    }

    await b.ui.unmount()
  }

  return { ...shape, worstWallMs: Math.max(...reps.map(r => r.wallMs)), meanWallMs: sumOf(reps.map(r => r.wallMs)) / reps.length, worstRenderMs: Math.max(...reps.map(r => r.renderMs)), reps }
}

// Evaluated inside the page (serialized with toString): geometry of the board as Chromium lays it out.
function pageProbe() {
  const q = (s, r = document) => [...r.querySelectorAll(s)]
  const rect = e => e.getBoundingClientRect()
  const sorted = xs => [...xs].sort((a, b) => a - b)
  const stat = xs => {
    const s = sorted(xs)
    const n = s.length

    return n ? { n, min: s[0], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, max: s[n - 1], mean: s.reduce((a, b) => a + b, 0) / n } : null
  }
  const out = { nodes: document.querySelectorAll('*').length }
  const cards = q('[data-trello="card"]')
  out.cardHeight = stat(cards.map(c => rect(c).height))

  if (cards.length) {
    const per = cards.map(c => {
      const title = q('[data-trello="card-open"] > span', c)[0]
      const chips = q('[data-trello="label-chip"],[data-trello="label-bar"]', c)
      const labelRow = chips.length ? chips[0].parentElement : null
      const avatars = q('span', c).find(s => s.style.marginLeft === 'auto')

      return {
        h: rect(c).height,
        titleH: title ? rect(title).height : 0,
        titleClamped: title ? title.scrollHeight > title.clientHeight + 1 : false,
        labels: chips.length,
        labelRowH: labelRow ? rect(labelRow).height : 0,
        labelsWrapped: labelRow ? rect(labelRow).height > 20 : false,
        chipsTruncated: q('[data-trello="label-chip"]', c).filter(x => x.scrollWidth > x.clientWidth + 1).length,
        chipsTruncatedWithoutTitle: q('[data-trello="label-chip"]', c).filter(x => x.scrollWidth > x.clientWidth + 1 && !x.title).length,
        metaOverflow: (() => { const m = q('[data-trello="card-open"] > div', c)[0]; return m ? m.scrollWidth > m.clientWidth + 1 : false })(),
        due: q('[data-trello^="due-"]', c).length,
        checklist: q('[data-trello="checklist"]', c).length,
        comments: q('[data-trello="comments"]', c).length,
        attachments: q('[data-trello="attachments"]', c).length,
        avatars: avatars ? avatars.children.length : 0
      }
    })
    const total = key => per.reduce((a, p) => a + p[key], 0)
    const tokens = per.map(p => p.labels + p.due + p.checklist + p.comments + p.attachments + p.avatars)

    out.noise = {
      cards: per.length,
      titlesClamped: per.filter(p => p.titleClamped).length,
      cardsWithLabels: per.filter(p => p.labels > 0).length,
      labelsWrapped: per.filter(p => p.labelsWrapped).length,
      chipsTruncated: total('chipsTruncated'),
      chipsTruncatedWithoutTitle: total('chipsTruncatedWithoutTitle'),
      metaOverflow: per.filter(p => p.metaOverflow).length,
      tokensPerCard: stat(tokens),
      labelsPerCard: stat(per.map(p => p.labels)),
      labelRowShare: total('labelRowH') / total('h'),
      titleShare: total('titleH') / total('h'),
      avatarsMax: Math.max(...per.map(p => p.avatars))
    }
  }

  const visibleIn = (el, box) => { const r = rect(el); return { part: r.bottom > box.top && r.top < box.bottom, full: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 } }

  const columns = q('[data-trello="columns"]')[0]

  if (columns) {
    const box = rect(columns)
    const lanes = q('[data-trello="lane"]')
    const body = lanes[0].querySelector('[data-trello="lane-body"]')
    const bodyBox = rect(body)
    const laneCards = q('[data-trello="card"]', body)
    out.columns = {
      lanes: lanes.length,
      laneWidth: rect(lanes[0]).width,
      scrollWidth: columns.scrollWidth,
      clientWidth: columns.clientWidth,
      lanesFullyVisible: lanes.filter(l => rect(l).left >= box.left - 0.5 && rect(l).right <= box.right + 0.5).length,
      lanesPartlyVisible: lanes.filter(l => rect(l).right > box.left && rect(l).left < box.right).length,
      lane1: {
        cards: laneCards.length,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        screens: body.scrollHeight / body.clientHeight,
        cardsFullyVisible: laneCards.filter(c => visibleIn(c, bodyBox).full).length,
        cardsPartlyVisible: laneCards.filter(c => visibleIn(c, bodyBox).part).length,
        cardHeight: stat(laneCards.map(c => rect(c).height)),
        addCardTop: (q('[data-trello="add-card"]', body)[0] ? rect(q('[data-trello="add-card"]', body)[0]).top - bodyBox.top + body.scrollTop : null)
      },
      headerHeight: rect(lanes[0].querySelector('header')).height
    }
  }

  const focus = q('[data-trello="list-focus"]')[0]

  if (focus) {
    const tabs = q('[role="tablist"]', focus)[0]
    const tabBox = rect(tabs)
    const chips = q('[data-trello="chip"]', tabs)
    const scroller = cards[0].parentElement
    const scrollerBox = rect(scroller)
    out.list = {
      chips: chips.length,
      chipsFullyVisible: chips.filter(c => rect(c).left >= tabBox.left - 0.5 && rect(c).right <= tabBox.right + 0.5).length,
      tabScrollWidth: tabs.scrollWidth,
      tabClientWidth: tabs.clientWidth,
      tabHeight: tabBox.height,
      cards: cards.length,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      screens: scroller.scrollHeight / scroller.clientHeight,
      cardsFullyVisible: cards.filter(c => visibleIn(c, scrollerBox).full).length,
      cardsPartlyVisible: cards.filter(c => visibleIn(c, scrollerBox).part).length,
      selectedCardHeight: (q('[data-selected="true"]')[0] ? rect(q('[data-selected="true"]')[0]).height : null),
      headerHeight: rect(q('header')[0]).height
    }
  }

  const drawer = q('[data-trello="drawer"]')[0]

  if (drawer) {
    const scroller = q('*', drawer).find(e => getComputedStyle(e).overflowY === 'auto')
    const top = rect(scroller).top
    const at = sel => { const el = q(sel, drawer)[0]; return el ? { top: rect(el).top - top + scroller.scrollTop, height: rect(el).height } : null }
    const comments = q('[data-trello="comment"]', drawer)
    const items = q('[data-trello="item"]', drawer)
    out.drawer = {
      width: rect(drawer).width,
      height: rect(drawer).height,
      headerHeight: rect(q('header', drawer)[0]).height,
      footerHeight: rect(q('footer', drawer)[0]).height,
      scrollerClientHeight: scroller.clientHeight,
      scrollerScrollHeight: scroller.scrollHeight,
      screens: scroller.scrollHeight / scroller.clientHeight,
      controls: at('[data-trello="drawer-controls"]'),
      description: at('[data-trello="description"]'),
      checklists: at('[data-trello="checklists"]'),
      comments: at('[data-trello="comments"]'),
      attachments: at('[data-trello="attachments"]'),
      activity: at('[data-trello="activity"]'),
      itemHeight: stat(items.map(i => rect(i).height)),
      commentHeight: stat(comments.map(c => rect(c).height)),
      itemsPerScreen: items.length ? scroller.clientHeight / (items.reduce((a, i) => a + rect(i).height, 0) / items.length) : null
    }
  }

  // Does selecting a card move the ones below it? Take the selected card's action area out of the page (the row
  // in the flow in the old layout, the overlay in the new one) and see how far the next card travels.
  const selected = q('[data-selected="true"]')[0]
  const send = selected && q('[data-trello="send"]', selected)[0]
  const following = selected && selected.nextElementSibling

  if (send && following) {
    const before = rect(following).top

    send.parentElement.remove()
    out.selectionShift = before - rect(following).top
  }

  const strip = q('[data-trello="lane-strip"]')[0]

  out.stripHeight = strip ? rect(strip).height : null

  return out
}

// Evaluated inside the page after load: cost of a full style + layout pass (CSS zoom invalidates every box).
function relayoutProbe() {
  const wrap = document.querySelector('#root > div')
  const run = n => {
    const times = []

    for (let i = 0; i < n; i += 1) {
      wrap.style.zoom = i % 2 ? '1' : '1.0001'
      const t = performance.now()
      void wrap.offsetHeight
      times.push(performance.now() - t)
    }

    return times
  }

  run(4)
  const times = run(20).sort((a, b) => a - b)
  wrap.style.zoom = ''

  return { median: times[times.length >> 1], max: times[times.length - 1], min: times[0] }
}

async function inspectPage(browser, { width, height, file }, { relayout = false } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => browser.send(method, params, sessionId)

  try {
    await call('Page.enable')
    await call('Performance.enable')
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

    const loaded = browser.once('Page.loadEventFired', sessionId)
    await call('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    await call('Runtime.evaluate', { awaitPromise: true, expression: 'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))' })

    const evaluate = async fn => {
      const res = await call('Runtime.evaluate', { expression: `(${fn.toString()})()`, returnByValue: true })

      if (res.exceptionDetails) {
        throw new Error(`page probe failed: ${res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text}`)
      }

      return res.result.value
    }

    const { metrics } = await call('Performance.getMetrics')
    const perf = Object.fromEntries(metrics.filter(m => ['LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'Nodes'].includes(m.name)).map(m => [m.name, m.value]))

    return { perf, probe: await evaluate(pageProbe), relayout: relayout ? await evaluate(relayoutProbe) : null }
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

// `content-visibility` as an experiment on the page, forced with !important so it works whatever the pane ships:
// off (what the pane would cost without it) and on with the comfortable estimate.
const CV_OFF = '[data-trello="card"]{content-visibility:visible !important}'
const CV_ON_84 = '[data-trello="card"]{content-visibility:auto !important;contain-intrinsic-size:auto 84px !important}'

async function measureLayout(browser, workDir) {
  const names = ['pane-columns', 'heavy-columns', 'heavy-compact', 'pane-list', 'heavy-list', 'card-drawer', 'heavy-drawer']
  const out = {}
  const files = {}

  for (const name of names) {
    const scene = SCENES.find(s => s.name === name)
    const body = await RENDERERS[name]()
    files[name] = { scene, body, file: path.join(workDir, `${name}.html`) }
    fs.writeFileSync(files[name].file, page({ ...scene, body }))
    out[name] = await inspectPage(browser, { ...scene, file: files[name].file }, { relayout: true })

    // `content-visibility` gives cards outside the viewport their estimated height, so card heights and the real
    // scroll extent are read from a second copy of the page with it forced off
    const naturalFile = path.join(workDir, `${name}-natural.html`)
    fs.writeFileSync(naturalFile, page({ ...scene, body, extraCss: CV_OFF }))
    out[name].natural = (await inspectPage(browser, { ...scene, file: naturalFile })).probe
  }

  // style/layout time over 5 loads (median) with content-visibility as rendered, forced off and forced on
  const variants = { 'as rendered': '', 'content-visibility forced off': CV_OFF, 'content-visibility forced on (84px)': CV_ON_84 }
  out.contentVisibility = {}

  for (const name of ['heavy-columns', 'heavy-compact', 'heavy-list']) {
    out.contentVisibility[name] = {}

    for (const [variant, extraCss] of Object.entries(variants)) {
      const { scene, body } = files[name]
      const file = path.join(workDir, `${name}-${variant.replace(/[^a-z0-9]+/gi, '-')}.html`)
      fs.writeFileSync(file, page({ ...scene, body, extraCss }))

      const runs = []

      for (let i = 0; i < 5; i += 1) {
        runs.push(await inspectPage(browser, { ...scene, file }, { relayout: true }))
      }

      const med = pick => summarize(runs.map(pick)).median

      out.contentVisibility[name][variant] = {
        layoutMs: med(r => r.perf.LayoutDuration * 1000),
        styleMs: med(r => r.perf.RecalcStyleDuration * 1000),
        layoutCount: med(r => r.perf.LayoutCount),
        relayoutMedianMs: med(r => r.relayout.median),
        scrollHeight: med(r => (r.probe.columns ? r.probe.columns.lane1.scrollHeight : r.probe.list.scrollHeight))
      }
    }
  }

  return out
}

function payloadSizes() {
  const heavy = makeBackend()
  applyHeavyFixture(heavy)
  const light = makeBackend()
  applyFixture(light)
  const bytes = x => Buffer.byteLength(JSON.stringify(x))
  const heavyId = oid(101)

  return {
    heavyViewBytes: bytes(heavy.state.view),
    heavyCards: heavy.state.view.cards.length,
    heavyViewBytesPerCard: Math.round(bytes(heavy.state.view.cards) / heavy.state.view.cards.length),
    baselineViewBytes: bytes(light.state.view),
    heavyDetailBytes: bytes(heavy.state.details[heavyId]),
    baselineDetailBytes: bytes(light.state.details[oid(101)])
  }
}

/** What the heavy fixture really contains, so the contract in the brief is checked rather than assumed. */
function fixtureStats() {
  const backend = makeBackend()
  applyHeavyFixture(backend)
  const { cards, lists } = backend.state.view
  const detail = backend.state.details[oid(101)]
  const lens = cards.map(c => c.name.length)

  return {
    lanes: lists.length,
    cards: cards.length,
    firstLaneCards: cards.filter(c => c.id_list === lists[0].id).length,
    titleLength: summarize(lens),
    titles8: lens.filter(n => n === 8).length,
    titles120: lens.filter(n => n === 120).length,
    withoutDue: cards.filter(c => !c.due).length,
    withoutLabels: cards.filter(c => c.labels.length === 0).length,
    labelsPerCardMax: Math.max(...cards.map(c => c.labels.length)),
    membersPerCardMax: Math.max(...cards.map(c => c.id_members.length)),
    cardsWithMoreThan3Members: cards.filter(c => c.id_members.length > 3).length,
    hiddenMemberAvatars: sumOf(cards.map(c => Math.max(0, c.id_members.length - 3))),
    // what a filter would leave on screen (evidence for the board-filter proposal)
    filters: {
      overdue: cards.filter(c => c.due && !c.due_complete && Date.parse(c.due) < NOW).length,
      overdueInLane1: cards.filter(c => c.id_list === lists[0].id && c.due && !c.due_complete && Date.parse(c.due) < NOW).length,
      dueWithin48h: cards.filter(c => c.due && !c.due_complete && Date.parse(c.due) >= NOW && Date.parse(c.due) - NOW <= 2 * DAY).length,
      memberAda: cards.filter(c => c.id_members.includes(oid(21))).length,
      labelBug: cards.filter(c => c.label_ids.includes(oid(31))).length
    },
    pendingPerChecklist: detail.checklists.map(c => c.items.filter(i => i.state !== 'complete').length),
    heavyCard: { descChars: detail.desc.length, checklists: detail.checklists.length, items: sumOf(detail.checklists.map(c => c.items.length)), itemsDone: sumOf(detail.checklists.map(c => c.items.filter(i => i.state === 'complete').length)), comments: detail.comments.length, commentChars: summarize(detail.comments.map(c => c.text.length)), attachments: detail.attachments.length, labels: detail.card.labels.length, members: detail.card.id_members.length, activity: detail.activity.length, due: detail.card.due }
  }
}

/**
 * Key presses to reach the last lane of the heavy board in columns mode. `j` is computed from the reading order
 * (nothing else moves between lanes in the old pane). `l` is really pressed in the pane: from nothing selected and
 * from a selected card of the first lane; `null` when the pane does not react to it.
 */
async function keyboardReach(V) {
  const backend = makeBackend()
  applyHeavyFixture(backend)
  const view = backend.state.view
  const ids = V.plugin.visibleCardIds(view, 'columns', null)

  const lanes = view.lists.map(list => {
    const first = view.cards.find(c => c.id_list === list.id)

    return { lane: list.name, cards: view.cards.filter(c => c.id_list === list.id).length, jPressesToFirstCard: first ? ids.indexOf(first.id) + 1 : null }
  })

  const lastLane = view.lists[view.lists.length - 1].id

  const press = async (start, key) => {
    const b = await boot(V, { width: 1280, fixture: applyHeavyFixture })
    const workspace = $(b.root, '[data-trello="workspace"]')
    const laneOfSelected = () => {
      const card = $(b.root, '[data-trello="card"][data-selected="true"]')
      const lane = card && card.closest('[data-trello="lane"]')

      return lane ? lane.dataset.laneId || [...b.root.querySelectorAll('[data-trello="lane"]')].indexOf(lane) : null
    }
    const lastIndex = view.lists.length - 1
    let presses = 0

    try {
      if (start === 'first-lane') {
        await env.key(workspace, 'j')
        presses = 0
      }

      const startedAt = laneOfSelected()

      for (; presses < 40; presses += 1) {
        const lane = laneOfSelected()

        if (lane === lastLane || lane === lastIndex) {
          return presses
        }

        const before = $(b.root, '[data-trello="card"][data-selected="true"]')

        await env.key(workspace, key)

        if ($(b.root, '[data-trello="card"][data-selected="true"]') === before && laneOfSelected() === startedAt && presses > 0) {
          return null
        }
      }

      return null
    } finally {
      await b.ui.unmount()
    }
  }

  return {
    lanes,
    jToLastLane: lanes[lanes.length - 1].jPressesToFirstCard,
    lFromNothing: await press('nothing', 'l'),
    lFromFirstLane: await press('first-lane', 'l')
  }
}

function readMemory() {
  const out = {}

  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8')
    const hwm = /VmHWM:\s+(\d+) kB/.exec(status)
    out.processPeakRssMB = hwm ? round(Number(hwm[1]) / 1024, 0) : null
  } catch {
    out.processPeakRssMB = null
  }

  try {
    const rel = /^0::(.*)$/m.exec(fs.readFileSync('/proc/self/cgroup', 'utf8'))
    const dir = `/sys/fs/cgroup${rel ? rel[1] : ''}`
    const read = name => { try { const v = fs.readFileSync(path.join(dir, name), 'utf8').trim(); return v === 'max' ? v : round(Number(v) / 1048576, 0) } catch { return null } }
    out.cgroupPeakMB = read('memory.peak')
    out.cgroupMaxMB = read('memory.max')
    out.cgroupSwapMaxMB = read('memory.swap.max')
  } catch {
    out.cgroupPeakMB = null
  }

  return out
}

async function runMeasure() {
  const V = await loadVisualPlugin({ sdkFile: 'sdk-visual.mjs', count: true })
  const S = await loadVisualPlugin({ sdkFile: 'sdk-stub.mjs', count: true })
  const result = { meta: { node: process.version, chromium: null, reps: REPS, fixedClock: new RealDate(NOW).toISOString(), react: env.React.version } }

  console.error('measure: DOM + mount (jsdom, visual SDK)')
  result.domAndMount = await measureMountAndDom(V)

  console.error('measure: drawer cost (jsdom, visual SDK)')
  result.drawer = {
    baseline: await measureDrawerCost(V, 'baseline drawer', {
      width: 480, fixture: applyFixture,
      open: async b => {
        await goToList(b.root, 'In progress')
        await env.click($($$(b.root, '[data-trello="card"]').find(el => text(el).includes('Onboarding')), '[data-trello="card-open"]'))
      }
    }),
    heavy: await measureDrawerCost(V, 'heavy drawer', {
      width: 520, fixture: applyHeavyFixture,
      open: async b => {
        await goToList(b.root, 'In progress')
        await env.click($($$(b.root, '[data-trello="card"]').find(el => text(el).includes('Release 4.2')), '[data-trello="card-open"]'))
      }
    })
  }

  console.error('measure: renders per interaction (jsdom, stub SDK)')
  result.interactions = {
    baseline: await measureInteractions(S, 'baseline', applyFixture, { drawer: { match: 'Onboarding', cardId: oid(101) } }),
    heavy: await measureInteractions(S, 'heavy', applyHeavyFixture, { drawer: { match: 'Release 4.2', cardId: oid(101) } })
  }

  result.keyboardReach = await keyboardReach(V)
  result.fixture = fixtureStats()
  result.payload = payloadSizes()

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-measure-'))
  let browser = null

  try {
    console.error('measure: layout (real Chromium, serialized pages)')
    browser = startBrowser(chromium, path.join(workDir, 'profile'))
    result.layout = await measureLayout(browser, workDir)
    result.meta.chromium = (await browser.send('Browser.getVersion')).product
  } finally {
    browser && browser.close()
  }

  result.memory = readMemory()

  return result
}

/** The handful of numbers docs/UI-REVIEW.md tracks across changes, flat so two runs can be diffed. */
function buildSummary(r) {
  const L = r.layout
  const heavy = r.interactions.heavy
  const col = L['heavy-columns'].probe
  const compact = L['heavy-compact'].probe
  const list = L['heavy-list'].probe
  const natural = { col: L['heavy-columns'].natural, compact: L['heavy-compact'].natural, list: L['heavy-list'].natural }
  const audit = r.domAndMount['heavy-columns'].overflow
  const cv = L.contentVisibility['heavy-columns']

  return {
    'relayout median ms, 80-card lane, columns': round(L['heavy-columns'].relayout.median, 1),
    'relayout median ms, 80-card lane, list': round(L['heavy-list'].relayout.median, 1),
    'relayout median ms, compact columns': round(L['heavy-compact'].relayout.median, 1),
    'relayout median ms, columns with content-visibility forced off': round(cv['content-visibility forced off'].relayoutMedianMs, 1),
    'CardRow renders per poll, nothing changed (207 cards)': heavy.pollUnchanged.cardRenders,
    'CardRow renders per poll, one card changed': heavy.pollOneCardChanged.cardRenders,
    'CardRow renders per selection move': heavy.selectNext.cardRenders,
    'CardRow renders per checklist toggle': heavy.toggleItem.cardRenders,
    'ItemRow renders per checklist toggle': heavy.toggleItem.itemRenders,
    'Markdown renders per checklist toggle': heavy.toggleItem.byComponent.Markdown,
    'commits per poll': heavy.pollUnchanged.commits,
    'board renders per poll (BoardBody + Workspace)': heavy.pollUnchanged.byComponent.BoardBody + heavy.pollUnchanged.byComponent.Workspace,
    'cards fully visible in the 80-card lane, comfortable (1280x720)': col.columns.lane1.cardsFullyVisible,
    'cards fully visible in the 80-card lane, compact (1280x720)': compact.columns.lane1.cardsFullyVisible,
    'cards fully visible, list mode, comfortable (480x760)': list.list.cardsFullyVisible,
    'lane 1 scroll height px, comfortable (as rendered)': col.columns.lane1.scrollHeight,
    'lane 1 scroll height px, comfortable (every card laid out)': natural.col.columns.lane1.scrollHeight,
    'lane 1 scroll height px, compact (as rendered)': compact.columns.lane1.scrollHeight,
    'lane 1 scroll height px, compact (every card laid out)': natural.compact.columns.lane1.scrollHeight,
    'card height median px, comfortable': natural.col.cardHeight.median,
    'card height median px, compact': natural.compact.cardHeight.median,
    'avatars hidden without a +N': audit.avatarsHiddenSilently,
    'labels hidden without a +N': audit.labelsHiddenSilently,
    'label rows wrapped to 2+ lines': natural.col.noise.labelsWrapped,
    'truncated label chips without a title': natural.col.noise.chipsTruncatedWithoutTitle,
    'meta rows overflowing the card': natural.col.noise.metaOverflow + natural.compact.noise.metaOverflow,
    'selected card pushes the next one by px': natural.list.selectionShift === undefined ? null : round(natural.list.selectionShift, 1),
    'lane strip height px (columns mode)': col.stripHeight,
    'j presses to the last lane': r.keyboardReach.jToLastLane,
    'l presses to the last lane, from nothing selected': r.keyboardReach.lFromNothing,
    'l presses to the last lane, from a card in lane 1': r.keyboardReach.lFromFirstLane,
    'DOM nodes, 207 cards, comfortable': r.domAndMount['heavy-columns'].paneNodes,
    'mount() worst ms, comfortable columns (jsdom, dev React)': round(r.domAndMount['heavy-columns'].worstMountMs, 1)
  }
}

function printMeasurements(r) {
  const d = r.domAndMount
  const lines = []
  const f = (x, digits = 1) => (x === null || x === undefined ? null : round(x, digits))

  lines.push(`# environment: node ${r.meta.node}, react ${r.meta.react}, ${r.meta.chromium}, ${r.meta.reps} reps`, '')

  lines.push('## DOM nodes and mount time (jsdom, React dev build; ms are relative, not browser ms)', '')
  lines.push(mdTable(['scene', 'cards', 'pane nodes', 'nodes/card median (min–max)', 'chrome nodes', 'mount() worst ms', 'mean ms', 'render-phase worst ms', 'list→columns switch worst ms'],
    Object.keys(d).filter(k => k !== 'nodesPerCard').map(k => [k, d[k].cards, d[k].paneNodes, `${d[k].cardNodes.median} (${d[k].cardNodes.min}–${d[k].cardNodes.max})`, d[k].chromeNodes, f(d[k].worstMountMs), f(d[k].meanMountMs), f(d[k].worstRenderMs), f(d[k].worstSwitchMs)])), '')
  lines.push(`nodes per card, ${d.nodesPerCard.method}: columns ${d.nodesPerCard.columns}, list ${d.nodesPerCard.list}`, '')

  lines.push('## Drawer (visual SDK)', '')
  const dr = r.drawer
  lines.push(mdTable(['drawer', 'pane nodes (drawer open)', 'drawer nodes', 'description', 'checklists', 'comments', 'attachments', 'activity', 'items', 'buttons', 'nodes/item', 'nodes/comment', 'open worst wall ms', 'open worst render ms'],
    ['baseline', 'heavy'].map(k => [k, dr[k].paneNodesAfter, dr[k].drawerNodes, dr[k].sections.description, dr[k].sections.checklists, dr[k].sections.comments, dr[k].sections.attachments, dr[k].sections.activity, dr[k].items, dr[k].buttons, dr[k].nodesPerItem, dr[k].nodesPerComment, f(dr[k].worstWallMs), f(dr[k].worstRenderMs)])), '')

  lines.push('## Renders per interaction (stub SDK; CardRow calls; worst of reps for ms)', '')
  const steps = ['pollUnchanged', 'pollOneCardChanged', 'selectNext', 'openDrawer', 'pollWithDrawer', 'toggleItem', 'closeDrawer']
  const rows = []

  for (const board of ['baseline', 'heavy']) {
    for (const step of steps) {
      const s = r.interactions[board][step]
      rows.push([board, r.interactions[board].cards, step, s.commits, s.cardRenders, s.cardsRendered, s.maxRendersPerCard, s.itemRenders, s.maxRendersPerItem, s.componentCalls, `${f(s.renderMedianMs)} (${f(s.renderMs)})`, `${f(s.wallMedianMs)} (${f(s.wallMs)})`])
    }
  }

  lines.push(mdTable(['board', 'cards', 'step', 'commits', 'CardRow renders', 'distinct cards', 'max per card', 'ItemRow renders', 'max per item', 'all component calls', 'render ms median (worst)', 'wall ms median (worst)'], rows), '')

  lines.push('## Fixture contract (what the heavy fixture actually contains)', '')
  const fx = r.fixture
  lines.push(mdTable(['lanes', 'cards', 'lane 1', 'title length min/median/max', 'titles of 8', 'titles of 120', 'no due', 'no labels', 'max labels', 'max members', 'cards >3 members', 'hidden avatars'],
    [[fx.lanes, fx.cards, fx.firstLaneCards, `${fx.titleLength.min}/${fx.titleLength.median}/${fx.titleLength.max}`, fx.titles8, fx.titles120, fx.withoutDue, fx.withoutLabels, fx.labelsPerCardMax, fx.membersPerCardMax, fx.cardsWithMoreThan3Members, fx.hiddenMemberAvatars]]), '')
  lines.push(`heavy card: ${JSON.stringify(fx.heavyCard)}`, `filters: ${JSON.stringify(fx.filters)}; pending items per checklist: ${JSON.stringify(fx.pendingPerChecklist)}`, '')

  lines.push('## Keyboard: j presses to reach the first card of each lane (columns mode)', '', mdTable(['lane', 'cards', 'j presses'], r.keyboardReach.lanes.map(k => [k.lane, k.cards, k.jPressesToFirstCard])), '')
  lines.push(`last lane: ${r.keyboardReach.jToLastLane} j presses; l presses: ${r.keyboardReach.lFromNothing} from nothing selected, ${r.keyboardReach.lFromFirstLane} from a card in lane 1 (null = the pane does not react to l)`, '')

  lines.push('## Payload the pane polls (JSON bytes)', '', mdTable(['what', 'bytes'], [['heavy /view', r.payload.heavyViewBytes], ['  per card', r.payload.heavyViewBytesPerCard], ['baseline /view', r.payload.baselineViewBytes], ['heavy card detail', r.payload.heavyDetailBytes], ['baseline card detail', r.payload.baselineDetailBytes]]), '')

  lines.push('## Real Chromium layout (serialized pages)', '')
  const L = r.layout
  const hc = L['heavy-columns'].probe.columns
  const bc = L['pane-columns'].probe.columns
  lines.push(mdTable(['scene', 'nodes', 'lanes', 'lanes fully visible', 'board scrollWidth / clientWidth', 'lane 1 cards', 'lane 1 scrollH / clientH (screens)', 'cards fully visible', 'card height median (min–max)', 'relayout median ms', 'style ms', 'layout ms'],
    [['pane-columns', L['pane-columns'].probe.nodes, bc.lanes, bc.lanesFullyVisible, `${bc.scrollWidth} / ${bc.clientWidth}`, bc.lane1.cards, `${bc.lane1.scrollHeight} / ${bc.lane1.clientHeight} (${f(bc.lane1.screens)})`, bc.lane1.cardsFullyVisible, `${f(bc.lane1.cardHeight.median)} (${f(bc.lane1.cardHeight.min)}–${f(bc.lane1.cardHeight.max)})`, f(L['pane-columns'].relayout.median, 2), f(L['pane-columns'].perf.RecalcStyleDuration * 1000), f(L['pane-columns'].perf.LayoutDuration * 1000)],
      ['heavy-columns', L['heavy-columns'].probe.nodes, hc.lanes, hc.lanesFullyVisible, `${hc.scrollWidth} / ${hc.clientWidth}`, hc.lane1.cards, `${hc.lane1.scrollHeight} / ${hc.lane1.clientHeight} (${f(hc.lane1.screens)})`, hc.lane1.cardsFullyVisible, `${f(hc.lane1.cardHeight.median)} (${f(hc.lane1.cardHeight.min)}–${f(hc.lane1.cardHeight.max)})`, f(L['heavy-columns'].relayout.median, 2), f(L['heavy-columns'].perf.RecalcStyleDuration * 1000), f(L['heavy-columns'].perf.LayoutDuration * 1000)]]), '')

  const lm = k => L[k].probe.list
  lines.push(mdTable(['scene', 'nodes', 'chips (fully visible)', 'chip bar scrollW / clientW', 'cards', 'list scrollH / clientH (screens)', 'cards fully visible', 'card height median (min–max)', 'selected card height', 'relayout median ms'],
    ['pane-list', 'heavy-list'].map(k => [k, L[k].probe.nodes, `${lm(k).chips} (${lm(k).chipsFullyVisible})`, `${lm(k).tabScrollWidth} / ${lm(k).tabClientWidth}`, lm(k).cards, `${lm(k).scrollHeight} / ${lm(k).clientHeight} (${f(lm(k).screens)})`, lm(k).cardsFullyVisible, `${f(L[k].probe.cardHeight.median)} (${f(L[k].probe.cardHeight.min)}–${f(L[k].probe.cardHeight.max)})`, f(lm(k).selectedCardHeight), f(L[k].relayout.median, 2)])), '')

  const dw = k => L[k].probe.drawer
  lines.push(mdTable(['drawer scene', 'nodes', 'scroller clientH', 'scrollH', 'screens', 'description top/height', 'checklists top/height', 'comments top/height', 'attachments top/height', 'activity top/height', 'header+footer px', 'item height median', 'relayout median ms'],
    ['card-drawer', 'heavy-drawer'].map(k => [k, L[k].probe.nodes, dw(k).scrollerClientHeight, dw(k).scrollerScrollHeight, f(dw(k).screens), ...['description', 'checklists', 'comments', 'attachments', 'activity'].map(s => `${f(dw(k)[s].top, 0)} / ${f(dw(k)[s].height, 0)}`), f(dw(k).headerHeight + dw(k).footerHeight, 0), f(dw(k).itemHeight ? dw(k).itemHeight.median : null), f(L[k].relayout.median, 2)])), '')

  const nz = k => L[k].probe.noise
  lines.push('## Visual density per card (real Chromium; shares are of card height)', '')
  lines.push(mdTable(['scene', 'cards', 'titles clamped at 2 lines', 'cards with labels', 'label rows wrapped to 2+ lines', 'label chips truncated', 'tokens per card median (max)', 'labels per card median (max)', 'label rows share of card height', 'title share of card height', 'avatars shown max'],
    ['pane-columns', 'heavy-columns', 'heavy-compact'].map(k => [k, nz(k).cards, nz(k).titlesClamped, nz(k).cardsWithLabels, nz(k).labelsWrapped, nz(k).chipsTruncated, `${nz(k).tokensPerCard.median} (${nz(k).tokensPerCard.max})`, `${nz(k).labelsPerCard.median} (${nz(k).labelsPerCard.max})`, `${f(nz(k).labelRowShare * 100, 0)}%`, `${f(nz(k).titleShare * 100, 0)}%`, nz(k).avatarsMax])), '')

  lines.push('## content-visibility experiment (CSS injected into the serialized page only; median of 5 loads)', '')
  lines.push(mdTable(['scene', 'variant', 'style ms', 'layout ms', 'layout passes', 'full relayout median ms', 'lane scrollHeight'],
    Object.entries(L.contentVisibility).flatMap(([scene, variants]) => Object.entries(variants).map(([variant, v]) => [scene, variant, f(v.styleMs, 2), f(v.layoutMs, 2), v.layoutCount, f(v.relayoutMedianMs, 2), f(v.scrollHeight, 0)]))), '')

  r.summary = buildSummary(r)
  lines.push('## Summary (flat, for before/after comparisons)', '', mdTable(['metric', 'value'], Object.entries(r.summary)), '')

  lines.push('## Memory', '', `process peak RSS (VmHWM): ${r.memory.processPeakRssMB} MB; cgroup memory.peak: ${r.memory.cgroupPeakMB} MB (memory.max ${r.memory.cgroupMaxMB}, swap.max ${r.memory.cgroupSwapMaxMB})`)

  return lines.join('\n')
}

if (args.measure) {
  const watchdogMeasure = setTimeout(() => fail(6, 'measure: timed out'), 280000)

  try {
    const result = await runMeasure()

    const report = printMeasurements(result)

    if (args.measureOut) {
      fs.mkdirSync(path.dirname(path.resolve(args.measureOut)), { recursive: true })
      fs.writeFileSync(args.measureOut, `${JSON.stringify(result, null, 2)}\n`)
    }

    console.log(report)
  } catch (err) {
    fail(6, `measure: ${err instanceof Error ? err.stack : String(err)}`)
  } finally {
    clearTimeout(watchdogMeasure)
  }

  process.exit(0)
}

// -- screenshots ----------------------------------------------------------------

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(1, 4).toString('latin1') !== 'PNG') {
    return null
  }

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const outDir = path.resolve(args.out || path.join(ROOT, 'docs', 'screenshots'))
fs.mkdirSync(outDir, { recursive: true })

if (args.keepHtml) {
  fs.mkdirSync(args.keepHtml, { recursive: true })
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-shots-run-'))
const written = []
let browser = null

const watchdog = setTimeout(() => fail(6, 'timed out waiting for Chromium'), 180000)

try {
  browser = startBrowser(chromium, path.join(work, 'profile'))

  for (const scene of SCENES) {
    if (only && !only.has(scene.name)) {
      continue
    }

    const body = await RENDERERS[scene.name]()
    const htmlFile = path.join(args.keepHtml || work, `${scene.name}.html`)
    fs.writeFileSync(htmlFile, page({ ...scene, body }))

    const png = await capture(browser, { width: scene.width, height: scene.height, file: htmlFile, scrollTo: scene.scrollTo })
    const size = pngSize(png)

    if (!size || size.width !== scene.width || size.height !== scene.height) {
      throw new Error(`${scene.name}: Chromium returned ${size ? `${size.width}x${size.height}` : 'no image'}, expected ${scene.width}x${scene.height}`)
    }

    const target = path.join(outDir, `${scene.name}.png`)
    fs.writeFileSync(target, png)
    written.push(`${path.relative(process.cwd(), target) || target}  ${size.width}x${size.height}  ${(png.length / 1024).toFixed(1)} KB`)
  }
} catch (err) {
  fail(6, err instanceof Error ? err.message : String(err))
} finally {
  clearTimeout(watchdog)
  browser && browser.close()
}

console.log(written.join('\n'))

if (args.reportMemory) {
  const mem = readMemory()
  console.log(`memory: process peak RSS ${mem.processPeakRssMB} MB; cgroup memory.peak ${mem.cgroupPeakMB} MB (memory.max ${mem.cgroupMaxMB}, swap.max ${mem.cgroupSwapMaxMB}); cgroup peak includes Chromium and page cache`)
}

process.exit(0)
