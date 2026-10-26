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

/** Copy plugin.js next to the SDK stub, point its SDK import at the stub, import both. */
export async function loadPlugin() {
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

  fs.writeFileSync(path.join(dir, 'plugin.mjs'), rewritten)

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

  return { dom, window: w, document: w.document, act, settle, mount, click, key, type, fire, resizeTo, React }
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
    id: oid(100 + n), name, id_list: list, due: null, due_complete: false, labels: [], id_members: [],
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
        card(1, 'Onboarding — step 2 has no exit on cancel', L.doing, { labels: ['red', 'bug'], due: new Date(now + 30 * HOUR).toISOString(), id_members: [M1], comment_count: 4, attachment_count: 1, checklist: { total: 4, done: 2 } }),
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
    details: {}
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
    backend.calls.push({ method, path: pathname, body: opts.body })

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
        return { connected: false, member: null, source: null, ...(state.rejected ? { error: 'credentials_rejected' } : {}) }
      }

      return { connected: true, member: { id: M1, username: 'ada', full_name: 'Ada Demo' }, source: 'file' }
    }

    if (method === 'POST' && pathname === '/credentials') {
      state.connected = true
      state.rejected = false

      return { connected: true, member: { id: M1, username: 'ada', full_name: 'Ada Demo' }, source: 'file', shadowed_by_env: false }
    }

    if (method === 'DELETE' && pathname === '/credentials') {
      state.connected = false

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

    if (method === 'GET' && (m = /^\/cards\/([0-9a-f]{24})$/.exec(pathname))) {
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

      return { card: JSON.parse(JSON.stringify(summary)), desc: '', checklists: [], comments: [], attachments: [] }
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
      if (body.id_labels) target.labels = body.id_labels.map(id => state.view.labels.find(l => l.id === id)).map(l => l.name || l.color)

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
