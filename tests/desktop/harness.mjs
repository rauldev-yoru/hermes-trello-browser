// Shared test harness for the desktop plugin: loads desktop/plugin.js against the SDK
// stub, builds a jsdom environment and provides a synthetic in-memory Trello backend.
//
// Dependencies (react, react-dom, jsdom, nanostores, @nanostores/react) are NOT vendored:
// the harness looks for a node_modules that has them, walking up from the repository root,
// or at $TRELLO_TEST_NODE_MODULES. Without them the desktop tests are skipped, never faked.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
const REQUIRED = ['react', 'react-dom', 'jsdom', 'nanostores', '@nanostores/react']

export function findNodeModules() {
  const candidates = []

  if (process.env.TRELLO_TEST_NODE_MODULES) {
    candidates.push(process.env.TRELLO_TEST_NODE_MODULES)
  }

  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    candidates.push(path.join(dir, 'node_modules'))

    if (path.dirname(dir) === dir) {
      break
    }
  }

  return candidates.find(c => REQUIRED.every(name => fs.existsSync(path.join(c, name)))) || null
}

export const SKIP_REASON =
  'react, react-dom, jsdom, nanostores and @nanostores/react not found: run `npm i react react-dom jsdom nanostores @nanostores/react` or set TRELLO_TEST_NODE_MODULES'

/**
 * A drop-in `react/jsx-runtime` that counts how often each function component is rendered, without touching the
 * plugin: every function component (and the function inside `memo()`) is wrapped once, by identity, in a function
 * with the same name. Counters live on `globalThis.__TRELLO_COUNT__`: `calls` by component name, `byCard` by
 * `props.card.id` for `CardRow`, `byItem` by `props.item.id` for `ItemRow`. Counting is on only while `on` is true.
 */
export const COUNT_SHIM = `
import * as rt from 'react/jsx-runtime'
import { memo } from 'react'
const G = (globalThis.__TRELLO_COUNT__ ||= { on: false, total: 0, calls: new Map(), byCard: new Map(), byItem: new Map() })
const wrapped = new WeakMap()
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)
function wrapFn(fn) {
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
function prep(type) {
  if (typeof type === 'function' && !(type.prototype && type.prototype.isReactComponent)) return wrapFn(type)
  if (type && typeof type === 'object' && type.$$typeof === Symbol.for('react.memo') && typeof type.type === 'function') {
    let w = wrapped.get(type)
    if (!w) {
      w = memo(wrapFn(type.type), type.compare || undefined)
      wrapped.set(type, w)
    }
    return w
  }
  return type
}
export const Fragment = rt.Fragment
export const jsx = (type, props, key) => rt.jsx(prep(type), props, key)
export const jsxs = (type, props, key) => rt.jsxs(prep(type), props, key)
`

/** Copy plugin.js next to the SDK stub, point its SDK import at the stub, import both. `count` adds COUNT_SHIM. */
export async function loadPlugin({ count = false } = {}) {
  const modules = findNodeModules()

  if (!modules) {
    throw new Error(SKIP_REASON)
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-harness-'))
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir')
  fs.copyFileSync(path.join(HERE, 'sdk-stub.mjs'), path.join(dir, 'sdk-stub.mjs'))

  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'plugin.js'), 'utf8')
  const rewritten = source.replace("from '@hermes/plugin-sdk'", "from './sdk-stub.mjs'")

  if (rewritten === source) {
    throw new Error('plugin.js no longer imports from @hermes/plugin-sdk')
  }

  let final = rewritten

  if (count) {
    final = rewritten.replace("from 'react/jsx-runtime'", "from './jsx-count.mjs'")

    if (final === rewritten) {
      throw new Error("plugin.js no longer imports 'react/jsx-runtime'")
    }

    fs.writeFileSync(path.join(dir, 'jsx-count.mjs'), COUNT_SHIM)
  }

  fs.writeFileSync(path.join(dir, 'plugin.mjs'), final)

  const plugin = await import(pathToFileURL(path.join(dir, 'plugin.mjs')).href)
  const sdk = await import(pathToFileURL(path.join(dir, 'sdk-stub.mjs')).href)

  return { plugin, sdk, dir }
}

// -- jsdom ------------------------------------------------------------------

export class FakeResizeObserver {
  static instances = new Set()

  constructor(callback) {
    this.callback = callback
  }

  observe(target) {
    this.target = target
    FakeResizeObserver.instances.add(this)
  }

  unobserve() {}

  disconnect() {
    FakeResizeObserver.instances.delete(this)
  }
}

export class FakeIntersectionObserver {
  static instances = new Set()

  constructor(callback, options) {
    this.callback = callback
    this.options = options
    this.targets = new Set()
  }

  observe(target) {
    this.targets.add(target)
    FakeIntersectionObserver.instances.add(this)
  }

  unobserve(target) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
    FakeIntersectionObserver.instances.delete(this)
  }
}

export async function setupDom() {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const w = dom.window

  const names = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']

  for (const name of names) {
    try {
      Object.defineProperty(globalThis, name, { value: name === 'window' ? w : w[name], writable: true, configurable: true })
    } catch {
      // read-only on this Node version: the plugin never needs it
    }
  }

  try {
    Object.defineProperty(globalThis, 'navigator', { value: w.navigator, writable: true, configurable: true })
  } catch {
    // Node exposes a getter-only navigator
  }

  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.IntersectionObserver = FakeIntersectionObserver
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')

  const act = React.act

  const settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) {
      await act(async () => {
        await new Promise(r => setTimeout(r, 0))
      })
    }
  }

  const mount = async element => {
    const container = w.document.createElement('div')
    w.document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(element)
    })
    await settle()

    return {
      container,
      unmount: async () => {
        await act(async () => root.unmount())
        container.remove()
      }
    }
  }

  const fire = async (el, event) => {
    await act(async () => {
      el.dispatchEvent(event)
    })
    await settle(4)
  }

  const click = (el, init = {}) => fire(el, new w.MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  const key = (el, k, init = {}) => fire(el, new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))

  const type = async (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    await fire(el, new w.Event('input', { bubbles: true }))
  }

  const resizeTo = async width => {
    await act(async () => {
      for (const o of FakeResizeObserver.instances) {
        o.callback([{ target: o.target, contentRect: { width } }])
      }
    })
    await settle(4)
  }

  /** Tell every observer which elements are on screen: `onScreen` are fully visible, everything else is not. */
  const intersect = async onScreen => {
    const visible = new Set(onScreen)

    await act(async () => {
      for (const observer of FakeIntersectionObserver.instances) {
        observer.callback([...observer.targets].map(target => ({ target, intersectionRatio: visible.has(target) ? 1 : 0, isIntersecting: visible.has(target) })))
      }
    })
    await settle(4)
  }

  return { dom, window: w, document: w.document, act, settle, mount, click, key, type, fire, resizeTo, intersect, React }
}

// -- synthetic backend ---------------------------------------------------------

export const oid = n => n.toString(16).padStart(24, '0')

export function apiError(status, code, message = '', retryAfter = null) {
  const error = new Error(`${status}: ${JSON.stringify({ error: code, message, retry_after: retryAfter })}`)
  error.statusCode = status

  return error
}

const HOUR = 3600 * 1000

export function makeBackend({ connected = true, rejected = false } = {}) {
  const now = Date.now()
  const B1 = oid(1)
  const L = { backlog: oid(2), doing: oid(3), review: oid(4), done: oid(5) }
  const M1 = oid(20)

  const card = (n, name, list, extra = {}) => ({
    id: oid(100 + n), name, id_list: list, due: null, due_complete: false, labels: [], label_ids: [], id_members: [],
    short_link: `Card${String(n).padStart(4, '0')}`, url: `https://trello.com/c/Card${String(n).padStart(4, '0')}`,
    comment_count: 0, attachment_count: 0, checklist: { total: 0, done: 0 }, last_activity: new Date(now - HOUR).toISOString(), ...extra
  })

  const state = {
    connected,
    rejected,
    boards: [
      { id: oid(9), name: 'Archive tools', url: 'https://trello.com/b/Arch0001', closed: false, starred: false },
      { id: B1, name: 'Product Launch', url: 'https://trello.com/b/Prod0001', closed: false, starred: true }
    ],
    view: {
      board: { id: B1, name: 'Product Launch', url: 'https://trello.com/b/Prod0001', closed: false, starred: true },
      lists: [
        { id: L.backlog, name: 'Backlog', pos: 1, closed: false },
        { id: L.doing, name: 'In progress', pos: 2, closed: false },
        { id: L.review, name: 'Review', pos: 3, closed: false },
        { id: L.done, name: 'Done', pos: 4, closed: false }
      ],
      cards: [
        card(1, 'Onboarding — step 2 has no exit on cancel', L.doing, { labels: ['red', 'bug'], label_ids: [oid(32), oid(31)], due: new Date(now + 30 * HOUR).toISOString(), id_members: [M1], comment_count: 4, attachment_count: 1, checklist: { total: 4, done: 2 } }),
        card(2, 'Empty state for search without copy', L.doing, { labels: ['yellow'] }),
        card(3, 'Export report to CSV', L.backlog, { labels: ['purple', 'green'], comment_count: 2, attachment_count: 1 }),
        card(4, 'Migrate tooltips to the new component', L.doing, { labels: ['blue'], due: new Date(now - 5 * 24 * HOUR).toISOString(), checklist: { total: 4, done: 0 } }),
        card(5, 'Contrast AA on secondary button', L.review, { labels: ['green'] }),
        card(6, 'Unified date format', L.done)
      ],
      members: [{ id: M1, username: 'ada', full_name: 'Ada Demo', initials: 'AD', avatar_url: null }],
      labels: [
        { id: oid(31), name: 'bug', color: 'red' },
        { id: oid(32), name: '', color: 'red' },
        { id: oid(33), name: 'onboarding', color: 'blue' }
      ]
    },
    details: {},
    // credential storage as the backend reports it: files per scope, and whether environment variables decide
    scopes: { app: connected, profile: false },
    env: false,
    profileIsRoot: false
  }

  const credentialStatus = () => {
    const source = state.env ? 'env' : state.scopes.profile && !state.profileIsRoot ? 'profile' : state.scopes.app ? 'app' : null

    return {
      configured: source !== null, source, active_scope: source, env_partial: false,
      app_file: state.scopes.app, profile_file: state.scopes.profile && !state.profileIsRoot,
      profile_overrides: source === 'profile', profile_is_root: state.profileIsRoot, profile_home: 'profile-home'
    }
  }

  state.details[oid(101)] = {
    card: state.view.cards[0],
    desc: [
      'Pressing **Cancel** on step 2 closes the modal but leaves the *session* half-open.',
      'Details in [the docs](https://example.invalid/docs) and `onCancel()`.',
      '[bad](javascript:alert(1)) <script>alert(1)</script>',
      '',
      '```js',
      'if (cancelled) reset()',
      '```',
      '',
      '- [x] Reproduced',
      '- [ ] Fix handler'
    ].join('\n'),
    checklists: [
      {
        id: oid(40), name: 'QA',
        items: [
          { id: oid(41), name: 'Reproduce in Safari', state: 'complete' },
          { id: oid(42), name: 'Review the cancel handler', state: 'complete' },
          { id: oid(43), name: 'Clear session state', state: 'incomplete' },
          { id: oid(44), name: 'Add regression test', state: 'incomplete' }
        ]
      }
    ],
    list: { id: L.doing, name: 'In progress' },
    activity: [
      { id: oid(120), type: 'updateCard', author: 'Ada Demo', date: new Date(now - 30 * 60 * 1000).toISOString(), text: 'moved from Backlog to In progress' },
      { id: oid(121), type: 'commentCard', author: 'RM', date: new Date(now - 3 * HOUR).toISOString(), text: 'still happens on build 3.4' },
      { id: oid(122), type: 'updateCheckItemStateOnCard', author: 'AL', date: new Date(now - 26 * HOUR).toISOString(), text: 'completed Reproduce in Safari' },
      { id: oid(123), type: 'createCard', author: 'AL', date: new Date(now - 72 * HOUR).toISOString(), text: 'created this card in Backlog' }
    ],
    comments: [
      { id: oid(61), author: 'RM', text: 'still happens on build 3.4', date: new Date(now - 3 * HOUR).toISOString() },
      { id: oid(62), author: 'AL', text: 'looking at it today', date: new Date(now - 2 * HOUR).toISOString() }
    ],
    attachments: [
      { id: oid(50), name: 'repro.mov', url: 'https://example.invalid/repro.mov', is_upload: true, bytes: 2048, mime: 'video/quicktime' },
      { id: oid(51), name: 'broken-link', url: null, is_upload: false, bytes: null, mime: null }
    ]
  }

  const backend = {
    state,
    ids: { B1, L, M1, card1: oid(101), checklist: oid(40), item3: oid(43) },
    calls: [],
    failures: [],
    gates: [],
    /** Make requests matching `match(method, path)` fail with `error` (until `clear`). */
    failWhen(match, error) {
      const rule = { match, error }
      backend.failures.push(rule)

      return () => backend.failures.splice(backend.failures.indexOf(rule), 1)
    },
    /** Hold requests matching `match` until the returned `release()` is called. */
    hold(match) {
      let release
      const gate = { match, promise: new Promise(r => { release = r }) }
      backend.gates.push(gate)

      return () => { release(); backend.gates.splice(backend.gates.indexOf(gate), 1) }
    },
    callsTo(method, pattern) {
      return backend.calls.filter(c => c.method === method && pattern.test(c.path))
    }
  }

  const resolveCardId = ref => (state.view.cards.find(c => c.short_link === ref) || { id: ref }).id

  const recount = id => {
    const detail = state.details[id]

    if (!detail) {
      return
    }

    const items = detail.checklists.flatMap(c => c.items)
    const counts = { total: items.length, done: items.filter(i => i.state === 'complete').length }
    detail.card.checklist = counts
    state.view.cards.find(c => c.id === id).checklist = { ...counts }
  }

  backend.rest = async (rawPath, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase()
    const pathname = rawPath.split('?')[0]
    backend.calls.push({ method, path: pathname, body: opts.body, query: Object.fromEntries(new URLSearchParams(rawPath.split('?')[1] || '')) })

    for (const gate of backend.gates) {
      if (gate.match(method, pathname)) {
        await gate.promise
      }
    }

    for (const rule of backend.failures) {
      if (rule.match(method, pathname)) {
        throw rule.error
      }
    }

    const body = opts.body || {}
    let m

    if (method === 'GET' && pathname === '/health') {
      if (!state.connected) {
        return { connected: false, member: null, source: null, scope: null, ...(state.rejected ? { error: 'credentials_rejected' } : {}) }
      }

      const { source } = credentialStatus()

      return { connected: true, member: { id: M1, username: 'ada', full_name: 'Ada Demo' }, source, scope: source }
    }

    if (method === 'GET' && pathname === '/credentials') {
      return credentialStatus()
    }

    if (method === 'POST' && pathname === '/credentials') {
      const requested = body.scope || 'app'
      const stored = requested === 'profile' && state.profileIsRoot ? 'app' : requested
      state.scopes[stored] = true
      state.connected = true
      state.rejected = false

      return { connected: true, member: { id: M1, username: 'ada', full_name: 'Ada Demo' }, source: credentialStatus().source, scope: stored, scope_requested: requested, shadowed_by_env: state.env }
    }

    if (method === 'DELETE' && pathname === '/credentials') {
      const scope = new URLSearchParams(rawPath.split('?')[1] || '').get('scope') || credentialStatus().active_scope

      if (scope === 'app' || scope === 'profile') {
        state.scopes[scope === 'profile' && state.profileIsRoot ? 'app' : scope] = false
      }

      state.connected = state.env || state.scopes.app || state.scopes.profile

      return undefined
    }

    if (!state.connected) {
      throw apiError(424, 'not_connected', 'Trello is not connected.')
    }

    if (method === 'GET' && pathname === '/boards') {
      return JSON.parse(JSON.stringify(state.boards))
    }

    if (method === 'GET' && (m = /^\/boards\/([0-9a-f]{24})\/view$/.exec(pathname))) {
      return JSON.parse(JSON.stringify(state.view))
    }

    if (method === 'GET' && (m = /^\/cards\/([0-9a-f]{24}|[A-Za-z0-9]{8})$/.exec(pathname))) {
      m[1] = resolveCardId(m[1])
      const detail = state.details[m[1]]

      if (detail) {
        const live = state.view.cards.find(c => c.id === m[1])
        detail.card = { ...live, checklist: detail.card.checklist }

        return JSON.parse(JSON.stringify(detail))
      }

      const summary = state.view.cards.find(c => c.id === m[1])

      if (!summary) {
        throw apiError(404, 'not_found', 'gone')
      }

      return { card: JSON.parse(JSON.stringify(summary)), desc: '', list: { id: summary.id_list, name: state.view.lists.find(l => l.id === summary.id_list).name }, checklists: [], comments: [], attachments: [], activity: [] }
    }

    if (method === 'POST' && pathname === '/cards') {
      const created = card(50 + state.view.cards.length, body.name, body.list_id)
      state.view.cards.push(created)

      return created
    }

    if (method === 'PATCH' && (m = /^\/cards\/([0-9a-f]{24})$/.exec(pathname))) {
      const target = state.view.cards.find(c => c.id === m[1])

      if (body.id_list) target.id_list = body.id_list
      if ('due' in body) target.due = body.due
      if (body.closed) state.view.cards = state.view.cards.filter(c => c.id !== m[1])
      if (body.id_labels) {
        target.label_ids = [...body.id_labels]
        target.labels = body.id_labels.map(id => state.view.labels.find(l => l.id === id)).map(l => l.name || l.color)
      }

      return target
    }

    if (method === 'POST' && (m = /^\/cards\/([0-9a-f]{24})\/comments$/.exec(pathname))) {
      const detail = state.details[m[1]]
      const comment = { id: oid(70 + detail.comments.length), author: 'Ada Demo', text: body.text, date: new Date().toISOString() }
      detail.comments.unshift(comment)

      return comment
    }

    if (method === 'POST' && (m = /^\/cards\/([0-9a-f]{24})\/checklists$/.exec(pathname))) {
      const detail = state.details[m[1]]
      const checklist = { id: oid(80 + detail.checklists.length), name: body.name, items: [] }
      detail.checklists.push(checklist)

      return checklist
    }

    if (method === 'POST' && (m = /^\/checklists\/([0-9a-f]{24})\/items$/.exec(pathname))) {
      const detail = state.details[backend.ids.card1]
      const list = detail.checklists.find(c => c.id === m[1])
      const item = { id: oid(90 + list.items.length), name: body.name, state: 'incomplete' }
      list.items.push(item)
      recount(backend.ids.card1)

      return item
    }

    if ((m = /^\/checklists\/([0-9a-f]{24})\/items\/([0-9a-f]{24})$/.exec(pathname))) {
      const detail = state.details[backend.ids.card1]
      const list = detail.checklists.find(c => c.id === m[1])
      const item = list.items.find(i => i.id === m[2])

      if (method === 'DELETE') {
        list.items = list.items.filter(i => i.id !== m[2])
        recount(backend.ids.card1)

        return undefined
      }

      if (body.state) item.state = body.state
      if (body.name) item.name = body.name
      recount(backend.ids.card1)

      return item
    }

    throw apiError(404, 'not_found', `no route ${method} ${pathname}`)
  }

  return backend
}

// -- heavy board fixture -------------------------------------------------------------
//
// Shared by the render-count tests and scripts/render_screenshots.mjs. A synthetic stand-in for a real work board: 10 lanes, the first one with 80 cards, titles from 8 to 120
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

const DAY = 24 * HOUR

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

export function applyHeavyFixture(backend, { firstLane = 80, now = Date.now() } = {}) {
  const { state } = backend
  const iso = offsetMs => new Date(now + offsetMs).toISOString()
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


/** A `ctx` like the one the desktop app hands to register(). */
export function makeCtx(sdk, backend, { clipboard = true } = {}) {
  const store = new Map()
  const ctx = {
    registered: [],
    opened: [],
    clipboard: [],
    register(contribution) {
      ctx.registered.push(contribution)

      return () => {}
    },
    i18n: { register: bundles => sdk.registerLocales('trello-browser', bundles), t: (key, ...args) => sdk.translate('trello-browser', key, args) },
    storage: {
      get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      set: (key, value) => store.set(key, value),
      remove: key => store.delete(key)
    },
    store,
    os: {
      openExternal: async url => { ctx.opened.push(url); return true },
      writeClipboard: async text => { if (clipboard) ctx.clipboard.push(text); return clipboard }
    },
    // delays are shrunk so the new-chat retry loop finishes inside a test tick
    setTimeout: (fn, ms) => { const id = setTimeout(fn, Math.min(ms, 1)); return () => clearTimeout(id) },
    rest: (path, opts) => backend.rest(path, opts)
  }

  return ctx
}
