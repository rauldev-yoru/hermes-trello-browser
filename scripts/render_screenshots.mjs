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
//                           heavy-columns, heavy-list, heavy-drawer, heavy-drawer-checklists
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

const { findNodeModules, SKIP_REASON, makeBackend, makeCtx, setupDom, oid } = await import(pathToFileURL(path.join(ROOT, 'tests', 'desktop', 'harness.mjs')).href)
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

// Counts how often each function component is called (rendered). Used by --measure only: the plugin file is
// copied and its `react/jsx-runtime` import is pointed at this shim, so the plugin itself stays untouched.
const COUNT_SHIM = `
import * as rt from 'react/jsx-runtime'
const G = (globalThis.__TRELLO_COUNT__ ||= { on: false, total: 0, calls: new Map(), byCard: new Map(), byItem: new Map() })
const wrapped = new WeakMap()
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)
function wrap(fn) {
  let w = wrapped.get(fn)
  if (!w) {
    const name = fn.displayName || fn.name || 'Anonymous'
    w = { [name]: function (props, ref) {
      if (G.on) {
        G.total += 1
        bump(G.calls, name)
        if (name === 'CardRow' && props && props.card) bump(G.byCard, props.card.id)
        if (name === 'ItemRow' && props && props.item) bump(G.byItem, props.item.id)
      }
      return fn(props, ref)
    } }[name]
    wrapped.set(fn, w)
  }
  return w
}
const prep = type => (typeof type === 'function' && !(type.prototype && type.prototype.isReactComponent) ? wrap(type) : type)
export const Fragment = rt.Fragment
export const jsx = (type, props, key) => rt.jsx(prep(type), props, key)
export const jsxs = (type, props, key) => rt.jsxs(prep(type), props, key)
`

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

async function withPane(width, drive, { connected = true, fixture = applyFixture } = {}) {
  sdk.queryClient.reset()
  sdk.host.paneVisible.set(true)

  const backend = makeBackend({ connected })
  if (connected) fixture(backend)
  const ctx = makeCtx(sdk, backend)
  plugin.default.register(ctx)

  const ui = await env.mount(env.React.createElement(plugin.PaneRoot))

  try {
    await env.resizeTo(width)
    await drive({ root: ui.container, ctx, backend })

    return ui.container.innerHTML
  } finally {
    await ui.unmount()
  }
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

// -- heavy board fixture (UI review) -----------------------------------------------
//
// A synthetic stand-in for a real work board: 10 lanes, the first one with 80 cards, titles from 8 to 120
// characters, cards with and without due dates / labels / members, and one card whose drawer is as heavy as
// the longest ones seen in practice. Everything comes from a seeded PRNG, so the output is byte-stable.

function mulberry32(seed) {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HEAVY_LANES = ['Inbox', 'Triage', 'Backlog — grooming', 'Ready', 'In progress', 'In review', 'QA', 'Blocked / waiting on others', 'Release candidate', 'Done']
// cards per lane; the first lane is the 80-card one
const HEAVY_LANE_COUNTS = [80, 6, 14, 9, 22, 11, 5, 3, 17, 40]

const HEAVY_TITLES = [
  'Checkout — coupon field loses focus after validation',
  'Export report to CSV',
  'Rate limit headers missing on the search endpoint',
  'Dark mode: chart gridlines too faint',
  'Audit the retry policy of the webhook dispatcher',
  'Migrate tooltips to the new component',
  'Empty state for saved filters',
  'Slow query on the activity feed (p95 above 2s)',
  'Add a keyboard shortcut to toggle the sidebar',
  'Typo on the pricing page',
  'Replace the date picker in the invoice form',
  'Onboarding checklist does not persist after logout',
  'Upgrade the build image to the latest LTS',
  'Document the permission matrix for workspace roles',
  'Notifications: group by thread instead of by event',
  'Investigate flaky test in the billing suite',
  'Mobile nav overlaps the cookie banner on small screens',
  'Add pagination to the audit log',
  'Support SSO group mapping for contractors',
  'Clean up unused feature flags'
]

// exactly 8 characters each
const HEAVY_SHORT = ['Fix typo', 'Bump dep', 'Add logs', 'Cache it', 'Lint fix', 'Alt text', 'Dead css', 'Fix nits']

// longer than 120 characters; cut to exactly 120 below
const HEAVY_LONG_BASES = [
  'Investigate why the nightly synchronisation job intermittently duplicates invoices for customers that changed plan mid-cycle',
  'Make the permission checks of the bulk-edit dialog consistent with the single-edit flow, including the audit trail and the undo toast',
  'Rework the empty, loading and error states of every report so they stop shifting the layout when the data arrives late or twice'
]

if (!HEAVY_SHORT.every(t => t.length === 8) || !HEAVY_LONG_BASES.every(t => t.length > 120)) {
  throw new Error('heavy fixture: title pools do not meet the 8/120 character contract')
}

const heavyLongTitle = i => {
  const cut = HEAVY_LONG_BASES[i % HEAVY_LONG_BASES.length].slice(0, 120)

  return cut.endsWith(' ') ? `${cut.slice(0, 119)}.` : cut
}

const HEAVY_DESC = [
  '# Release 4.2 — regression sweep',
  '',
  'This card tracks the **regression sweep** for release 4.2. Nothing ships until every checklist below is green and the rollout notes were reviewed by a second person. Background lives in the [release runbook](https://example.invalid/runbook) and the [incident template](https://example.invalid/incident).',
  '',
  '## Scope',
  '',
  '- Billing: invoices, proration and the new `retry_policy` defaults',
  '- Search: the ranking pipeline behind the `search_v2` flag',
  '- Onboarding: steps 1 to 4 on web and on mobile web',
  '- Exports: CSV and XLSX for reports larger than 50k rows',
  '- Permissions: the workspace role matrix after the SSO change',
  '',
  '## How to run the sweep',
  '',
  'Use the staging stack, never the shared demo tenant. Reset the fixtures first and keep the *seed* identical between runs so failures are comparable:',
  '',
  '```bash',
  'make fixtures SEED=4242',
  'make sweep ENV=staging SUITE=regression',
  'make report OUT=build/sweep-4.2.html',
  '```',
  '',
  '## Known risks',
  '',
  '1. The proration job runs at 02:00 UTC and overlaps with the nightly export.',
  '2. `search_v2` doubles the index size; check disk alerts before enabling it for everyone.',
  '3. SSO group mapping is cached for 15 minutes, so role changes look delayed in the UI.',
  '',
  '## Rollout',
  '',
  'Ramp in four steps (5%, 25%, 50%, 100%) with at least one hour between steps. Roll back with the **kill switch** described in [the runbook](https://example.invalid/runbook#rollback) if the error budget burns faster than 2x. Post the status in the release channel after every step and attach the dashboard snapshot to this card.',
  '',
  '## Notes from the last release',
  '',
  '- The export timeout was raised from 30s to 120s and never lowered again.',
  '- Two customers hit the legacy date picker on Safari; see https://example.invalid/issues/4812 for the repro.',
  '- The rollback rehearsal took 18 minutes instead of the planned 5.',
  '',
  '## Contacts',
  '',
  '- Release captain: Ada Demo',
  '- Billing owner: Lin Demo, on call until Friday',
  '- Support liaison: see the rota at https://example.invalid/rota'
].join('\n')

if (HEAVY_DESC.length < 1900 || HEAVY_DESC.length > 2100) {
  throw new Error(`heavy fixture: description is ${HEAVY_DESC.length} characters, expected about 2000`)
}

const HEAVY_CHECKLISTS = [
  {
    name: 'Pre-flight',
    items: [
      'Freeze the release branch', 'Tag the release candidate', 'Reset the staging fixtures with the agreed seed', 'Verify the database migration dry-run output',
      'Confirm the feature flags are off by default', 'Snapshot the dashboards before the rollout starts', 'Check that the on-call rota is published',
      'Review the open P1 and P2 tickets', 'Run the smoke suite against staging', 'Confirm the rollback artefact exists and is downloadable',
      'Export the current error budget', 'Notify support about the maintenance window', 'Pre-warm the search index', 'Check disk alerts on the search cluster',
      'Verify the SSO group mapping in staging', 'Confirm the status page template', 'Back up the feature flag configuration', 'Lock the dependency versions',
      'Share the rollout plan with the release channel', 'Get the second reviewer to sign the runbook'
    ]
  },
  {
    name: 'Regression sweep',
    items: [
      'Billing: create, pay and refund an invoice', 'Billing: proration when the plan changes mid-cycle', 'Billing: retry policy after a declined card', 'Search: ranking for the top 50 queries',
      'Search: empty results and typo tolerance', 'Search: filters combined with sorting', 'Onboarding: all four steps on web', 'Onboarding: cancelling on step 2 does not leave the session half-open',
      'Onboarding: resume after logout', 'Exports: CSV with 50k rows', 'Exports: XLSX with accents and emoji in the headers', 'Exports: cancel an export in progress',
      'Permissions: viewer cannot edit', 'Permissions: contractors see only their workspaces', 'Permissions: role change is visible after the cache expires', 'Notifications: grouped by thread',
      'Notifications: mute a thread and verify the digest', 'Accessibility: keyboard-only pass over the main flows', 'Accessibility: contrast on the secondary button and the disabled states',
      'Performance: p95 of the activity feed stays under 1.5s'
    ]
  },
  {
    name: 'Rollout and follow-up',
    items: [
      'Ramp to 5% and watch the error budget for an hour', 'Ramp to 25%', 'Ramp to 50%', 'Ramp to 100%', 'Post the status after every step', 'Attach the dashboard snapshots to this card',
      'Disable the legacy date picker flag', 'Remove the temporary export timeout', 'Lower the retry ceiling back to 3', 'Archive the staging fixtures', 'Write the rollout summary',
      'Schedule the retrospective', 'Update the runbook with what we learned', 'File follow-up tickets for every workaround', 'Close the P2 tickets that shipped',
      'Notify support that the maintenance window is over', 'Delete the release branch', 'Update the changelog', 'Publish the customer-facing notes', 'Thank the people on call'
    ]
  }
]

const HEAVY_COMMENT_BASES = [
  'Ramp to 25% looks clean. Error rate flat at 0.12%, p95 on the activity feed went from 1.9s to 1.4s. I am holding at 25% for the full hour as agreed and will post the dashboard snapshot here before moving on.',
  'Heads up: the proration job overlapped with the nightly export again and the export took 41 minutes instead of the usual 12. Not a regression of this release, but we should move the export to 04:00 UTC before the next one. I opened a follow-up ticket.',
  'Reproduced the onboarding cancel bug on Safari 17 only after navigating back from step 3. On Chrome it never happens. The session cookie is cleared but the wizard state in local storage survives, so the next visit resumes in a half-done step. Fix is a two-liner, test attached to the PR.',
  'Search ranking diff for the top 50 queries is attached. 46 are identical, 3 improved, 1 got worse ("invoice reminder", the exact-match boost lost to a longer document). I think that one is acceptable, but I would like a second opinion from someone who owns the ranking model.',
  'SSO group mapping: confirmed the 15 minute cache is the cause of the delayed role changes. Support should tell customers to wait or sign out and in. Documented in the runbook under "Known risks".',
  'Accessibility pass done with keyboard only. Two findings: the secondary button on the invoice form has contrast 3.9:1 in dark mode, and the date picker traps focus on Escape. Both filed, neither blocks the release in my view.',
  'Rollback rehearsal finished. It took 18 minutes, mostly waiting for the search index to reload. If we pre-warm the index on the old version the rehearsal should drop under 7. Adding that to the pre-flight checklist.',
  'Exports: CSV with 50k rows is fine (38s). XLSX with emoji in the headers fails on the second sheet because of the sheet name limit. Workaround is to truncate to 31 characters, patch is in review.',
  'Billing sandbox declined every card on Tuesday afternoon, so the retry-policy tests were inconclusive. Re-ran them this morning against the new sandbox account and all 12 scenarios pass.',
  'Can someone confirm the contractors workspace mapping? In staging, contractors from two vendors see each other\'s workspaces. Production data looks right, but I would like to be sure before we ramp past 5%.',
  'Dashboards snapshot before the rollout is attached to the card, together with the error budget export. Budget at 94% remaining, no burn in the last 7 days.',
  'Created the card from the planning meeting. Scope and owners are in the description; please keep the checklists up to date as you go so the status post can be generated from them.'
]

// Real comments run long: most get one or two extra sentences, so they span roughly 180 to 600 characters.
const HEAVY_COMMENT_TAILS = [
  ' I attached the exact commands and the output so anyone can rerun them without asking me.',
  ' This is the third time we see this on a Tuesday, so I suspect the cron overlap is not a coincidence and we should look at the schedule before touching the code.',
  ' Not blocking, but please do not close this card until the follow-up ticket is linked here, otherwise we will lose the context again next quarter.',
  ' For reference, the same scenario passed on the previous release candidate, so the regression must have come in with the dependency bump from last week.',
  ' If you disagree with any of this, say so here and not in the chat thread, because the thread is not archived and the next release captain will not find it.',
  ' Dashboards, logs and the raw export are in the shared folder linked from the description; the folder is read-only for everyone except the release captain.'
]

const HEAVY_COMMENTS = HEAVY_COMMENT_BASES.map((base, i) => (i % 4 === 3 ? base : `${base}${HEAVY_COMMENT_TAILS[i % 6]}${i % 4 === 2 ? HEAVY_COMMENT_TAILS[(i + 1) % 6] : ''}`))

function applyHeavyFixture(backend, { firstLane = 80 } = {}) {
  const { state } = backend
  const B1 = backend.ids.B1
  const rand = mulberry32(20261026)
  const pick = list => list[Math.floor(rand() * list.length)]

  const members = [
    { id: oid(21), username: 'ada', full_name: 'Ada Demo', initials: 'AD', avatar_url: null },
    { id: oid(22), username: 'lin', full_name: 'Lin Demo', initials: 'LD', avatar_url: null },
    { id: oid(23), username: 'sam', full_name: 'Sam Demo', initials: 'SD', avatar_url: null },
    { id: oid(24), username: 'kai', full_name: 'Kai Demo', initials: 'KD', avatar_url: null },
    { id: oid(25), username: 'noor', full_name: 'Noor Demo', initials: 'ND', avatar_url: null },
    { id: oid(26), username: 'tom', full_name: 'Tom Demo', initials: 'TD', avatar_url: null }
  ]

  // the last two board labels are unnamed colours, rendered as bars; one name is deliberately long
  const labels = [
    { id: oid(31), name: 'bug', color: 'red' },
    { id: oid(32), name: 'onboarding', color: 'blue' },
    { id: oid(33), name: 'copy', color: 'yellow' },
    { id: oid(34), name: 'design', color: 'purple' },
    { id: oid(35), name: 'a11y', color: 'green' },
    { id: oid(36), name: 'perf', color: 'orange' },
    { id: oid(37), name: 'customer-escalation-needed', color: 'pink' },
    { id: oid(38), name: '', color: 'sky' }
  ]

  const labelText = l => l.name || l.color
  const counts = HEAVY_LANE_COUNTS.map((n, i) => (i === 0 ? firstLane : n))

  const lists = HEAVY_LANES.map((name, i) => ({ id: oid(200 + i), name, pos: i + 1, closed: false }))
  const cards = []
  let n = 0

  lists.forEach((list, laneIndex) => {
    for (let k = 0; k < counts[laneIndex]; k += 1) {
      n += 1
      const roll = rand()
      let name

      if (n % 7 === 0) {
        name = HEAVY_SHORT[n % HEAVY_SHORT.length]
      } else if (n % 9 === 0) {
        name = heavyLongTitle(Math.floor(n / 9))
      } else {
        name = `${pick(HEAVY_TITLES)}${roll < 0.3 ? ` (${1 + Math.floor(rand() * 40)})` : ''}`
      }

      const dueRoll = rand()
      let due = null
      let dueComplete = false

      if (dueRoll >= 0.4 && dueRoll < 0.6) {
        due = iso(-(1 + Math.floor(rand() * 20)) * DAY)
      } else if (dueRoll >= 0.6 && dueRoll < 0.75) {
        due = iso((4 + Math.floor(rand() * 36)) * HOUR)
      } else if (dueRoll >= 0.75 && dueRoll < 0.95) {
        due = iso((3 + Math.floor(rand() * 28)) * DAY)
      } else if (dueRoll >= 0.95) {
        due = iso(-(1 + Math.floor(rand() * 10)) * DAY)
        dueComplete = true
      }

      const labelCount = rand() < 0.25 ? 0 : 1 + Math.floor(rand() * 4)
      const chosen = []

      while (chosen.length < labelCount) {
        const l = pick(labels)

        if (!chosen.includes(l)) {
          chosen.push(l)
        }
      }

      const memberRoll = rand()
      const memberCount = memberRoll < 0.4 ? 0 : memberRoll < 0.75 ? 1 : memberRoll < 0.93 ? 2 : 4 + Math.floor(rand() * 2)
      const people = []

      while (people.length < memberCount) {
        const m = pick(members)

        if (!people.includes(m.id)) {
          people.push(m.id)
        }
      }
      const total = rand() < 0.45 ? 0 : 2 + Math.floor(rand() * 18)
      const short = `Hvy${String(n).padStart(5, '0')}`

      cards.push({
        id: oid(1000 + n), name, id_list: list.id, due, due_complete: dueComplete,
        labels: chosen.map(labelText), label_ids: chosen.map(l => l.id), id_members: people,
        short_link: short, url: `https://trello.com/c/${short}`,
        comment_count: rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 14), attachment_count: rand() < 0.6 ? 0 : 1 + Math.floor(rand() * 6),
        checklist: { total, done: Math.floor(rand() * (total + 1)) }, last_activity: iso(-(1 + Math.floor(rand() * 200)) * HOUR)
      })
    }
  })

  // the heavy card: first card of "In progress". The harness' checklist routes work on oid(101), so it takes that id.
  const inProgress = lists[4]
  const heavy = cards.find(c => c.id_list === inProgress.id)
  const heavyChecklists = HEAVY_CHECKLISTS.map((cl, ci) => ({
    id: oid(300 + ci), name: cl.name,
    items: cl.items.map((name, ii) => ({ id: oid(320 + ci * 20 + ii), name, state: (ci * 3 + ii * 7) % 5 < 2 ? 'complete' : 'incomplete' }))
  }))
  const heavyDone = heavyChecklists.flatMap(c => c.items).filter(i => i.state === 'complete').length

  Object.assign(heavy, {
    id: oid(101), name: 'Release 4.2 — regression sweep and rollout checklist', short_link: 'Hvy00101', url: 'https://trello.com/c/Hvy00101',
    due: iso(-3 * DAY), due_complete: false,
    labels: [labels[0], labels[1], labels[5], labels[6]].map(labelText), label_ids: [oid(31), oid(32), oid(36), oid(37)],
    id_members: [members[0].id, members[1].id],
    comment_count: HEAVY_COMMENTS.length, attachment_count: 6, checklist: { total: 60, done: heavyDone }, last_activity: iso(-25 * 60 * 1000)
  })

  const authors = ['Ada Demo', 'Lin Demo', 'Sam Demo', 'Kai Demo']
  const attachments = [
    { name: 'release-notes-draft.pdf', url: 'https://example.invalid/files/release-notes-draft.pdf', is_upload: true, bytes: 482113, mime: 'application/pdf' },
    { name: 'perf-before-after.png', url: 'https://example.invalid/files/perf-before-after.png', is_upload: true, bytes: 221044, mime: 'image/png' },
    { name: 'rollout-plan.xlsx', url: 'https://example.invalid/files/rollout-plan.xlsx', is_upload: true, bytes: 88231, mime: 'application/vnd.ms-excel' },
    { name: 'incident-timeline-2026-09-30-search-index-outage-postmortem-draft-v3-final.md', url: 'https://example.invalid/files/timeline.md', is_upload: true, bytes: 9120, mime: 'text/markdown' },
    { name: 'Release runbook', url: 'https://example.invalid/runbook', is_upload: false, bytes: null, mime: null },
    { name: 'Dashboard — error budget', url: 'https://example.invalid/dashboards/error-budget', is_upload: false, bytes: null, mime: null }
  ].map((a, i) => ({ id: oid(50 + i), ...a }))

  const activityTypes = ['updateCard', 'commentCard', 'updateCheckItemStateOnCard', 'updateCheckItemStateOnCard', 'addChecklistToCard']
  const activity = Array.from({ length: 20 }, (_, i) => ({
    id: oid(500 + i), type: activityTypes[i % activityTypes.length], author: authors[i % authors.length], date: iso(-(i + 1) * 3 * HOUR),
    text: ['moved from Ready to In progress', 'Ramp to 25% looks clean', 'completed Ramp to 5% and watch the error budget for an hour', 'completed Run the smoke suite against staging', 'added the checklist Rollout and follow-up'][i % 5]
  }))

  state.boards = [{ id: B1, name: 'Platform — release train', url: 'https://trello.com/b/hEaVy001', closed: false, starred: true }]
  state.view = { board: state.boards[0], lists, cards, members, labels }

  state.details = {
    [heavy.id]: {
      card: heavy,
      desc: HEAVY_DESC,
      list: { id: inProgress.id, name: inProgress.name },
      board: { id: B1, name: state.boards[0].name },
      checklists: heavyChecklists,
      comments: HEAVY_COMMENTS.map((text, i) => ({ id: oid(60 + i), author: authors[i % authors.length], text, date: iso(-(i + 1) * 7 * HOUR) })),
      attachments,
      activity
    }
  }
}

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
async function boot(M, { width, fixture }) {
  M.sdk.queryClient.reset()
  M.sdk.host.paneVisible.set(true)

  const backend = makeBackend({ connected: true })
  fixture(backend)
  const ctx = makeCtx(M.sdk, backend)
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

const REPS = 3
const INTERACTION_REPS = 5
async function measureMountAndDom(V) {
  const defs = [
    { id: 'baseline-columns', width: 1280, fixture: applyFixture },
    { id: 'lane5-columns', width: 1280, fixture: b => applyHeavyFixture(b, { firstLane: 5 }) },
    { id: 'heavy-columns', width: 1280, fixture: applyHeavyFixture },
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
          chromeNodes: countAll(b.root) - sumOf(perCard)
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

const CV_CARD_100 = '[data-trello="card"]{content-visibility:auto;contain-intrinsic-size:auto 100px}'
const CV_CARD_84 = '[data-trello="card"]{content-visibility:auto;contain-intrinsic-size:auto 84px}'
const CV_LANE = '[data-trello="lane"]{content-visibility:auto;contain-intrinsic-size:auto 300px auto 600px}'

async function measureLayout(browser, workDir) {
  const names = ['pane-columns', 'heavy-columns', 'pane-list', 'heavy-list', 'card-drawer', 'heavy-drawer']
  const out = {}
  const files = {}

  for (const name of names) {
    const scene = SCENES.find(s => s.name === name)
    const body = await RENDERERS[name]()
    files[name] = { scene, body, file: path.join(workDir, `${name}.html`) }
    fs.writeFileSync(files[name].file, page({ ...scene, body }))
    out[name] = await inspectPage(browser, { ...scene, file: files[name].file }, { relayout: true })
  }

  // what content-visibility would buy on the two heavy board scenes: style/layout time over 5 loads (median)
  const variants = { baseline: '', 'cv-card (84px est.)': CV_CARD_84, 'cv-card (100px est.)': CV_CARD_100, 'cv-lane+card (84px est.)': `${CV_CARD_84}${CV_LANE}` }
  out.contentVisibility = {}

  for (const name of ['heavy-columns', 'heavy-list']) {
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

/** How many `j` presses it takes to reach the first card of each lane in columns mode (the flat reading order). */
function keyboardReach() {
  const backend = makeBackend()
  applyHeavyFixture(backend)
  const view = backend.state.view
  const ids = plugin.visibleCardIds(view, 'columns', null)

  return view.lists.map(list => {
    const first = view.cards.find(c => c.id_list === list.id)

    return { lane: list.name, cards: view.cards.filter(c => c.id_list === list.id).length, jPressesToFirstCard: first ? ids.indexOf(first.id) + 1 : null }
  })
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

  result.keyboardReach = keyboardReach()
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

  lines.push('## Keyboard: j presses to reach the first card of each lane (columns mode)', '', mdTable(['lane', 'cards', 'j presses'], r.keyboardReach.map(k => [k.lane, k.cards, k.jPressesToFirstCard])), '')

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
    ['pane-columns', 'heavy-columns'].map(k => [k, nz(k).cards, nz(k).titlesClamped, nz(k).cardsWithLabels, nz(k).labelsWrapped, nz(k).chipsTruncated, `${nz(k).tokensPerCard.median} (${nz(k).tokensPerCard.max})`, `${nz(k).labelsPerCard.median} (${nz(k).labelsPerCard.max})`, `${f(nz(k).labelRowShare * 100, 0)}%`, `${f(nz(k).titleShare * 100, 0)}%`, nz(k).avatarsMax])), '')

  lines.push('## content-visibility experiment (CSS injected into the serialized page only; median of 5 loads)', '')
  lines.push(mdTable(['scene', 'variant', 'style ms', 'layout ms', 'layout passes', 'full relayout median ms', 'lane scrollHeight'],
    Object.entries(L.contentVisibility).flatMap(([scene, variants]) => Object.entries(variants).map(([variant, v]) => [scene, variant, f(v.styleMs, 2), f(v.layoutMs, 2), v.layoutCount, f(v.relayoutMedianMs, 2), f(v.scrollHeight, 0)]))), '')

  lines.push('## Memory', '', `process peak RSS (VmHWM): ${r.memory.processPeakRssMB} MB; cgroup memory.peak: ${r.memory.cgroupPeakMB} MB (memory.max ${r.memory.cgroupMaxMB}, swap.max ${r.memory.cgroupSwapMaxMB})`)

  return lines.join('\n')
}

if (args.measure) {
  const watchdogMeasure = setTimeout(() => fail(6, 'measure: timed out'), 280000)

  try {
    const result = await runMeasure()

    if (args.measureOut) {
      fs.mkdirSync(path.dirname(path.resolve(args.measureOut)), { recursive: true })
      fs.writeFileSync(args.measureOut, `${JSON.stringify(result, null, 2)}\n`)
    }

    console.log(printMeasurements(result))
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
