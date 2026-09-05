import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { cn } from './cn'
import { IconButton } from './button'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Widths are tokens, not arbitrary. */
  size?: 'sm' | 'md' | 'lg'
}

const WIDTHS = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' } as const

/**
 * A modal.
 *
 * Uses the native <dialog> element so focus trapping, inertness of the page
 * behind, and Escape all come from the platform rather than from a hand-rolled
 * keydown listener that will be wrong in some browser.
 *
 * On a phone it arrives as a bottom sheet, because a centred box with a
 * keyboard open leaves nothing visible.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  const handleCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      // Escape closes through React so the caller's state stays the source of
      // truth, rather than the element closing itself and the two drifting.
      event.preventDefault()
      onClose()
    },
    [onClose],
  )

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClick={(event) => {
        // Clicking the backdrop closes. The check is on the target being the
        // dialog itself, which only happens outside the content box.
        if (event.target === ref.current) onClose()
      }}
      aria-labelledby="dialog-title"
      className={cn(
        'm-0 w-full max-w-none bg-transparent p-0 text-text backdrop:bg-scrim',
        'mt-auto sm:m-auto',
        'backdrop:animate-[var(--animate-fade-in)]',
        'open:animate-[var(--animate-slide-up)] sm:open:animate-[var(--animate-scale-in)]',
        'motion-reduce:animate-none motion-reduce:open:animate-none',
      )}
    >
      <div
        className={cn(
          'mx-auto flex w-full flex-col rounded-t-2xl border border-border bg-surface',
          'max-h-[88dvh] shadow-[var(--shadow-xl)]',
          'sm:rounded-2xl',
          WIDTHS[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="dialog-title" className="text-md font-semibold text-text">
              {title}
            </h2>
            {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
          </div>
          <IconButton icon="X" label="Close" size="sm" onClick={onClose} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  )
}
