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
      const { width = 1280, fixture = applyHeavyFixture, settings = null } = options
      const backend = makeBackend()
      fixture(backend)
      sdk.queryClient.reset()
      sdk.host.paneVisible.set(true)

      const ctx = makeCtx(sdk, backend)

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
    assert.equal($(el, '[data-trello^="due-"]'), null)
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
    const row = $(rich, '[data-trello="avatars"]').parentElement
    assert.equal($(rich, '[data-trello="checklist"]').parentElement, row, 'checklist and avatars share a row')
    assert.equal($(rich, '[data-trello^="due-"]').parentElement, row, 'due and avatars share a row')
  })

  for (const density of ['comfortable', 'compact']) {
    await scenario(`P5: actions are an overlay in ${density} (selecting never changes the card's flow)`, { settings: { density }, width: 480 }, async ({ root, workspace }) => {
      const card = $$(root, '[data-trello="card"]')[1]
      const flow = () => [...card.children].filter(el => el.style.position !== 'absolute').map(el => el.tagName + el.dataset.trello)

      assert.equal($(card, '[data-trello="card-actions"]'), null, 'hidden at rest')
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
      assert.equal($(card, '[data-trello="card-actions"]'), null, 'gone when the selection moves on')
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
})
