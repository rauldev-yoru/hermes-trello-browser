// Heavy-board behaviour of the pane: render isolation (P2), content-visibility (P1), density (P5), overflow (P9)
// and lane navigation (P4). Counts, styles and structure only: nothing here depends on real layout (jsdom has none);
// how it looks is covered by the screenshots in docs/screenshots and the numbers in docs/UI-REVIEW.md.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyHeavyFixture, findNodeModules, loadPlugin, makeBackend, makeCtx, oid, setupDom, SKIP_REASON } from './harness.mjs'

const skip = findNodeModules() ? false : SKIP_REASON

test('heavy board: render isolation, content-visibility, density, overflow and lane navigation', { skip }, async t => {
  const { plugin, sdk } = await loadPlugin({ count: true })
  const env = await setupDom()
  const G = globalThis.__TRELLO_COUNT__
  const $ = (root, selector) => root.querySelector(selector)
  const $$ = (root, selector) => [...root.querySelectorAll(selector)]
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
  const sum = values => [...values].reduce((a, b) => a + b, 0)

  const scenario = (name, options, body) =>
    t.test(name, async () => {
      const { width = 1280, fixture = applyHeavyFixture, settings = null, prepare = null } = options
      const backend = makeBackend()
      fixture(backend)
      sdk.queryClient.reset()
      sdk.host.paneVisible.set(true)

      const ctx = makeCtx(sdk, backend)

      if (settings) {
        ctx.store.set('settings', settings)
      }

      if (prepare) {
        prepare(ctx, backend)
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

  /** Run `fn` with the render counter on. */
  const counted = async fn => {
    G.calls.clear()
    G.byCard.clear()
    G.byItem.clear()
    G.total = 0
    G.on = true

    try {
      await fn()
    } finally {
      G.on = false
    }

    return { cardRenders: sum(G.byCard.values()), cardsRendered: G.byCard.size, maxPerCard: Math.max(0, ...G.byCard.values()), itemRenders: sum(G.byItem.values()), maxPerItem: Math.max(0, ...G.byItem.values()), calls: name => G.calls.get(name) || 0 }
  }

  /** A poll as the app sees it: the request starts (isFetching flips), is held, then answers. */
  const poll = (backend, ...keys) => async () => {
    const release = backend.hold(() => true)

    await env.act(async () => {
      for (const queryKey of keys) {
        sdk.queryClient.invalidateQueries({ queryKey })
      }
    })
    await env.settle(2)
    release()
    await env.settle(4)
  }

  const openHeavyCard = async root => {
    const card = $$(root, '[data-trello="card"]').find(el => text(el).includes('Release 4.2'))
    assert.ok(card, 'the heavy card is on the board')
    await env.click($(card, '[data-trello="card-open"]'))
    assert.ok($(root, '[data-trello="drawer"]'))
  }

  // -- P2: render isolation -------------------------------------------------

  await scenario('P2: the fixture is the 207-card board of the review', {}, async ({ root, backend }) => {
    assert.equal($$(root, '[data-trello="card"]').length, 207)
    assert.equal($$(root, '[data-trello="lane"]').length, 10)
    assert.equal($$($$(root, '[data-trello="lane"]')[0], '[data-trello="card"]').length, 80)
    assert.equal(backend.state.view.cards.length, 207)
  })

  await scenario('P2: a poll that changes nothing renders no card (was 414), and not the board either', {}, async ({ root, backend }) => {
    const before = backend.callsTo('GET', /\/view$/).length
    const run = await counted(poll(backend, plugin.K.view(backend.ids.B1)))

    assert.equal(backend.callsTo('GET', /\/view$/).length, before + 1, 'the poll really fetched')
    assert.equal(run.cardRenders, 0, 'no CardRow rendered')
    assert.equal(run.calls('BoardBody'), 0, 'the board body did not render')
    assert.equal(run.calls('Workspace'), 0, 'isFetching is read by the header, not by the workspace')
    assert.ok(run.calls('RefreshButton') >= 1, 'the refresh button follows isFetching')
  })

  await scenario('P2: a poll that changes one card renders that card and shows its new data', {}, async ({ root, backend }) => {
    const target = backend.state.view.cards[3]
    const other = backend.state.view.cards[4]
    const otherName = other.name
    target.name = 'Renamed by someone else'
    target.labels = ['a11y']
    target.label_ids = [oid(35)]
    target.due = null

    const run = await counted(poll(backend, plugin.K.view(backend.ids.B1)))
    const el = $$(root, '[data-trello="card"]').find(c => c.dataset.cardId === target.id)

    assert.equal(run.cardRenders, 1, 'only the changed card rendered')
    assert.equal(text($(el, '[data-trello="card-open"] > span')), 'Renamed by someone else', 'a memoized card never shows stale props')
    assert.equal(text($(el, '[data-trello="label-chip"]')), 'a11y')
    assert.ok($(el, '[data-trello^="due-"]') === null)
    assert.equal(text($$(root, '[data-trello="card"]').find(c => c.dataset.cardId === other.id).querySelector('[data-trello="card-open"] > span')), otherName)
  })

  await scenario('P2: moving the selection renders the two cards that change (was 207)', {}, async ({ root, workspace }) => {
    const first = await counted(() => env.key(workspace(), 'j'))
    assert.equal(first.cardRenders, 1, 'from nothing to the first card')

    const next = await counted(() => env.key(workspace(), 'j'))
    assert.equal(next.cardRenders, 2, 'the old and the new selection')
    assert.deepEqual($$(root, '[data-trello="card"][data-selected="true"]').map(c => c.dataset.cardId), [oid(1002)])
  })

  await scenario('P2: ticking one checklist item renders a few cards and a few items (was 621 and 180)', {}, async ({ root, backend }) => {
    await openHeavyCard(root)
    const heavy = () => $$(root, '[data-trello="card"]').find(c => c.dataset.cardId === oid(101))
    const checklistText = () => text($(heavy(), '[data-trello="checklist"]'))
    const before = checklistText()
    const box = $(root, '[data-trello="item"][data-state="incomplete"] input[type="checkbox"]')
    const itemName = box.getAttribute('aria-label')

    const run = await counted(() => env.click(box))

    assert.ok(run.cardRenders <= 3, `CardRow renders: ${run.cardRenders}`)
    assert.ok(run.maxPerCard <= 3)
    assert.ok(run.itemRenders <= 3, `ItemRow renders: ${run.itemRenders}`)
    assert.equal(run.calls('Markdown'), 0, 'the description and the comments are not parsed again')
    assert.equal($(root, `[data-trello="item"][data-state="complete"] input[aria-label="${itemName}"]`) !== null, true, 'the item is done')
    assert.notEqual(checklistText(), before, 'the card on the board shows the new count')
    assert.equal(backend.state.details[oid(101)].checklists.flatMap(c => c.items).filter(i => i.state === 'complete').length, 25)
  })

  await scenario('P2: moving a card (optimistic) lands it in the new lane once, with the right data', {}, async ({ root, backend }) => {
    const card = $$(root, '[data-trello="card"]')[0]
    const id = card.dataset.cardId
    const target = $$(root, '[data-trello="lane"]')[1]
    const run = await counted(async () => {
      await env.click($(card, '[data-trello="card-open"]'))
      await env.click($$(card, '[role="menuitem"]').find(b => text(b).endsWith('Triage')))
    })

    assert.equal($$(root, `[data-card-id="${id}"]`).length, 1)
    assert.equal($$(target, `[data-card-id="${id}"]`).length, 1, 'the card moved to Triage')
    assert.equal(backend.state.view.cards.find(c => c.id === id).id_list, oid(201))
    assert.ok(run.cardRenders < 20, `a move renders a handful of cards, not the board (${run.cardRenders})`)
  })

  await scenario('P2: a label edit reaches the card (no stale memoized props)', {}, async ({ root, backend }) => {
    const target = backend.state.view.cards[10]
    const view = sdk.queryClient.getQueryData(plugin.K.view(backend.ids.B1))
    const patched = { ...view, cards: view.cards.map(c => (c.id === target.id ? { ...c, labels: ['design'], label_ids: [oid(34)] } : c)) }
    await env.act(async () => sdk.queryClient.setQueryData(plugin.K.view(backend.ids.B1), patched))
    await env.settle(2)

    const el = $$(root, '[data-trello="card"]').find(c => c.dataset.cardId === target.id)
    assert.deepEqual($$(el, '[data-trello="label-chip"]').map(text), ['design'])
  })

  // -- P1: content-visibility -------------------------------------------------

  await scenario('P1: cards carry content-visibility and an intrinsic height that follows the density', {}, async ({ root, ctx }) => {
    assert.equal(plugin.CARD_ESTIMATED_HEIGHT.comfortable, 84)
    assert.ok(plugin.CARD_ESTIMATED_HEIGHT.compact >= 48 && plugin.CARD_ESTIMATED_HEIGHT.compact <= 64, 'compact is about 56')
    assert.ok(plugin.CARD_ESTIMATED_HEIGHT.compact < plugin.CARD_ESTIMATED_HEIGHT.comfortable)

    // contain-intrinsic-size is the content box: the estimate is the outer height minus padding and border
    assert.equal(plugin.cardIntrinsicSize('comfortable'), 'auto 66px')
    assert.equal(plugin.cardIntrinsicSize('compact'), 'auto 42px')
    assert.equal(plugin.cardIntrinsicSize('nonsense'), 'auto 66px', 'unknown densities fall back to comfortable')

    const styles = () => $$(root, '[data-trello="card"]').map(c => [c.style.contentVisibility, c.style.containIntrinsicSize])
    assert.ok(styles().every(([cv, size]) => cv === 'auto' && size === 'auto 66px'))

    await env.click($(root, '[data-trello="settings-button"]'))
    await env.click($$(root, '[data-trello="density-setting"] button').find(b => text(b) === 'Compact'))
    assert.ok(styles().every(([cv, size]) => cv === 'auto' && size === 'auto 42px'), 'the estimate followed the density')
    assert.equal(ctx.store.get('settings').density, 'compact')
  })

  await scenario('P1: list mode uses the same style', { width: 480 }, async ({ root }) => {
    const cards = $$(root, '[data-trello="card"]')
    assert.equal(cards.length, 80)
    assert.ok(cards.every(c => c.style.contentVisibility === 'auto' && c.style.containIntrinsicSize === 'auto 66px'))
  })

  // -- P5: density --------------------------------------------------------------

  await scenario('P5: comfortable is the default and compact is persisted with the other settings', {}, async ({ root, ctx }) => {
    assert.ok($$(root, '[data-trello="card"]').every(c => c.dataset.density === 'comfortable'))
    assert.equal(plugin.DEFAULT_SETTINGS.density, 'comfortable')
    assert.equal(plugin.normalizeSettings({ density: 'compact' }).density, 'compact')
    assert.equal(plugin.normalizeSettings({ density: 'huge' }).density, 'comfortable')

    await env.click($(root, '[data-trello="settings-button"]'))
    const control = $$(root, '[data-trello="density-setting"] [role="radio"]')
    assert.deepEqual(control.map(text), ['Comfortable', 'Compact'])
    assert.equal(control[0].getAttribute('aria-checked'), 'true')

    const run = await counted(() => env.click(control[1]))
    assert.equal(run.cardRenders, 207, 'a density change renders each card once')
    assert.ok($$(root, '[data-trello="card"]').every(c => c.dataset.density === 'compact'))
    assert.equal(ctx.store.get('settings').density, 'compact')
    assert.equal(ctx.store.get('settings').refreshSec, 25, 'the other settings are kept')
  })

  await scenario('P5: a stored compact density is used at startup', { settings: { density: 'compact' } }, async ({ root }) => {
    assert.ok($$(root, '[data-trello="card"]').every(c => c.dataset.density === 'compact'))
  })

  await scenario('P5: compact card: one-line title, colour bars with the name in title, 6 px padding, one meta row', { settings: { density: 'compact' } }, async ({ root, backend }) => {
    const cards = $$(root, '[data-trello="card"]')
    const withLabels = cards.filter(c => $(c, '[data-trello="labels"]'))
    assert.ok(withLabels.length > 100)

    for (const card of cards) {
      assert.equal($(card, '[data-trello="card-open"] > span').style.webkitLineClamp || $(card, '[data-trello="card-open"] > span').style.WebkitLineClamp, '1', 'title clamps to one line')
      assert.equal(card.style.padding, '0.375rem', '6 px padding')
    }

    for (const card of withLabels) {
      assert.equal($$(card, '[data-trello="label-chip"]').length, 0, 'no label text on the card')
      const bars = $$(card, '[data-trello="label-bar"]')
      assert.ok(bars.length >= 1 && bars.every(b => b.getAttribute('title')), 'every bar names its label')
    }

    const named = backend.state.view.cards.find(c => c.labels.slice(0, 3).includes('bug'))
    const bar = $$($$(root, '[data-trello="card"]').find(c => c.dataset.cardId === named.id), '[data-trello="label-bar"]').find(b => b.title === 'bug')
    assert.ok(bar, 'the bug label is a bar titled "bug"')

    const rich = cards.find(c => $(c, '[data-trello="checklist"]') && $(c, '[data-trello="avatars"]') && $(c, '[data-trello^="due-"]'))
    assert.ok(rich, 'a card with due, checklist and avatars exists')
    // compare with ok(a === b): assert.equal on DOM nodes serializes the whole jsdom tree on failure
    const metaRow = $(rich, '[data-trello="card-meta"]')
    assert.ok(metaRow && $$(rich, '[data-trello="card-meta"]').length === 1, 'one meta row')
    assert.ok(metaRow.contains($(rich, '[data-trello="checklist"]')), 'checklist is in the meta row')
    assert.ok(metaRow.contains($(rich, '[data-trello^="due-"]')), 'due is in the meta row')
    assert.ok(metaRow.contains($(rich, '[data-trello="avatars"]')), 'the avatars are in the meta row')
    assert.ok(!$(rich, '[data-trello="card-open"]').contains(metaRow), 'the meta row is a sibling of the title button')
  })

  for (const density of ['comfortable', 'compact']) {
    await scenario(`P5: actions are an overlay in ${density} (selecting never changes the card's flow)`, { settings: { density }, width: 480 }, async ({ root, workspace }) => {
      const card = $$(root, '[data-trello="card"]')[1]
      const flow = () => [...card.children].filter(el => el.style.position !== 'absolute').map(el => el.tagName + el.dataset.trello)

      assert.ok($(card, '[data-trello="card-actions"]') === null, 'hidden at rest')
      const atRest = flow()

      await env.key(workspace(), 'j')
      await env.key(workspace(), 'j')
      assert.equal(card.dataset.selected, 'true')
      const actions = $(card, '[data-trello="card-actions"]')
      assert.ok(actions, 'shown on the selected card')
      assert.equal(actions.style.position, 'absolute', 'it is out of the flow')
      assert.ok($(actions, '[data-trello="send"]'))
      assert.deepEqual(flow(), atRest, 'the in-flow content is exactly what it was')
      assert.equal(card.style.position, 'relative')

      await env.key(workspace(), 'j')
      assert.ok($(card, '[data-trello="card-actions"]') === null, 'gone when the selection moves on')
    })
  }

  // -- P9: overflow -------------------------------------------------------------

  await scenario('P9: no avatar is dropped without an indicator', {}, async ({ root, backend }) => {
    const names = new Map(backend.state.view.members.map(m => [m.id, m.full_name]))
    let withOverflow = 0

    for (const el of $$(root, '[data-trello="card"]')) {
      const card = backend.state.view.cards.find(c => c.id === el.dataset.cardId)
      const n = card.id_members.length
      const avatars = $(el, '[data-trello="avatars"]')
      const more = $(el, '[data-trello="avatars-more"]')

      if (n === 0) {
        assert.equal(avatars, null)
        continue
      }

      const shown = avatars.children.length - (more ? 1 : 0)
      assert.equal(shown, Math.min(n, 3), `${n} members`)

      if (n > 3) {
        withOverflow += 1
        assert.equal(text(more), `+${n - 3}`)
        assert.deepEqual(more.title.split(', '), card.id_members.slice(3).map(id => names.get(id)), 'the title names the rest')
      } else {
        assert.equal(more, null)
      }
    }

    assert.ok(withOverflow >= 10, 'the fixture has cards with more than three members')
  })

  await scenario('P9: labels: at most three on one line, +N for the rest, a title on every chip', {}, async ({ root, backend }) => {
    let withOverflow = 0

    for (const el of $$(root, '[data-trello="card"]')) {
      const card = backend.state.view.cards.find(c => c.id === el.dataset.cardId)
      const row = $(el, '[data-trello="labels"]')

      if (!card.labels.length) {
        assert.equal(row, null)
        continue
      }

      assert.equal(row.style.flexWrap, 'nowrap', 'one line by construction')
      const marks = $$(row, '[data-trello="label-chip"], [data-trello="label-bar"]')
      assert.equal(marks.length, Math.min(card.labels.length, 3))
      assert.ok(marks.every(m => m.getAttribute('title')), 'every label mark has a title')

      for (const chip of $$(row, '[data-trello="label-chip"]')) {
        assert.equal(chip.style.maxWidth, '5rem')
        assert.equal(chip.style.minWidth, '0px', 'chips may shrink so three fit one line')
        assert.equal(chip.title, text(chip))
      }

      const more = $(row, '[data-trello="label-more"]')

      if (card.labels.length > 3) {
        withOverflow += 1
        assert.equal(text(more), `+${card.labels.length - 3}`)
        assert.ok(more.title.length > 0 && more.title.split(', ').length === card.labels.length - 3, 'the title names the rest')
      } else {
        assert.equal(more, null)
      }
    }

    assert.ok(withOverflow >= 5)
  })

  // -- P4: lane strip and lane keys ---------------------------------------------

  await scenario('P4: columns mode shows the lane strip; chips and counts match the lanes', {}, async ({ root }) => {
    const strip = $(root, '[data-trello="lane-strip"]')
    const lanes = $$(root, '[data-trello="lane"]')
    const chips = $$(strip, '[data-trello="chip"]')

    assert.equal(chips.length, 10)
    assert.deepEqual(chips.map(c => text(c)), lanes.map(l => text($(l, 'header'))))
    assert.deepEqual(chips.map(c => c.dataset.laneId), lanes.map(l => l.dataset.laneId))
    assert.equal(strip.getAttribute('role'), 'group')
    assert.ok(strip.compareDocumentPosition($(root, '[data-trello="columns"]')) & 4, 'the strip is above the board')
  })

  await scenario('P4: list mode uses the same component as tabs', { width: 480 }, async ({ root }) => {
    const strip = $(root, '[data-trello="lane-strip"]')
    assert.equal(strip.getAttribute('role'), 'tablist')
    assert.equal(strip.dataset.mode, 'list')
    assert.equal($$(strip, '[role="tab"]').length, 10)
    assert.equal($$(strip, '[aria-selected="true"]').length, 1)
  })

  await scenario('P4: a chip scrolls its lane to the left edge', {}, async ({ root }) => {
    const proto = env.window.Element.prototype
    const original = proto.getBoundingClientRect
    const scroller = $(root, '[data-trello="columns"]')
    const jumps = []
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: options => jumps.push(options.left) })
    const lanes = $$(root, '[data-trello="lane"]')

    proto.getBoundingClientRect = function () {
      const at = lanes.indexOf(this)

      return at >= 0 ? { left: at * 310, right: at * 310 + 300, top: 0, bottom: 600, width: 300, height: 600 } : original.call(this)
    }

    try {
      await env.click($$(root, '[data-trello="lane-strip"] [data-trello="chip"]')[4])
    } finally {
      proto.getBoundingClientRect = original
    }

    assert.deepEqual(jumps, [4 * 310 - 12])
    assert.equal($$(root, '[data-trello="lane-strip"] [data-active="true"]').length, 1, 'the clicked lane is highlighted right away')
  })

  await scenario('P4: the lanes on screen are highlighted from an IntersectionObserver', {}, async ({ root }) => {
    const lanes = $$(root, '[data-trello="lane"]')
    const active = () => $$(root, '[data-trello="lane-strip"] [data-trello="chip"]').map(c => c.dataset.active)

    await env.intersect(lanes.slice(0, 4))
    assert.deepEqual(active(), ['true', 'true', 'true', 'true', 'false', 'false', 'false', 'false', 'false', 'false'])

    await env.intersect(lanes.slice(5, 9))
    assert.deepEqual(active(), ['false', 'false', 'false', 'false', 'false', 'true', 'true', 'true', 'true', 'false'])
    assert.equal($$(root, '[data-trello="lane-strip"] [aria-current="true"]').length, 4)
  })

  await scenario('P4: l / h select the first card of the next / previous lane that has cards', { width: 1280 }, async ({ root, workspace }) => {
    const proto = env.window.Element.prototype
    const original = proto.getBoundingClientRect
    const scroller = $(root, '[data-trello="columns"]')
    const jumps = []
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: options => jumps.push(options.left) })
    const lanes = $$(root, '[data-trello="lane"]')

    proto.getBoundingClientRect = function () {
      const at = lanes.indexOf(this)

      return at >= 0 ? { left: at * 310, right: at * 310 + 300, top: 0, bottom: 600, width: 300, height: 600 } : original.call(this)
    }

    const selectedLane = () => {
      const card = $(root, '[data-trello="card"][data-selected="true"]')

      return card ? lanes.indexOf(card.closest('[data-trello="lane"]')) : -1
    }

    try {
      await env.key(workspace(), 'j')
      assert.equal(selectedLane(), 0)

      let presses = 0

      while (selectedLane() < 9 && presses < 30) {
        await env.key(workspace(), 'l')
        presses += 1
      }

      assert.equal(selectedLane(), 9)
      assert.equal(presses, 9, 'the last of 10 lanes is 9 presses away (was 168 with j)')
      assert.deepEqual(jumps, [310 - 12, 620 - 12, 930 - 12, 1240 - 12, 1550 - 12, 1860 - 12, 2170 - 12, 2480 - 12, 2790 - 12])

      assert.equal($(root, '[data-trello="card"][data-selected="true"]').dataset.cardId, oid(1168), 'the first card of the last lane')

      await env.key(workspace(), 'l')
      assert.equal(selectedLane(), 9, 'stops at the last lane')

      await env.key(workspace(), 'h')
      assert.equal(selectedLane(), 8)
      await env.key(workspace(), 'j')
      await env.key(workspace(), 'k')
      assert.equal(selectedLane(), 8, 'j and k keep walking the cards')
    } finally {
      proto.getBoundingClientRect = original
    }
  })

  await scenario('P4: h / l do nothing while typing', {}, async ({ root }) => {
    await env.click($(root, '[data-trello="board-picker"]'))
    const input = $(root, '[data-popover] input')
    await env.key(input, 'l')
    await env.key(input, 'h')
    assert.equal($$(root, '[data-trello="card"][data-selected="true"]').length, 0)
  })

  await scenario('P4: in list mode l / h switch the list and select its first card', { width: 480 }, async ({ root, workspace }) => {
    const active = () => text($(root, '[data-trello="chip"][aria-selected="true"]')).replace(/\d+$/, '')

    assert.equal(active(), 'Inbox')
    await env.key(workspace(), 'l')
    assert.equal(active(), 'Triage')
    assert.equal($(root, '[data-trello="card"][data-selected="true"]').dataset.cardId, oid(1081))
    await env.key(workspace(), 'h')
    assert.equal(active(), 'Inbox')
    assert.equal($(root, '[data-trello="card"][data-selected="true"]').dataset.cardId, oid(1001))
  })

  t.test('P4: laneJumpTarget skips empty lanes and stops at the ends', () => {
    const view = {
      lists: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      cards: [{ id: 'a1', id_list: 'a' }, { id: 'a2', id_list: 'a' }, { id: 'c1', id_list: 'c' }]
    }

    assert.deepEqual(plugin.laneJumpTarget(view, 'a', 1), { listId: 'c', cardId: 'c1' }, 'b is empty')
    assert.deepEqual(plugin.laneJumpTarget(view, 'c', -1), { listId: 'a', cardId: 'a1' })
    assert.equal(plugin.laneJumpTarget(view, 'c', 1), null, 'd is empty and nothing follows')
    assert.equal(plugin.laneJumpTarget(view, 'a', -1), null)
    assert.deepEqual(plugin.laneJumpTarget(view, null, 1), { listId: 'a', cardId: 'a1' }, 'no selection: l starts at the first lane')
    assert.deepEqual(plugin.laneJumpTarget(view, null, -1), { listId: 'c', cardId: 'c1' }, '... and h at the last')
    assert.deepEqual(plugin.laneJumpTarget(view, 'b', 1), { listId: 'c', cardId: 'c1' }, 'from an empty lane')
    assert.deepEqual(plugin.laneJumpTarget(view, 'b', -1), { listId: 'a', cardId: 'a1' })
    assert.equal(plugin.laneJumpTarget({ lists: [], cards: [] }, null, 1), null)
  })

  // =========================================================================================================
  // Turn 9: F1 lane strip only when needed, F2 actions in the avatar slot, P7 sections, P8 checklists, P3 comments
  // =========================================================================================================

  const fourLanes = backend => applyHeavyFixture(backend, { laneCount: 4 })
  const drawerOf = root => $(root, '[data-trello="drawer"]')

  // jsdom has no layout: give the drawer's scroller and sections geometry by data-trello
  const withGeometry = async (root, geometry, fn) => {
    const proto = env.window.Element.prototype
    const original = proto.getBoundingClientRect
    const drawer = drawerOf(root)
    const scroller = $(drawer, '[data-trello="drawer-scroll"]')
    const tabs = $(drawer, '[data-trello="drawer-tabs"]')

    proto.getBoundingClientRect = function () {
      const box = (top, height) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height })

      if (this === scroller) {
        return box(geometry.scrollerTop, 700)
      }

      if (this === tabs) {
        return box(geometry.scrollerTop, geometry.tabsHeight)
      }

      const hit = this.tagName === 'SECTION' ? geometry.sections[this.dataset.trello] : undefined

      return hit !== undefined && hit !== null ? box(geometry.scrollerTop + hit, 100) : original.call(this)
    }

    try {
      await fn(scroller)
    } finally {
      proto.getBoundingClientRect = original
    }
  }

  const SECTION_TOPS = { description: 30, checklists: 600, comments: 2400, attachments: 3500, activity: 3900 }

  // -- F1: the lane strip only when the lanes do not fit ----------------------------------

  t.test('F1: lanesFit follows the lane width, the gaps and the padding', () => {
    assert.equal(plugin.lanesFit(1280, 4), true, '4 x 300 + 3 x 10 + 24 = 1254')
    assert.equal(plugin.lanesFit(1253, 4), false)
    assert.equal(plugin.lanesFit(1254, 4), true)
    assert.equal(plugin.lanesFit(1280, 10), false)
    assert.equal(plugin.lanesFit(720, 4), false)
    assert.equal(plugin.lanesFit(720, 2), true)
    assert.equal(plugin.lanesFit(900, 1), true)
    assert.equal(plugin.lanesFit(1280, 0), true)
  })

  await scenario('F1: a 4-lane board that fits has no strip; the board takes its height back', { fixture: fourLanes }, async ({ root }) => {
    assert.equal($$(root, '[data-trello="lane"]').length, 4)
    assert.ok($(root, '[data-trello="lane-strip"]') === null)
    assert.ok($(root, '[data-trello="columns"]'))
  })

  await scenario('F1: a 10-lane board has the strip', {}, async ({ root }) => {
    assert.ok($(root, '[data-trello="lane-strip"]'))
  })

  await scenario('F1: the decision follows the measured width', { fixture: fourLanes }, async ({ root }) => {
    assert.ok($(root, '[data-trello="lane-strip"]') === null)
    await env.resizeTo(900)
    assert.ok($(root, '[data-trello="lane-strip"]'), '4 lanes do not fit 900 px')
    await env.resizeTo(1280)
    assert.ok($(root, '[data-trello="lane-strip"]') === null, 'and fit again at 1280 px')
  })

  await scenario('F1: list mode keeps its strip whatever the lane count', { fixture: fourLanes, width: 480 }, async ({ root }) => {
    assert.equal($(root, '[data-trello="lane-strip"]').dataset.mode, 'list')
  })

  // -- F2: the actions take the avatars' place --------------------------------------------

  await scenario('F2: the actions replace the avatars in the meta row: no text covered, same height, keyboard reachable', {}, async ({ root, workspace }) => {
    const card = () => $$(root, '[data-trello="card"]').find(c => $(c, '[data-trello="avatars"]') && $(c, '[data-trello^="due-"]') && $(c, '[data-trello="checklist"]'))
    const el = card()
    const inFlow = node => [...node.querySelectorAll('*')].filter(x => x.style.position !== 'absolute' && !x.closest('[data-trello="card-actions"]')).map(x => `${x.tagName}:${x.dataset.trello || ''}`)
    const slotOf = node => $(node, '[data-trello="card-slot"]')

    // at rest
    assert.deepEqual([...el.children].map(c => c.dataset.trello), ['card-open', 'card-meta'], 'title button and meta row are siblings')
    assert.ok($(el, '[data-trello="card-actions"]') === null)
    assert.equal($(el, '[data-trello="avatars"]').style.visibility, 'visible')
    const flowAtRest = inFlow(el)
    const metaHeight = $(el, '[data-trello="card-meta"]').style.minHeight

    // select it with the keyboard (j until it is the selected one)
    for (let i = 0; i < 200 && card().dataset.selected !== 'true'; i += 1) {
      await env.key(workspace(), 'j')
    }

    const selected = card()
    assert.equal(selected.dataset.selected, 'true')
    const actions = $(selected, '[data-trello="card-actions"]')
    assert.ok(actions, 'shown for the selected card')

    // (a) nothing is covered: the actions are in the slot of the meta row, never inside the title button, and they
    // are the only absolutely positioned thing in the card
    assert.ok(!$(selected, '[data-trello="card-open"]').contains(actions), 'not inside the title button')
    assert.ok($(selected, '[data-trello="card-meta"]').contains(actions))
    assert.ok(slotOf(selected).contains(actions), 'in the avatar slot')
    assert.equal(actions.style.position, 'absolute')
    assert.deepEqual([...selected.querySelectorAll('*')].filter(x => x.style.position === 'absolute').map(x => x.dataset.trello), ['card-actions'])
    assert.equal(slotOf(selected).style.position, 'relative', 'anchored to the slot, not to the card')
    assert.equal($(selected, '[data-trello="avatars"]').style.visibility, 'hidden', 'the avatars make room')
    assert.ok(!$(selected, '[data-trello="card-open"]').contains($(selected, '[data-trello="avatars"]')))

    // (b) the in-flow height cannot change: same in-flow elements, same meta row height, slot width reserved
    assert.deepEqual(inFlow(selected), flowAtRest)
    assert.equal($(selected, '[data-trello="card-meta"]').style.minHeight, metaHeight)
    assert.ok(parseFloat(slotOf(selected).style.minWidth) >= 3.5, 'the slot always reserves room for the three actions')

    // (c) keyboard: three real buttons with names, in the tab order after the card
    const buttons = $$(actions, 'button').filter(b => b.getAttribute('role') !== 'menuitem')
    assert.deepEqual(buttons.map(b => b.getAttribute('aria-label')), ['Send to agent', 'Open in Trello', 'More actions'])
    assert.ok(buttons.every(b => b.tabIndex !== -1))

    // moving on restores the avatars
    await env.key(workspace(), 'j')
    assert.ok($(card(), '[data-trello="card-actions"]') === null)
    assert.equal($(card(), '[data-trello="avatars"]').style.visibility, 'visible')
  })

  await scenario('F2: hover shows the actions too, and clicking an action does not open the card', {}, async ({ root, ctx }) => {
    const el = $$(root, '[data-trello="card"]')[2]
    await env.hover(el)
    const actions = $(el, '[data-trello="card-actions"]')
    assert.ok(actions)
    await env.click($(actions, '[data-trello="send"]'))
    assert.ok($(root, '[data-trello="drawer"]') === null, 'a click on an action is not a click on the card')
    await env.click($(el, '[data-trello="card-meta"]'))
    assert.ok($(root, '[data-trello="drawer"]'), 'a click on the meta row opens the card')
    await env.unhover(el)
  })

  await scenario('F2: the same rules in compact density', { settings: { density: 'compact' } }, async ({ root, workspace }) => {
    await env.key(workspace(), 'j')
    const el = $(root, '[data-trello="card"][data-selected="true"]')
    assert.deepEqual([...el.children].map(c => c.dataset.trello), ['card-open', 'card-meta'])
    assert.ok($(el, '[data-trello="card-slot"]').contains($(el, '[data-trello="card-actions"]')))
    assert.equal($(el, '[data-trello="card-meta"]').style.minHeight, '1rem')
  })

  // -- P7: sections, clamp, headings, footer --------------------------------------------------

  t.test('P7: tab counts, section order and the active section are pure and exact', () => {
    const detail = { checklists: [{ items: [{ state: 'complete' }, { state: 'incomplete' }] }, { items: [{ state: 'complete' }] }], comments: [{}, {}], attachments: [{}], activity: [{ id: 'a' }] }
    assert.deepEqual(plugin.checklistTotals(detail), { done: 2, total: 3 })
    assert.equal(plugin.tabCounts(detail).checklists, '2/3')
    assert.equal(plugin.tabCounts({ ...detail, checklists: [] }).checklists, 0)
    assert.deepEqual(plugin.DRAWER_SECTIONS.map(x => x.id), ['description', 'checklists', 'comments', 'files', 'activity'])

    const tops = [{ id: 'description', top: 10 }, { id: 'checklists', top: 300 }, { id: 'comments', top: 900 }]
    assert.equal(plugin.activeSection(tops, 48), 'description')
    assert.equal(plugin.activeSection(tops, 300), 'checklists')
    assert.equal(plugin.activeSection(tops, 5000), 'comments')
    assert.equal(plugin.activeSection(tops, 0, true), 'comments', 'at the bottom the last section wins')
    assert.equal(plugin.activeSection([], 10), null)
    assert.equal(plugin.estimateLines(''), 0)
    assert.equal(plugin.estimateLines('a\n\nb'), 3)
    assert.equal(plugin.estimateLines('x'.repeat(105)), 3)
  })

  await scenario('P7: sticky tabs with counts; a click scrolls the drawer scroller (never scrollIntoView) and lights the tab', {}, async ({ root }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    const nav = $(drawer, '[data-trello="drawer-tabs"]')
    const scroller = $(drawer, '[data-trello="drawer-scroll"]')

    assert.ok(scroller.contains(nav), 'the tabs live in the scroller and stick to its top')
    assert.equal(nav.style.position, 'sticky')
    assert.equal(nav.style.top, '0px')
    assert.deepEqual($$(nav, '[data-trello="drawer-tab"]').map(b => b.dataset.section), ['description', 'checklists', 'comments', 'files', 'activity'])
    assert.deepEqual($$(nav, '[data-trello="drawer-tab"]').map(b => text(b)), ['Description', 'Checklists24/60', 'Comments12', 'Files6', 'Activity20'])
    assert.equal(nav.getAttribute('aria-label'), 'Sections')
    assert.deepEqual($$(nav, '[aria-current="true"]').map(b => b.dataset.section), ['description'])

    const jumps = []
    let intoView = 0
    const section = $(drawer, '[data-trello="comments"]')

    section.scrollIntoView = () => { intoView += 1 }

    await withGeometry(root, { scrollerTop: 100, tabsHeight: 36, sections: SECTION_TOPS }, async sc => {
      Object.defineProperty(sc, 'scrollTo', { configurable: true, value: o => jumps.push(o) })
      await env.click($(nav, '[data-section="comments"]'))
    })

    assert.deepEqual(jumps, [{ top: 2400 - 36 - 6, behavior: 'smooth' }], 'to the section, below the sticky row')
    assert.equal(intoView, 0)
    assert.deepEqual($$(nav, '[aria-current="true"]').map(b => b.dataset.section), ['comments'])
  })

  await scenario('P7: scrolling lights the section that has reached the tabs', {}, async ({ root }) => {
    await openHeavyCard(root)
    const nav = $(drawerOf(root), '[data-trello="drawer-tabs"]')

    await withGeometry(root, { scrollerTop: 100, tabsHeight: 36, sections: { description: -700, checklists: -200, comments: 40, attachments: 1100, activity: 1500 } }, async sc => {
      await env.fire(sc, new env.window.Event('scroll'))
    })

    assert.deepEqual($$(nav, '[aria-current="true"]').map(b => b.dataset.section), ['comments'])
  })

  await scenario('P7: a long description is clamped to ~14 lines with Show more / Show less', {}, async ({ root }) => {
    await openHeavyCard(root)
    const section = $(drawerOf(root), '[data-trello="description"]')
    const body = () => $(section, '[data-trello="description-clamp"] > div')
    const toggle = () => $(section, '[data-trello="description-toggle"]')

    assert.equal(body().style.maxHeight, '17.5rem', '14 lines of 1.25rem')
    assert.equal(body().style.overflow, 'hidden')
    assert.equal(text(toggle()), 'Show more')
    assert.equal(toggle().getAttribute('aria-expanded'), 'false')

    const run = await counted(() => env.click(toggle()))

    assert.equal(run.calls('Markdown'), 0, 'expanding does not parse again')
    assert.equal(body().style.maxHeight, '')
    assert.equal(text(toggle()), 'Show less')
    await env.click(toggle())
    assert.equal(body().style.maxHeight, '17.5rem')
  })

  await scenario('P7: a short description has no clamp button', { fixture: b => { applyHeavyFixture(b); b.state.details[oid(101)].desc = 'Short and sweet.' } }, async ({ root }) => {
    await openHeavyCard(root)
    assert.ok($(drawerOf(root), '[data-trello="description-toggle"]') === null)
  })

  await scenario('P7: heading levels differ in size and weight', { fixture: b => { applyHeavyFixture(b); b.state.details[oid(101)].desc = '# One\n\n## Two\n\n### Three\n\n#### Four\n\nbody' } }, async ({ root }) => {
    await openHeavyCard(root)
    const heads = $$(drawerOf(root), '[data-trello="description"] [role="heading"]')
    const size = h => parseFloat(h.style.fontSize)

    assert.deepEqual(heads.map(h => h.dataset.level), ['1', '2', '3', '4'])
    assert.ok(size(heads[0]) > size(heads[1]) && size(heads[1]) > size(heads[2]) && size(heads[2]) > size(heads[3]) - 0.0001, 'sizes never grow with the level')
    assert.ok(size(heads[0]) > size(heads[3]))
    assert.ok(Number(heads[0].style.fontWeight) >= Number(heads[2].style.fontWeight))
    assert.ok(heads.every(h => h.getAttribute('aria-level') === h.dataset.level))
  })

  await scenario('P7: the footer is one row: send, suggest and an overflow menu with open, copy link and archive', {}, async ({ root, ctx }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    const footer = $(drawer, '[data-trello="drawer-footer"]')
    const outside = $$(footer, 'button').filter(b => b.getAttribute('role') !== 'menuitem')

    assert.deepEqual(outside.map(b => b.dataset.trello || b.getAttribute('aria-label')), ['drawer-send', 'suggest', 'drawer-more'])
    assert.deepEqual($$(footer, '[role="menuitem"]').map(b => text(b)), ['Open in Trello', 'Copy link', 'Archive card'])
    await env.click($$(footer, '[role="menuitem"]')[0])
    assert.deepEqual(ctx.opened, ['https://trello.com/c/Hvy00101'])
    await env.click($$(footer, '[role="menuitem"]')[1])
    assert.ok(ctx.clipboard.length === 1 && ctx.clipboard[0].includes('Hvy00101'))
    await env.click($(footer, '[data-trello="archive"]'))
    assert.ok($(root, '[role="dialog"][aria-label="Archive this card?"]'), 'archive still asks first')
  })

  // -- P8: checklists -------------------------------------------------------------------------

  t.test('P8: visibleChecklistItems keeps the ticked ones that are pinned', () => {
    const items = [{ id: 'a', state: 'complete' }, { id: 'b', state: 'incomplete' }, { id: 'c', state: 'complete' }]
    assert.deepEqual(plugin.visibleChecklistItems(items, false, new Set()).map(i => i.id), ['a', 'b', 'c'])
    assert.deepEqual(plugin.visibleChecklistItems(items, true, new Set()).map(i => i.id), ['b'])
    assert.deepEqual(plugin.visibleChecklistItems(items, true, new Set(['c'])).map(i => i.id), ['b', 'c'])
  })

  await scenario('P8: per checklist a progress bar, the count and a collapse toggle', {}, async ({ root }) => {
    await openHeavyCard(root)
    const lists = $$(drawerOf(root), '[data-trello="checklist"]')

    assert.equal(lists.length, 3)

    for (const list of lists) {
      const bar = $(list, '[data-trello="progress"]')
      const done = $$(list, '[data-trello="item"][data-state="complete"]').length

      assert.equal(bar.getAttribute('role'), 'progressbar')
      assert.equal(bar.getAttribute('aria-valuemax'), '20')
      assert.equal(bar.getAttribute('aria-valuenow'), String(done))
      assert.ok(text($(list, '[data-trello="checklist-toggle"]')).endsWith(`${done}/20`))
      assert.equal(bar.firstElementChild.style.width, `${done * 5}%`)
    }

    const first = lists[0]
    const toggle = $(first, '[data-trello="checklist-toggle"]')
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    await env.click(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal($$(first, '[data-trello="item"]').length, 0, 'a collapsed checklist draws no items')
    assert.equal($$(drawerOf(root), '[data-trello="item"]').length, 40)
    await env.click(toggle)
    assert.equal($$(first, '[data-trello="item"]').length, 20)
  })

  await scenario('P8: checklists that are 100% done start collapsed; ticking the last item does not fold one under the pointer', {
    fixture: b => {
      applyHeavyFixture(b)
      const lists = b.state.details[oid(101)].checklists
      lists[0].items.forEach(i => { i.state = 'complete' })
      lists[1].items.forEach((i, k) => { i.state = k === 0 ? 'incomplete' : 'complete' })
    }
  }, async ({ root }) => {
    await openHeavyCard(root)
    const [done, almost, rest] = $$(drawerOf(root), '[data-trello="checklist"]')

    assert.equal(done.dataset.open, 'false')
    assert.equal($$(done, '[data-trello="item"]').length, 0)
    assert.equal(almost.dataset.open, 'true')
    assert.equal(rest.dataset.open, 'true')

    await env.click($(almost, '[data-trello="item"][data-state="incomplete"] input'))
    assert.equal($$(almost, '[data-trello="item"][data-state="complete"]').length, 20, 'now 100% done')
    assert.equal(almost.dataset.open, 'true', 'and it stays open')
    assert.equal($$(almost, '[data-trello="item"]').length, 20)
  })

  await scenario('P8: "Pending only" hides the done items, keeps the totals, and a ticked item leaves a moment later', {
    prepare: ctx => {
      ctx.timers = []
      ctx.setTimeout = fn => { ctx.timers.push(fn); return () => {} }
    }
  }, async ({ root, ctx }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    const rows = () => $$(drawer, '[data-trello="item"]').length
    const tab = () => text($(drawer, '[data-trello="drawer-tab"][data-section="checklists"]'))

    assert.equal(rows(), 60)
    assert.equal(tab(), 'Checklists24/60')

    await env.click($(drawer, '[data-trello="pending-only"] input'))
    assert.equal(rows(), 36, '60 -> 36 rows')
    assert.equal($$(drawer, '[data-trello="item"][data-state="complete"]').length, 0)
    assert.equal(tab(), 'Checklists24/60', 'the total does not change')
    assert.ok($$(drawer, '[data-trello="checklist-toggle"]').every(b => text(b).endsWith('/20')), 'neither do the per-checklist counts')

    // tick one: it must still be there in the same render and for as long as the settle delay
    const box = $(drawer, '[data-trello="item"] input')
    const name = box.getAttribute('aria-label')
    await env.click(box)
    const row = () => $$(drawer, '[data-trello="item"]').find(r => r.querySelector(`input[aria-label="${name}"]`))

    assert.equal(rows(), 36, 'still drawn right after the tick')
    assert.equal(row().dataset.state, 'complete', 'struck through, under the pointer')
    assert.equal(ctx.timers.length, 1, 'one settle timer')

    await env.act(async () => { ctx.timers.forEach(fn => fn()) })
    assert.equal(rows(), 35, 'it leaves once the delay is over')
    assert.equal(row(), undefined)
    assert.equal(tab(), 'Checklists25/60')

    await env.click($(drawer, '[data-trello="pending-only"] input'))
    assert.equal(rows(), 60, 'the switch brings everything back')
  })

  await scenario('P8: with every item done, "Pending only" says so instead of showing nothing', {
    fixture: b => {
      applyHeavyFixture(b)
      b.state.details[oid(101)].checklists.forEach(cl => cl.items.forEach(i => { i.state = 'complete' }))
    }
  }, async ({ root }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    assert.ok($$(drawer, '[data-trello="checklist"]').every(c => c.dataset.open === 'false'))
    await env.click($(drawer, '[data-trello="pending-only"] input'))
    await env.click($$(drawer, '[data-trello="checklist-toggle"]')[0])
    assert.ok(text($$(drawer, '[data-trello="checklist"]')[0]).includes('Every item is done.'))
  })

  await scenario('P8: edit and delete are not drawn at rest: hover and keyboard focus show them', {}, async ({ root }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    const row = () => $$(drawer, '[data-trello="item"]')[3]
    const tools = () => $(row(), '[data-trello="item-tools"]')

    assert.equal($$(drawer, '[aria-label="Rename item"], [aria-label="Delete item"]').length, 0, 'no permanent buttons')
    await env.hover(row())
    assert.deepEqual($$(tools(), 'button').map(b => b.getAttribute('aria-label')), ['Rename item', 'Delete item'])
    await env.unhover(row())
    assert.ok(tools() === null)

    // keyboard: focus on the checkbox of the row reveals the tools, leaving the row hides them again
    const box = $(row(), 'input')
    await env.fire(box, new env.window.FocusEvent('focusin', { bubbles: true }))
    assert.ok(tools(), 'visible while the row has focus')
    await env.fire(box, new env.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    assert.ok(tools() === null)

    // touch: a tap on the text reveals them (and a second tap hides them)
    await env.click($(row(), 'span'))
    assert.ok(tools())
    await env.click($(row(), 'span'))
    assert.ok(tools() === null)
  })

  await scenario('P8: deleting asks inline first; cancel and Escape change nothing; confirm deletes once', {}, async ({ root, backend, workspace }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    const row = () => $$(drawer, '[data-trello="item"]')[1]
    const del = () => backend.callsTo('DELETE', /items/).length
    const askAgain = async () => {
      await env.hover(row())
      await env.click($(row(), '[aria-label="Delete item"]'))
    }

    await askAgain()
    const group = $(row(), '[data-trello="item-confirm"]')
    assert.ok(group, 'an inline confirmation')
    assert.equal(text($(group, 'span')), 'Delete this item?')
    assert.ok(env.document.activeElement === $(group, '[data-trello="item-delete-cancel"]'), 'focus starts on the safe choice')
    assert.equal(del(), 0)
    assert.ok($(row(), '[data-trello="item-tools"]') === null, 'no other tool next to the question')

    await env.click($(group, '[data-trello="item-delete-cancel"]'))
    assert.ok($(row(), '[data-trello="item-confirm"]') === null)
    assert.equal(del(), 0)

    await askAgain()
    await env.key($(row(), '[data-trello="item-delete-cancel"]'), 'Escape')
    assert.ok($(row(), '[data-trello="item-confirm"]') === null, 'Escape cancels')
    assert.ok($(drawerOf(root), '[data-trello="drawer-tabs"]'), 'and does not close the drawer')
    assert.equal(del(), 0)

    await askAgain()
    await env.click($(row(), '[data-trello="item-delete-confirm"]'))
    assert.equal(del(), 1)
  })

  await scenario('P8 + P3 budget: the heavy drawer is smaller in nodes and buttons', {}, async ({ root }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    const nodes = drawer.querySelectorAll('*').length + 1
    const controls = $$(drawer, 'button, [role="checkbox"], input[type="checkbox"]').filter(b => b.getAttribute('role') !== 'menuitem').length

    assert.ok(nodes <= 650, `drawer nodes ${nodes} (was 871)`)
    assert.ok(controls <= 80 + 3, `drawer buttons and checkboxes ${controls} (was 200; the stub draws a checkbox input where the app draws a button)`)
  })

  // -- P3: comments -----------------------------------------------------------------------------

  t.test('P3: recentComments sorts newest first and keeps the API order when there is no date', () => {
    const list = [{ id: 'a', date: '2026-10-01T00:00:00Z' }, { id: 'b', date: '2026-10-03T00:00:00Z' }, { id: 'c' }, { id: 'd' }]
    assert.deepEqual(plugin.recentComments(list).map(c => c.id), ['b', 'a', 'c', 'd'])
    assert.deepEqual(plugin.recentComments(undefined), [])
    assert.equal(plugin.COMMENT_LIMIT, 20)
    assert.equal(plugin.COMMENTS_PREVIEW, 3)
  })

  await scenario('P3: the composer and the 3 newest comments; Show 9 more reveals the rest without a request', {}, async ({ root, backend }) => {
    const run = await counted(() => openHeavyCard(root))
    const drawer = drawerOf(root)
    const section = () => $(drawer, '[data-trello="comments"]')
    const ids = () => $$(section(), '[data-trello="comment"]').length

    assert.ok(run.calls('Markdown') <= 4, `Markdown blocks when the drawer opens: ${run.calls('Markdown')} (was 13)`)
    assert.equal(ids(), 3)
    assert.ok($(section(), 'textarea'), 'the composer is there')
    assert.equal(text($(section(), '[data-trello="comments-more"]')), 'Show 9 more')

    const authors = $$(section(), '[data-trello="comment"] b').map(text)
    assert.deepEqual(authors, ['Ada Demo', 'Lin Demo', 'Sam Demo'], 'the newest three, newest first')

    const gets = backend.callsTo('GET', /\/cards\//).length
    await env.click($(section(), '[data-trello="comments-more"]'))

    assert.equal(ids(), 12)
    assert.ok($(section(), '[data-trello="comments-more"]') === null)
    assert.equal(backend.callsTo('GET', /\/cards\//).length, gets, 'no new request')
    assert.equal(text($(section(), '[data-trello="comments-less"]')), 'Show less')
    await env.click($(section(), '[data-trello="comments-less"]'))
    assert.equal(ids(), 3)
  })

  await scenario('P3: a long comment is clamped to ~6 lines with its own Show more', {}, async ({ root }) => {
    await openHeavyCard(root)
    const comments = $$(drawerOf(root), '[data-trello="comment"]')
    const long = comments.filter(c => $(c, '[data-trello="comment-toggle"]'))

    assert.ok(long.length >= 1)

    for (const c of long) {
      assert.equal($(c, '[data-trello="comment-clamp"] > div').style.maxHeight, '7.5rem', '6 lines of 1.25rem')
    }

    const one = long[0]
    const button = () => $(one, '[data-trello="comment-toggle"]')
    assert.equal(text(button()), 'Show more')
    await env.click(button())
    assert.equal(text(button()), 'Show less')
    assert.equal($(one, '[data-trello="comment-clamp"] > div').style.maxHeight, '')

    for (const other of long.slice(1)) {
      assert.equal(text($(other, '[data-trello="comment-toggle"]')), 'Show more', 'the others stay clamped')
    }
  })

  await scenario('P3: a short comment has no clamp button', { fixture: b => { applyHeavyFixture(b); b.state.details[oid(101)].comments = [{ id: oid(70), author: 'Ada Demo', text: 'Looks good.', date: new Date().toISOString() }] } }, async ({ root }) => {
    await openHeavyCard(root)
    const drawer = drawerOf(root)
    assert.equal($$(drawer, '[data-trello="comment"]').length, 1)
    assert.ok($(drawer, '[data-trello="comment-toggle"]') === null)
    assert.ok($(drawer, '[data-trello="comments-more"]') === null)
  })

  const manyComments = n => b => {
    applyHeavyFixture(b)
    b.state.details[oid(101)].comments = Array.from({ length: n }, (_, i) => ({ id: oid(80 + i), author: 'Ada Demo', text: `Comment number ${i}`, date: new Date(Date.UTC(2026, 9, 1) - i * 3600e3).toISOString() }))
  }

  await scenario('P3: exactly 20 comments (the API limit): a line says older ones are in Trello, with the action', { fixture: manyComments(20) }, async ({ root, ctx }) => {
    await openHeavyCard(root)
    const older = $(drawerOf(root), '[data-trello="comments-older"]')

    assert.ok(older)
    assert.ok(text(older).startsWith('Older comments are in Trello'))
    await env.click($(older, 'button'))
    assert.deepEqual(ctx.opened, ['https://trello.com/c/Hvy00101'])
  })

  await scenario('P3: 19 comments: nothing is hidden, so no such line', { fixture: manyComments(19) }, async ({ root }) => {
    await openHeavyCard(root)
    assert.ok($(drawerOf(root), '[data-trello="comments-older"]') === null)
    assert.equal(text($(drawerOf(root), '[data-trello="comments-more"]')), 'Show 16 more')
  })

  t.test('i18n: every new string exists in en and es', () => {
    const keys = ['drawer.sections', 'drawer.files', 'drawer.showMore', 'drawer.showLess', 'drawer.moreComments', 'drawer.olderInTrello', 'drawer.pendingOnly', 'drawer.allDone', 'drawer.confirmDelete', 'drawer.confirmDeleteYes', 'common.cancel']

    for (const locale of ['en', 'es']) {
      const bundle = plugin.LOCALES[locale]

      for (const key of keys) {
        const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), bundle)
        assert.ok(typeof value === 'string' || typeof value === 'function', `${locale}:${key}`)
      }
    }

    assert.equal(plugin.LOCALES.en.drawer.moreComments(9), 'Show 9 more')
    assert.equal(plugin.LOCALES.es.drawer.moreComments(9), 'Mostrar 9 más')
  })
})
