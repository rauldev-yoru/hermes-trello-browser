// Visual SDK for the README screenshots.
//
// The test stub (tests/desktop/sdk-stub.mjs) only needs components to be clickable, so it renders bare
// <button>/<input> elements. For screenshots the markup has to carry the same class names as the app's own
// components, so the compiled app stylesheet styles them exactly as in the product. This module re-exports
// the whole stub and overrides only the visible UI components with class-faithful versions (class strings are
// copied from apps/desktop/src/components/ui/{button,checkbox,codicon,control,input,textarea,skeleton,
// separator,empty-state,error-state}.tsx of the app). Behaviour is irrelevant here: the page is static.

import * as React from 'react'

export * from './sdk-stub.mjs'

const e = React.createElement
const cx = (...parts) => parts.flat().filter(Boolean).join(' ')

// -- Codicon ----------------------------------------------------------------

export function Codicon({ className, name, size, spinning, style, ...props }) {
  return e('i', {
    'aria-hidden': 'true',
    className: cx('codicon', `codicon-${name}`, spinning && 'codicon-modifier-spin', className),
    style: { ...(size != null && size !== '' ? { fontSize: size } : {}), ...style },
    ...props
  })
}

// -- Button -----------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[2.5px] text-xs leading-4 font-medium whitespace-nowrap shadow-none transition-all duration-100 outline-none focus-visible:border-ring focus-visible:ring-[0.1875rem] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"

const TEXT_ACTION_ICON = '[&_.codicon]:no-underline [&_svg]:no-underline'

const BUTTON_VARIANTS = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
  outline: 'bg-transparent text-(--ui-text-primary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ui-stroke-secondary)_50%,transparent)] hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
  secondary: 'bg-(--ui-bg-quaternary) text-(--ui-text-primary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
  ghost: 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
  text: `text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${TEXT_ACTION_ICON}`
}

const BUTTON_SIZES = {
  default: 'px-3 py-1.5 has-[>svg]:px-2.5',
  xs: "gap-1 px-2 py-0.5 text-[0.6875rem] leading-4 has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
  sm: 'px-2.5 py-1 has-[>svg]:px-2',
  'icon-xs': "size-6 rounded-[4px] [&_svg:not([class*='size-'])]:size-3"
}

export function Button({ className, variant = 'default', size = 'default', asChild, children, disabled, ...props }) {
  return e(
    'button',
    {
      className: cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className),
      'data-size': size,
      'data-slot': 'button',
      'data-variant': variant,
      disabled,
      ...props
    },
    children
  )
}

// -- Checkbox (Radix markup: a button with data-state and an indicator when checked) ------------------

const CHECKBOX_BOX =
  'group peer size-4 shrink-0 rounded-sm border border-input shadow-xs outline-none transition-shadow data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground'

export function Checkbox({ checked, onCheckedChange, className, disabled, ...props }) {
  const state = checked ? 'checked' : 'unchecked'

  return e(
    'button',
    {
      'aria-checked': Boolean(checked),
      className: cx(CHECKBOX_BOX, 'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50', className),
      'data-slot': 'checkbox',
      'data-state': state,
      disabled,
      role: 'checkbox',
      type: 'button',
      ...props,
      // like Radix: a click asks for the opposite state
      onClick: event => {
        if (props.onClick) props.onClick(event)
        if (onCheckedChange && !disabled) onCheckedChange(!checked)
      }
    },
    checked
      ? e(
          'span',
          { className: 'flex items-center justify-center text-current', 'data-slot': 'checkbox-indicator', 'data-state': state },
          e(Codicon, { className: 'hidden! group-data-[state=checked]:block!', name: 'check', size: '0.875rem' }),
          e(Codicon, { className: 'hidden! group-data-[state=indeterminate]:block!', name: 'dash', size: '0.875rem' })
        )
      : null
  )
}

// -- Inputs -----------------------------------------------------------------

const CONTROL_BASE =
  'desktop-input-chrome w-full min-w-0 rounded-[2.5px] border text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'

const CONTROL_SIZES = {
  xs: 'px-2 py-0.5 text-[0.6875rem] leading-4',
  sm: 'px-2 py-1',
  default: 'px-2.5 py-1.5',
  lg: 'px-3 py-2 text-sm leading-5'
}

export function Input({ className, size = 'default', prefix, suffix, containerClassName, ...props }) {
  return e('input', {
    autoCapitalize: 'off',
    autoComplete: 'off',
    autoCorrect: 'off',
    className: cx(CONTROL_BASE, CONTROL_SIZES[size], 'selection:bg-primary selection:text-primary-foreground', className),
    'data-slot': 'input',
    spellCheck: false,
    ...props
  })
}

export function Textarea({ className, size = 'default', ...props }) {
  return e('textarea', {
    autoCapitalize: 'off',
    autoComplete: 'off',
    autoCorrect: 'off',
    className: cx(CONTROL_BASE, CONTROL_SIZES[size], 'min-h-16', className),
    'data-slot': 'textarea',
    spellCheck: false,
    ...props
  })
}

// -- Static pieces ----------------------------------------------------------

export const Skeleton = ({ className, ...props }) => e('div', { className: cx('animate-pulse rounded-md bg-accent', className), 'data-slot': 'skeleton', ...props })

export const Separator = ({ className, ...props }) =>
  e('div', { className: cx('shrink-0 bg-border h-px w-full', className), 'data-slot': 'separator', role: 'none', ...props })

export function EmptyState({ title, description, className }) {
  return e(
    'div',
    { className: cx('grid min-h-48 place-items-center text-center', className) },
    e('div', null, e('div', { className: 'text-sm font-medium' }, title), description ? e('div', { className: 'mt-1 text-xs text-muted-foreground' }, description) : null)
  )
}

export function ErrorState({ children, className, description, title }) {
  return e(
    'div',
    { className: cx('grid gap-5', className) },
    e(
      'div',
      { className: 'flex flex-col items-center gap-3 text-center' },
      e(Codicon, { className: 'text-destructive', name: 'error', size: '1.75rem' }),
      e('h2', { className: 'text-center text-xl font-semibold tracking-tight' }, title),
      description ? e('p', { className: 'max-w-prose text-center text-sm leading-5 text-muted-foreground' }, description) : null
    ),
    children ? e('div', { className: 'grid gap-2' }, children) : null
  )
}

// -- Menus: closed until opened (the stub renders menu content unconditionally) --------------------------

const MenuContext = React.createContext({ open: false, setOpen: () => {} })

export function DropdownMenu({ children }) {
  const [open, setOpen] = React.useState(false)

  return e(MenuContext.Provider, { value: { open, setOpen } }, children)
}

export function DropdownMenuTrigger({ children }) {
  const menu = React.useContext(MenuContext)

  return React.cloneElement(children, { 'aria-expanded': menu.open, onClick: () => menu.setOpen(!menu.open) })
}

export function DropdownMenuContent({ children }) {
  return React.useContext(MenuContext).open ? e('div', { role: 'menu' }, children) : null
}
