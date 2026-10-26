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
//   --only <name>[,<name>]  render a subset: pane-list, pane-columns, card-drawer, directive-chip
//   --keep-html <dir>       also write the intermediate HTML pages there (debugging)
//   --allow-missing-font    continue without the icon font (icons render as empty boxes)
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
  const takes = new Set(['--css', '--chromium', '--codicon-font', '--out', '--only', '--keep-html'])

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') {
      out.help = true
    } else    if (arg === '--allow-missing-font') {
      out.allowMissingFont = true
    } else if (arg === '--require-font') {
      out.requireFont = true
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
  { name: 'stress', width: 900, height: 600 }
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

async function loadVisualPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-shots-'))
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir')
  fs.copyFileSync(path.join(ROOT, 'tests', 'desktop', 'sdk-stub.mjs'), path.join(dir, 'sdk-stub.mjs'))
  fs.copyFileSync(path.join(HERE, 'screenshots', 'sdk-visual.mjs'), path.join(dir, 'sdk-visual.mjs'))

  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'plugin.js'), 'utf8')
  const rewritten = source.replace("from '@hermes/plugin-sdk'", "from './sdk-visual.mjs'")

  if (rewritten === source) {
    fail(4, 'desktop/plugin.js no longer imports from @hermes/plugin-sdk')
  }

  fs.writeFileSync(path.join(dir, 'plugin.mjs'), rewritten)

  return {
    dir,
    plugin: await import(pathToFileURL(path.join(dir, 'plugin.mjs')).href),
    sdk: await import(pathToFileURL(path.join(dir, 'sdk-visual.mjs')).href)
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

function page({ width, height, body }) {
  const vars = Object.entries(THEME_VARS).map(([k, v]) => `${k}:${v}`).join(';')

  return `<!doctype html>
<html lang="en" class="dark" data-hermes-theme="nous" data-hermes-mode="dark" style="color-scheme:dark;${vars}">
<head><meta charset="utf-8"><title>screenshot</title><style>${appCss}</style></head>
<body><div id="root"><div style="width:${width}px;height:${height}px;overflow:hidden;position:relative">${body}</div></div></body>
</html>
`
}

// -- drive the pane -------------------------------------------------------------

const { plugin, sdk, dir: loadDir } = await loadVisualPlugin()
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

async function capture(browser, { width, height, file }) {
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

    const { data } = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false })

    return Buffer.from(data, 'base64')
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  }
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

    const png = await capture(browser, { width: scene.width, height: scene.height, file: htmlFile })
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
process.exit(0)
