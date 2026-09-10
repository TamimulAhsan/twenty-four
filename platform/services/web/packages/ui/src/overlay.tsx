import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { cn } from './cn'
import type { IconName } from './icon'
import { Button, IconButton, type ButtonVariant } from './button'

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

export interface ConfirmDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: string
  /** What the person is agreeing to, in a sentence. Not a restatement of the
   *  title: if it says nothing the title did not, leave it out. */
  description?: ReactNode
  /** Names the action, never "OK". A button that says what it does is the
   *  difference between reading the dialog and dismissing it. */
  confirmLabel: string
  cancelLabel?: string
  confirmVariant?: ButtonVariant
  confirmIcon?: IconName
  pending?: boolean
  children?: ReactNode
}

/**
 * A modal that asks before doing something the person cannot undo by clicking
 * again.
 *
 * Built on Dialog rather than beside it, so the focus trap, the Escape key and
 * the backdrop behave the same as every other modal in the product.
 *
 * Cancel is the safe side and is focused on open: Enter and Escape both back
 * out, and confirming is the deliberate act. Nothing here auto-focuses the
 * confirm button, which would turn a stray keypress into the very thing the
 * dialog exists to prevent.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  confirmIcon,
  pending,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} iconStart={confirmIcon} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p className="text-base text-text-muted">{description}</p>}
      {children}
    </Dialog>
  )
}
