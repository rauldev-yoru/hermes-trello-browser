/**
 * Trello Browser — desktop half.
 *
 * Plain ESM, loaded uncompiled by the Hermes desktop app: no build step, no JSX
 * syntax (only jsx()/jsxs() calls), and the ONLY imports are `@hermes/plugin-sdk`,
 * `react` and `react/jsx-runtime`. Every Trello call goes through `ctx.rest()` to
 * this plugin's own backend, so the renderer never holds the API key or token.
 *
 * Layout of this file:
 *   1. constants + locale bundles
 *   2. pure helpers (exported for tests): card block builder, markdown subset,
 *      label/due logic, optimistic updaters, composer delivery
 *   3. runtime (stores) + data layer (queries and mutations)
 *   4. components
 *   5. register()
 */

import {
  atom,
  Button,
  Checkbox,
  Codicon,
  ConfirmDialog,
  CopyButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  haptic,
  host,
  Input,
  isSubmitEnter,
  PALETTE_AREA,
  PANES_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  queryClient,
  SearchField,
  SegmentedControl,
  Separator,
  Skeleton,
  Textarea,
  Tip,
  TRANSCRIPT_DIRECTIVE_AREA,
  useMutation,
  usePluginI18n,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// 1. Constants + locale bundles
// ---------------------------------------------------------------------------

export const ID = 'trello-browser'
/** Contribution-scoped pane id: `<pluginId>:<paneId>`. */
export const PANE_ID = `${ID}:pane`
/** Pane width (px) at which the layout switches from list focus to columns. */
export const COLUMNS_MIN_WIDTH = 560
const DAY_MS = 24 * 60 * 60 * 1000
const SOON_MS = 2 * DAY_MS
const REFRESH_CHOICES = [0, 15, 25, 60]
const TRELLO_ADMIN_URL = 'https://trello.com/apps/admin'

export const DEFAULT_SETTINGS = Object.freeze({ sendMode: 'insert', refreshSec: 25, defaultBoard: null })

const EN = {
  pane: { title: 'Trello' },
  palette: { open: 'Open Trello' },
  common: {
    retry: 'Retry',
    close: 'Close',
    add: 'Add',
    refresh: 'Refresh',
    settings: 'Settings',
    openInTrello: 'Open in Trello',
    copyLink: 'Copy link',
    linkCopied: 'Link copied'
  },
  errors: {
    generic: 'Something went wrong while talking to Trello.',
    not_connected: 'Trello is not connected.',
    credentials_rejected: 'Trello rejected the saved API key or token.',
    not_found: 'That card or board was deleted or is out of reach.',
    rate_limited: 'Trello is rate-limiting requests. Try again shortly.',
    trello_unavailable: 'The backend is up but cannot reach Trello right now.',
    bad_request: 'Trello refused that change.',
    network: 'No connection to the Trello backend.',
    network_hint: 'The plugin backend did not answer. Check that the dashboard is running, then retry.',
    plugin_not_mounted: 'The Trello backend is not mounted for this profile.',
    plugin_not_mounted_hint: 'Enable the plugin in the active profile, or restart the dashboard, then retry.'
  },
  directive: {
    open: 'Open in Trello',
    loading: 'Loading card…',
    list: name => `in ${name}`
  },
  connect: {
    title: 'Connect your Trello account',
    intro: 'Paste the API key and token of a Trello Power-Up. They stay on this machine and are never shown again.',
    steps: 'Create a Power-Up, open its API key page, generate a key, then use the Token link next to it. Both values must come from the same Power-Up.',
    apiKey: 'API key',
    token: 'Token',
    connect: 'Connect',
    connecting: 'Checking…',
    openAdmin: 'Open Power-Up admin',
    rejected: 'Trello rejected the saved credentials. Enter a new key and token.',
    connectedAs: name => `Connected as ${name}`
  },
  board: {
    pick: 'Choose a board',
    search: 'Search boards',
    noBoards: 'No open boards found for this account.',
    noMatch: 'No board matches that search.',
    emptyBoard: 'This board has no lists yet.',
    emptyList: 'No cards in this list.',
    lists: 'Lists'
  },
  status: {
    stale: 'Showing saved data — Trello could not be reached.',
    rateLimited: 'Trello is rate-limiting; will retry quietly.'
  },
  card: {
    sendToAgent: 'Send to agent',
    sendHint: 'Click inserts into the composer. Shift+click sends it.',
    menu: 'More actions',
    overdue: 'Overdue',
    dueSoon: 'Due soon',
    dueDone: 'Done',
    add: 'Add card',
    addPlaceholder: 'Card title',
    created: 'Card created',
    archived: 'Card archived',
    moveTo: 'Move to list',
    moved: name => `Moved to ${name}`
  },
  drawer: {
    close: 'Close card',
    loading: 'Loading card…',
    description: 'Description',
    noDescription: 'No description.',
    checklists: 'Checklists',
    noChecklists: 'No checklists yet.',
    addChecklist: 'Add checklist',
    checklistName: 'Checklist title',
    addItem: 'Add item',
    itemPlaceholder: 'New item',
    renameItem: 'Rename item',
    deleteItem: 'Delete item',
    comments: 'Comments',
    noComments: 'No comments yet.',
    commentPlaceholder: 'Write a comment',
    postComment: 'Comment',
    attachments: 'Attachments',
    noAttachments: 'No attachments.',
    activity: 'Activity',
    lastActivity: date => `Last activity ${date}`,
    noActivity: 'No activity yet.',
    unknownAuthor: 'Someone',
    due: 'Due date',
    clearDue: 'Clear',
    labels: 'Labels',
    noLabels: 'This board has no labels.',
    archive: 'Archive card',
    archiveTitle: 'Archive this card?',
    archiveBody: 'It will disappear from the board. You can restore it from Trello.',
    suggest: 'Suggest checklist',
    suggestInserted: 'Prompt inserted — press Enter to run it.',
    openAttachment: 'Open attachment'
  },
  send: {
    inserted: 'Card inserted into the composer.',
    submitted: 'Card sent to the agent.',
    insertedNew: 'Card inserted into a new chat.',
    submittedNew: 'Card sent in a new chat.',
    copied: 'No chat is open: the card was copied to the clipboard.',
    failed: 'Could not reach a chat or the clipboard. Copy the block manually.',
    partial: 'Card details could not be loaded; sent what the board already knows.',
    fallbackTitle: 'Copy this block',
    fallbackBody: 'Paste it into the chat yourself.'
  },
  settings: {
    title: 'Trello settings',
    sendMode: 'Send to agent',
    sendInsert: 'Insert',
    sendSubmit: 'Send',
    sendModeHint: 'Insert leaves the card in the composer so you can add an instruction.',
    refresh: 'Refresh every',
    refreshOff: 'Off',
    refreshSeconds: n => `${n}s`,
    defaultBoard: 'Default board',
    defaultBoardLast: 'Last used',
    disconnect: 'Disconnect',
    disconnectTitle: 'Disconnect Trello?',
    disconnectBody: 'The stored API key and token will be deleted from this machine.',
    disconnected: 'Trello disconnected.',
    connectedAs: name => `Signed in as ${name}`
  }
}

const ES = {
  pane: { title: 'Trello' },
  palette: { open: 'Abrir Trello' },
  common: {
    retry: 'Reintentar',
    close: 'Cerrar',
    add: 'Añadir',
    refresh: 'Actualizar',
    settings: 'Ajustes',
    openInTrello: 'Abrir en Trello',
    copyLink: 'Copiar enlace',
    linkCopied: 'Enlace copiado'
  },
  errors: {
    generic: 'Algo falló al hablar con Trello.',
    not_connected: 'Trello no está conectado.',
    credentials_rejected: 'Trello rechazó la API key o el token guardados.',
    not_found: 'Esa card o tablero se borró o no está al alcance.',
    rate_limited: 'Trello está limitando las peticiones. Prueba en unos segundos.',
    trello_unavailable: 'El backend funciona pero no logra llegar a Trello ahora mismo.',
    bad_request: 'Trello rechazó ese cambio.',
    network: 'Sin conexión con el backend de Trello.',
    network_hint: 'El backend del plugin no respondió. Comprueba que el dashboard esté en marcha y reintenta.',
    plugin_not_mounted: 'El backend de Trello no está montado para este perfil.',
    plugin_not_mounted_hint: 'Activa el plugin en el perfil activo, o reinicia el dashboard, y reintenta.'
  },
  directive: {
    open: 'Abrir en Trello',
    loading: 'Cargando card…',
    list: name => `en ${name}`
  },
  connect: {
    title: 'Conecta tu cuenta de Trello',
    intro: 'Pega la API key y el token de un Power-Up de Trello. Se quedan en esta máquina y no se vuelven a mostrar.',
    steps: 'Crea un Power-Up, abre su página de API key, genera una key y usa el enlace Token junto a ella. Ambos valores deben salir del mismo Power-Up.',
    apiKey: 'API key',
    token: 'Token',
    connect: 'Conectar',
    connecting: 'Comprobando…',
    openAdmin: 'Abrir administración de Power-Ups',
    rejected: 'Trello rechazó las credenciales guardadas. Introduce una key y un token nuevos.',
    connectedAs: name => `Conectado como ${name}`
  },
  board: {
    pick: 'Elige un tablero',
    search: 'Buscar tableros',
    noBoards: 'No hay tableros abiertos en esta cuenta.',
    noMatch: 'Ningún tablero coincide con la búsqueda.',
    emptyBoard: 'Este tablero aún no tiene listas.',
    emptyList: 'No hay cards en esta lista.',
    lists: 'Listas'
  },
  status: {
    stale: 'Mostrando datos guardados — no se pudo contactar con Trello.',
    rateLimited: 'Trello está limitando; se reintentará en silencio.'
  },
  card: {
    sendToAgent: 'Enviar al agente',
    sendHint: 'Clic lo inserta en el compositor. Mayús+clic lo envía.',
    menu: 'Más acciones',
    overdue: 'Vencida',
    dueSoon: 'Vence pronto',
    dueDone: 'Hecha',
    add: 'Añadir card',
    addPlaceholder: 'Título de la card',
    created: 'Card creada',
    archived: 'Card archivada',
    moveTo: 'Mover a la lista',
    moved: name => `Movida a ${name}`
  },
  drawer: {
    close: 'Cerrar card',
    loading: 'Cargando card…',
    description: 'Descripción',
    noDescription: 'Sin descripción.',
    checklists: 'Checklists',
    noChecklists: 'Aún no hay checklists.',
    addChecklist: 'Añadir checklist',
    checklistName: 'Título del checklist',
    addItem: 'Añadir ítem',
    itemPlaceholder: 'Nuevo ítem',
    renameItem: 'Renombrar ítem',
    deleteItem: 'Borrar ítem',
    comments: 'Comentarios',
    noComments: 'Aún no hay comentarios.',
    commentPlaceholder: 'Escribe un comentario',
    postComment: 'Comentar',
    attachments: 'Adjuntos',
    noAttachments: 'Sin adjuntos.',
    activity: 'Actividad',
    lastActivity: date => `Última actividad ${date}`,
    noActivity: 'Todavía no hay actividad.',
    unknownAuthor: 'Alguien',
    due: 'Fecha límite',
    clearDue: 'Quitar',
    labels: 'Etiquetas',
    noLabels: 'Este tablero no tiene etiquetas.',
    archive: 'Archivar card',
    archiveTitle: '¿Archivar esta card?',
    archiveBody: 'Desaparecerá del tablero. Puedes restaurarla desde Trello.',
    suggest: 'Sugerir checklist',
    suggestInserted: 'Prompt insertado — pulsa Enter para ejecutarlo.',
    openAttachment: 'Abrir adjunto'
  },
  send: {
    inserted: 'Card insertada en el compositor.',
    submitted: 'Card enviada al agente.',
    insertedNew: 'Card insertada en un chat nuevo.',
    submittedNew: 'Card enviada en un chat nuevo.',
    copied: 'No hay chat abierto: la card se copió al portapapeles.',
    failed: 'No se pudo llegar a un chat ni al portapapeles. Copia el bloque a mano.',
    partial: 'No se pudo cargar el detalle; se envió lo que el tablero ya conoce.',
    fallbackTitle: 'Copia este bloque',
    fallbackBody: 'Pégalo tú mismo en el chat.'
  },
  settings: {
    title: 'Ajustes de Trello',
    sendMode: 'Enviar al agente',
    sendInsert: 'Insertar',
    sendSubmit: 'Enviar',
    sendModeHint: 'Insertar deja la card en el compositor para que añadas una instrucción.',
    refresh: 'Actualizar cada',
    refreshOff: 'Nunca',
    refreshSeconds: n => `${n}s`,
    defaultBoard: 'Tablero por defecto',
    defaultBoardLast: 'El último usado',
    disconnect: 'Desconectar',
    disconnectTitle: '¿Desconectar Trello?',
    disconnectBody: 'La API key y el token guardados se borrarán de esta máquina.',
    disconnected: 'Trello desconectado.',
    connectedAs: name => `Sesión como ${name}`
  }
}

export const LOCALES = { en: EN, es: ES }

// ---------------------------------------------------------------------------
// 2. Pure helpers (all exported for tests)
// ---------------------------------------------------------------------------

/** Parse the error thrown by `ctx.rest()` ("<status>: <json body>") into a flat shape. */
export function parseApiError(err) {
  const message = err instanceof Error ? err.message : String(err ?? '')
  let status = Number(err && typeof err === 'object' ? err.statusCode : NaN)

  if (!Number.isInteger(status) || status <= 0) {
    const m = /^\s*(\d{3})\b/.exec(message)
    status = m ? Number(m[1]) : 0
  }

  let body = null
  const start = message.indexOf('{')

  if (start >= 0) {
    try {
      const parsed = JSON.parse(message.slice(start))
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      body = null
    }
  }

  let code = body && typeof body.error === 'string' ? body.error : status === 0 ? 'network' : `http_${status}`

  if (!(body && typeof body.error === 'string')) {
    if (status === 404 && body && body.detail === 'Plugin not found') {
      // the dashboard answered, but this plugin's API router is not mounted for the active profile
      code = 'plugin_not_mounted'
    } else if (status === 502 || status === 503 || status === 504) {
      // a gateway-style failure without our JSON contract: the backend itself is not answering
      code = 'network'
    }
  }
  const retry = body && body.retry_after !== null && body.retry_after !== undefined && Number.isFinite(Number(body.retry_after)) ? Number(body.retry_after) : null

  return {
    status,
    code,
    message: body && typeof body.message === 'string' ? body.message : status === 0 ? '' : message,
    retryAfter: retry
  }
}

const KNOWN_ERROR_CODES = new Set([
  'not_connected',
  'credentials_rejected',
  'not_found',
  'rate_limited',
  'trello_unavailable',
  'bad_request',
  'network',
  'plugin_not_mounted'
])

/** The locale key (under `errors.`) that explains a parsed error. */
export function errorKey(parsed) {
  return KNOWN_ERROR_CODES.has(parsed.code) ? parsed.code : 'generic'
}

/** Title + explanation for an error state; never the same generic line for different causes. */
export function errorCopy(t, parsed) {
  const key = errorKey(parsed)
  const hint = `errors.${key}_hint`

  if (parsed.code === 'bad_request' && parsed.message) {
    return { title: t(`errors.${key}`), description: parsed.message }
  }

  return { title: t(`errors.${key}`), description: key === 'network' || key === 'plugin_not_mounted' ? t(hint) : '' }
}

/** True when retrying the same request cannot help. */
export function isClientError(err) {
  const { status } = parseApiError(err)

  return status >= 400 && status < 500 && status !== 429
}

export function truncate(text, max) {
  const s = String(text ?? '')

  return s.length > max ? `${s.slice(0, max)}…` : s
}

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Make untrusted Trello text safe to embed between the card-data fences: strip control
 * characters and collapse any run of three or more dashes, so card text can never forge
 * the `--- end card data ---` marker and escape the untrusted region.
 */
export function neutralize(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/-{3,}/g, '—')
}

export const BLOCK_LIMITS = Object.freeze({
  description: 1200,
  commentChars: 300,
  comments: 3,
  itemsTotal: 40,
  itemsPerChecklist: 20,
  itemChars: 80,
  headerChars: 200
})

function checklistsLine(checklists) {
  if (!Array.isArray(checklists) || !checklists.length) {
    return '(none)'
  }

  let budget = BLOCK_LIMITS.itemsTotal
  const parts = []

  for (const list of checklists) {
    const items = Array.isArray(list.items) ? list.items : []
    const done = items.filter(i => i.state === 'complete').length
    const take = Math.max(0, Math.min(items.length, BLOCK_LIMITS.itemsPerChecklist, budget))
    budget -= take

    const names = items.slice(0, take).map(i => neutralize(truncate(oneLine(i.name), BLOCK_LIMITS.itemChars)))
    const more = take < items.length ? ', …' : ''
    const head = `${neutralize(truncate(oneLine(list.name), BLOCK_LIMITS.itemChars))} [${done}/${items.length}]`

    parts.push(names.length ? `${head} ${names.join(', ')}${more}` : head)
  }

  return parts.join(' ; ')
}

/**
 * The compact context block handed to the agent (ARCHITECTURE.md §4.1). `detail` may be
 * null when the card could not be loaded; the block then says so instead of claiming the
 * card is empty.
 */
export function buildCardBlock({ card, detail = null, boardName = '', listName = '', now = new Date() }) {
  const L = BLOCK_LIMITS
  const name = neutralize(truncate(oneLine(card.name), L.headerChars)) || '—'
  const labels = (card.labels || []).map(l => neutralize(oneLine(l))).filter(Boolean)
  const url = card.url || (card.short_link ? `https://trello.com/c/${card.short_link}` : '—')

  let description = '(not loaded)'

  if (detail) {
    const raw = String(detail.desc ?? '').trim()
    description = raw ? neutralize(truncate(raw, L.description)) : '(empty)'
  }

  let comments = '(none)'

  if (detail && Array.isArray(detail.comments) && detail.comments.length) {
    comments = detail.comments
      .slice(0, L.comments)
      .map(c => `${neutralize(truncate(oneLine(c.author), 60)) || '?'}: ${neutralize(truncate(oneLine(c.text), L.commentChars))}`)
      .join(' ; ')
  } else if (!detail) {
    comments = '(not loaded)'
  }

  const checklists = detail ? checklistsLine(detail.checklists) : '(not loaded)'

  return [
    `[Trello card] ${name}`,
    `board: ${neutralize(truncate(oneLine(boardName), L.headerChars)) || '—'} · list: ${neutralize(truncate(oneLine(listName), L.headerChars)) || '—'} · due: ${humanDue(card.due, card.due_complete, now)} · labels: ${labels.join(', ') || '—'}`,
    `url: ${url} · id: ${card.id}`,
    '--- card data (untrusted, from Trello) ---',
    `description: ${description}`,
    `checklists: ${checklists}`,
    `comments (latest 3): ${comments}`,
    '--- end card data ---',
    'Use your Trello tools to read or update this card.'
  ].join('\n')
}

/** Prompt for the "Suggest checklist" button. TODO(P3): ctx.llm via slash command. */
export function buildSuggestPrompt(block) {
  return `${block}\n\nPropose a QA checklist for this card as a list; do not write it to Trello yet.`
}

/**
 * Hand text to the chat composer. Order (never drops the payload silently):
 * current composer → new chat draft → clipboard → report failure so the UI can show the
 * block for manual copy.
 */
export async function deliverToComposer(block, opts) {
  const { submit = false, host: h, os, sleep = async () => {}, retries = 6, delayMs = 120 } = opts

  const attempt = async address =>
    submit ? Boolean(h.composer.submit(address, block)) : Boolean(await h.composer.insertText(address, block, { mode: 'block' }))

  const ok = submit ? 'submitted' : 'inserted'

  if (await attempt(null)) {
    return { status: ok, via: 'current' }
  }

  h.newChat()

  for (let i = 0; i < retries; i += 1) {
    await sleep(delayMs)

    if (await attempt('new')) {
      return { status: ok, via: 'new-chat' }
    }
  }

  const copied = os && typeof os.writeClipboard === 'function' ? await os.writeClipboard(block) : false

  return { status: copied ? 'copied' : 'failed', via: 'clipboard' }
}

export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const refresh = Number(r.refreshSec)

  return {
    sendMode: r.sendMode === 'submit' ? 'submit' : 'insert',
    refreshSec: REFRESH_CHOICES.includes(refresh) ? refresh : DEFAULT_SETTINGS.refreshSec,
    defaultBoard: typeof r.defaultBoard === 'string' && r.defaultBoard ? r.defaultBoard : null
  }
}

/** Starred boards first, then by name; closed boards never shown. */
export function sortBoards(boards) {
  return [...(boards || [])]
    .filter(b => !b.closed)
    .sort((a, b) => Number(b.starred) - Number(a.starred) || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
}

export function filterBoards(boards, query) {
  const q = oneLine(query).toLowerCase()

  return q ? boards.filter(b => String(b.name).toLowerCase().includes(q)) : boards
}

/** Current choice → fallback (the default-board setting) → first board. */
export function resolveBoardId(boards, current, fallback) {
  const ids = new Set((boards || []).map(b => b.id))

  if (current && ids.has(current)) {
    return current
  }

  if (fallback && ids.has(fallback)) {
    return fallback
  }

  return boards && boards.length ? boards[0].id : null
}

export const modeForWidth = width => (Number(width) >= COLUMNS_MIN_WIDTH ? 'columns' : 'list')

/** Lane width for the columns layout, tracked from the measured container width. */
export function laneWidth(containerWidth, laneCount) {
  const visible = Math.max(1, Math.min(laneCount, 3))
  const fit = Math.floor((Number(containerWidth) - 24 - 10 * (visible - 1)) / visible)

  return Math.max(220, Math.min(300, fit))
}

export function cardsByList(view) {
  const map = new Map()

  for (const list of view?.lists || []) {
    map.set(list.id, [])
  }

  for (const card of view?.cards || []) {
    if (map.has(card.id_list)) {
      map.get(card.id_list).push(card)
    }
  }

  return map
}

/** Card ids in on-screen order for the active layout (keyboard navigation). */
export function visibleCardIds(view, mode, listId) {
  const grouped = cardsByList(view)

  if (mode === 'columns') {
    return (view?.lists || []).flatMap(l => (grouped.get(l.id) || []).map(c => c.id))
  }

  return (grouped.get(listId) || []).map(c => c.id)
}

export function stepSelection(ids, current, delta) {
  if (!ids.length) {
    return null
  }

  const at = ids.indexOf(current)

  if (at < 0) {
    return delta >= 0 ? ids[0] : ids[ids.length - 1]
  }

  return ids[Math.max(0, Math.min(ids.length - 1, at + delta))]
}

const TRELLO_COLOR_RE = /^(green|yellow|orange|red|purple|blue|sky|lime|pink|black)(_light|_dark)?$/

const COLOR_VARS = {
  green: '--ui-green',
  lime: '--ui-green',
  yellow: '--ui-yellow',
  orange: '--ui-orange',
  red: '--ui-red',
  purple: '--ui-purple',
  pink: '--ui-purple',
  blue: '--ui-blue',
  sky: '--ui-cyan',
  black: '--ui-text-quaternary'
}

const NEUTRAL_VAR = '--ui-text-quaternary'

export function labelColorVar(color) {
  const m = TRELLO_COLOR_RE.exec(String(color || ''))

  return m ? COLOR_VARS[m[1]] : NEUTRAL_VAR
}

/**
 * Cards carry labels as "<name|color>" strings. A string that is a Trello color name and
 * matches no named board label is an unnamed label: render a swatch, not text.
 */
export function resolveLabel(text, boardLabels) {
  const named = (boardLabels || []).find(l => l.name && l.name === text)

  if (named) {
    return { text, cssVar: labelColorVar(named.color), key: text }
  }

  if (TRELLO_COLOR_RE.test(text)) {
    return { text: null, cssVar: labelColorVar(text), key: text }
  }

  return { text, cssVar: NEUTRAL_VAR, key: text }
}

/** Board labels with their checked state, taken from the card's `label_ids`. */
export function labelChoices(boardLabels, cardLabelIds) {
  const active = new Set(Array.isArray(cardLabelIds) ? cardLabelIds : [])

  return (boardLabels || []).map(l => ({
    id: l.id,
    label: l,
    key: l.name || l.color || '',
    checked: active.has(l.id)
  }))
}

/** Next `id_labels` array after toggling one label. */
export function toggleLabelIds(choices, labelId) {
  const next = new Set(choices.filter(c => c.checked).map(c => c.id))

  if (next.has(labelId)) {
    next.delete(labelId)
  } else {
    next.add(labelId)
  }

  return [...next]
}

export function dueInfo(due, dueComplete, now = Date.now()) {
  const ts = typeof due === 'string' ? Date.parse(due) : NaN

  if (Number.isNaN(ts)) {
    return null
  }

  if (dueComplete) {
    return { kind: 'done', ts }
  }

  const diff = ts - now

  if (diff < 0) {
    return { kind: 'overdue', ts }
  }

  return { kind: diff <= SOON_MS ? 'soon' : 'later', ts }
}

export const DUE_VARS = { overdue: '--ui-red', soon: '--ui-yellow', done: '--ui-green', later: '--ui-text-tertiary' }

/** `YYYY-MM-DD` of a Trello due date in local time, for <input type="date">. */
export function dueToInput(due) {
  const ts = typeof due === 'string' ? Date.parse(due) : NaN

  if (Number.isNaN(ts)) {
    return ''
  }

  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local noon of a picked day as ISO, so timezone shifts never move the date. */
export function inputToDue(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))

  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toISOString() : null
}

/**
 * Local calendar date plus a relative hint, for the agent: `2026-10-29 (in 3 days)`,
 * `(today)`, `(3 days overdue)`; `—` without a usable date. A completed due date reads
 * `(done)` instead of a countdown.
 */
export function humanDue(due, dueComplete = false, now = new Date()) {
  const ts = typeof due === 'string' ? Date.parse(due) : NaN

  if (Number.isNaN(ts)) {
    return '—'
  }

  const date = new Date(ts)
  const today = new Date(now)
  const days = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / DAY_MS)
  const plural = n => `${n} day${n === 1 ? '' : 's'}`
  let hint = 'today'

  if (dueComplete) {
    hint = 'done'
  } else if (days > 0) {
    hint = `in ${plural(days)}`
  } else if (days < 0) {
    hint = `${plural(-days)} overdue`
  }

  return `${dueToInput(due)} (${hint})`
}

/** "3 hours ago" / "yesterday" for activity rows; '' when the date is unusable. */
export function relativeAgo(iso, now = Date.now(), locale = undefined) {
  const ts = typeof iso === 'string' ? Date.parse(iso) : NaN

  if (Number.isNaN(ts)) {
    return ''
  }

  const seconds = Math.round((ts - now) / 1000)
  const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]

  try {
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

    for (const [unit, size] of steps) {
      if (Math.abs(seconds) >= size) {
        return fmt.format(Math.round(seconds / size), unit)
      }
    }

    return fmt.format(0, 'second')
  } catch {
    return new Date(ts).toISOString().slice(0, 10)
  }
}

/** Codicon for a Trello action type (anything unknown gets a neutral dot). */
export const ACTIVITY_ICONS = {
  createCard: 'add',
  updateCard: 'edit',
  commentCard: 'comment',
  addChecklistToCard: 'checklist',
  updateCheckItemStateOnCard: 'check'
}

export const ACTIVITY_MAX_ROWS = 20

/** Rows to show in the drawer: the newest `ACTIVITY_MAX_ROWS`, tolerant of old backends. */
export function activityRows(detail) {
  return Array.isArray(detail && detail.activity) ? detail.activity.filter(a => a && a.id).slice(0, ACTIVITY_MAX_ROWS) : []
}

/** Card reference a directive may carry: a 24-hex id or an 8-char short link. */
export function directiveCardRef(attrs) {
  const raw = attrs && typeof attrs.card === 'string' ? attrs.card.trim() : ''

  return /^[0-9a-f]{24}$/.test(raw) || /^[A-Za-z0-9]{8}$/.test(raw) ? raw : null
}

// -- optimistic updaters (pure, immutable) ----------------------------------

export function withCardMoved(view, cardId, listId) {
  if (!view) {
    return view
  }

  return { ...view, cards: view.cards.map(c => (c.id === cardId ? { ...c, id_list: listId } : c)) }
}

export function withDetailMoved(detail, listId) {
  return detail ? { ...detail, card: { ...detail.card, id_list: listId } } : detail
}

/** Flip one checklist item in a card detail; also reports the change in done count. */
export function withItemState(detail, checklistId, itemId, state) {
  if (!detail) {
    return { detail, delta: 0 }
  }

  let delta = 0

  const checklists = detail.checklists.map(list =>
    list.id !== checklistId
      ? list
      : {
          ...list,
          items: list.items.map(item => {
            if (item.id !== itemId || item.state === state) {
              return item
            }

            delta = state === 'complete' ? 1 : -1

            return { ...item, state }
          })
        }
  )

  const total = checklists.reduce((n, l) => n + l.items.length, 0)
  const done = checklists.reduce((n, l) => n + l.items.filter(i => i.state === 'complete').length, 0)

  return { detail: { ...detail, checklists, card: { ...detail.card, checklist: { total, done } } }, delta }
}

export function withViewChecklist(view, cardId, checklist) {
  if (!view) {
    return view
  }

  return { ...view, cards: view.cards.map(c => (c.id === cardId ? { ...c, checklist } : c)) }
}

// -- markdown subset ---------------------------------------------------------

const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = []
  let i = 0

  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'p', text: para.join('\n') })
      para = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*```([\w-]*)\s*$/.exec(line)

    if (fence) {
      flush()
      const code = []
      i += 1

      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i += 1
      }

      i += 1
      blocks.push({ type: 'code', lang: fence[1], text: code.join('\n') })
      continue
    }

    if (ITEM_RE.test(line)) {
      flush()
      const ordered = /^\s*\d/.test(line)
      const items = []

      while (i < lines.length) {
        const m = ITEM_RE.exec(lines[i])

        if (!m) {
          break
        }

        items.push({ checked: m[1] === undefined ? null : m[1].toLowerCase() === 'x', text: m[2] })
        i += 1
      }

      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)

    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }

    if (!line.trim()) {
      flush()
    } else {
      para.push(line)
    }

    i += 1
  }

  flush()

  return blocks
}

/** Only http(s) and mailto links ever become clickable. */
export function safeUrl(url) {
  const raw = String(url ?? '').trim()

  if (!/^(https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i.test(raw)) {
    return null
  }

  try {
    const parsed = new URL(raw)

    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? raw : null
  } catch {
    return null
  }
}

const INLINE_RE =
  /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g

export function parseInline(text) {
  const src = String(text ?? '')
  const out = []
  let last = 0
  const re = new RegExp(INLINE_RE.source, 'g')
  let m = re.exec(src)

  while (m) {
    if (m.index > last) {
      out.push({ type: 'text', text: src.slice(last, m.index) })
    }

    if (m[1] !== undefined) {
      out.push({ type: 'code', text: m[1] })
    } else if (m[2] !== undefined || m[3] !== undefined) {
      out.push({ type: 'bold', children: parseInline(m[2] ?? m[3]) })
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push({ type: 'italic', children: parseInline(m[4] ?? m[5]) })
    } else if (m[6] !== undefined) {
      const url = safeUrl(m[7])
      out.push(url ? { type: 'link', url, text: m[6] } : { type: 'text', text: m[6] })
    } else if (m[8] !== undefined) {
      const url = safeUrl(m[8])
      out.push(url ? { type: 'link', url, text: m[8] } : { type: 'text', text: m[8] })
    }

    last = m.index + m[0].length
    m = re.exec(src)
  }

  if (last < src.length) {
    out.push({ type: 'text', text: src.slice(last) })
  }

  return out
}

export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') {
    return false
  }

  const tag = String(el.tagName || '').toLowerCase()

  return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(el.isContentEditable)
}

// ---------------------------------------------------------------------------
// 3. Runtime (plugin-local stores) + data layer
// ---------------------------------------------------------------------------

/** Filled by register(); components read it lazily so a plugin reload swaps it cleanly. */
const RT = { ctx: null, store: null }

export function initRuntime(ctx) {
  const settings = normalizeSettings(ctx.storage.get('settings', DEFAULT_SETTINGS))
  const saved = ctx.storage.get('boardId', null)

  RT.ctx = ctx
  RT.store = {
    settings: atom(settings),
    boardId: atom(settings.defaultBoard || (typeof saved === 'string' ? saved : null)),
    listId: atom(null),
    selected: atom(null),
    openCard: atom(null),
    visibleIds: atom([]),
    fallbackBlock: atom(null)
  }

  return RT
}

export function getRuntime() {
  return RT
}

const tr = (key, ...args) => RT.ctx.i18n.t(key, ...args)
const toast = (kind, message) => host.notify({ kind, message })
const rest = (path, opts) => RT.ctx.rest(path, opts)
const seg = id => encodeURIComponent(String(id))

function setSettings(patch) {
  const next = normalizeSettings({ ...RT.store.settings.get(), ...patch })
  RT.store.settings.set(next)
  RT.ctx.storage.set('settings', next)
}

function selectBoard(id) {
  RT.store.boardId.set(id)
  RT.store.listId.set(null)
  RT.store.openCard.set(null)
  RT.store.selected.set(null)
  RT.ctx.storage.set('boardId', id)
}

export const K = {
  all: ['trello'],
  health: ['trello', 'health'],
  boards: ['trello', 'boards'],
  view: id => ['trello', 'view', id],
  card: id => ['trello', 'card', id]
}

const paneVisible = () => (typeof host.paneVisibility === 'function' ? Boolean(host.paneVisibility(PANE_ID).get()) : true)

/** Polling policy: only while the pane is on screen; plus refetch on window focus. */
function pollOptions() {
  return {
    refetchInterval: () => {
      const { refreshSec } = RT.store.settings.get()

      return refreshSec > 0 && paneVisible() ? refreshSec * 1000 : false
    },
    refetchOnWindowFocus: true,
    retry: (count, err) => count < 1 && !isClientError(err)
  }
}

const useHealth = () => useQuery({ queryKey: K.health, queryFn: () => rest('/health'), ...pollOptions() })
const useBoards = enabled => useQuery({ queryKey: K.boards, queryFn: () => rest('/boards'), enabled, ...pollOptions() })

const useBoardView = boardId =>
  useQuery({
    queryKey: K.view(boardId),
    queryFn: () => rest(`/boards/${seg(boardId)}/view`),
    enabled: Boolean(boardId),
    ...pollOptions()
  })

const useCard = cardId =>
  useQuery({
    queryKey: K.card(cardId),
    queryFn: () => rest(`/cards/${seg(cardId)}`),
    enabled: Boolean(cardId),
    ...pollOptions()
  })

function errorText(t, err) {
  const parsed = parseApiError(err)

  if (parsed.code === 'bad_request' && parsed.message) {
    return parsed.message
  }

  return t(`errors.${errorKey(parsed)}`)
}

/** Every write the pane performs. Optimistic only for checklist toggles and card moves. */
function useCardActions(boardId) {
  const qc = useQueryClient()
  const t = usePluginI18n(ID)

  const refresh = cardId => {
    qc.invalidateQueries({ queryKey: K.view(boardId) })

    if (cardId) {
      qc.invalidateQueries({ queryKey: K.card(cardId) })
    }
  }

  const fail = err => toast('error', errorText(t, err))
  const send = (path, method, body) => rest(path, { method, body })

  const move = useMutation({
    mutationFn: ({ cardId, listId }) => send(`/cards/${seg(cardId)}`, 'PATCH', { id_list: listId }),
    onMutate: async ({ cardId, listId }) => {
      await qc.cancelQueries({ queryKey: K.view(boardId) })
      const prevView = qc.getQueryData(K.view(boardId))
      const prevDetail = qc.getQueryData(K.card(cardId))

      if (prevView) {
        qc.setQueryData(K.view(boardId), withCardMoved(prevView, cardId, listId))
      }

      if (prevDetail) {
        qc.setQueryData(K.card(cardId), withDetailMoved(prevDetail, listId))
      }

      return { prevView, prevDetail }
    },
    onError: (err, { cardId }, rollback) => {
      if (rollback?.prevView) {
        qc.setQueryData(K.view(boardId), rollback.prevView)
      }

      if (rollback?.prevDetail) {
        qc.setQueryData(K.card(cardId), rollback.prevDetail)
      }

      fail(err)
    },
    onSuccess: (_d, { listId }, _r) => {
      const name = qc.getQueryData(K.view(boardId))?.lists?.find(l => l.id === listId)?.name

      if (name) {
        toast('success', t('card.moved', name))
      }
    },
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const toggle = useMutation({
    mutationFn: ({ checklistId, itemId, state }) =>
      send(`/checklists/${seg(checklistId)}/items/${seg(itemId)}`, 'PATCH', { state }),
    onMutate: async ({ cardId, checklistId, itemId, state }) => {
      await qc.cancelQueries({ queryKey: K.card(cardId) })
      const prevDetail = qc.getQueryData(K.card(cardId))
      const prevView = qc.getQueryData(K.view(boardId))
      const { detail } = withItemState(prevDetail, checklistId, itemId, state)

      if (prevDetail && detail) {
        qc.setQueryData(K.card(cardId), detail)

        if (prevView) {
          qc.setQueryData(K.view(boardId), withViewChecklist(prevView, cardId, detail.card.checklist))
        }
      }

      return { prevDetail, prevView }
    },
    onError: (err, { cardId }, rollback) => {
      if (rollback?.prevDetail) {
        qc.setQueryData(K.card(cardId), rollback.prevDetail)
      }

      if (rollback?.prevView) {
        qc.setQueryData(K.view(boardId), rollback.prevView)
      }

      fail(err)
    },
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const patch = useMutation({
    mutationFn: ({ cardId, fields }) => send(`/cards/${seg(cardId)}`, 'PATCH', fields),
    onError: fail,
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const createCard = useMutation({
    mutationFn: ({ listId, name }) => send('/cards', 'POST', { list_id: listId, name }),
    onSuccess: () => toast('success', t('card.created')),
    onError: fail,
    onSettled: () => refresh()
  })

  const comment = useMutation({
    mutationFn: ({ cardId, text }) => send(`/cards/${seg(cardId)}/comments`, 'POST', { text }),
    onError: fail,
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const addChecklist = useMutation({
    mutationFn: ({ cardId, name }) => send(`/cards/${seg(cardId)}/checklists`, 'POST', { name }),
    onError: fail,
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const addItem = useMutation({
    mutationFn: ({ checklistId, name }) => send(`/checklists/${seg(checklistId)}/items`, 'POST', { name }),
    onError: fail,
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const renameItem = useMutation({
    mutationFn: ({ checklistId, itemId, name }) =>
      send(`/checklists/${seg(checklistId)}/items/${seg(itemId)}`, 'PATCH', { name }),
    onError: fail,
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  const deleteItem = useMutation({
    mutationFn: ({ checklistId, itemId }) => send(`/checklists/${seg(checklistId)}/items/${seg(itemId)}`, 'DELETE'),
    onError: fail,
    onSettled: (_d, _e, { cardId }) => refresh(cardId)
  })

  return { move, toggle, patch, createCard, comment, addChecklist, addItem, renameItem, deleteItem }
}

/**
 * Hand a card to the agent. `submit` sends it; otherwise it is only inserted into the
 * composer. `suggest` swaps the block for the "suggest a checklist" prompt.
 * TODO(P3): ctx.llm via slash command (the button then stops needing a turn).
 */
export async function handoffCard(cardId, { submit = false, suggest = false } = {}) {
  const view = queryClient.getQueryData(K.view(RT.store.boardId.get()))
  const summary = view?.cards?.find(c => c.id === cardId)
  let detail = null

  try {
    detail = await queryClient.fetchQuery({
      queryKey: K.card(cardId),
      queryFn: () => rest(`/cards/${seg(cardId)}`),
      staleTime: 10_000
    })
  } catch {
    detail = null
  }

  const card = detail?.card || summary

  if (!card) {
    toast('error', tr('errors.not_found'))

    return { status: 'failed', via: 'none' }
  }

  const listName = view?.lists?.find(l => l.id === card.id_list)?.name || ''
  const block = buildCardBlock({ card, detail, boardName: view?.board?.name || '', listName })
  const text = suggest ? buildSuggestPrompt(block) : block

  if (!detail) {
    toast('warning', tr('send.partial'))
  }

  const sleep = ms => new Promise(resolve => RT.ctx.setTimeout(resolve, ms))
  const result = await deliverToComposer(text, { submit, host, os: RT.ctx.os, sleep })
  const fresh = result.via === 'new-chat'

  if (result.status === 'inserted') {
    toast('success', suggest ? tr('drawer.suggestInserted') : tr(fresh ? 'send.insertedNew' : 'send.inserted'))
  } else if (result.status === 'submitted') {
    toast('success', tr(fresh ? 'send.submittedNew' : 'send.submitted'))
  } else if (result.status === 'copied') {
    toast('info', tr('send.copied'))
  } else {
    RT.store.fallbackBlock.set(text)
    toast('error', tr('send.failed'))
  }

  return result
}

async function copyCardLink(card) {
  const url = card?.url || (card?.short_link ? `https://trello.com/c/${card.short_link}` : '')

  if (url && (await RT.ctx.os.writeClipboard(url))) {
    toast('success', tr('common.linkCopied'))
  }
}

// ---------------------------------------------------------------------------
// 4. Components
// ---------------------------------------------------------------------------

/** jsx()/jsxs() wrapper: a single child goes through jsx(), several through jsxs(). */
function h(type, props, ...kids) {
  const { key, ...rest_ } = props || {}
  const children = kids.filter(k => k !== false && k !== null && k !== undefined)

  if (children.length === 0) {
    return jsx(type, rest_, key)
  }

  if (children.length === 1 && !Array.isArray(children[0])) {
    return jsx(type, { ...rest_, children: children[0] }, key)
  }

  return jsxs(type, { ...rest_, children }, key)
}

const st = (...parts) => Object.assign({}, ...parts)

const FILL = { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }
const ROW = { display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }
const MUTED = { color: 'var(--ui-text-tertiary)' }
const SMALL = { fontSize: '0.6875rem', lineHeight: '1rem' }
const HAIRLINE = '1px solid var(--ui-stroke-tertiary)'
const mix = (cssVar, pct) => `color-mix(in srgb, var(${cssVar}) ${pct}%, transparent)`

function formatDate(iso, withTime = false) {
  const ts = Date.parse(iso)

  if (Number.isNaN(ts)) {
    return ''
  }

  try {
    return new Date(ts).toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric' })
  } catch {
    return new Date(ts).toISOString().slice(0, 10)
  }
}

// -- markdown ---------------------------------------------------------------

function openLink(url) {
  RT.ctx.os.openExternal(url)
}

function renderInline(nodes, prefix) {
  return nodes.map((n, i) => {
    const key = `${prefix}${i}`

    if (n.type === 'text') {
      return h('span', { key }, n.text)
    }

    if (n.type === 'code') {
      return h('code', { key, style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.92em', background: 'var(--ui-bg-tertiary)', borderRadius: '3px', padding: '0 0.25rem' } }, n.text)
    }

    if (n.type === 'bold') {
      return h('strong', { key, style: { fontWeight: 600 } }, ...renderInline(n.children, `${key}.`))
    }

    if (n.type === 'italic') {
      return h('em', { key }, ...renderInline(n.children, `${key}.`))
    }

    return h(
      'a',
      {
        key,
        href: n.url,
        rel: 'noreferrer noopener',
        style: { color: 'var(--ui-accent)', textDecoration: 'underline', cursor: 'pointer' },
        onClick: event => {
          event.preventDefault()
          openLink(n.url)
        }
      },
      n.text
    )
  })
}

/** Safe markdown subset rendered as React elements: never an HTML string. */
function Markdown({ text }) {
  const blocks = parseMarkdown(text)

  return h(
    'div',
    { 'data-trello': 'markdown', style: st(FILL, { gap: '0.5rem', overflowWrap: 'anywhere' }) },
    ...blocks.map((b, i) => {
      if (b.type === 'code') {
        return h('pre', { key: i, style: { margin: 0, padding: '0.5rem', background: 'var(--ui-bg-tertiary)', borderRadius: '6px', fontFamily: 'ui-monospace, monospace', fontSize: '0.6875rem', overflowX: 'auto', whiteSpace: 'pre' } }, b.text)
      }

      if (b.type === 'heading') {
        return h('div', { key: i, style: { fontWeight: 600 } }, ...renderInline(parseInline(b.text), `h${i}.`))
      }

      if (b.type === 'list') {
        return h(
          'ul',
          { key: i, style: { margin: 0, paddingLeft: b.items.some(x => x.checked !== null) ? 0 : '1.1rem', listStyle: b.items.some(x => x.checked !== null) ? 'none' : b.ordered ? 'decimal' : 'disc' } },
          ...b.items.map((item, j) =>
            h(
              'li',
              { key: j, style: { marginBottom: '0.125rem' } },
              item.checked !== null && h('span', { 'aria-hidden': true, style: { marginRight: '0.375rem' } }, item.checked ? '☑' : '☐'),
              ...renderInline(parseInline(item.text), `l${i}.${j}.`)
            )
          )
        )
      }

      return h('div', { key: i, style: { whiteSpace: 'pre-wrap' } }, ...renderInline(parseInline(b.text), `p${i}.`))
    })
  )
}

// -- small pieces -----------------------------------------------------------

function IconButton({ icon, label, onClick, disabled, spinning, children }) {
  return h(
    Tip,
    { label },
    h(Button, { 'aria-label': label, disabled, onClick, size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: icon, spinning: Boolean(spinning) }), children)
  )
}

function LabelMark({ text, boardLabels }) {
  const info = resolveLabel(text, boardLabels)

  if (info.text === null) {
    return h('span', { 'data-trello': 'label-bar', title: text, style: { display: 'inline-block', width: '2.125rem', height: '0.375rem', borderRadius: '3px', background: `var(${info.cssVar})` } })
  }

  return h('span', { 'data-trello': 'label-chip', style: st(SMALL, { display: 'inline-block', maxWidth: '8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: '3px', padding: '0 0.375rem', background: mix(info.cssVar, 24), color: 'var(--ui-text-primary)' }) }, info.text)
}

function Avatars({ ids, members }) {
  const people = ids.map(id => members.find(m => m.id === id)).filter(Boolean).slice(0, 3)

  if (!people.length) {
    return null
  }

  return h(
    'span',
    { style: st(ROW, { marginLeft: 'auto', gap: '0.125rem' }) },
    ...people.map(p => h('span', { key: p.id, title: p.full_name || p.username, style: { width: '1.125rem', height: '1.125rem', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: '0.5625rem', border: HAIRLINE, color: 'var(--ui-text-tertiary)' } }, p.initials || '?'))
  )
}

function DueChip({ card }) {
  const t = usePluginI18n(ID)
  const info = dueInfo(card.due, card.due_complete)

  if (!info) {
    return null
  }

  const cssVar = DUE_VARS[info.kind]
  const title = info.kind === 'overdue' ? t('card.overdue') : info.kind === 'soon' ? t('card.dueSoon') : info.kind === 'done' ? t('card.dueDone') : ''

  return h('span', { 'data-trello': `due-${info.kind}`, title, style: st(SMALL, { border: `1px solid var(${cssVar})`, color: `var(${cssVar})`, borderRadius: '4px', padding: '0 0.3125rem', textDecoration: info.kind === 'done' ? 'line-through' : 'none' }) }, formatDate(card.due))
}

function CardMeta({ card, view }) {
  const { total, done } = card.checklist

  return h(
    'div',
    { style: st(ROW, MUTED, SMALL, { gap: '0.625rem' }) },
    h(DueChip, { card }),
    total > 0 && h('span', { 'data-trello': 'checklist', style: { fontVariantNumeric: 'tabular-nums' } }, `☑ ${done}/${total}`),
    card.comment_count > 0 && h('span', { 'data-trello': 'comments' }, `💬 ${card.comment_count}`),
    card.attachment_count > 0 && h('span', { 'data-trello': 'attachments' }, `📎 ${card.attachment_count}`),
    h(Avatars, { ids: card.id_members, members: view.members })
  )
}

function MoveMenu({ view, card, actions, children }) {
  const t = usePluginI18n(ID)

  return h(
    DropdownMenu,
    null,
    h(DropdownMenuTrigger, { asChild: true }, children),
    h(
      DropdownMenuContent,
      { align: 'end' },
      ...view.lists
        .filter(l => l.id !== card.id_list)
        .map(l => h(DropdownMenuItem, { key: l.id, onSelect: () => actions.move.mutate({ cardId: card.id, listId: l.id }) }, `${t('card.moveTo')}: ${l.name}`))
    )
  )
}

// -- card row ---------------------------------------------------------------

function CardRow({ card, view, actions }) {
  const t = usePluginI18n(ID)
  const selectedId = useValue(RT.store.selected)
  const [hot, setHot] = useState(false)
  const ref = useRef(null)
  const selected = selectedId === card.id

  useEffect(() => {
    if (selected && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ block: 'nearest' })
    }
  }, [selected])

  const open = () => {
    RT.store.selected.set(card.id)
    RT.store.openCard.set(card.id)
  }

  const send = event => {
    haptic('tap')
    handoffCard(card.id, { submit: Boolean(event.shiftKey) || RT.store.settings.get().sendMode === 'submit' })
  }

  return h(
    'article',
    {
      ref,
      'data-trello': 'card',
      'data-card-id': card.id,
      'data-selected': selected ? 'true' : 'false',
      onMouseEnter: () => setHot(true),
      onMouseLeave: () => setHot(false),
      style: st(FILL, { gap: '0.375rem', border: `1px solid ${selected ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'}`, borderRadius: '8px', padding: '0.5rem 0.625rem', background: selected ? mix('--ui-accent', 8) : 'var(--ui-bg-tertiary)' })
    },
    h(
      'button',
      { type: 'button', onClick: open, 'data-trello': 'card-open', style: st(FILL, { gap: '0.375rem', textAlign: 'left', background: 'transparent', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', font: 'inherit' }) },
      h('span', { style: { fontWeight: 500, fontSize: '0.8125rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, card.name),
      card.labels.length > 0 && h('span', { style: st(ROW, { flexWrap: 'wrap', gap: '0.25rem' }) }, ...card.labels.map((l, i) => h(LabelMark, { key: `${l}${i}`, text: l, boardLabels: view.labels }))),
      h(CardMeta, { card, view })
    ),
    (hot || selected) &&
      h(
        'div',
        { style: st(ROW, { gap: '0.25rem' }) },
        h(Tip, { label: t('card.sendHint') }, h(Button, { 'data-trello': 'send', onClick: send, size: 'xs', type: 'button', variant: 'secondary' }, h(Codicon, { name: 'send' }), t('card.sendToAgent'))),
        h(IconButton, { icon: 'link-external', label: t('common.openInTrello'), onClick: () => card.url && openLink(card.url) }),
        h(
          MoveMenu,
          { view, card, actions },
          h(Button, { 'aria-label': t('card.menu'), size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'ellipsis' }))
        )
      )
  )
}

function AddCard({ listId, actions }) {
  const t = usePluginI18n(ID)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  if (!open) {
    return h(Button, { 'data-trello': 'add-card', onClick: () => setOpen(true), size: 'xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'add' }), t('card.add'))
  }

  const submit = () => {
    const title = name.trim()

    if (title) {
      actions.createCard.mutate({ listId, name: title })
      setName('')
      setOpen(false)
    }
  }

  return h(
    'div',
    { style: st(ROW, { gap: '0.25rem' }) },
    h(Input, { autoFocus: true, 'aria-label': t('card.addPlaceholder'), onChange: e => setName(e.target.value), onKeyDown: e => { if (isSubmitEnter(e)) submit(); else if (e.key === 'Escape') setOpen(false) }, placeholder: t('card.addPlaceholder'), value: name }),
    h(Button, { onClick: submit, size: 'xs', type: 'button' }, t('common.add'))
  )
}

// -- board layouts ----------------------------------------------------------

function ListFocus({ view, actions }) {
  const t = usePluginI18n(ID)
  const listId = useValue(RT.store.listId)
  const grouped = cardsByList(view)
  const active = grouped.has(listId) ? listId : view.lists[0].id
  const cards = grouped.get(active) || []

  return h(
    'div',
    { 'data-trello': 'list-focus', style: st(FILL, { flex: 1 }) },
    h(
      'div',
      { 'aria-label': t('board.lists'), role: 'tablist', style: st(ROW, { gap: '0.375rem', padding: '0.5rem 0.75rem', overflowX: 'auto', borderBottom: HAIRLINE, flexShrink: 0 }) },
      ...view.lists.map(l => {
        const on = l.id === active

        return h(
          'button',
          { key: l.id, 'aria-selected': on, 'data-trello': 'chip', onClick: () => RT.store.listId.set(l.id), role: 'tab', type: 'button', style: st({ whiteSpace: 'nowrap', cursor: 'pointer', font: 'inherit', fontSize: '0.75rem', borderRadius: '999px', padding: '0.125rem 0.625rem', color: on ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)', border: `1px solid ${on ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'}`, background: on ? mix('--ui-accent', 15) : 'transparent' }) },
          l.name,
          h('b', { style: { marginLeft: '0.25rem', opacity: 0.75, fontWeight: 600 } }, (grouped.get(l.id) || []).length)
        )
      })
    ),
    h(
      'div',
      { style: st(FILL, { flex: 1, overflowY: 'auto', padding: '0.625rem 0.75rem', gap: '0.4375rem' }) },
      cards.length === 0 && h(EmptyState, { description: t('board.emptyList'), title: view.lists.find(l => l.id === active).name }),
      ...cards.map(c => h(CardRow, { key: c.id, card: c, view, actions })),
      h(AddCard, { key: `add-${active}`, listId: active, actions })
    )
  )
}

function Columns({ view, actions, width }) {
  const grouped = cardsByList(view)
  const w = laneWidth(width, view.lists.length)

  return h(
    'div',
    { 'data-trello': 'columns', style: st({ flex: 1, minHeight: 0, display: 'flex', gap: '0.625rem', padding: '0.75rem', overflowX: 'auto', alignItems: 'stretch' }) },
    ...view.lists.map(l => {
      const cards = grouped.get(l.id) || []

      return h(
        'section',
        { key: l.id, 'data-trello': 'lane', 'data-lane-width': w, style: st(FILL, { flex: '0 0 auto', width: `${w}px`, border: HAIRLINE, borderRadius: '9px', background: mix('--ui-text-primary', 4) }) },
        h('header', { style: st(ROW, { justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 1, padding: '0.5rem 0.625rem', fontSize: '0.75rem', background: 'var(--ui-bg-elevated)', borderBottom: HAIRLINE, borderRadius: '9px 9px 0 0' }) }, h('b', { className: 'truncate', style: { fontWeight: 600 } }, l.name), h('span', { style: st(MUTED, { fontVariantNumeric: 'tabular-nums' }) }, cards.length)),
        h('div', { style: st(FILL, { flex: 1, overflowY: 'auto', padding: '0.5rem', gap: '0.4375rem' }) }, ...cards.map(c => h(CardRow, { key: c.id, card: c, view, actions })), h(AddCard, { listId: l.id, actions }))
      )
    })
  )
}

function Strip({ icon, children }) {
  return h('div', { 'data-trello': 'strip', role: 'status', style: st(ROW, SMALL, MUTED, { padding: '0.25rem 0.75rem', borderBottom: HAIRLINE, background: mix('--ui-yellow', 10), flexShrink: 0 }) }, h(Codicon, { name: icon }), children)
}

/** Error body: connection problems get their own copy; credential problems get the form. */
function BackendError({ error, onRetry }) {
  const t = usePluginI18n(ID)
  const parsed = parseApiError(error)

  if (parsed.code === 'not_connected') {
    return h(ConnectView, { rejected: false })
  }

  if (parsed.code === 'credentials_rejected') {
    return h(ConnectView, { rejected: true })
  }

  const copy = errorCopy(t, parsed)

  return h('div', { 'data-trello': 'error', 'data-trello-error': parsed.code, style: { padding: '1rem' } }, h(ErrorState, { description: copy.description, title: copy.title, children: h(Button, { 'data-trello': 'retry', onClick: onRetry, size: 'xs', type: 'button', variant: 'outline' }, t('common.retry')) }))
}

function BodySkeleton() {
  return h('div', { 'data-trello': 'skeleton', style: st(FILL, { gap: '0.5rem', padding: '0.75rem' }) }, ...[0, 1, 2, 3].map(i => h(Skeleton, { key: i, style: { height: '3.5rem', borderRadius: '8px' } })))
}

function BoardBody({ boardId, mode, width, actions }) {
  const t = usePluginI18n(ID)
  const q = useBoardView(boardId)
  const view = q.data
  const listId = useValue(RT.store.listId)
  const grouped = cardsByList(view)
  const active = grouped.has(listId) ? listId : view?.lists?.[0]?.id || null

  useEffect(() => {
    RT.store.visibleIds.set(view ? visibleCardIds(view, mode, active) : [])
  }, [view, mode, active])

  if (!view) {
    if (q.isError) {
      return h(BackendError, { error: q.error, onRetry: () => q.refetch() })
    }

    return h(BodySkeleton, null)
  }

  const parsed = q.isError ? parseApiError(q.error) : null

  return h(
    'div',
    { style: st(FILL, { flex: 1 }) },
    parsed && (parsed.code === 'rate_limited' ? h(Strip, { icon: 'clock' }, t('status.rateLimited')) : h(Strip, { icon: 'warning' }, h('span', { 'data-trello': 'stale' }, t('status.stale')), h(Button, { onClick: () => q.refetch(), size: 'xs', type: 'button', variant: 'text' }, t('common.retry')))),
    view.lists.length === 0 ? h(EmptyState, { description: t('board.emptyBoard'), title: view.board.name }) : mode === 'columns' ? h(Columns, { view, actions, width }) : h(ListFocus, { view, actions })
  )
}

// -- header: board picker + settings ---------------------------------------

function BoardPicker({ boards, boardId }) {
  const t = usePluginI18n(ID)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = boards.find(b => b.id === boardId)
  const shown = filterBoards(boards, query)

  return h(
    Popover,
    { onOpenChange: setOpen, open },
    h(PopoverTrigger, { asChild: true }, h(Button, { 'aria-label': t('board.pick'), 'data-trello': 'board-picker', size: 'sm', type: 'button', variant: 'ghost' }, h('span', { className: 'truncate', style: { fontWeight: 600, maxWidth: '12rem' } }, current ? current.name : t('board.pick')), h(Codicon, { name: 'chevron-down' }))),
    h(
      PopoverContent,
      { align: 'start', style: { width: '16rem' } },
      h(SearchField, { onChange: setQuery, placeholder: t('board.search'), value: query }),
      h(
        'div',
        { style: st(FILL, { maxHeight: '16rem', overflowY: 'auto', marginTop: '0.375rem', gap: '0.125rem' }) },
        shown.length === 0 && h('div', { style: st(MUTED, SMALL, { padding: '0.5rem' }) }, boards.length ? t('board.noMatch') : t('board.noBoards')),
        ...shown.map(b =>
          h(
            'button',
            { key: b.id, 'data-trello': 'board-option', onClick: () => { selectBoard(b.id); setOpen(false); setQuery('') }, type: 'button', style: st(ROW, { textAlign: 'left', cursor: 'pointer', font: 'inherit', fontSize: '0.75rem', padding: '0.3125rem 0.5rem', borderRadius: '5px', border: 0, background: b.id === boardId ? mix('--ui-accent', 15) : 'transparent', color: 'var(--ui-text-primary)' }) },
            b.starred && h(Codicon, { name: 'star-full', style: { color: 'var(--ui-yellow)' } }),
            h('span', { className: 'truncate' }, b.name)
          )
        )
      )
    )
  )
}

function SettingsPanel({ boards, member, onDisconnect }) {
  const t = usePluginI18n(ID)
  const settings = useValue(RT.store.settings)
  const board = boards.find(b => b.id === settings.defaultBoard)

  return h(
    'div',
    { 'data-trello': 'settings', style: st(FILL, { gap: '0.75rem' }) },
    h('div', { style: { fontWeight: 600 } }, t('settings.title')),
    member && h('div', { style: st(MUTED, SMALL) }, t('settings.connectedAs', member.username)),
    h('div', { style: st(FILL, { gap: '0.25rem' }) }, h('span', { style: SMALL }, t('settings.sendMode')), h(SegmentedControl, { onChange: id => setSettings({ sendMode: id }), options: [{ id: 'insert', label: t('settings.sendInsert') }, { id: 'submit', label: t('settings.sendSubmit') }], value: settings.sendMode }), h('span', { style: st(MUTED, SMALL) }, t('settings.sendModeHint'))),
    h('div', { style: st(FILL, { gap: '0.25rem' }) }, h('span', { style: SMALL }, t('settings.refresh')), h(SegmentedControl, { onChange: id => setSettings({ refreshSec: Number(id) }), options: REFRESH_CHOICES.map(n => ({ id: String(n), label: n === 0 ? t('settings.refreshOff') : t('settings.refreshSeconds', n) })), value: String(settings.refreshSec) })),
    h(
      'div',
      { style: st(FILL, { gap: '0.25rem' }) },
      h('span', { style: SMALL }, t('settings.defaultBoard')),
      h(
        DropdownMenu,
        null,
        h(DropdownMenuTrigger, { asChild: true }, h(Button, { 'data-trello': 'default-board', size: 'sm', type: 'button', variant: 'outline' }, board ? board.name : t('settings.defaultBoardLast'), h(Codicon, { name: 'chevron-down' }))),
        h(DropdownMenuContent, { align: 'start' }, h(DropdownMenuItem, { onSelect: () => setSettings({ defaultBoard: null }) }, t('settings.defaultBoardLast')), h(DropdownMenuSeparator, null), ...boards.map(b => h(DropdownMenuItem, { key: b.id, onSelect: () => setSettings({ defaultBoard: b.id }) }, b.name)))
      )
    ),
    h(Separator, null),
    h(Button, { 'data-trello': 'disconnect', onClick: onDisconnect, size: 'sm', type: 'button', variant: 'destructive' }, t('settings.disconnect'))
  )
}

function Header({ boards, boardId, member, fetching, onRefresh }) {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const disconnect = async () => {
    try {
      await rest('/credentials', { method: 'DELETE' })
    } catch (err) {
      // A 204 has no body; only a real HTTP failure aborts the disconnect.
      if (parseApiError(err).status >= 400) {
        throw new Error(errorText(t, err))
      }
    }

    RT.ctx.storage.remove('boardId')
    RT.store.boardId.set(null)
    RT.store.openCard.set(null)
    qc.setQueryData(K.health, { connected: false, member: null, source: null })
    qc.invalidateQueries({ queryKey: K.health })
    toast('info', t('settings.disconnected'))
  }

  return h(
    'header',
    { style: st(ROW, { padding: '0.375rem 0.5rem', borderBottom: HAIRLINE, flexShrink: 0 }) },
    h(BoardPicker, { boards, boardId }),
    h('span', { style: { flex: 1 } }),
    h(IconButton, { icon: 'refresh', label: t('common.refresh'), onClick: onRefresh, spinning: fetching }),
    h(
      Popover,
      { onOpenChange: setSettingsOpen, open: settingsOpen },
      h(PopoverTrigger, { asChild: true }, h(Button, { 'aria-label': t('common.settings'), 'data-trello': 'settings-button', size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'gear' }))),
      h(PopoverContent, { align: 'end', style: { width: '18rem' } }, h(SettingsPanel, { boards, member, onDisconnect: () => { setSettingsOpen(false); setConfirm(true) } }))
    ),
    h(ConfirmDialog, { confirmLabel: t('settings.disconnect'), description: t('settings.disconnectBody'), destructive: true, onClose: () => setConfirm(false), onConfirm: disconnect, open: confirm, title: t('settings.disconnectTitle') })
  )
}

// -- drawer -----------------------------------------------------------------

function SectionTitle({ children }) {
  return h('div', { style: st(MUTED, { fontSize: '0.625rem', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: '0.25rem' }) }, children)
}

function InlineAdd({ label, placeholder, onSubmit, busy }) {
  const [value, setValue] = useState('')

  const submit = () => {
    const text = value.trim()

    if (text) {
      onSubmit(text)
      setValue('')
    }
  }

  return h(
    'div',
    { style: st(ROW, { gap: '0.25rem' }) },
    h(Input, { 'aria-label': placeholder, disabled: busy, onChange: e => setValue(e.target.value), onKeyDown: e => { if (isSubmitEnter(e)) submit() }, placeholder, value }),
    h(Button, { disabled: busy || !value.trim(), onClick: submit, size: 'xs', type: 'button', variant: 'secondary' }, label)
  )
}

function ItemRow({ cardId, checklist, item, actions }) {
  const t = usePluginI18n(ID)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.name)
  const done = item.state === 'complete'

  const save = () => {
    const name = draft.trim()
    setEditing(false)

    if (name && name !== item.name) {
      actions.renameItem.mutate({ cardId, checklistId: checklist.id, itemId: item.id, name })
    }
  }

  return h(
    'div',
    { 'data-trello': 'item', 'data-state': item.state, style: st(ROW, { alignItems: 'flex-start', padding: '0.125rem 0' }) },
    h(Checkbox, { 'aria-label': item.name, checked: done, onCheckedChange: value => actions.toggle.mutate({ cardId, checklistId: checklist.id, itemId: item.id, state: value ? 'complete' : 'incomplete' }) }),
    editing
      ? h(Input, { autoFocus: true, 'aria-label': t('drawer.renameItem'), onBlur: save, onChange: e => setDraft(e.target.value), onKeyDown: e => { if (isSubmitEnter(e)) save(); else if (e.key === 'Escape') { setDraft(item.name); setEditing(false) } }, value: draft })
      : h('span', { onDoubleClick: () => { setDraft(item.name); setEditing(true) }, style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', cursor: 'text', textDecoration: done ? 'line-through' : 'none', color: done ? 'var(--ui-text-tertiary)' : 'inherit' } }, item.name),
    h(IconButton, { icon: 'edit', label: t('drawer.renameItem'), onClick: () => { setDraft(item.name); setEditing(true) } }),
    h(IconButton, { icon: 'trash', label: t('drawer.deleteItem'), onClick: () => actions.deleteItem.mutate({ cardId, checklistId: checklist.id, itemId: item.id }) })
  )
}

function ChecklistSection({ detail, cardId, actions }) {
  const t = usePluginI18n(ID)

  return h(
    'section',
    { 'data-trello': 'checklists' },
    h(SectionTitle, null, t('drawer.checklists')),
    detail.checklists.length === 0 && h('div', { style: st(MUTED, SMALL) }, t('drawer.noChecklists')),
    ...detail.checklists.map(cl => {
      const done = cl.items.filter(i => i.state === 'complete').length

      return h(
        'div',
        { key: cl.id, 'data-trello': 'checklist', style: st(FILL, { gap: '0.125rem', marginBottom: '0.625rem' }) },
        h('div', { style: st(ROW, { justifyContent: 'space-between', fontWeight: 600, fontSize: '0.75rem' }) }, h('span', null, cl.name), h('span', { style: st(MUTED, { fontVariantNumeric: 'tabular-nums' }) }, `${done}/${cl.items.length}`)),
        ...cl.items.map(item => h(ItemRow, { key: item.id, actions, cardId, checklist: cl, item })),
        h(InlineAdd, { busy: actions.addItem.isPending, label: t('drawer.addItem'), onSubmit: name => actions.addItem.mutate({ cardId, checklistId: cl.id, name }), placeholder: t('drawer.itemPlaceholder') })
      )
    }),
    h(InlineAdd, { busy: actions.addChecklist.isPending, label: t('drawer.addChecklist'), onSubmit: name => actions.addChecklist.mutate({ cardId, name }), placeholder: t('drawer.checklistName') })
  )
}

function CommentsSection({ detail, cardId, actions }) {
  const t = usePluginI18n(ID)
  const [text, setText] = useState('')

  const post = () => {
    const body = text.trim()

    if (body) {
      actions.comment.mutate({ cardId, text: body }, { onSuccess: () => setText('') })
    }
  }

  return h(
    'section',
    { 'data-trello': 'comments' },
    h(SectionTitle, null, t('drawer.comments')),
    h(
      'div',
      { style: st(FILL, { gap: '0.375rem' }) },
      h(Textarea, { 'aria-label': t('drawer.commentPlaceholder'), onChange: e => setText(e.target.value), placeholder: t('drawer.commentPlaceholder'), rows: 2, value: text }),
      h('div', null, h(Button, { disabled: actions.comment.isPending || !text.trim(), onClick: post, size: 'xs', type: 'button', variant: 'secondary' }, t('drawer.postComment'))),
      detail.comments.length === 0 && h('div', { style: st(MUTED, SMALL) }, t('drawer.noComments')),
      ...detail.comments.map(c =>
        h(
          'div',
          { key: c.id, 'data-trello': 'comment', style: st(FILL, { gap: '0.125rem', border: HAIRLINE, borderRadius: '7px', padding: '0.375rem 0.5rem' }) },
          h('div', { style: st(ROW, SMALL, { justifyContent: 'space-between' }) }, h('b', { style: { fontWeight: 600 } }, c.author || '?'), h('span', { style: MUTED }, formatDate(c.date, true))),
          h(Markdown, { text: c.text })
        )
      )
    )
  )
}

function AttachmentsSection({ detail }) {
  const t = usePluginI18n(ID)

  return h(
    'section',
    { 'data-trello': 'attachments' },
    h(SectionTitle, null, t('drawer.attachments')),
    detail.attachments.length === 0 && h('div', { style: st(MUTED, SMALL) }, t('drawer.noAttachments')),
    ...detail.attachments.map(a =>
      h(
        'div',
        { key: a.id, style: st(ROW, { justifyContent: 'space-between' }) },
        h('span', { className: 'truncate' }, a.name || a.url || '?'),
        a.url && h(IconButton, { icon: 'link-external', label: `${t('drawer.openAttachment')}: ${a.name}`, onClick: () => openLink(a.url) })
      )
    )
  )
}

function ActivityRow({ row }) {
  const t = usePluginI18n(ID)
  const icon = ACTIVITY_ICONS[row.type] || 'circle-small'
  const ago = relativeAgo(row.date)

  return h(
    'div',
    { 'data-trello': 'activity-row', 'data-trello-type': row.type, style: st(ROW, { alignItems: 'flex-start', padding: '0.1875rem 0' }) },
    h('span', { 'aria-hidden': true, style: st(MUTED, { flexShrink: 0, paddingTop: '0.0625rem' }) }, h(Codicon, { name: icon })),
    h(
      'div',
      { style: st(FILL, { flex: 1 }) },
      h('div', { style: st(SMALL, MUTED) }, `${row.author || t('drawer.unknownAuthor')}${ago ? ` · ${ago}` : ''}`),
      row.text && h('div', { style: { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', fontSize: '0.75rem' } }, row.text)
    )
  )
}

function ActivitySection({ card, detail }) {
  const t = usePluginI18n(ID)
  const rows = activityRows(detail)

  return h(
    'section',
    { 'data-trello': 'activity' },
    h(SectionTitle, null, t('drawer.activity')),
    h(
      'div',
      { style: st(FILL, { gap: '0.0625rem' }) },
      rows.length === 0 && h('span', { style: st(SMALL, MUTED) }, card.last_activity ? t('drawer.lastActivity', formatDate(card.last_activity, true)) : t('drawer.noActivity')),
      ...rows.map(row => h(ActivityRow, { key: row.id, row }))
    )
  )
}

function LabelEditor({ view, card, actions }) {
  const t = usePluginI18n(ID)
  const choices = labelChoices(view.labels, card.label_ids)

  const toggle = id => actions.patch.mutate({ cardId: card.id, fields: { id_labels: toggleLabelIds(choices, id) } })

  return h(
    Popover,
    null,
    h(PopoverTrigger, { asChild: true }, h(Button, { 'data-trello': 'labels-button', size: 'xs', type: 'button', variant: 'outline' }, h(Codicon, { name: 'tag' }), t('drawer.labels'))),
    h(
      PopoverContent,
      { align: 'start', style: { width: '15rem' } },
      choices.length === 0 && h('div', { style: st(MUTED, SMALL) }, t('drawer.noLabels')),
      ...choices.map(c =>
        h(
          'label',
          { key: c.id, style: st(ROW, { padding: '0.1875rem 0' }) },
          h(Checkbox, { 'aria-label': c.key, checked: c.checked, onCheckedChange: () => toggle(c.id) }),
          h('span', { style: { width: '0.75rem', height: '0.75rem', borderRadius: '3px', background: `var(${labelColorVar(c.label.color)})` } }),
          h('span', { className: 'truncate' }, c.label.name || c.label.color || '')
        )
      )
    )
  )
}

function Drawer({ cardId, view, actions }) {
  const t = usePluginI18n(ID)
  const q = useCard(cardId)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const detail = q.data
  const card = detail ? detail.card : view.cards.find(c => c.id === cardId)
  const close = () => RT.store.openCard.set(null)

  const frame = children =>
    h(
      'aside',
      { 'aria-label': card ? card.name : t('drawer.loading'), 'data-trello': 'drawer', style: st(FILL, { position: 'absolute', top: 0, right: 0, bottom: 0, width: '86%', maxWidth: '25rem', minWidth: 'min(18.75rem, 100%)', zIndex: 5, background: 'var(--ui-bg-elevated)', borderLeft: HAIRLINE, boxShadow: '-18px 0 30px -20px var(--ui-text-quaternary)' }) },
      children
    )

  if (!card) {
    return frame(
      h(
        'div',
        { style: st(FILL, { padding: '0.75rem', gap: '0.5rem' }) },
        h('div', { style: ROW }, h('span', { style: { flex: 1 } }), h(IconButton, { icon: 'close', label: t('drawer.close'), onClick: close })),
        q.isError ? h(ErrorState, { ...errorCopy(t, parseApiError(q.error)), children: h(Button, { onClick: () => q.refetch(), size: 'xs', type: 'button', variant: 'outline' }, t('common.retry')) }) : h(BodySkeleton, null)
      )
    )
  }

  const list = view.lists.find(l => l.id === card.id_list)

  const archive = async () => {
    try {
      await actions.patch.mutateAsync({ cardId: card.id, fields: { closed: true } })
    } catch (err) {
      throw new Error(errorText(t, err))
    }

    close()
    toast('success', t('card.archived'))
  }

  return frame(
    h(
      'div',
      { style: st(FILL, { flex: 1 }) },
      h(
        'header',
        { style: st(FILL, { gap: '0.125rem', padding: '0.625rem 0.75rem', borderBottom: HAIRLINE, flexShrink: 0 }) },
        h('div', { style: st(ROW, { alignItems: 'flex-start' }) }, h('div', { 'data-trello': 'drawer-title', style: { flex: 1, minWidth: 0, fontWeight: 600, overflowWrap: 'anywhere' } }, card.name), h(IconButton, { icon: 'close', label: t('drawer.close'), onClick: close })),
        h('div', { style: st(MUTED, SMALL, { overflowWrap: 'anywhere' }) }, `${view.board.name} · ${list ? list.name : '—'} · `, h('a', { href: card.url, onClick: e => { e.preventDefault(); card.url && openLink(card.url) }, rel: 'noreferrer noopener', style: { color: 'var(--ui-accent)', cursor: 'pointer' } }, card.short_link ? `trello.com/c/${card.short_link}` : '—'))
      ),
      h(
        'div',
        { style: st(FILL, { flex: 1, overflowY: 'auto', padding: '0.625rem 0.75rem', gap: '0.875rem' }) },
        h(
          'div',
          { 'data-trello': 'drawer-controls', style: st(ROW, { flexWrap: 'wrap', gap: '0.375rem' }) },
          h(MoveMenu, { view, card, actions }, h(Button, { 'data-trello': 'move-button', size: 'xs', type: 'button', variant: 'outline' }, list ? list.name : t('card.moveTo'), h(Codicon, { name: 'chevron-down' }))),
          h(LabelEditor, { view, card, actions }),
          h('label', { style: st(ROW, SMALL, { gap: '0.25rem' }) }, t('drawer.due'), h('input', { key: card.due || 'none', 'aria-label': t('drawer.due'), 'data-trello': 'due-input', defaultValue: dueToInput(card.due), onChange: e => actions.patch.mutate({ cardId: card.id, fields: { due: inputToDue(e.target.value) } }), style: { font: 'inherit', fontSize: '0.75rem', background: 'transparent', color: 'inherit', border: HAIRLINE, borderRadius: '4px', padding: '0 0.25rem' }, type: 'date' })),
          card.due && h(Button, { onClick: () => actions.patch.mutate({ cardId: card.id, fields: { due: null } }), size: 'xs', type: 'button', variant: 'text' }, t('drawer.clearDue'))
        ),
        card.labels.length > 0 && h('div', { style: st(ROW, { flexWrap: 'wrap', gap: '0.25rem' }) }, ...card.labels.map((l, i) => h(LabelMark, { key: `${l}${i}`, text: l, boardLabels: view.labels }))),
        !detail
          ? q.isError
            ? h(Strip, { icon: 'warning' }, errorText(t, q.error))
            : h(BodySkeleton, null)
          : h(
              'div',
              { style: st(FILL, { gap: '0.875rem' }) },
              h('section', { 'data-trello': 'description' }, h(SectionTitle, null, t('drawer.description')), detail.desc.trim() ? h(Markdown, { text: detail.desc }) : h('div', { style: st(MUTED, SMALL) }, t('drawer.noDescription'))),
              h(ChecklistSection, { actions, cardId: card.id, detail }),
              h(CommentsSection, { actions, cardId: card.id, detail }),
              h(AttachmentsSection, { detail }),
              h(ActivitySection, { card, detail })
            )
      ),
      h(
        'footer',
        { style: st(ROW, { flexWrap: 'wrap', gap: '0.375rem', padding: '0.5rem 0.75rem', borderTop: HAIRLINE, flexShrink: 0 }) },
        h(Tip, { label: t('card.sendHint') }, h(Button, { 'data-trello': 'drawer-send', onClick: e => handoffCard(card.id, { submit: Boolean(e.shiftKey) || RT.store.settings.get().sendMode === 'submit' }), size: 'sm', type: 'button' }, h(Codicon, { name: 'send' }), t('card.sendToAgent'))),
        // TODO(P3): ctx.llm via slash command. Today this only inserts a prepared prompt.
        h(Button, { 'data-trello': 'suggest', onClick: () => handoffCard(card.id, { suggest: true }), size: 'sm', type: 'button', variant: 'outline' }, h(Codicon, { name: 'sparkle' }), t('drawer.suggest')),
        h(Button, { onClick: () => card.url && openLink(card.url), size: 'sm', type: 'button', variant: 'outline' }, h(Codicon, { name: 'link-external' }), t('common.openInTrello')),
        h(IconButton, { icon: 'link', label: t('common.copyLink'), onClick: () => copyCardLink(card) }),
        h(Button, { 'data-trello': 'archive', onClick: () => setArchiveOpen(true), size: 'sm', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'archive' }), t('drawer.archive'))
      ),
      h(ConfirmDialog, { confirmLabel: t('drawer.archive'), description: t('drawer.archiveBody'), destructive: true, onClose: () => setArchiveOpen(false), onConfirm: archive, open: archiveOpen, title: t('drawer.archiveTitle') })
    )
  )
}

// -- connect form -----------------------------------------------------------

function ConnectView({ rejected }) {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  const connect = useMutation({
    mutationFn: body => rest('/credentials', { method: 'POST', body }),
    onSuccess: res => {
      setApiKey('')
      setToken('')
      setError('')
      toast('success', t('connect.connectedAs', res?.member?.username || ''))

      // Nothing from a previous account may survive: drop every cached Trello payload
      // (none is on screen while the connect form is up), then re-check the connection.
      qc.removeQueries({ queryKey: K.boards })
      qc.removeQueries({ queryKey: ['trello', 'view'] })
      qc.removeQueries({ queryKey: ['trello', 'card'] })
      qc.invalidateQueries({ queryKey: K.all })
    },
    onError: err => {
      const parsed = parseApiError(err)
      setError(parsed.message || t(`errors.${errorKey(parsed)}`))
    }
  })

  const ready = apiKey.trim().length > 0 && token.trim().length > 0

  const submit = () => {
    if (ready && !connect.isPending) {
      connect.mutate({ api_key: apiKey.trim(), token: token.trim() })
    }
  }

  return h(
    'div',
    { 'data-trello': 'connect', style: st(FILL, { gap: '0.625rem', padding: '1rem' }) },
    h(EmptyState, { className: 'min-h-0', description: t('connect.intro'), title: t('connect.title') }),
    rejected && h('div', { 'data-trello': 'rejected', role: 'alert', style: st(SMALL, { color: 'var(--ui-red)' }) }, t('connect.rejected')),
    h('div', { style: st(MUTED, SMALL) }, t('connect.steps')),
    h(Button, { onClick: () => openLink(TRELLO_ADMIN_URL), size: 'xs', type: 'button', variant: 'text' }, h(Codicon, { name: 'link-external' }), t('connect.openAdmin')),
    h(Input, { 'aria-label': t('connect.apiKey'), 'data-trello': 'api-key', onChange: e => setApiKey(e.target.value), onKeyDown: e => { if (isSubmitEnter(e)) submit() }, placeholder: t('connect.apiKey'), value: apiKey }),
    h(Input, { 'aria-label': t('connect.token'), 'data-trello': 'token', onChange: e => setToken(e.target.value), onKeyDown: e => { if (isSubmitEnter(e)) submit() }, placeholder: t('connect.token'), type: 'password', value: token }),
    error && h('div', { 'data-trello': 'connect-error', role: 'alert', style: st(SMALL, { color: 'var(--ui-red)' }) }, error),
    h('div', null, h(Button, { 'data-trello': 'connect-submit', disabled: !ready || connect.isPending, onClick: submit, type: 'button' }, connect.isPending ? t('connect.connecting') : t('connect.connect')))
  )
}

// -- workspace + pane root --------------------------------------------------

function FallbackDialog() {
  const t = usePluginI18n(ID)
  const block = useValue(RT.store.fallbackBlock)

  return h(
    ConfirmDialog,
    { confirmLabel: t('common.close'), description: t('send.fallbackBody'), onClose: () => RT.store.fallbackBlock.set(null), onConfirm: () => {}, open: Boolean(block), title: t('send.fallbackTitle') },
    block && h('div', { style: st(FILL, { gap: '0.375rem' }) }, h(Textarea, { 'aria-label': t('send.fallbackTitle'), readOnly: true, rows: 8, value: block }), h('div', null, h(CopyButton, { appearance: 'button', label: t('common.copyLink'), text: block })))
  )
}

function Workspace({ health, width, mode }) {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const settings = useValue(RT.store.settings)
  const storedBoard = useValue(RT.store.boardId)
  const boardsQ = useBoards(true)
  const boards = sortBoards(boardsQ.data)
  const boardId = resolveBoardId(boards, storedBoard, settings.defaultBoard)
  const viewQ = useBoardView(boardId)
  const actions = useCardActions(boardId)
  const openId = useValue(RT.store.openCard)

  useEffect(() => {
    if (boardId && boardId !== storedBoard) {
      RT.store.boardId.set(boardId)
    }
  }, [boardId, storedBoard])

  const onKeyDown = event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    // Portaled popovers/dialogs bubble React events through us: only handle our own DOM.
    if (!event.currentTarget.contains(event.target) || isTypingTarget(event.target)) {
      return
    }

    const store = RT.store
    const current = store.selected.get()
    const view = queryClient.getQueryData(K.view(store.boardId.get()))
    const card = view?.cards?.find(c => c.id === current)

    if (event.key === 'j' || event.key === 'k') {
      const next = stepSelection(store.visibleIds.get(), current, event.key === 'j' ? 1 : -1)

      if (next) {
        store.selected.set(next)
        event.preventDefault()
      }
    } else if (event.key === 'Enter' && event.target === event.currentTarget && current) {
      store.openCard.set(current)
      event.preventDefault()
    } else if (event.key === 'Escape' && store.openCard.get()) {
      store.openCard.set(null)
      event.preventDefault()
    } else if (event.key === 's' && card) {
      handoffCard(card.id, { submit: store.settings.get().sendMode === 'submit' })
      event.preventDefault()
    } else if (event.key === 'c' && card) {
      copyCardLink(card)
      event.preventDefault()
    }
  }

  let body

  if (boardsQ.isPending && !boardsQ.data) {
    body = h(BodySkeleton, null)
  } else if (boardsQ.isError && !boardsQ.data) {
    body = h(BackendError, { error: boardsQ.error, onRetry: () => boardsQ.refetch() })
  } else if (!boardId) {
    body = h(EmptyState, { description: t('board.noBoards'), title: t('board.pick') })
  } else {
    body = h(BoardBody, { actions, boardId, mode, width })
  }

  return h(
    'div',
    { 'data-trello': 'workspace', onKeyDown, tabIndex: 0, style: st(FILL, { flex: 1, outline: 'none', position: 'relative' }) },
    h(Header, { boardId, boards, fetching: viewQ.isFetching, member: health.member, onRefresh: () => qc.invalidateQueries({ queryKey: K.all }) }),
    body,
    openId && viewQ.data && h(Drawer, { key: openId, actions, cardId: openId, view: viewQ.data }),
    h(FallbackDialog, null)
  )
}

/** The pane: measures itself, gates on the connection, then shows the workspace. */
export function PaneRoot() {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  const health = useHealth()

  useEffect(() => {
    const el = ref.current

    if (!el) {
      return undefined
    }

    const measure = value => setWidth(Math.round(value))
    measure(el.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }

    const observer = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      measure(entry && entry.contentRect ? entry.contentRect.width : el.getBoundingClientRect().width)
    })

    observer.observe(el)

    return () => observer.disconnect()
  }, [])

  // Revealing the pane refreshes it once (no timers involved).
  useEffect(() => {
    if (typeof host.paneVisibility !== 'function') {
      return undefined
    }

    return host.paneVisibility(PANE_ID).listen(visible => {
      if (visible) {
        qc.invalidateQueries({ queryKey: K.all })
      }
    })
  }, [qc])

  const mode = modeForWidth(width)
  const data = health.data
  let content

  if (health.isPending && !data) {
    content = h(BodySkeleton, null)
  } else if (health.isError && !data) {
    content = h(BackendError, { error: health.error, onRetry: () => health.refetch() })
  } else if (!data.connected) {
    content = h(ConnectView, { rejected: data.error === 'credentials_rejected' })
  } else {
    content = h(Workspace, { health: data, mode, width })
  }

  return h('div', { ref, 'data-trello-pane': mode, 'data-trello-width': width, style: st(FILL, { height: '100%', width: '100%', position: 'relative', overflow: 'hidden', fontSize: '0.8125rem' }) }, content)
}

// -- transcript directive: ::trello{card="<shortLink|id>"} -------------------

/** A live chip for one card, rendered inline in an assistant message. */
export function CardChip({ attrs, source }) {
  const t = usePluginI18n(ID)
  const ref = directiveCardRef(attrs)

  const q = useQuery({
    queryKey: ['trello', 'chip', ref],
    queryFn: () => rest(`/cards/${seg(ref)}`),
    enabled: ref !== null,
    retry: false,
    staleTime: 15000
  })

  const box = { display: 'inline-flex', alignItems: 'center', gap: '0.375rem', maxWidth: '100%', minWidth: 0, border: HAIRLINE, borderRadius: '6px', padding: '0.125rem 0.5rem', fontSize: '0.8125rem', verticalAlign: 'middle' }

  if (ref !== null && q.isPending) {
    return h('span', { 'data-trello': 'chip-loading', 'aria-label': t('directive.loading'), style: box }, h(Skeleton, { style: { height: '1rem', width: '11rem', borderRadius: '4px' } }))
  }

  if (ref === null || q.isError || !q.data || !q.data.card) {
    const shown = truncate(oneLine(attrs && typeof attrs.card === 'string' && attrs.card ? attrs.card : source || ''), 60)

    return h('span', { 'data-trello': 'chip-plain', style: st(box, MUTED) }, h(Codicon, { name: 'tag' }), h('span', { className: 'truncate' }, shown))
  }

  const { card, list } = q.data
  const open = () => card.url && RT.ctx.os.openExternal(card.url)

  return h(
    'span',
    { 'data-trello': 'chip', style: box },
    h(Codicon, { name: 'tag' }),
    h('span', { className: 'truncate', style: { fontWeight: 500 } }, card.name),
    list && list.name && h('span', { style: st(SMALL, MUTED), className: 'truncate' }, t('directive.list', list.name)),
    h(DueChip, { card }),
    card.url && h(Button, { 'data-trello': 'chip-open', onClick: open, size: 'xs', type: 'button', variant: 'text' }, h(Codicon, { name: 'link-external' }), t('directive.open'))
  )
}

// ---------------------------------------------------------------------------
// 5. Plugin
// ---------------------------------------------------------------------------

export default {
  id: ID,
  name: 'Trello Browser',
  description: 'Trello boards, lists and cards in a pane, with one-click handoff of any card to the agent.',
  register(ctx) {
    ctx.i18n.register(LOCALES)
    initRuntime(ctx)

    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      title: ctx.i18n.t('pane.title'),
      data: { placement: 'right', width: '380px', minWidth: '320px' },
      render: () => jsx(PaneRoot, {})
    })

    ctx.register({
      id: 'card-directive',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: { name: 'trello', render: ({ attrs, source }) => jsx(CardChip, { attrs, source }) }
    })

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        label: ctx.i18n.t('palette.open'),
        keywords: ['trello', 'board', 'kanban', 'cards'],
        run: () => host.revealPane(PANE_ID)
      }
    })
  }
}
