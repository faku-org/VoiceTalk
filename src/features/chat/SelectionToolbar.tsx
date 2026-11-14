import { useEffect, useRef, useState } from 'react'
import {
  CornerUpLeft,
  Ellipsis,
  GitBranch,
  Highlighter,
  Pencil,
  Repeat2,
  type LucideIcon,
} from 'lucide-react'
import { focusRing } from './view'

export type SelectionAction =
  | 'reply'
  | 'correct'
  | 'follow'
  | 'fork'
  | 'highlight'

const ITEMS: Record<SelectionAction, { label: string; icon: LucideIcon }> = {
  reply: { label: 'Responder', icon: CornerUpLeft },
  correct: { label: 'Corregir', icon: Pencil },
  follow: { label: 'Continuar tema', icon: Repeat2 },
  fork: { label: 'Bifurcar', icon: GitBranch },
  highlight: { label: 'Resaltar', icon: Highlighter },
}

const PRIMARY: SelectionAction[] = ['reply', 'correct']
const MORE: SelectionAction[] = ['follow', 'fork', 'highlight']

const itemClass = `inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 body font-medium text-text transition-colors duration-(--dur-fast) hover:bg-surface-2 ${focusRing}`

/** Floating surface: above the text, never moves it, never takes the selection. */
const floatClass =
  'fixed z-30 rounded-control border border-border bg-surface shadow-float'

function MenuList({
  actions,
  onPick,
  onClose,
  autoFocus,
  className,
}: {
  actions: SelectionAction[]
  onPick: (a: SelectionAction) => void
  onClose: () => void
  autoFocus: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (autoFocus)
      ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [autoFocus])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      buttons[(n + buttons.length) % buttons.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(buttons.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Acciones"
      onKeyDown={onKeyDown}
      // Keep the selection while a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      className={className}
    >
      {actions.map((a) => {
        const { label, icon: Icon } = ITEMS[a]
        return (
          <button
            key={a}
            type="button"
            role="menuitem"
            onClick={() => onPick(a)}
            className={`${itemClass} w-full justify-start`}
          >
            <Icon className="size-4 text-muted" aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Actions over a selected passage (or a whole turn): Responder, Corregir, Más. `toolbar` floats over the
 * selection; `menu` opens the same items at the pointer (right click, Shift+F10). Esc closes the topmost
 * layer and leaves the selection as it was.
 */
export function SelectionToolbar({
  mode,
  x,
  y,
  placement,
  onAction,
  onClose,
}: {
  mode: 'toolbar' | 'menu'
  x: number
  y: number
  placement: 'above' | 'below'
  onAction: (a: SelectionAction) => void
  onClose: () => void
}) {
  const [more, setMore] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Esc closes the topmost layer: the "Más" list first, then the toolbar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (more) setMore(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [more, onClose])

  // A menu is dismissed by pressing anywhere outside it.
  useEffect(() => {
    if (mode !== 'menu') return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [mode, onClose])

  if (mode === 'menu') {
    return (
      <div
        ref={rootRef}
        style={{ left: x, top: y }}
        className={`${floatClass} w-48 p-1`}
      >
        <MenuList
          actions={[...PRIMARY, ...MORE]}
          onPick={onAction}
          onClose={onClose}
          autoFocus
        />
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Acciones sobre la selección"
      // Keep the text selected while a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        left: x,
        top: y,
        transform:
          placement === 'above' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
      }}
      className={`${floatClass} flex items-center gap-0.5 p-1`}
    >
      {PRIMARY.map((a) => {
        const { label, icon: Icon } = ITEMS[a]
        return (
          <button
            key={a}
            type="button"
            onClick={() => onAction(a)}
            className={itemClass}
          >
            <Icon className="size-4 text-muted" aria-hidden="true" />
            {label}
          </button>
        )
      })}
      <div className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
          className={itemClass}
        >
          <Ellipsis className="size-4 text-muted" aria-hidden="true" />
          Más
        </button>
        {more && (
          <div
            className={`absolute left-0 w-44 rounded-control border border-border bg-surface p-1 shadow-float ${
              placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            <MenuList
              actions={MORE}
              onPick={(a) => {
                setMore(false)
                onAction(a)
              }}
              onClose={() => setMore(false)}
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  )
}
