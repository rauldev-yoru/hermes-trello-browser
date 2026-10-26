// Markdown (M1), images and attachments (M2) and checklist legibility (M3).
// Parser and policy tests are pure; the render tests mount the pane against the synthetic backend. Nothing depends on
// real layout (jsdom has none): styles, structure and counts only. How it looks is in docs/screenshots.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyHeavyFixture, applyShowcaseFixture, findNodeModules, loadPlugin, makeBackend, makeCtx, oid, setupDom, SKIP_REASON } from './harness.mjs'

const skip = findNodeModules() ? false : SKIP_REASON

// -- parser ---------------------------------------------------------------------------------

test('markdown parser: blocks, inlines, robustness', { skip }, async t => {
  const { plugin: P } = await loadPlugin()
  const types = text => P.parseMarkdown(text).map(b => b.type)
  const kinds = text => P.parseInline(text).map(n => n.type)

  await t.test('blockquote: consecutive > lines, markdown inside, nesting capped', () => {
    const [q] = P.parseMarkdown('> first **line**\n> second\n>\n> - item')
    assert.equal(q.type, 'quote')
    assert.deepEqual(q.blocks.map(b => b.type), ['p', 'list'])
    assert.equal(q.blocks[0].text, 'first **line**\nsecond')
    assert.deepEqual(types('> a\n\nb'), ['quote', 'p'], 'a blank line ends it')
    assert.deepEqual(types('text\n> quote'), ['p', 'quote'], 'it interrupts a paragraph')

    const deep = P.parseMarkdown('> > > > > deep')
    let depth = 0
    for (let b = deep[0]; b && b.type === 'quote'; b = b.blocks[0]) depth += 1
    assert.ok(depth <= 3, `quote depth ${depth}`)
    assert.ok(JSON.stringify(deep).includes('deep'), 'the text is still there')
  })

  await t.test('horizontal rule: --- and *** (and ___), not a list, not inside words', () => {
    assert.deepEqual(types('a\n\n---\n\nb'), ['p', 'hr', 'p'])
    assert.deepEqual(types('***'), ['hr'])
    assert.deepEqual(types('___'), ['hr'])
    assert.deepEqual(types('--'), ['p'])
    assert.deepEqual(types('---x'), ['p'])
  })

  await t.test('table: header, alignment, rows, escaped pipes', () => {
    const [tab] = P.parseMarkdown('| Name | Qty | Price |\n|:--|:-:|--:|\n| a | 1 | 2.50 |\n| b \\| c | 2 | 3.00 |\n\nafter')
    assert.equal(tab.type, 'table')
    assert.deepEqual(tab.header, ['Name', 'Qty', 'Price'])
    assert.deepEqual(tab.align, ['left', 'center', 'right'])
    assert.deepEqual(tab.rows, [['a', '1', '2.50'], ['b | c', '2', '3.00']])
    assert.deepEqual(types('| a | b |\n|---|---|\n| 1 | 2 |\n\ntext'), ['table', 'p'])

    const bare = P.parseMarkdown('a | b\n--|--\n1 | 2')[0]
    assert.equal(bare.type, 'table', 'pipes at the edges are optional')
    assert.deepEqual(bare.align, [null, null])
  })

  await t.test('table: uneven rows are padded or cut, a bad delimiter row is not a table', () => {
    const [tab] = P.parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n|')
    assert.equal(tab.type, 'table')
    assert.ok(tab.rows.every(r => r.length === 3))
    assert.deepEqual(tab.rows[0], ['1', '', ''])
    assert.deepEqual(tab.rows[1], ['1', '2', '3'])

    assert.deepEqual(types('| a | b |\n|---|\n| 1 | 2 |'), ['p'], 'delimiter row with the wrong column count')
    assert.deepEqual(types('| a | b |\n| x | y |'), ['p'], 'no delimiter row')
    assert.deepEqual(types('a | b'), ['p'])
    assert.deepEqual(types('| only header |\n|---|'), ['table'])
  })

  await t.test('lists: two levels, other bullets per level, task items, loose lists', () => {
    const [list] = P.parseMarkdown('- a\n  - a1\n  - a2\n- b\n    - b1\n      - flattened\n- [x] done\n- [ ] todo')
    assert.equal(list.type, 'list')
    assert.deepEqual(list.items.map(i => i.text), ['a', 'b', 'done', 'todo'])
    assert.deepEqual(list.items[0].sub.items.map(i => i.text), ['a1', 'a2'])
    assert.deepEqual(list.items[1].sub.items.map(i => i.text), ['b1', 'flattened'], 'a third level is flattened into the second')
    assert.ok(list.items.every(i => !i.sub || i.sub.items.every(x => !x.sub)), 'never more than 2 levels')
    assert.deepEqual(list.items.map(i => i.checked), [null, null, true, false])

    const [numbered] = P.parseMarkdown('3. c\n4. d\n   1. d1')
    assert.equal(numbered.ordered, true)
    assert.equal(numbered.start, 3)
    assert.equal(numbered.items[1].sub.ordered, true)

    assert.deepEqual(types('- a\n\n- b\n\n- c'), ['list'], 'one blank line between items keeps one list')
    assert.deepEqual(types('- a\n\n\n- b'), ['list', 'list'], 'two blank lines end it')
    assert.deepEqual(types('- a\n\n1. b'), ['list', 'list'], 'a different kind is a new list')
    assert.deepEqual(P.parseMarkdown('  - indented first\n- later').map(b => b.items.length), [2])
  })

  await t.test('fences: unclosed runs to the end, a fence swallows markdown', () => {
    const [code] = P.parseMarkdown('```js\n# not a heading\n> not a quote\n| a | b |')
    assert.equal(code.type, 'code')
    assert.equal(code.lang, 'js')
    assert.equal(code.text, '# not a heading\n> not a quote\n| a | b |')
    assert.deepEqual(types('```\n---\n```\n---'), ['code', 'hr'])
  })

  await t.test('inline: strike, escapes, ***both***, bare URLs', () => {
    assert.deepEqual(kinds('a ~~gone~~ b'), ['text', 'strike', 'text'])
    assert.deepEqual(P.parseInline('~~**x**~~')[0].children.map(n => n.type), ['bold'])
    assert.deepEqual(kinds('~~ not closed'), ['text'])
    assert.deepEqual(P.parseInline('\\*not italic\\* and \\[x\\]'), [{ type: 'text', text: '*not italic* and [x]' }])

    const both = P.parseInline('***both***')[0]
    assert.equal(both.type, 'bold')
    assert.equal(both.children[0].type, 'italic')

    const auto = P.parseInline('see https://example.invalid/a_b?c=1, and (https://example.invalid/x).')
    assert.deepEqual(auto.filter(n => n.type === 'link').map(n => n.url), ['https://example.invalid/a_b?c=1', 'https://example.invalid/x'])
    assert.ok(P.parseInline('xhttps://example.invalid').every(n => n.type === 'text'), 'inside a word it is not a link')
    assert.ok(P.parseInline('https://').every(n => n.type === 'text'))
    assert.deepEqual(kinds('2*3*4'), ['text', 'italic', 'text'], 'a star may emphasise inside a word')
    assert.ok(P.parseInline('snake_case_name').every(n => n.type === 'text'), 'underscores inside a word are not emphasis')
  })

  await t.test('inline: images, with an unsafe URL they are only their alt text', () => {
    const [img] = P.parseInline('![a diagram](https://example.invalid/d.png)')
    assert.deepEqual(img, { type: 'image', alt: 'a diagram', url: 'https://example.invalid/d.png' })
    assert.ok(P.parseInline('![x](javascript:alert(1))').every(n => n.type === 'text'), 'nothing but text')
    assert.ok(!P.parseInline('![x](data:image/png;base64,AAAA)').some(n => n.type === 'image'))
    assert.ok(!P.parseInline('![x](file:///etc/passwd)').some(n => n.type === 'image'))
    assert.ok(!P.parseInline('![x](mailto:a@example.invalid)').some(n => n.type === 'image'), 'mailto is a link, never an image')
    assert.ok(!kinds('![](https://example.invalid/d.png)').includes('image'), 'an empty label is not an image (the URL is still a link)')
  })

  await t.test('robustness: malformed input never throws and keeps its text', () => {
    const inputs = [
      '```\nnever closed',
      '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n|||\n',
      '- 1\n  - 2\n    - 3\n      - 4\n        - 5\n          - 6',
      '> > > > > > > > > > x',
      '**never closed and *neither',
      '[link without parens] and [another](no close',
      '[x](',
      '![](',
      '](',
      '~~ ** __ `` ** ~~',
      '\\',
      '|',
      '|---|',
      '- [',
      '- [ ]',
      '1.',
      '#',
      '\u0000\u0001 \t\r\n',
      'a'.repeat(10000),
      '- x\n'.repeat(2000),
      '> q\n'.repeat(2000),
      '| a | b |\n|---|---|\n'.concat('| 1 | 2 |\n'.repeat(1500))
    ]

    for (const input of inputs) {
      const blocks = P.parseMarkdown(input)
      assert.ok(Array.isArray(blocks))
      assert.ok(Array.isArray(P.parseInline(input)))
    }

    assert.deepEqual(P.parseMarkdown(null), [])
    assert.deepEqual(P.parseMarkdown(undefined), [])
    assert.deepEqual(P.parseMarkdown(42).map(b => b.type), ['p'])
    assert.deepEqual(P.parseMarkdown('\r\n'), [])
    assert.equal(JSON.stringify(P.parseInline('**never closed')).includes('**never closed'), true)
    assert.equal(P.parseInline('[link without parens]')[0].text, '[link without parens]')
  })

  await t.test('robustness: 10 000 characters of every nasty pattern is fast (linear, no catastrophic regex)', () => {
    const patterns = ['[', '](', '![', '*', '**', '_', '__', '~~', '`', '*a ', '_a ', '[a](', '| a ', '> ', '- ', '  - ', '\\', 'http://', '***', '|-', '1. ', '#', '<b>', ')']
    let slowest = 0

    for (const piece of patterns) {
      const input = piece.repeat(Math.ceil(10000 / piece.length)).slice(0, 10000)

      for (const form of [input, input.replace(/(.{80})/g, '$1\n')]) {
        const started = performance.now()
        P.parseMarkdown(form)
        P.parseInline(form)
        const took = performance.now() - started

        slowest = Math.max(slowest, took)
        assert.ok(took < 1500, `${JSON.stringify(piece)} x ${form.length}: ${took.toFixed(0)} ms`)
      }
    }

    // doubling the input must not square the time (a quadratic parser would take 4x, a linear one 2x)
    const time = n => {
      const input = '*a [b](c '.repeat(n) + '| x '.repeat(n)
      const started = performance.now()
      for (let rep = 0; rep < 3; rep += 1) P.parseInline(input)

      return performance.now() - started
    }

    time(500)
    const small = time(1500)
    const big = time(6000)

    assert.ok(big < small * 12, `4x input took ${(big / small).toFixed(1)}x the time`)
  })

  await t.test('robustness: random markdown-ish strings never throw and every node is a known type', () => {
    let seed = 20261026
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0

      return seed / 2 ** 32
    }
    const alphabet = ['*', '_', '~', '`', '[', ']', '(', ')', '!', '|', '-', ':', '>', '#', ' ', ' ', '\n', '\n', '\\', 'a', 'b', 'http://x.invalid/', '1.', '- ', '  ', '```']
    const known = new Set(['text', 'code', 'bold', 'italic', 'strike', 'link', 'image'])
    const visit = nodes => nodes.forEach(n => {
      assert.ok(known.has(n.type), n.type)
      if (n.children) visit(n.children)
    })
    const blockTypes = new Set(['p', 'heading', 'code', 'hr', 'quote', 'table', 'list'])
    const walk = blocks => blocks.forEach(b => {
      assert.ok(blockTypes.has(b.type), b.type)
      if (b.blocks) walk(b.blocks)
    })

    for (let n = 0; n < 400; n += 1) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 120) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('')
      walk(P.parseMarkdown(text))
      visit(P.parseInline(text))
    }
  })

  await t.test('the existing behaviour is unchanged: <script>, javascript: links, plain paragraphs', () => {
    assert.deepEqual(kinds('<script>alert(1)</script>'), ['text'])
    assert.ok(!P.parseInline('[x](javascript:alert(1))').some(n => n.type === 'link'))
    assert.deepEqual(P.parseMarkdown('one\ntwo').map(b => b.text), ['one\ntwo'], 'soft line breaks stay (the pane draws them)')
  })
})

// -- policy and pure helpers ------------------------------------------------------------------

test('images and attachments: policy and helpers', { skip }, async t => {
  const { plugin: P } = await loadPlugin()

  await t.test('imagePolicy: Trello https hosts load by themselves, everything else asks, non-http is null', () => {
    const trusted = [
      'https://trello-attachments.s3.amazonaws.com/5f/6a/shot.png',
      'https://eu.trello-attachments.s3.amazonaws.com/x.png',
      'https://trello.com/1/cards/abc/attachments/def/download/x.png',
      'https://api.trello.com/x.png',
      'https://cdn.trello-attachments.com/x.png',
      'https://trello-attachments.com/x.png',
      'HTTPS://TRELLO.COM/x.png',
      'https://trello.com./x.png'
    ]

    for (const url of trusted) {
      const policy = P.imagePolicy(url)
      assert.ok(policy && policy.trusted === true, url)
    }

    const asks = [
      'https://images.example.invalid/x.png',
      'https://evil-trello.com/x.png',
      'https://trello.com.evil.invalid/x.png',
      'https://nottrello.com/x.png',
      'https://trello-attachments.s3.amazonaws.com.evil.invalid/x.png',
      'https://other-bucket.s3.amazonaws.com/x.png',
      'https://amazonaws.com/trello-attachments.s3/x.png',
      'https://trello.com@evil.invalid/x.png',
      'https://user:pw@trello.com/x.png',
      'http://trello.com/x.png',
      'http://images.example.invalid/x.png'
    ]

    for (const url of asks) {
      const policy = P.imagePolicy(url)
      assert.ok(policy && policy.trusted === false, url)
    }

    assert.equal(P.imagePolicy('https://images.example.invalid:8443/a/b.png?x=1').host, 'images.example.invalid')
    assert.equal(P.imagePolicy('https://Images.Example.invalid/a.png').host, 'images.example.invalid')
    assert.equal(P.imagePolicy('https://trello.com@evil.invalid/x.png').host, 'evil.invalid', 'the host is the one the browser would call')

    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://example.invalid/x.png', 'blob:https://trello.com/x', '//trello.com/x.png', 'mailto:a@example.invalid', '', null, undefined, 42, 'not a url', 'https://', 'https://exa mple.invalid/x.png']) {
      assert.equal(P.imagePolicy(url), null, String(url))
    }
  })

  await t.test('formatBytes', () => {
    assert.equal(P.formatBytes(0), '0 B')
    assert.equal(P.formatBytes(999), '999 B')
    assert.equal(P.formatBytes(1536), '1.5 KB')
    assert.equal(P.formatBytes(482113), '471 KB')
    assert.equal(P.formatBytes(5 * 1024 * 1024), '5 MB')
    assert.equal(P.formatBytes(3.2 * 1024 ** 3), '3.2 GB')
    for (const bad of [null, undefined, 'x', -1, NaN]) assert.equal(P.formatBytes(bad), '')
  })

  await t.test('attachmentThumbSource: only Trello-hosted pictures load by themselves', () => {
    const trello = 'https://trello-attachments.s3.amazonaws.com/a/p150.png'
    assert.equal(P.attachmentThumbSource({ thumb_url: trello, is_image: true }), trello)
    assert.ok(P.attachmentThumbSource({ thumb_url: 'https://images.example.invalid/p.png', is_image: true, url: 'https://images.example.invalid/o.png' }) === null)
    assert.equal(P.attachmentThumbSource({ is_image: true, url: 'https://trello.com/1/cards/x/attachments/y/download/o.png' }), 'https://trello.com/1/cards/x/attachments/y/download/o.png')
    assert.ok(P.attachmentThumbSource({ is_image: false, url: 'https://trello.com/x.pdf' }) === null)
    assert.ok(P.attachmentThumbSource({ thumb_url: 'javascript:alert(1)', is_image: true }) === null)
    assert.ok(P.attachmentThumbSource(null) === null)
    assert.ok(P.attachmentThumbSource({}) === null)
  })
})

// -- rendering ------------------------------------------------------------------------------------

test('markdown, images, attachments and checklist rows in the pane', { skip }, async t => {
  const { plugin, sdk } = await loadPlugin()
  const env = await setupDom()
  const $ = (root, selector) => root.querySelector(selector)
  const $$ = (root, selector) => [...root.querySelectorAll(selector)]
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')

  const scenario = (name, options, body) =>
    t.test(name, async () => {
      const { fixture = applyHeavyFixture, width = 520 } = options
      const backend = makeBackend()
      fixture(backend)
      sdk.queryClient.reset()
      sdk.host.paneVisible.set(true)

      const ctx = makeCtx(sdk, backend)
      plugin.default.register(ctx)
      const ui = await env.mount(env.React.createElement(plugin.PaneRoot))
      await env.resizeTo(width)

      try {
        await body({ ui, ctx, backend, root: ui.container })
      } finally {
        await ui.unmount()
      }
    })

  const openHeavy = async root => {
    const card = $$(root, '[data-trello="card"]').find(c => text(c).includes('Release 4.2'))
    // narrow pane: list mode, so go to the list that has the card
    if (!card) {
      await env.click($$(root, '[data-trello="chip"]').find(c => text(c).startsWith('In progress')))
    }

    await env.click($($$(root, '[data-trello="card"]').find(c => text(c).includes('Release 4.2')), '[data-trello="card-open"]'))

    return $(root, '[data-trello="drawer"]')
  }

  const expand = async drawer => {
    const toggle = $(drawer, '[data-trello="description-toggle"]')

    if (toggle && text(toggle) === 'Show more') {
      await env.click(toggle)
    }
  }

  await scenario('M1: the showcase description renders every block and inline as React elements', { fixture: applyShowcaseFixture }, async ({ root }) => {
    const drawer = await openHeavy(root)
    await expand(drawer)
    const md = $(drawer, '[data-trello="description"] [data-trello="markdown"]')

    assert.deepEqual($$(md, '[role="heading"]').map(h => h.dataset.level), ['1', '2', '3'])
    assert.equal(text($(md, 'strong')), 'bold')
    assert.equal(text($(md, 'em')), 'italic')
    assert.equal(text($(md, 's')), 'struck')
    assert.equal(text($(md, 'code')), 'inline code')
    assert.deepEqual($$(md, 'a').map(a => a.getAttribute('href')), ['https://example.invalid/runbook', 'https://example.invalid/status', 'https://images.example.invalid/diagram.png'])
    assert.equal($$(md, 'hr').length, 1)

    const quote = $(md, 'blockquote')
    assert.ok(quote && quote.style.borderLeft.includes('3px solid') && quote.style.borderLeft.includes('var(--ui-'), 'a theme-coloured left border')
    assert.ok(text(quote).includes('Ship only when every checklist is green.'))

    const table = $(md, '[data-trello="md-table"]')
    assert.equal(table.style.overflowX, 'auto', 'a wide table scrolls on its own')
    assert.deepEqual($$(table, 'th').map(text), ['Stage', 'Share', 'Owner'])
    assert.deepEqual($$(table, 'tbody tr').map(r => $$(r, 'td').map(text)), [['Canary', '5%', 'Ada'], ['Ramp', '25%', 'Lin'], ['Everyone', '100%', 'Sam']])
    assert.deepEqual($$(table, 'th').map(c => c.style.textAlign), ['left', 'center', 'right'])
    assert.deepEqual($$($$(table, 'tbody tr')[0], 'td').map(c => c.style.textAlign), ['left', 'center', 'right'])

    const outer = $(md, 'ul')
    const nested = $(outer, 'ul')
    assert.ok(nested, 'a nested list')
    assert.deepEqual($$(nested, 'li').map(text), ['invoices', 'proration'])
    assert.notEqual(outer.style.listStyleType, nested.style.listStyleType, 'a different bullet per level')

    const tasks = $$(md, '[data-trello="md-task"]')
    assert.deepEqual(tasks.map(x => [x.dataset.state, x.getAttribute('aria-checked'), x.getAttribute('aria-readonly')]), [['complete', 'true', 'true'], ['incomplete', 'false', 'true']])
    assert.deepEqual(tasks.map(x => text(x.parentElement)), ['☑Reproduced', '☐Fix handler'])
    assert.ok($(md, 'input') === null, 'task items are read-only marks, not form controls')
  })

  await scenario('M2: a Trello-hosted markdown image loads inline (lazy, no referrer, capped height) and opens the original', { fixture: applyShowcaseFixture }, async ({ root, ctx }) => {
    const drawer = await openHeavy(root)
    await expand(drawer)
    const img = $(drawer, 'img[data-trello="md-image"]')

    assert.equal(img.getAttribute('src'), 'https://trello-attachments.s3.amazonaws.com/demo/latency.png')
    assert.equal(img.getAttribute('loading'), 'lazy')
    assert.equal(img.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(img.getAttribute('alt'), 'Latency, last 24 h')
    assert.equal(img.style.maxHeight, '20rem', 'about 320 px')
    assert.equal(img.style.cursor, 'pointer')
    await env.click(img)
    assert.deepEqual(ctx.opened, ['https://trello-attachments.s3.amazonaws.com/demo/latency.png'])
  })

  await scenario('M2: an image from another host is a chip; nothing is requested until Load image', { fixture: applyShowcaseFixture }, async ({ root, ctx }) => {
    const drawer = await openHeavy(root)
    await expand(drawer)
    const description = $(drawer, '[data-trello="description"]')
    const chip = () => $(description, '[data-trello="image-chip"]')

    assert.ok(chip())
    assert.equal(text(chip()).startsWith('🖼'), true)
    assert.equal($(chip(), 'span[title]').getAttribute('title'), 'Diagram from another host · images.example.invalid')
    assert.equal($$(description, 'img').length, 1, 'only the Trello-hosted image exists yet')
    assert.equal(text($(chip(), '[data-trello="image-load"]')), 'Load image')

    // "open in browser" goes to the OS handler without loading anything
    await env.click($$(chip(), 'a').find(a => text(a) === 'open in browser'))
    assert.deepEqual(ctx.opened, ['https://images.example.invalid/diagram.png'])
    assert.equal($$(description, 'img').length, 1)

    await env.click($(chip(), '[data-trello="image-load"]'))
    assert.ok(chip() === null, 'the chip is replaced by the image')
    const loaded = $$(description, 'img').find(i => i.getAttribute('src') === 'https://images.example.invalid/diagram.png')
    assert.ok(loaded)
    assert.equal(loaded.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(loaded.getAttribute('loading'), 'lazy')

    // when it fails the chip comes back with a message instead of a broken picture
    await env.fire(loaded, new env.window.Event('error'))
    assert.ok(chip())
    assert.ok(text(chip()).includes('Could not load the image.'))
    assert.ok($(chip(), '[data-trello="image-load"]') === null)
  })

  await scenario('M2: whatever the description says, opening the drawer loads only Trello hosts', {
    fixture: b => {
      applyShowcaseFixture(b)
      b.state.details[oid(101)].attachments = []
      b.state.details[oid(101)].desc = '![a](https://tracker.example.invalid/pixel.gif) ![b](http://trello.com/x.png) ![c](https://trello.com.evil.invalid/x.png) ![d](javascript:alert(1)) ![e](data:image/gif;base64,R0lGOD) ![f](https://trello.com/x.png)'
      b.state.details[oid(101)].comments = [{ id: oid(70), author: 'Ada Demo', text: '![g](https://tracker.example.invalid/c.gif)', date: new Date().toISOString() }]
    }
  }, async ({ root }) => {
    const drawer = await openHeavy(root)
    await expand(drawer)
    const sources = $$(drawer, 'img').map(i => i.getAttribute('src'))

    assert.deepEqual(sources, ['https://trello.com/x.png'])
    assert.equal($$(drawer, '[data-trello="image-chip"]').length, 4, 'a, b, c and g ask first; d and e are not images at all')
  })

  await scenario('M2: attachments: a Trello image is a thumbnail row, a file is an icon row, an external image asks', {}, async ({ root, ctx }) => {
    const drawer = await openHeavy(root)
    const rows = $$(drawer, '[data-trello="attachment"]')

    assert.deepEqual(rows.map(r => r.dataset.kind), ['file', 'image', 'file', 'file', 'file', 'image-external'])

    const photo = rows[1]
    const thumb = $(photo, '[data-trello="attachment-thumb"] img')
    assert.equal(thumb.getAttribute('src'), 'https://trello-attachments.s3.amazonaws.com/demo/previews/perf-150.png')
    assert.equal(thumb.getAttribute('loading'), 'lazy')
    assert.equal(thumb.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(thumb.getAttribute('width'), '150')
    assert.equal(thumb.parentElement.style.width, '4rem')
    assert.equal(thumb.parentElement.style.borderRadius, '6px')
    assert.ok(text(photo).includes('perf-before-after.png') && text(photo).includes('216 KB'), text(photo))
    await env.click($$(photo, 'a')[0])
    assert.deepEqual(ctx.opened, ['https://trello-attachments.s3.amazonaws.com/demo/perf-before-after.png'], 'the click opens the original, not the thumbnail')

    // every other file: icon + link + size, no <img>
    assert.equal($$(rows[0], 'img').length, 0)
    assert.ok(text(rows[0]).includes('release-notes-draft.pdf') && text(rows[0]).includes('471 KB'))
    assert.ok($(rows[0], '[data-icon="file"]'))

    // an image from another host: its row has the consent chip and nothing is loaded
    assert.ok($(rows[5], '[data-trello="image-chip"]'))
    assert.equal($$(rows[5], 'img').length, 0)
    assert.deepEqual($$(drawer, 'img').map(i => i.getAttribute('src')).filter(s => !s.includes('trello-attachments.s3.amazonaws.com')), [])
  })

  await scenario('M2: a thumbnail that fails to load falls back to the icon', {}, async ({ root }) => {
    const drawer = await openHeavy(root)
    const photo = $$(drawer, '[data-trello="attachment"]')[1]
    await env.fire($(photo, 'img'), new env.window.Event('error'))
    assert.ok($(photo, 'img') === null)
    assert.ok($(photo, '[data-trello="attachment-thumb"] [data-icon="file-media"]'))
  })

  await scenario('M2: an old backend without thumbnails still draws the attachments', {
    fixture: b => {
      applyHeavyFixture(b)
      b.state.details[oid(101)].attachments = [{ id: oid(50), name: 'legacy.png', url: 'https://trello.com/x/legacy.png', is_upload: true, bytes: 1024, mime: 'image/png' }]
    }
  }, async ({ root }) => {
    const drawer = await openHeavy(root)
    const row = $(drawer, '[data-trello="attachment"]')
    assert.equal(row.dataset.kind, 'file')
    assert.ok(text(row).includes('legacy.png') && text(row).includes('1 KB'))
  })

  // -- M3 ---------------------------------------------------------------------------------------

  await scenario('M3: an unticked box has a border that is not transparent; ticked and unticked differ', {}, async ({ root }) => {
    const drawer = await openHeavy(root)
    const empty = $(drawer, '[data-trello="item"][data-state="incomplete"] input')
    const done = $(drawer, '[data-trello="item"][data-state="complete"] input')

    assert.equal(empty.style.borderStyle, 'solid')
    assert.equal(empty.style.borderWidth, '1.5px', 'a border you can see')
    assert.equal(empty.style.borderColor, 'var(--ui-text-tertiary)', 'ink colour: reads on a dark and on a light theme')
    assert.ok(empty.style.background.includes('var(--ui-bg-'), 'with a fill from the theme')
    assert.equal(empty.style.width, '1rem')
    assert.equal(empty.style.height, '1rem')
    assert.equal(done.style.borderStyle, '', 'a ticked box keeps the theme accent look')

    const pending = $(drawer, '[data-trello="pending-only"] input')
    assert.equal(pending.style.borderStyle, 'solid', 'the Pending only box is as visible as the item boxes')
    assert.equal(pending.style.borderColor, 'var(--ui-text-tertiary)')
    assert.equal(done.style.width, '1rem')
  })

  await scenario('M3: the box gets stronger on hover; the row has padding, a separator and a hover tint', {}, async ({ root }) => {
    const drawer = await openHeavy(root)
    const row = () => $$(drawer, '[data-trello="item"][data-state="incomplete"]')[2]
    const box = () => $(row(), 'input')

    assert.equal(row().style.borderBottom, '1px solid var(--ui-stroke-tertiary)', 'a hairline between items')
    assert.equal(row().style.padding, '0.25rem 0.375rem', '4 px above and below')
    assert.equal(row().style.background, 'transparent')
    assert.equal(box().style.borderColor, 'var(--ui-text-tertiary)')

    await env.hover(row())
    assert.ok(row().style.background.includes('var(--ui-accent)'), 'tinted under the pointer')
    assert.equal(box().style.borderColor, 'var(--ui-text-secondary)', 'and the box darkens')
    await env.unhover(row())
    assert.equal(row().style.background, 'transparent')
  })

  await scenario('M3: the text can shrink, wraps long names, and a done item is struck through and dimmer', {
    fixture: b => {
      applyHeavyFixture(b)
      const list = b.state.details[oid(101)].checklists[0]
      list.items[3].name = 'an-extremely-long-item-name-without-any-break-'.repeat(8)
    }
  }, async ({ root }) => {
    const drawer = await openHeavy(root)
    const rows = $$(drawer, '[data-trello="checklist"]')[0]
    const label = r => $(r, 'span')
    const done = $$(rows, '[data-trello="item"][data-state="complete"]')[0]
    const open = $$(rows, '[data-trello="item"][data-state="incomplete"]')[0]
    const long = $$(rows, '[data-trello="item"]')[3]

    assert.equal(label(long).style.minWidth, '0px')
    assert.equal(label(long).style.overflowWrap, 'anywhere')
    assert.equal(label(open).style.lineHeight, '1.25rem')
    assert.equal(label(open).style.textDecoration, 'none')
    assert.equal(label(done).style.textDecoration, 'line-through')
    assert.equal(label(done).style.color, 'var(--ui-text-tertiary)', 'dimmer than the open items, still above 3:1 on both themes')
    assert.equal(label(open).style.color, 'inherit')
  })

  await scenario('M3: tools, the optimistic toggle and Pending only still work on the new rows', {}, async ({ root, backend }) => {
    const drawer = await openHeavy(root)
    const row = () => $$(drawer, '[data-trello="item"]')[0]
    assert.equal($$(drawer, '[aria-label="Rename item"]').length, 0)
    await env.hover(row())
    assert.ok($(row(), '[aria-label="Rename item"]') && $(row(), '[aria-label="Delete item"]'))
    await env.unhover(row())

    const before = $$(drawer, '[data-trello="item"][data-state="complete"]').length
    const box = $$(drawer, '[data-trello="item"][data-state="incomplete"] input')[0]
    await env.click(box)
    assert.equal($$(drawer, '[data-trello="item"][data-state="complete"]').length, before + 1)
    assert.ok(backend.callsTo('PATCH', /items/).length >= 1, 'the toggle reached the backend')

    await env.click($(drawer, '[data-trello="pending-only"] input'))
    assert.equal($$(drawer, '[data-trello="item"][data-state="complete"]').length, 0)
  })
})
