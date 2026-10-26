// SDK stub for the desktop-plugin tests. Only the SDK surface is faked: React,
// nanostores and @nanostores/react are the real packages. The query layer is a
// small in-memory stand-in for the app's React Query client (cache, invalidate,
// optimistic setQueryData, mutations with onMutate/onError/onSettled).

import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import * as React from 'react'

const e = React.createElement

export { atom, computed }
export const useValue = useStore
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
export const cn = (...a) => a.filter(Boolean).join(' ')
export const haptic = () => {}
export const isSubmitEnter = event => event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing)

// -- host -----------------------------------------------------------------

export const notifications = []
export const hostCalls = []

export const host = {
  notify: n => notifications.push(n),
  newChat: () => hostCalls.push('newChat'),
  revealPane: id => hostCalls.push(`revealPane:${id}`),
  paneVisible: atom(true),
  paneVisibility: () => host.paneVisible,
  composer: {
    insertText: async () => true,
    submit: () => true
  }
}

// -- i18n -------------------------------------------------------------------

const bundles = new Map()

export function registerLocales(id, value) {
  bundles.set(id, value)
}

export function translate(id, key, args = []) {
  const tree = bundles.get(id)?.en
  let node = tree

  for (const part of String(key).split('.')) {
    node = node && typeof node === 'object' ? node[part] : undefined
  }

  if (typeof node === 'function') {
    return node(...args)
  }

  return typeof node === 'string' ? node : key
}

export const usePluginI18n = id => (key, ...args) => translate(id, key, args)

// -- query layer ------------------------------------------------------------

const matches = (key, prefix) => !prefix || prefix.every((part, i) => JSON.stringify(key[i]) === JSON.stringify(part))

class MiniQueryClient {
  constructor() {
    this.entries = new Map()
  }

  reset() {
    this.entries.clear()
  }

  entry(key) {
    const hash = JSON.stringify(key)
    let entry = this.entries.get(hash)

    if (!entry) {
      entry = { key, hash, data: undefined, error: null, status: 'pending', fetching: false, listeners: new Set(), promise: null, updatedAt: 0, invalidated: false, options: null }
      this.entries.set(hash, entry)
    }

    return entry
  }

  notify(entry) {
    entry.listeners.forEach(l => l())
  }

  getQueryData(key) {
    return this.entries.get(JSON.stringify(key))?.data
  }

  setQueryData(key, data) {
    const entry = this.entry(key)
    entry.data = typeof data === 'function' ? data(entry.data) : data
    entry.status = 'success'
    entry.error = null
    this.notify(entry)

    return entry.data
  }

  cancelQueries() {
    return Promise.resolve()
  }

  removeQueries({ queryKey } = {}) {
    for (const [hash, entry] of this.entries) {
      if (matches(entry.key, queryKey)) {
        this.entries.delete(hash)
      }
    }
  }

  runFetch(entry, fn) {
    if (entry.promise) {
      return entry.promise
    }

    entry.fetching = true
    entry.invalidated = false
    this.notify(entry)

    entry.promise = (async () => {
      try {
        entry.data = await fn()
        entry.status = 'success'
        entry.error = null
        entry.updatedAt = Date.now()

        return { ok: true }
      } catch (error) {
        entry.error = error
        entry.status = 'error'

        return { ok: false, error }
      } finally {
        entry.fetching = false
        entry.promise = null
        this.notify(entry)
      }
    })()

    return entry.promise
  }

  invalidateQueries({ queryKey } = {}) {
    const work = []

    for (const entry of this.entries.values()) {
      if (matches(entry.key, queryKey)) {
        entry.invalidated = true

        if (entry.listeners.size && entry.options && entry.options.enabled !== false) {
          work.push(this.runFetch(entry, entry.options.queryFn))
        }
      }
    }

    return Promise.all(work)
  }

  async fetchQuery({ queryKey, queryFn, staleTime = 0 }) {
    const entry = this.entry(queryKey)

    if (entry.data !== undefined && !entry.invalidated && Date.now() - entry.updatedAt < staleTime) {
      return entry.data
    }

    const result = await this.runFetch(entry, queryFn)

    if (!result.ok) {
      throw result.error
    }

    return entry.data
  }
}

export const queryClient = new MiniQueryClient()
export const useQueryClient = () => queryClient
export const optionLog = new Map()

export function useQuery(options) {
  const [, force] = React.useReducer(x => x + 1, 0)
  const entry = queryClient.entry(options.queryKey)
  const enabled = options.enabled !== false
  entry.options = options
  optionLog.set(entry.hash, options)

  React.useEffect(() => {
    entry.listeners.add(force)

    return () => entry.listeners.delete(force)
  }, [entry.hash])

  React.useEffect(() => {
    if (enabled && !entry.promise && (entry.data === undefined || entry.invalidated || options.refetchOnMount === 'always')) {
      queryClient.runFetch(entry, options.queryFn)
    }
  }, [entry.hash, enabled])

  return {
    data: entry.data,
    error: entry.error,
    status: entry.status,
    isPending: entry.data === undefined && entry.status !== 'error',
    isError: entry.status === 'error',
    isFetching: entry.fetching,
    refetch: () => queryClient.runFetch(entry, options.queryFn)
  }
}

export function useMutation(options) {
  const [pending, setPending] = React.useState(false)
  const ref = React.useRef(options)
  ref.current = options

  const run = React.useCallback(async (vars, callbacks) => {
    const o = ref.current
    let context
    setPending(true)

    try {
      context = o.onMutate ? await o.onMutate(vars) : undefined
      const data = await o.mutationFn(vars)
      await (o.onSuccess && o.onSuccess(data, vars, context))
      callbacks && callbacks.onSuccess && callbacks.onSuccess(data, vars, context)
      await (o.onSettled && o.onSettled(data, null, vars, context))

      return data
    } catch (error) {
      await (o.onError && o.onError(error, vars, context))
      callbacks && callbacks.onError && callbacks.onError(error, vars, context)
      await (o.onSettled && o.onSettled(undefined, error, vars, context))
      throw error
    } finally {
      setPending(false)
    }
  }, [])

  return { isPending: pending, mutate: (vars, callbacks) => void run(vars, callbacks).catch(() => {}), mutateAsync: run }
}

// -- UI components ----------------------------------------------------------

const strip = (props, names) => {
  const out = { ...props }

  for (const n of names) {
    delete out[n]
  }

  return out
}

export const Button = ({ children, ...rest }) => e('button', strip(rest, ['variant', 'size', 'asChild']), children)
export const Tip = ({ children }) => children
export const Codicon = ({ name, spinning, ...rest }) => e('i', { 'data-icon': name, 'data-spinning': spinning ? 'true' : undefined, 'aria-hidden': 'true', ...strip(rest, ['size']) })
export const Input = props => e('input', strip(props, ['size', 'prefix', 'suffix', 'containerClassName']))
export const Textarea = props => e('textarea', strip(props, ['size']))
export const SearchField = ({ value, onChange, placeholder }) => e('input', { 'aria-label': placeholder, onChange: ev => onChange(ev.target.value), placeholder, type: 'text', value })
export const Checkbox = ({ checked, onCheckedChange, disabled, ...rest }) => e('input', { ...strip(rest, ['className']), checked: Boolean(checked), disabled, onChange: ev => onCheckedChange && onCheckedChange(ev.target.checked), type: 'checkbox' })
export const Skeleton = props => e('div', { 'data-skeleton': 'true', ...props })
export const EmptyState = ({ title, description }) => e('div', { 'data-empty': 'true', role: 'note' }, e('div', null, title), description ? e('div', null, description) : null)
export const ErrorState = ({ title, description, children }) => e('div', { 'data-error': 'true', role: 'alert' }, e('div', null, title), description ? e('p', null, description) : null, children)
export const Separator = () => e('hr')
export const SegmentedControl = ({ options, value, onChange, disabled = false }) => e('div', { 'aria-disabled': disabled ? 'true' : undefined, role: 'radiogroup' }, ...options.map(o => e('button', { 'aria-checked': o.id === value, disabled, key: o.id, onClick: () => onChange(o.id), role: 'radio', type: 'button' }, o.label)))
export const CopyButton = ({ text, label }) => e('button', { 'data-copy': text, type: 'button' }, label || 'copy')

export function ConfirmDialog({ open, onClose, onConfirm, title, description, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  const [error, setError] = React.useState('')

  if (!open) {
    return null
  }

  const confirm = async () => {
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(String(err && err.message ? err.message : err))
    }
  }

  return e('div', { role: 'dialog', 'aria-label': String(title) }, e('h2', null, title), description ? e('p', null, description) : null, children, error ? e('div', { role: 'alert' }, error) : null, e('button', { onClick: onClose, type: 'button' }, cancelLabel), e('button', { 'data-confirm': 'true', onClick: confirm, type: 'button' }, confirmLabel))
}

export const DropdownMenu = ({ children }) => e('div', { 'data-menu': 'true' }, children)
export const DropdownMenuTrigger = ({ children }) => children
export const DropdownMenuContent = ({ children }) => e('div', { role: 'menu' }, children)
export const DropdownMenuItem = ({ children, onSelect }) => e('button', { onClick: () => onSelect && onSelect(), role: 'menuitem', type: 'button' }, children)
export const DropdownMenuSeparator = () => e('hr')

const PopoverContext = React.createContext(null)

export function Popover({ open, onOpenChange, children }) {
  const [inner, setInner] = React.useState(false)
  const controlled = open !== undefined
  const isOpen = controlled ? open : inner
  const setOpen = value => (controlled ? onOpenChange && onOpenChange(value) : setInner(value))

  return e(PopoverContext.Provider, { value: { isOpen, setOpen } }, children)
}

export function PopoverTrigger({ children }) {
  const ctx = React.useContext(PopoverContext)

  return React.cloneElement(children, {
    'aria-expanded': ctx.isOpen,
    onClick: event => {
      children.props.onClick && children.props.onClick(event)
      ctx.setOpen(!ctx.isOpen)
    }
  })
}

export function PopoverContent({ children }) {
  const ctx = React.useContext(PopoverContext)

  return ctx.isOpen ? e('div', { 'data-popover': 'true', role: 'dialog' }, children) : null
}
