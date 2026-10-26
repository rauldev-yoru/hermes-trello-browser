import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apiError, findNodeModules, loadPlugin, makeBackend, makeCtx, oid, setupDom, SKIP_REASON } from './harness.mjs'

const skip = findNodeModules() ? false : SKIP_REASON

test('desktop pane render harness', { skip }, async t => {
  const { plugin, sdk } = await loadPlugin()
  const env = await setupDom()
  const $ = (root, selector) => root.querySelector(selector)
  const $$ = (root, selector) => [...root.querySelectorAll(selector)]
  const text = el => (el ? el.textContent : '')
  const byLabel = (root, label) => $(root, `[aria-label="${label}"]`)
  const byText = (root, selector, needle) => $$(root, selector).find(el => text(el).includes(needle))
  const names = root => $$(root, '[data-trello="card"]').map(el => text($(el, '[data-trello="card-open"] span')))

  /** Boot the pane against a synthetic backend; always unmounts afterwards. */
  const scenario = (name, options, body) =>
    t.test(name, async () => {
      const { backend = makeBackend(), clipboard = true, width = 380, settings = null, setup = null } = options
      setup && setup(backend)
      sdk.queryClient.reset()
      sdk.notifications.length = 0
      sdk.hostCalls.length = 0
      sdk.host.paneVisible.set(true)
      sdk.host.composer.insertText = async () => true
      sdk.host.composer.submit = () => true

      const ctx = makeCtx(sdk, backend, { clipboard })

      if (settings) {
        ctx.store.set('settings', settings)
      }

      plugin.default.register(ctx)
      const ui = await env.mount(env.React.createElement(plugin.PaneRoot))
      await env.resizeTo(width)

      try {
        await body({ ui, ctx, backend, root: ui.container, workspace: () => $(ui.container, '[data-trello="workspace"]') })
      } finally {
        await ui.unmount()
      }
    })

  const openCard = async (root, name) => {
    const card = $$(root, '[data-trello="card"]').find(el => text(el).includes(name))
    assert.ok(card, `card ${name}`)
    await env.click($(card, '[data-trello="card-open"]'))
  }

  const goToList = async (root, name) => env.click(byText(root, '[data-trello="chip"]', name))

  await scenario('registers the pane, the palette command and both locales', {}, async ({ ctx }) => {
    const pane = ctx.registered.find(c => c.area === 'panes')
    assert.equal(pane.id, 'pane')
    assert.deepEqual(pane.data, { placement: 'right', width: '380px', minWidth: '320px' })
    assert.equal(typeof pane.render, 'function')
    assert.equal(pane.render().type, plugin.PaneRoot)

    const palette = ctx.registered.find(c => c.area === 'palette')
    assert.equal(palette.data.label, 'Open Trello')
    palette.data.run()
    assert.ok(sdk.hostCalls.includes('revealPane:trello-browser:pane'))
    assert.equal(plugin.default.id, 'trello-browser')
    assert.equal(plugin.default.name, 'Trello Browser')
  })

  await scenario('list focus below 560 px: list chips with counts and one list of cards', { width: 380 }, async ({ root }) => {
    assert.equal($(root, '[data-trello-pane]').dataset.trelloPane, 'list')
    assert.equal($$(root, '[data-trello="lane"]').length, 0)
    assert.equal(text($(root, '[data-trello="board-picker"]')).includes('Product Launch'), true, 'starred board is the default')

    const chips = $$(root, '[data-trello="chip"]').map(text)
    assert.deepEqual(chips, ['Backlog1', 'In progress3', 'Review1', 'Done1'])
    assert.deepEqual(names(root), ['Export report to CSV'])

    await goToList(root, 'In progress')
    assert.deepEqual(names(root), ['Onboarding — step 2 has no exit on cancel', 'Empty state for search without copy', 'Migrate tooltips to the new component'])

    const first = $$(root, '[data-trello="card"]')[0]
    assert.ok(text(first).includes('☑ 2/4'))
    assert.ok(text(first).includes('💬 4'))
    assert.ok(text(first).includes('📎 1'))
    assert.ok($(first, '[data-trello="label-bar"]'), 'unnamed color renders a swatch')
    assert.equal(text($(first, '[data-trello="label-chip"]')), 'bug', 'named label renders a chip')
    assert.ok($(first, '[data-trello="due-soon"]'), 'due within 48h')
    assert.ok($(root, '[data-trello="due-overdue"]'), 'overdue card')
    assert.ok(text(first).includes('AD'), 'member initials')
  })

  await scenario('columns from 560 px, decided by the measured width', { width: 720 }, async ({ root }) => {
    assert.equal($(root, '[data-trello-pane]').dataset.trelloPane, 'columns')
    assert.equal($(root, '[data-trello-pane]').dataset.trelloWidth, '720')
    // the lane strip is shared with list mode: one chip per lane, with the same counts as the lane headers
    assert.deepEqual($$(root, '[data-trello="chip"]').map(text), ['Backlog1', 'In progress3', 'Review1', 'Done1'])
    assert.equal($(root, '[data-trello="lane-strip"]').dataset.mode, 'columns')

    const lanes = $$(root, '[data-trello="lane"]')
    assert.equal(lanes.length, 4)
    assert.deepEqual(lanes.map(l => text($(l, 'header'))), ['Backlog1', 'In progress3', 'Review1', 'Done1'])
    assert.equal(lanes.reduce((n, l) => n + $$(l, '[data-trello="card"]').length, 0), 6)

    const width = Number(lanes[0].dataset.laneWidth)
    assert.ok(width >= 220 && width <= 300, `lane width ${width}`)

    await env.resizeTo(400)
    assert.equal($(root, '[data-trello-pane]').dataset.trelloPane, 'list')
    await env.resizeTo(559)
    assert.equal($(root, '[data-trello-pane]').dataset.trelloPane, 'list')
    await env.resizeTo(560)
    assert.equal($(root, '[data-trello-pane]').dataset.trelloPane, 'columns')
  })

  await scenario('drawer with a rich card: safe markdown, checklists, comments, attachments, activity', { width: 720 }, async ({ root, ctx, backend }) => {
    await openCard(root, 'Onboarding')
    const drawer = $(root, '[data-trello="drawer"]')
    assert.ok(drawer, 'drawer is rendered inside the pane')
    assert.ok(root.contains(drawer))
    assert.equal(text($(drawer, '[data-trello="drawer-title"]')), 'Onboarding — step 2 has no exit on cancel')
    assert.ok(text(drawer).includes('Product Launch · In progress'))

    const md = $(drawer, '[data-trello="description"]')
    assert.equal(text($(md, 'strong')), 'Cancel')
    assert.equal(text($(md, 'em')), 'session')
    assert.ok($$(md, 'code').some(c => text(c) === 'onCancel()'))
    assert.equal(text($(md, 'pre')), 'if (cancelled) reset()')
    assert.deepEqual($$(md, 'li').map(li => text(li)), ['☑Reproduced', '☐Fix handler'])

    const links = $$(md, 'a')
    assert.deepEqual(links.map(a => a.getAttribute('href')), ['https://example.invalid/docs'])
    assert.equal($(md, 'script'), null, 'no script element is ever created')
    assert.ok(text(md).includes('<script>alert(1)</script>'), 'markup is shown as literal text')
    assert.ok(text(md).includes('[bad](javascript:alert(1))') || text(md).includes('bad'), 'unsafe link degrades to text')

    const prevented = await (async () => {
      let defaultPrevented = false
      const event = new env.window.MouseEvent('click', { bubbles: true, cancelable: true })
      await env.act(async () => { links[0].dispatchEvent(event); defaultPrevented = event.defaultPrevented })

      return defaultPrevented
    })()
    assert.equal(prevented, true)
    assert.deepEqual(ctx.opened, ['https://example.invalid/docs'])

    const items = $$(drawer, '[data-trello="item"]')
    assert.deepEqual(items.map(i => [text(i).slice(0, 12), $(i, 'input[type=checkbox]').checked]), [['Reproduce in', true], ['Review the c', true], ['Clear sessio', false], ['Add regressi', false]])

    assert.equal($$(drawer, '[data-trello="comment"]').length, 2)
    assert.ok($(drawer, 'textarea'), 'comment composer')
    assert.ok(text($(drawer, '[data-trello="attachments"]')).includes('repro.mov'))
    assert.equal($$($(drawer, '[data-trello="attachments"]'), 'button').length, 1, 'only the attachment with a URL can be opened')
    const activity = $(drawer, '[data-trello="activity"]')
    const rows = $$(activity, '[data-trello="activity-row"]')
    assert.deepEqual(rows.map(r => r.getAttribute('data-trello-type')), ['updateCard', 'commentCard', 'updateCheckItemStateOnCard', 'createCard'])
    assert.ok(text(rows[0]).includes('Ada Demo') && text(rows[0]).includes('moved from Backlog to In progress'))
    const ago = (n, unit) => new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(n, unit)
    assert.ok(text(rows[0]).includes(ago(-30, 'minute')), text(rows[0]))
    assert.ok(text(rows[2]).includes(ago(-1, 'day')), text(rows[2]))
    assert.ok(text(rows[1]).includes('still happens on build 3.4'))
    assert.equal(new Set(rows.map(r => $(r, '[data-icon]').getAttribute('data-icon'))).size, 4, 'one icon per type')
    assert.ok($(drawer, '[data-trello="drawer-send"]'))
    assert.ok($(drawer, '[data-trello="suggest"]'))
    assert.equal(backend.callsTo('GET', /^\/cards\//).length, 1)

    await env.key($(root, '[data-trello="workspace"]'), 'Escape')
    assert.equal($(root, '[data-trello="drawer"]'), null)
  })

  await scenario('empty state without credentials: connect form, then the workspace', { backend: makeBackend({ connected: false }) }, async ({ root, backend }) => {
    const form = $(root, '[data-trello="connect"]')
    assert.ok(form)
    assert.ok($(form, '[data-empty]'), 'the connect form sits under an EmptyState')
    assert.equal($$(root, '[data-trello="card"]').length, 0)
    assert.equal($(root, '[data-trello="rejected"]'), null)
    assert.equal($(form, '[data-trello="token"]').type, 'password')
    assert.equal($(form, '[data-trello="connect-submit"]').disabled, true)

    await env.type($(form, '[data-trello="api-key"]'), 'k'.repeat(32))
    await env.type($(form, '[data-trello="token"]'), 't'.repeat(64))
    await env.click($(root, '[data-trello="connect-submit"]'))

    const post = backend.callsTo('POST', /^\/credentials$/)
    assert.equal(post.length, 1)
    assert.deepEqual(post[0].body, { api_key: 'k'.repeat(32), token: 't'.repeat(64), scope: 'profile' }, 'This profile is the default')
    assert.equal($(root, '[data-trello="connect"]'), null)
    assert.ok($$(root, '[data-trello="card"]').length > 0, 'workspace appears after connecting')
    assert.equal(text(root).includes('t'.repeat(64)), false, 'the token is never rendered back')
    assert.ok(sdk.notifications.some(n => n.kind === 'success'))
  })

  await scenario('rejected credentials ask for a new key; a bad key shows the backend message', { backend: makeBackend({ connected: false, rejected: true }) }, async ({ root, backend }) => {
    assert.ok($(root, '[data-trello="rejected"]'))
    backend.failWhen((m, p) => m === 'POST' && p === '/credentials', apiError(401, 'credentials_rejected', 'Trello rejected the stored API key or token.'))
    await env.type($(root, '[data-trello="api-key"]'), 'k'.repeat(32))
    await env.type($(root, '[data-trello="token"]'), 'x'.repeat(64))
    await env.click($(root, '[data-trello="connect-submit"]'))
    assert.equal(text($(root, '[data-trello="connect-error"]')), 'Trello rejected the stored API key or token.')
    assert.ok($(root, '[data-trello="connect"]'), 'stays on the form')
  })

  let release503
  await scenario('error state with retry when the board cannot be loaded', { setup: b => { release503 = b.failWhen((m, p) => /\/view$/.test(p), apiError(503, 'trello_unavailable', 'Trello is unreachable right now.')) } }, async ({ root }) => {
    const error = $(root, '[data-error]')
    assert.ok(error, 'error state')
    assert.ok(text(error).includes('cannot reach Trello'), 'the backend answered: Trello itself is the problem')
    assert.equal($$(root, '[data-trello="card"]').length, 0)
    release503()
    await env.click(byText(error, 'button', 'Retry'))
    assert.equal($(root, '[data-error]'), null)
    assert.ok($$(root, '[data-trello="card"]').length > 0)
  })

  await scenario('a dead backend never crashes the pane', { backend: Object.assign(makeBackend(), { rest: async () => { throw new Error('Hermes desktop bridge unavailable') } }) }, async ({ root }) => {
    const error = $(root, '[data-error]')
    assert.ok(error)
    assert.ok(text(error).includes('did not answer'))
    assert.ok($(error, '[data-trello="retry"]'))
  })

  const raw = (status, body) => Object.assign(new Error(`${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`), { statusCode: status })
  const errorOf = root => $(root, '[data-trello="error"]')

  await scenario('plugin not mounted for the profile: a specific explanation with retry', { backend: Object.assign(makeBackend(), { rest: async () => { throw raw(404, { detail: 'Plugin not found' }) } }) }, async ({ root }) => {
    const error = errorOf(root)
    assert.ok(error, 'error body')
    assert.equal(error.getAttribute('data-trello-error'), 'plugin_not_mounted')
    assert.ok(text(error).includes('not mounted for this profile'))
    assert.ok(text(error).includes('restart the dashboard'))
    assert.ok(!text(error).includes('Something went wrong'))
    assert.ok($(error, '[data-trello="retry"]'))
    assert.equal($(root, '[data-trello="connect"]'), null)
  })

  await scenario('backend down (503 without our contract): no connection, with retry', { backend: Object.assign(makeBackend(), { rest: async () => { throw raw(503, '<html>Service Unavailable</html>') } }) }, async ({ root }) => {
    const error = errorOf(root)
    assert.equal(error.getAttribute('data-trello-error'), 'network')
    assert.ok(text(error).includes('No connection to the Trello backend'))
    assert.ok($(error, '[data-trello="retry"]'))
  })

  await scenario('401 credentials_rejected from the board view offers the connect form again', { setup: b => { b.failWhen((m, p) => /\/view$/.test(p), apiError(401, 'credentials_rejected', 'rejected')) } }, async ({ root }) => {
    assert.ok($(root, '[data-trello="connect"]'), 'connect form')
    assert.ok($(root, '[data-trello="rejected"]'), 'says the credentials were rejected')
    assert.equal(errorOf(root), null)
  })

  await scenario('424 not_connected from the boards list shows the connect form', { setup: b => { b.failWhen((m, p) => p === '/boards', apiError(424, 'not_connected', 'no')) } }, async ({ root }) => {
    assert.ok($(root, '[data-trello="connect"]'))
    assert.equal($(root, '[data-trello="rejected"]'), null)
  })

  await scenario('an account without boards shows an empty state', { setup: b => { b.state.boards = [] } }, async ({ root }) => {
    assert.ok($(root, '[data-empty]'))
    assert.ok(text($(root, '[data-empty]')).includes('No open boards'))
  })

  await scenario('a board without lists shows an empty state', { setup: b => { b.state.view.lists = []; b.state.view.cards = [] } }, async ({ root }) => {
    assert.ok(text($(root, '[data-empty]')).includes('no lists yet'))
  })

  await scenario('stale: the old board stays visible and is labelled when a refetch fails', {}, async ({ root, backend }) => {
    assert.equal($(root, '[data-trello="stale"]'), null)
    const clear = backend.failWhen((m, p) => /\/view$/.test(p), apiError(503, 'trello_unavailable'))
    await env.click(byLabel(root, 'Refresh'))
    assert.ok($(root, '[data-trello="stale"]'), 'stale strip')
    assert.deepEqual(names(root), ['Export report to CSV'], 'last good payload is still on screen')
    clear()
    await env.click(byLabel(root, 'Refresh'))
    assert.equal($(root, '[data-trello="stale"]'), null)

    backend.failWhen((m, p) => /\/view$/.test(p), apiError(429, 'rate_limited', 'slow', 4))
    await env.click(byLabel(root, 'Refresh'))
    assert.ok(text($(root, '[data-trello="strip"]')).includes('rate-limiting'))
    assert.equal(names(root).length, 1)
  })

  const selectFirst = async root => {
    await env.key($(root, '[data-trello="workspace"]'), 'j')
  }

  await scenario('send to agent: click inserts, shift+click sends, never both', {}, async ({ root }) => {
    const calls = []
    sdk.host.composer.insertText = async (addr, block, opts) => { calls.push(['insert', addr, block, opts]); return true }
    sdk.host.composer.submit = (addr, block) => { calls.push(['submit', addr, block]); return true }

    await selectFirst(root)
    const send = $(root, '[data-trello="card"][data-selected="true"] [data-trello="send"]')
    assert.ok(send, 'selected card shows its actions')

    await env.click(send)
    assert.equal(calls.length, 1)
    assert.deepEqual([calls[0][0], calls[0][1], calls[0][3]], ['insert', null, { mode: 'block' }])
    const block = calls[0][2]
    assert.ok(block.startsWith('[Trello card] Export report to CSV\nboard: Product Launch · list: Backlog · due: — · labels: purple, green\n'))
    assert.ok(block.includes('--- card data (untrusted, from Trello) ---\ndescription: (empty)\nchecklists: (none)\ncomments (latest 3): (none)\n--- end card data ---\n'))
    assert.ok(block.endsWith('Use your Trello tools to read or update this card.'))
    assert.ok(sdk.notifications.some(n => n.kind === 'success' && n.message.includes('inserted')))

    await env.click(send, { shiftKey: true })
    assert.deepEqual(calls[1].slice(0, 2), ['submit', null])
    assert.ok(sdk.notifications.some(n => n.message.includes('sent to the agent')))
  })

  await scenario('send to agent: a card with detail carries description, checklists and comments', {}, async ({ root }) => {
    const calls = []
    sdk.host.composer.insertText = async (addr, block) => { calls.push(block); return true }
    await goToList(root, 'In progress')
    await selectFirst(root)
    await env.click($(root, '[data-trello="card"][data-selected="true"] [data-trello="send"]'))
    const block = calls[0]
    assert.ok(block.includes('list: In progress'))
    assert.ok(block.includes('description: Pressing **Cancel** on step 2'))
    assert.ok(block.includes('checklists: QA [2/4] Reproduce in Safari, Review the cancel handler, Clear session state, Add regression test'))
    assert.ok(block.includes('comments (latest 3): RM: still happens on build 3.4 ; AL: looking at it today'))
    assert.equal(block.split('\n').filter(l => l === '--- end card data ---').length, 1)
  })

  await scenario('send to agent: fallback chain insert → new chat → clipboard → manual copy', {}, async ({ root, ctx }) => {
    const log = []
    sdk.host.composer.insertText = async addr => { log.push(addr); return addr === 'new' }
    await selectFirst(root)
    const send = () => $(root, '[data-trello="card"][data-selected="true"] [data-trello="send"]')

    await env.click(send())
    await env.settle(30)
    assert.deepEqual(log, [null, 'new'])
    assert.deepEqual(sdk.hostCalls.filter(c => c === 'newChat'), ['newChat'])
    assert.ok(sdk.notifications.some(n => n.message.includes('new chat')))

    sdk.host.composer.insertText = async () => false
    sdk.hostCalls.length = 0
    await env.click(send())
    await env.settle(40)
    assert.equal(ctx.clipboard.length, 1)
    assert.ok(ctx.clipboard[0].startsWith('[Trello card]'))
    assert.ok(sdk.notifications.some(n => n.kind === 'info' && n.message.includes('clipboard')))
  })

  await scenario('send to agent: when even the clipboard fails the block is shown for manual copy', { clipboard: false }, async ({ root }) => {
    sdk.host.composer.insertText = async () => false
    await selectFirst(root)
    await env.click($(root, '[data-trello="card"][data-selected="true"] [data-trello="send"]'))
    await env.settle(40)
    const dialog = $(root, '[role="dialog"]')
    assert.ok(dialog)
    assert.ok($(dialog, 'textarea').value.startsWith('[Trello card]'))
    assert.ok($(dialog, '[data-copy]').getAttribute('data-copy').startsWith('[Trello card]'))
    assert.ok(sdk.notifications.some(n => n.kind === 'error'))
  })

  await scenario('send to agent: sendMode "submit" sends on a plain click', { settings: { sendMode: 'submit', refreshSec: 25, defaultBoard: null } }, async ({ root }) => {
    const calls = []
    sdk.host.composer.insertText = async () => { calls.push('insert'); return true }
    sdk.host.composer.submit = () => { calls.push('submit'); return true }
    await selectFirst(root)
    await env.click($(root, '[data-trello="card"][data-selected="true"] [data-trello="send"]'))
    assert.deepEqual(calls, ['submit'])
  })

  await scenario('send to agent: unloadable detail still sends and warns', {}, async ({ root, backend }) => {
    const calls = []
    sdk.host.composer.insertText = async (addr, block) => { calls.push(block); return true }
    backend.failWhen((m, p) => m === 'GET' && /^\/cards\//.test(p), apiError(503, 'trello_unavailable'))
    await selectFirst(root)
    await env.click($(root, '[data-trello="card"][data-selected="true"] [data-trello="send"]'))
    assert.ok(calls[0].includes('description: (not loaded)'))
    assert.ok(sdk.notifications.some(n => n.kind === 'warning'))
  })

  await scenario('suggest checklist only inserts a prepared prompt', {}, async ({ root }) => {
    const calls = []
    sdk.host.composer.insertText = async (addr, block, opts) => { calls.push([addr, block, opts]); return true }
    sdk.host.composer.submit = () => { calls.push('submit'); return true }
    await goToList(root, 'In progress')
    await openCard(root, 'Onboarding')
    await env.click($(root, '[data-trello="suggest"]'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], null)
    assert.ok(calls[0][1].startsWith('[Trello card] Onboarding'))
    assert.ok(calls[0][1].endsWith('Propose a QA checklist for this card as a list; do not write it to Trello yet.'))
  })

  await scenario('checklist toggle is optimistic and rolls back on error', {}, async ({ root, backend }) => {
    await goToList(root, 'In progress')
    await openCard(root, 'Onboarding')
    const checkbox = () => $$(root, '[data-trello="item"]')[2].querySelector('input')
    const progress = () => text($$(root, '[data-trello="card"]')[0])
    assert.equal(checkbox().checked, false)
    assert.ok(progress().includes('☑ 2/4'))

    const release = backend.hold((m, p) => m === 'PATCH' && /\/items\//.test(p))
    await env.click(checkbox())
    assert.equal(checkbox().checked, true, 'checked before the server answered')
    assert.ok(progress().includes('☑ 3/4'), 'board card progress follows optimistically')
    release()
    await env.settle()
    assert.equal(checkbox().checked, true)
    assert.deepEqual(backend.callsTo('PATCH', /items/).at(-1).body, { state: 'complete' })

    const clear = backend.failWhen((m, p) => m === 'PATCH' && /\/items\//.test(p), apiError(503, 'trello_unavailable'))
    await env.click(checkbox())
    assert.equal(checkbox().checked, true, 'rolled back to the previous state')
    assert.ok(progress().includes('☑ 3/4'))
    assert.ok(sdk.notifications.some(n => n.kind === 'error' && n.message.includes('cannot reach Trello')))
    clear()
  })

  await scenario('moving a card is optimistic and rolls back on error', {}, async ({ root, backend }) => {
    await goToList(root, 'In progress')
    await openCard(root, 'Onboarding')
    const move = list => byText($(root, '[data-trello="drawer-controls"]'), '[role="menuitem"]', list)
    const inList = () => names(root).filter(n => n.startsWith('Onboarding')).length

    const release = backend.hold((m, p) => m === 'PATCH' && /^\/cards\//.test(p))
    await env.click(move('Review'))
    assert.equal(inList(), 0, 'left the active list before the server answered')
    release()
    await env.settle()
    assert.equal(inList(), 0)
    assert.deepEqual(backend.callsTo('PATCH', /^\/cards\//).at(-1).body, { id_list: backend.ids.L.review })
    assert.ok(sdk.notifications.some(n => n.kind === 'success' && n.message === 'Moved to Review'))

    await goToList(root, 'Review')
    await openCard(root, 'Onboarding')
    backend.failWhen((m, p) => m === 'PATCH', apiError(503, 'trello_unavailable'))
    sdk.notifications.length = 0
    await env.click(byText($(root, '[data-trello="drawer-controls"]'), '[role="menuitem"]', 'Done'))
    assert.equal(names(root).filter(n => n.startsWith('Onboarding')).length, 1, 'rolled back into Review')
    assert.ok(sdk.notifications.some(n => n.kind === 'error'))
  })

  await scenario('keyboard: j/k move, Enter opens, Esc closes, s sends, c copies the link', {}, async ({ root, ctx }) => {
    await goToList(root, 'In progress')
    const ws = $(root, '[data-trello="workspace"]')
    const selected = () => $$(root, '[data-trello="card"]').map(c => c.dataset.selected)
    const inserted = []
    sdk.host.composer.insertText = async (addr, block) => { inserted.push(block); return true }

    await env.key(ws, 'j')
    assert.deepEqual(selected(), ['true', 'false', 'false'])
    await env.key(ws, 'j')
    await env.key(ws, 'j')
    await env.key(ws, 'j')
    assert.deepEqual(selected(), ['false', 'false', 'true'], 'stops at the last card')
    await env.key(ws, 'k')
    assert.deepEqual(selected(), ['false', 'true', 'false'])

    await env.key(ws, 'Enter')
    assert.ok($(root, '[data-trello="drawer"]'))
    assert.ok(text($(root, '[data-trello="drawer-title"]')).startsWith('Empty state'))
    await env.key(ws, 'Escape')
    assert.equal($(root, '[data-trello="drawer"]'), null)

    await env.key(ws, 's')
    assert.equal(inserted.length, 1)
    assert.ok(inserted[0].startsWith('[Trello card] Empty state'))

    await env.key(ws, 'c')
    assert.deepEqual(ctx.clipboard, ['https://trello.com/c/Card0002'])
    assert.ok(sdk.notifications.some(n => n.message === 'Link copied'))

    const before = selected()
    await env.key(ws, 'j', { ctrlKey: true })
    assert.deepEqual(selected(), before, 'modified keys are ignored')
  })

  await scenario('keyboard shortcuts are inert while typing', {}, async ({ root }) => {
    await env.click(byLabel(root, 'Board picker') || $(root, '[data-trello="board-picker"]'))
    const input = $(root, '[data-popover] input')
    assert.ok(input)
    await env.key(input, 'j')
    await env.key(input, 's')
    assert.equal($$(root, '[data-trello="card"][data-selected="true"]').length, 0)
  })

  await scenario('polling only while the pane is visible, at the configured interval', {}, async ({ root, backend }) => {
    const view = sdk.optionLog.get(JSON.stringify(['trello', 'view', backend.ids.B1]))
    assert.equal(typeof view.refetchInterval, 'function', 'polling goes through the query client, not a timer')
    assert.equal(view.refetchInterval(), 25000)
    assert.equal(view.refetchOnWindowFocus, true)

    await env.act(async () => sdk.host.paneVisible.set(false))
    assert.equal(view.refetchInterval(), false, 'hidden pane: no polling')

    const before = backend.callsTo('GET', /\/view$/).length
    await env.act(async () => sdk.host.paneVisible.set(true))
    await env.settle()
    assert.equal(view.refetchInterval(), 25000)
    assert.equal(backend.callsTo('GET', /\/view$/).length, before + 1, 'revealing the pane refreshes once')

    assert.equal(view.retry(0, apiError(404, 'not_found')), false, '4xx is not retried')
    assert.equal(view.retry(0, apiError(503, 'trello_unavailable')), true)
    assert.equal(view.retry(1, apiError(503, 'trello_unavailable')), false)
  })

  await scenario('settings: send mode, refresh interval, default board and disconnect', { settings: { credentialScope: 'app' } }, async ({ root, ctx, backend }) => {
    const polls = () => sdk.optionLog.get(JSON.stringify(['trello', 'view', backend.ids.B1])).refetchInterval()
    await env.click($(root, '[data-trello="settings-button"]'))
    const panel = $(root, '[data-trello="settings"]')
    assert.ok(text(panel).includes('Signed in as ada'))

    await env.click(byText(panel, '[role="radio"]', 'Send'))
    assert.equal(ctx.store.get('settings').sendMode, 'submit')
    await env.click(byText(panel, '[role="radio"]', 'Off'))
    assert.equal(ctx.store.get('settings').refreshSec, 0)
    assert.equal(polls(), false)
    await env.click(byText(panel, '[role="radio"]', '60s'))
    assert.equal(polls(), 60000)

    await env.click(byText($(root, '[data-trello="default-board"]').parentElement, '[role="menuitem"]', 'Archive tools'))
    assert.equal(ctx.store.get('settings').defaultBoard, oid(9))

    await env.click($(panel, '[data-trello="disconnect"]'))
    const dialog = $(root, '[role="dialog"][aria-label="Disconnect Trello?"]')
    assert.ok(dialog)
    await env.click($(dialog, '[data-confirm]'))
    assert.equal(backend.callsTo('DELETE', /^\/credentials$/).length, 1)
    assert.equal(backend.callsTo('DELETE', /^\/credentials$/)[0].query.scope, 'app', 'Disconnect acts on the chosen scope')
    assert.ok($(root, '[data-trello="connect"]'), 'back to the connect form')
    assert.equal(ctx.store.has('boardId'), false)
  })

  await scenario('board picker: starred first, searchable, remembers the last board', {}, async ({ root, ctx }) => {
    await env.click($(root, '[data-trello="board-picker"]'))
    assert.deepEqual($$(root, '[data-trello="board-option"]').map(text), ['Product Launch', 'Archive tools'])
    await env.type($(root, '[data-popover] input'), 'arch')
    assert.deepEqual($$(root, '[data-trello="board-option"]').map(text), ['Archive tools'])
    await env.click($(root, '[data-trello="board-option"]'))
    assert.equal(ctx.store.get('boardId'), oid(9))
    assert.ok(text($(root, '[data-trello="board-picker"]')).includes('Archive tools'))
    assert.equal($(root, '[data-popover]'), null, 'picker closes')
  })

  await scenario('the last board is restored from storage', { settings: null }, async ({ root }) => {
    assert.ok(text($(root, '[data-trello="board-picker"]')).includes('Product Launch'))
  })

  await scenario('writes: create card, comment, checklist, items, due, labels, archive', { width: 720 }, async ({ root, backend }) => {
    // create card in the "Review" lane
    const lane = $$(root, '[data-trello="lane"]')[2]
    await env.click($(lane, '[data-trello="add-card"]'))
    await env.type($(lane, 'input'), 'Write the release notes')
    await env.key($(lane, 'input'), 'Enter')
    assert.deepEqual(backend.callsTo('POST', /^\/cards$/).at(-1).body, { list_id: backend.ids.L.review, name: 'Write the release notes' })
    assert.ok(names(root).includes('Write the release notes'), 'new card appears after the refresh')
    assert.ok(sdk.notifications.some(n => n.message === 'Card created'))

    await openCard(root, 'Onboarding')
    const drawer = () => $(root, '[data-trello="drawer"]')

    await env.type($(drawer(), '[data-trello="comments"] textarea'), 'Fixed in the next build')
    await env.click(byText(drawer(), '[data-trello="comments"] button', 'Comment'))
    assert.deepEqual(backend.callsTo('POST', /comments$/).at(-1).body, { text: 'Fixed in the next build' })
    assert.equal($$(drawer(), '[data-trello="comment"]').length, 3)

    await env.type(byLabel(drawer(), 'New item'), 'Ship it')
    await env.click(byText(drawer(), '[data-trello="checklist"] button', 'Add item'))
    assert.deepEqual(backend.callsTo('POST', /\/items$/).at(-1).body, { name: 'Ship it' })
    assert.equal($$(drawer(), '[data-trello="item"]').length, 5)

    await env.type(byLabel(drawer(), 'Checklist title'), 'Release')
    await env.click(byText(drawer(), 'button', 'Add checklist'))
    assert.deepEqual(backend.callsTo('POST', /\/checklists$/).at(-1).body, { name: 'Release' })
    assert.equal($$(drawer(), '[data-trello="checklist"]').length, 2)

    await env.click($$(drawer(), '[data-trello="item"]')[0].querySelector('[aria-label="Rename item"]'))
    const rename = $(drawer(), '[data-trello="item"] input[type=text], [data-trello="item"] input:not([type])')
    await env.type(rename, 'Reproduce in Firefox')
    await env.key(rename, 'Enter')
    assert.deepEqual(backend.callsTo('PATCH', /items/).at(-1).body, { name: 'Reproduce in Firefox' })

    await env.click($$(drawer(), '[data-trello="item"]')[1].querySelector('[aria-label="Delete item"]'))
    assert.equal(backend.callsTo('DELETE', /items/).length, 1)

    await env.type($(drawer(), '[data-trello="due-input"]'), '2026-12-01')
    const due = backend.callsTo('PATCH', /^\/cards\//).at(-1).body.due
    assert.equal(new Date(due).getUTCFullYear(), 2026)
    await env.click(byText(drawer(), 'button', 'Clear'))
    assert.deepEqual(backend.callsTo('PATCH', /^\/cards\//).at(-1).body, { due: null })

    // two labels share the color "red" (one has no name): the editor works from label ids
    await env.click($(drawer(), '[data-trello="labels-button"]'))
    const box = name => drawer().querySelector(`input[aria-label="${name}"]`)
    assert.equal(box('bug').disabled, false)
    assert.equal(box('red').disabled, false, 'no ambiguity lock')
    assert.deepEqual([box('bug').checked, box('red').checked, box('onboarding').checked], [true, true, false])
    await env.click(box('red'))
    assert.deepEqual(backend.callsTo('PATCH', /^\/cards\//).at(-1).body, { id_labels: [oid(31)] })
    await env.click(box('red'))
    assert.deepEqual(backend.callsTo('PATCH', /^\/cards\//).at(-1).body, { id_labels: [oid(31), oid(32)] })
    await env.click(box('onboarding'))
    assert.deepEqual(backend.callsTo('PATCH', /^\/cards\//).at(-1).body, { id_labels: [oid(31), oid(32), oid(33)] })

    await env.click($(drawer(), '[data-trello="archive"]'))
    const confirm = $(root, '[role="dialog"][aria-label="Archive this card?"]')
    assert.ok(confirm)
    await env.click($(confirm, '[data-confirm]'))
    assert.deepEqual(backend.callsTo('PATCH', /^\/cards\//).at(-1).body, { closed: true })
    assert.equal($(root, '[data-trello="drawer"]'), null)
    assert.equal(names(root).some(n => n.startsWith('Onboarding')), false)
    assert.ok(sdk.notifications.some(n => n.message === 'Card archived'))
  })

  await scenario('open in Trello uses the OS handler, never window.open', { width: 720 }, async ({ root, ctx }) => {
    await openCard(root, 'Onboarding')
    await env.click(byText($(root, '[data-trello="drawer"]'), 'button', 'Open in Trello'))
    assert.deepEqual(ctx.opened, ['https://trello.com/c/Card0001'])
  })

  // -- credential scope and the connection flow ---------------------------------
  const openSettings = async root => {
    await env.click($(root, '[data-trello="settings-button"]'))

    return $(root, '[data-trello="settings"]')
  }

  const radio = (panel, label) => byText($(panel, '[data-trello="cred-scope"]'), '[role="radio"]', label)
  const line = panel => text($(panel, '[data-trello="cred-state"]'))
  const has = (panel, hook) => Boolean($(panel, `[data-trello="${hook}"]`))
  const writes = backend => backend.calls.filter(c => c.method !== 'GET')
  const dialogTitled = (root, title) => $(root, `[role="dialog"][aria-label="${title}"]`)
  const WARNING = 'Use one account for every profile?'

  await scenario('credentials: the scope defaults to This profile and switching to it moves nothing', {}, async ({ root, ctx, backend }) => {
    const panel = await openSettings(root)
    assert.deepEqual($$($(panel, '[data-trello="cred-scope"]'), '[role="radio"]').map(text), ['All profiles', 'This profile'])
    assert.equal(radio(panel, 'This profile').getAttribute('aria-checked'), 'true', 'default: this profile')
    assert.equal(radio(panel, 'All profiles').getAttribute('aria-checked'), 'false')
    assert.equal(ctx.store.has('settings'), false, 'merely opening Settings stores nothing')
    assert.equal($(root, '[data-trello="connect"]'), null, 'the empty-state form has no selector')
    await env.click(radio(panel, 'This profile'))
    assert.equal(ctx.store.get('settings').credentialScope, 'profile')
    assert.equal(writes(backend).length, 0)
  })

  await scenario('credentials: a stored choice is respected', { settings: { credentialScope: 'app' } }, async ({ root }) => {
    const panel = await openSettings(root)
    assert.equal(radio(panel, 'All profiles').getAttribute('aria-checked'), 'true')
    assert.equal(radio(panel, 'This profile').getAttribute('aria-checked'), 'false')
  })

  await scenario('credentials: choosing All profiles asks first and persists nothing until confirmed', {}, async ({ root, ctx, backend }) => {
    const panel = await openSettings(root)
    await env.click(radio(panel, 'All profiles'))
    const dialog = dialogTitled(root, WARNING)
    assert.ok(dialog, 'warning dialog')
    assert.deepEqual($$(dialog, 'li').map(text), [
      'Credentials saved from now on are stored once for the whole app.',
      'Every profile without its own connection will use this account.',
      'Profiles that already have their own credentials keep them — disconnect them explicitly to fall back to this one.'
    ])
    assert.equal(text(byText(dialog, 'button', 'Use for all profiles')), 'Use for all profiles')
    assert.ok(byText(dialog, 'button', 'Cancel'))
    assert.equal(ctx.store.has('settings'), false, 'nothing persisted while the question is open')
    assert.equal(writes(backend).length, 0)
  })

  await scenario('credentials: cancelling the warning keeps This profile and writes nothing', {}, async ({ root, ctx, backend }) => {
    let panel = await openSettings(root)
    await env.click(radio(panel, 'All profiles'))
    await env.click(byText(dialogTitled(root, WARNING), 'button', 'Cancel'))
    assert.equal(dialogTitled(root, WARNING), null, 'dialog closed')
    assert.equal(ctx.store.has('settings'), false)
    assert.equal(writes(backend).length, 0)
    panel = await openSettings(root)
    assert.equal(radio(panel, 'This profile').getAttribute('aria-checked'), 'true', 'the selector is back on This profile')
    assert.equal(radio(panel, 'All profiles').getAttribute('aria-checked'), 'false')
  })

  await scenario('credentials: confirming the warning persists the scope and copies or moves no credential', { setup: b => { b.state.scopes = { app: true, profile: true } } }, async ({ root, ctx, backend }) => {
    let panel = await openSettings(root)
    await env.click(radio(panel, 'All profiles'))
    await env.click($(dialogTitled(root, WARNING), '[data-confirm]'))
    assert.equal(ctx.store.get('settings').credentialScope, 'app')
    assert.equal(writes(backend).length, 0, 'no POST, no DELETE')
    assert.deepEqual(backend.state.scopes, { app: true, profile: true }, 'what is stored is untouched')
    panel = await openSettings(root)
    assert.equal(radio(panel, 'All profiles').getAttribute('aria-checked'), 'true')
    await env.click(radio(panel, 'This profile'))
    assert.equal(dialogTitled(root, WARNING), null, 'going back to This profile asks nothing')
    assert.equal(ctx.store.get('settings').credentialScope, 'profile')
  })

  await scenario('credentials panel (1/4) app-wide account, chosen This profile: says so and offers to connect the profile', { setup: b => { b.state.scopes = { app: true, profile: false } } }, async ({ root }) => {
    const panel = await openSettings(root)
    assert.equal(line(panel), 'Using the app-wide account for this profile')
    assert.equal(text($(panel, '[data-trello="cred-reconnect"]')), 'Reconnect to store credentials for this profile')
    assert.equal(text($(panel, '[data-trello="cred-connect"]')), 'Connect this profile')
    assert.equal(has(panel, 'cred-change'), false)
    assert.equal(has(panel, 'disconnect'), false, 'there is nothing of this profile to disconnect')
    assert.equal(has(panel, 'cred-overrides'), false)
  })

  await scenario('credentials panel (2/4) connected in the chosen scope: Change account and Disconnect', { settings: { credentialScope: 'app' } }, async ({ root }) => {
    const panel = await openSettings(root)
    assert.equal(line(panel), 'Using credentials for all profiles')
    assert.equal(text($(panel, '[data-trello="cred-change"]')), 'Change account')
    assert.equal(text($(panel, '[data-trello="disconnect"]')), 'Disconnect')
    assert.equal(has(panel, 'cred-connect'), false)
    assert.equal(has(panel, 'cred-remove-profile'), false)
  })

  await scenario('credentials panel (3/4) this profile overrides the app-wide account: line and Remove', { setup: b => { b.state.scopes = { app: true, profile: true } } }, async ({ root }) => {
    let panel = await openSettings(root)
    assert.equal(line(panel), 'Using credentials for this profile')
    assert.equal(text($(panel, '[data-trello="cred-overrides"]')), 'This profile overrides the app-wide account')
    assert.equal(text($(panel, '[data-trello="cred-remove-profile"]')), "Remove this profile's connection")
    assert.equal(text($(panel, '[data-trello="cred-change"]')), 'Change account')
    assert.equal(has(panel, 'disconnect'), false, 'Remove is the Disconnect of this profile, shown once')
    await env.click(radio(panel, 'All profiles'))
    await env.click($(dialogTitled(root, WARNING), '[data-confirm]'))
    panel = await openSettings(root)
    assert.ok(has(panel, 'cred-remove-profile') && has(panel, 'disconnect') && has(panel, 'cred-change'), 'viewed from All profiles every action applies')
  })

  await scenario('credentials panel (3b) a profile file alone is not an override', { setup: b => { b.state.scopes = { app: false, profile: true } } }, async ({ root }) => {
    const panel = await openSettings(root)
    assert.equal(line(panel), 'Using credentials for this profile')
    assert.equal(has(panel, 'cred-overrides'), false)
    assert.equal(has(panel, 'cred-remove-profile'), false)
    assert.ok(has(panel, 'disconnect'))
  })

  await scenario('credentials panel (4/4) environment credentials: locked, explained, nothing to change', { setup: b => { b.state.env = true } }, async ({ root, ctx }) => {
    const panel = await openSettings(root)
    assert.equal(line(panel), 'Using environment credentials')
    const radios = $$($(panel, '[data-trello="cred-scope"]'), '[role="radio"]')
    assert.ok(radios.length === 2 && radios.every(r => r.disabled), 'the selector is disabled')
    assert.equal($(panel, '[data-trello="cred-scope"] [role="radiogroup"]').getAttribute('aria-disabled'), 'true')
    const tip = $(panel, '[data-trello="cred-scope"]').getAttribute('data-tip')
    assert.ok(tip.includes('TRELLO_API_KEY') && tip.includes('TRELLO_TOKEN') && tip.includes('Remove them'), tip)
    for (const hook of ['cred-change', 'disconnect', 'cred-connect', 'cred-remove-profile']) {
      assert.equal(has(panel, hook), false, `no ${hook} while the environment decides`)
    }

    await env.click(radios[0])
    assert.equal(ctx.store.has('settings'), false, 'a disabled option changes nothing')
    assert.equal(dialogTitled(root, WARNING), null)
  })

  await scenario('credentials panel: not configured offers Connect', {}, async ({ root, backend }) => {
    await openSettings(root)
    await env.click($(root, '[data-trello="settings-button"]')) // close
    backend.state.scopes = { app: false, profile: false }
    const panel = await openSettings(root)
    assert.equal(line(panel), 'No credentials stored')
    assert.equal(text($(panel, '[data-trello="cred-connect"]')), 'Connect')
    assert.equal(has(panel, 'cred-change'), false)
    assert.equal(has(panel, 'disconnect'), false)
    await env.click($(panel, '[data-trello="cred-connect"]'))
    const dialog = $(root, '[data-trello="change-dialog"]')
    assert.ok(dialog)
    assert.ok(text(dialog).includes('Connect your Trello account'))
    assert.ok($(dialog, '[data-trello="api-key"]') && $(dialog, '[data-trello="token"]'))
  })

  await scenario('Change account: opens the connection form in a dialog and saves to the chosen scope', { setup: b => { b.state.scopes = { app: true, profile: true } } }, async ({ root, backend }) => {
    const panel = await openSettings(root)
    const boardsBefore = backend.callsTo('GET', /^\/boards$/).length
    await env.click($(panel, '[data-trello="cred-change"]'))
    const dialog = $(root, '[data-trello="change-dialog"]')
    assert.ok(dialog, 'dialog')
    assert.equal(text($(dialog, 'h2')), 'Change account')
    assert.ok(text(dialog).includes('The new account is stored for this profile only.'))
    assert.ok($(dialog, '[data-trello="connect-form"]'), 'the same ConnectForm as the empty state')
    assert.equal($(root, '[data-trello="connect"]'), null, 'the empty state is not shown')
    assert.equal($(dialog, '[data-trello="connect-submit"]').disabled, true)
    assert.equal($(dialog, '[data-trello="token"]').type, 'password')

    await env.type($(dialog, '[data-trello="api-key"]'), 'n'.repeat(32))
    await env.type($(dialog, '[data-trello="token"]'), 'u'.repeat(64))
    await env.click($(dialog, '[data-trello="connect-submit"]'))

    const post = backend.callsTo('POST', /^\/credentials$/)
    assert.equal(post.length, 1)
    assert.deepEqual(post[0].body, { api_key: 'n'.repeat(32), token: 'u'.repeat(64), scope: 'profile' })
    assert.equal($(root, '[data-trello="change-dialog"]'), null, 'closes on success')
    assert.ok(sdk.notifications.some(n => n.kind === 'success'))
    assert.ok(backend.callsTo('GET', /^\/boards$/).length > boardsBefore, 'the board data is read again')
    assert.ok($$(root, '[data-trello="card"]').length > 0, 'the workspace stays up')
    assert.equal(text(root).includes('u'.repeat(64)), false, 'the token is never rendered back')
  })

  await scenario('Change account: the scope sent follows Settings (All profiles)', { settings: { credentialScope: 'app' } }, async ({ root, backend }) => {
    const panel = await openSettings(root)
    await env.click($(panel, '[data-trello="cred-change"]'))
    const dialog = $(root, '[data-trello="change-dialog"]')
    assert.ok(text(dialog).includes('The new account is stored for all profiles.'))
    await env.type($(dialog, '[data-trello="api-key"]'), 'n'.repeat(32))
    await env.type($(dialog, '[data-trello="token"]'), 'u'.repeat(64))
    await env.click($(dialog, '[data-trello="connect-submit"]'))
    assert.equal(backend.callsTo('POST', /^\/credentials$/)[0].body.scope, 'app')
  })

  await scenario('Change account: a rejected key is reported in the dialog and nothing closes', { setup: b => { b.failWhen((m, p) => m === 'POST' && p === '/credentials', apiError(401, 'credentials_rejected', 'Trello rejected the stored API key or token.')) } }, async ({ root }) => {
    const panel = await openSettings(root)
    await env.click($(panel, '[data-trello="cred-connect"]'))
    const dialog = $(root, '[data-trello="change-dialog"]')
    await env.type($(dialog, '[data-trello="api-key"]'), 'n'.repeat(32))
    await env.type($(dialog, '[data-trello="token"]'), 'u'.repeat(64))
    await env.click($(dialog, '[data-trello="connect-submit"]'))
    assert.ok(text($(dialog, '[data-trello="connect-error"]')).includes('rejected'))
    assert.ok($(root, '[data-trello="change-dialog"]'), 'still open for another try')
  })

  await scenario('Remove this profile\'s connection falls back to the app-wide account', { setup: b => { b.state.scopes = { app: true, profile: true } } }, async ({ root, backend }) => {
    let panel = await openSettings(root)
    await env.click($(panel, '[data-trello="cred-remove-profile"]'))
    const dialog = dialogTitled(root, "Remove this profile's connection?")
    assert.ok(dialog)
    assert.ok(text(dialog).includes('This profile will go back to using the app-wide account.'))
    await env.click($(dialog, '[data-confirm]'))
    const del = backend.callsTo('DELETE', /^\/credentials$/)
    assert.equal(del.length, 1)
    assert.equal(del[0].query.scope, 'profile')
    assert.deepEqual(backend.state.scopes, { app: true, profile: false })
    assert.equal($(root, '[data-trello="connect"]'), null, 'still connected, through the app-wide account')
    assert.ok($$(root, '[data-trello="card"]').length > 0)
    panel = await openSettings(root)
    assert.equal(line(panel), 'Using the app-wide account for this profile')
    assert.equal(has(panel, 'cred-overrides'), false)
  })

  await scenario('Remove this profile\'s connection always targets the profile file, even when All profiles is chosen', { settings: { credentialScope: 'app' }, setup: b => { b.state.scopes = { app: true, profile: true } } }, async ({ root, backend }) => {
    const panel = await openSettings(root)
    await env.click($(panel, '[data-trello="cred-remove-profile"]'))
    await env.click($(dialogTitled(root, "Remove this profile's connection?"), '[data-confirm]'))
    assert.equal(backend.callsTo('DELETE', /^\/credentials$/)[0].query.scope, 'profile')
    assert.deepEqual(backend.state.scopes, { app: true, profile: false }, 'the app-wide account is untouched')
  })

  await scenario('Disconnect acts on the chosen scope and keeps the other account', { settings: { credentialScope: 'app' }, setup: b => { b.state.scopes = { app: true, profile: true } } }, async ({ root, backend }) => {
    const panel = await openSettings(root)
    await env.click($(panel, '[data-trello="disconnect"]'))
    const dialog = dialogTitled(root, 'Disconnect Trello?')
    assert.ok(text(dialog).includes('for all profiles'), text(dialog))
    await env.click($(dialog, '[data-confirm]'))
    const del = backend.callsTo('DELETE', /^\/credentials$/)
    assert.equal(del[0].query.scope, 'app')
    assert.deepEqual(backend.state.scopes, { app: false, profile: true })
    assert.equal($(root, '[data-trello="connect"]'), null, 'this profile keeps its own account')
  })

  await scenario('Disconnect of the only account returns to the connect form', { setup: b => { b.state.scopes = { app: false, profile: true } } }, async ({ root, backend }) => {
    const panel = await openSettings(root)
    await env.click($(panel, '[data-trello="disconnect"]'))
    const dialog = dialogTitled(root, 'Disconnect Trello?')
    assert.ok(text(dialog).includes('for this profile'))
    await env.click($(dialog, '[data-confirm]'))
    assert.equal(backend.callsTo('DELETE', /^\/credentials$/)[0].query.scope, 'profile')
    assert.ok($(root, '[data-trello="connect"]'))
  })

  await scenario('empty state: Connect posts the stored scope, default This profile', { backend: makeBackend({ connected: false }) }, async ({ root, backend }) => {
    const form = $(root, '[data-trello="connect"]')
    await env.type($(form, '[data-trello="api-key"]'), 'k'.repeat(32))
    await env.type($(form, '[data-trello="token"]'), 't'.repeat(64))
    await env.click($(root, '[data-trello="connect-submit"]'))
    assert.equal(backend.callsTo('POST', /^\/credentials$/)[0].body.scope, 'profile')
    assert.equal(backend.state.scopes.profile, true)
    assert.ok($$(root, '[data-trello="card"]').length > 0)
  })

  await scenario('empty state: Connect posts the scope saved in Settings', { backend: makeBackend({ connected: false }), settings: { credentialScope: 'app' } }, async ({ root, backend }) => {
    const form = $(root, '[data-trello="connect"]')
    await env.type($(form, '[data-trello="api-key"]'), 'k'.repeat(32))
    await env.type($(form, '[data-trello="token"]'), 't'.repeat(64))
    await env.click($(root, '[data-trello="connect-submit"]'))
    assert.equal(backend.callsTo('POST', /^\/credentials$/)[0].body.scope, 'app')
  })

  await scenario('the status line follows a change made elsewhere (Settings re-reads on open)', {}, async ({ root, backend }) => {
    let panel = await openSettings(root)
    assert.equal(line(panel), 'Using the app-wide account for this profile')
    await env.click($(root, '[data-trello="settings-button"]'))
    backend.state.scopes.profile = true
    panel = await openSettings(root)
    assert.equal(line(panel), 'Using credentials for this profile')
    assert.equal(has(panel, 'cred-reconnect'), false)
  })

  // -- transcript directive ---------------------------------------------------
  const chip = async (ctx, attrs, source = '::trello') => {
    const contribution = ctx.registered.find(c => c.area === 'transcript.directives')
    assert.ok(contribution, 'the directive is registered')

    return env.mount(contribution.data.render({ attrs, source, streaming: false }))
  }

  await scenario('directive: registered as "trello" and makes no request until it appears', {}, async ({ ctx, backend }) => {
    const contribution = ctx.registered.find(c => c.area === 'transcript.directives')
    assert.equal(contribution.data.name, 'trello')
    assert.equal(typeof contribution.data.render, 'function')
    assert.equal(backend.callsTo('GET', /^\/cards\//).length, 0)
  })

  await scenario('directive: a short link renders a live chip with name, list, due and open', {}, async ({ ctx, backend }) => {
    const gate = backend.hold((m, p) => /^\/cards\//.test(p))
    const ui = await chip(ctx, { card: 'Card0001' }, '::trello{card="Card0001"}')
    assert.ok($(ui.container, '[data-trello="chip-loading"]'), 'Skeleton while loading')
    gate()
    await env.settle()
    const el = $(ui.container, '[data-trello="chip"]')
    assert.ok(el)
    const label = text(el)
    assert.ok(label.includes('Onboarding — step 2 has no exit on cancel'))
    assert.ok(label.includes('in In progress'))
    assert.ok($(el, '[data-trello^="due-"]'), 'due chip when the card has a due date')
    assert.equal(backend.callsTo('GET', /^\/cards\/Card0001$/).length, 1)
    await env.click($(el, '[data-trello="chip-open"]'))
    assert.deepEqual(ctx.opened, ['https://trello.com/c/Card0001'])
    await ui.unmount()
  })

  await scenario('directive: a 24-hex id works and a card without due shows no due chip', {}, async ({ ctx, backend }) => {
    const ui = await chip(ctx, { card: oid(103) })
    const el = $(ui.container, '[data-trello="chip"]')
    assert.ok(text(el).includes('Export report to CSV'))
    assert.equal($(el, '[data-trello^="due-"]'), null)
    await ui.unmount()
  })

  await scenario('directive: 404 and invalid ids degrade to a minimal chip with the attrs text', {}, async ({ ctx, backend }) => {
    const missing = await chip(ctx, { card: 'Zz9Zz9Zz' })
    assert.ok($(missing.container, '[data-trello="chip-plain"]'))
    assert.equal(text(missing.container), 'Zz9Zz9Zz')
    assert.equal($(missing.container, '[data-trello="chip-open"]'), null)
    assert.equal(backend.callsTo('GET', /^\/cards\/Zz9Zz9Zz$/).length, 1)
    await missing.unmount()

    const before = backend.calls.length
    const weird = '../../etc/passwd <script>alert(1)</script> ' + 'x'.repeat(200)
    const odd = await chip(ctx, { card: weird })
    assert.ok($(odd.container, '[data-trello="chip-plain"]'))
    assert.equal($(odd.container, 'script'), null, 'text only, never markup')
    assert.ok(text(odd.container).length <= 62, 'long text is clamped')
    assert.ok(text(odd.container).includes('../../etc/passwd'))
    assert.equal(backend.calls.length, before, 'an invalid id never reaches the backend')
    await odd.unmount()

    const none = await chip(ctx, {}, '::trello')
    assert.equal(text(none.container), '::trello')
    await none.unmount()
  })

  await scenario('layout: the board scrolls sideways on a plain wheel, a tall lane keeps it', { width: 1200 }, async ({ root }) => {
    const columns = $(root, '[data-trello="columns"]')
    const laneBody = $(root, '[data-trello="lane-body"]')
    assert.ok(columns && laneBody, 'columns and lane body exist')

    // jsdom has no layout: drive the two measurements the handler reads.
    let scrolled = null
    Object.defineProperty(columns, 'scrollLeft', { get: () => scrolled ?? 0, set: v => { scrolled = v }, configurable: true })
    Object.defineProperty(columns, 'scrollWidth', { value: 1200, configurable: true })
    Object.defineProperty(columns, 'clientWidth', { value: 480, configurable: true })
    Object.defineProperty(laneBody, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(laneBody, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(laneBody, 'scrollTop', { value: 0, writable: true, configurable: true })

    // jsdom has no WheelEvent: a plain Event carrying the two deltas the handler reads
    const wheel = deltaY => {
      const event = new Event('wheel', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'deltaY', { value: deltaY })
      Object.defineProperty(event, 'deltaX', { value: 0 })
      return event
    }

    // a wheel over a lane that can still scroll down stays vertical
    const inLane = wheel(120)
    laneBody.dispatchEvent(inLane)
    assert.equal(scrolled, null, 'the lane keeps the wheel while it can scroll')
    assert.equal(inLane.defaultPrevented, false)

    // at the bottom of the lane the same wheel moves the board sideways
    laneBody.scrollTop = 600
    const atEnd = wheel(120)
    laneBody.dispatchEvent(atEnd)
    assert.equal(scrolled, 120, 'the board scrolls horizontally at the end of a lane')
    assert.equal(atEnd.defaultPrevented, true)

    // and the styling that makes a scrollable lane possible is in place
    assert.match(laneBody.getAttribute('style') || '', /overflow-y:\s*auto/)
    assert.match(columns.getAttribute('style') || '', /overflow-x:\s*auto/)
  })

  await scenario('directive: a failing backend leaves the plain chip and the message intact', { setup: b => { b.failWhen((m, p) => /^\/cards\//.test(p), raw(503, '<html>x</html>')) } }, async ({ ctx }) => {
    const ui = await chip(ctx, { card: 'Card0001' })
    assert.ok($(ui.container, '[data-trello="chip-plain"]'))
    assert.equal(text(ui.container), 'Card0001')
    await ui.unmount()
  })
})
