import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { IconButton, cn } from '@twentyfour/ui'
import { KeyValue } from './common'

/**
 * The detail panel.
 *
 * A drawer rather than a modal, because what goes in it is always read
 * alongside the list it came from: which order the specialist clicked, what
 * the audit event actually recorded. A modal would hide the row that prompted
 * the question, and answering "was that the same tenant" would mean closing it
 * and looking again.
 */
export interface DrawerContent {
  readonly title: string
  readonly subtitle?: string
  readonly rows: ReadonlyArray<{ key: string; value: ReactNode }>
  /** Raw payload, shown as it is stored. Never reformatted into prose. */
  readonly payload?: string
  readonly footer?: ReactNode
}

const DrawerContext = createContext<{
  open: (content: DrawerContent) => void
  close: () => void
} | null>(null)

export function useDrawer() {
  const value = useContext(DrawerContext)
  if (!value) throw new Error('useDrawer must be used inside a DrawerProvider')
  return value
}

const StateContext = createContext<DrawerContent | null>(null)

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<DrawerContent | null>(null)
  const actions = useMemo(
    () => ({ open: (next: DrawerContent) => setContent(next), close: () => setContent(null) }),
    [],
  )
  return (
    <DrawerContext.Provider value={actions}>
      <StateContext.Provider value={content}>{children}</StateContext.Provider>
    </DrawerContext.Provider>
  )
}

export function Drawer() {
  const content = useContext(StateContext)
  const { close } = useDrawer()

  // Escape closes, because a panel that only closes by finding a small button
  // is a panel that stays open. Bound while it is open and not otherwise.
  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    },
    [close],
  )
  useEffect(() => {
    if (!content) return
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [content, onKey])

  if (!content) return null

  return (
    <>
      <button
        type="button"
        aria-label="Close the detail panel"
        onClick={close}
        className="fixed inset-0 z-40 bg-scrim"
      />
      <aside
        aria-label={content.title}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col',
          'border-l border-border bg-surface shadow-[var(--shadow-xl)]',
        )}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-md font-semibold text-text">{content.title}</p>
            {content.subtitle && (
              <p className="mt-0.5 truncate text-sm text-text-muted">{content.subtitle}</p>
            )}
          </div>
          <IconButton icon="X" label="Close" size="sm" onClick={close} />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <KeyValue rows={content.rows} />

          {content.payload && (
            <div className="mt-5">
              <p className="font-mono text-2xs font-medium uppercase tracking-[0.14em] text-text-subtle">
                As recorded
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-bg-inset p-3 font-mono text-xs text-text-muted">
                {content.payload}
              </pre>
            </div>
          )}
        </div>

        {content.footer && (
          <div className="shrink-0 border-t border-border p-4">{content.footer}</div>
        )}
      </aside>
    </>
  )
}
