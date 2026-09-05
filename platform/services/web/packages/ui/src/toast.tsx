import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from './cn'
import { Icon, type IconName } from './icon'
import { IconButton } from './button'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface Toast {
  readonly id: string
  readonly tone: ToastTone
  readonly title: string
  readonly description?: string
  /** Lets a destructive or bulk action be taken back rather than confirmed
   *  first. Cheaper for the merchant than a dialog on every delete. */
  readonly action?: { label: string; onClick: () => void }
  readonly duration?: number
}

interface ToastContextValue {
  show(toast: Omit<Toast, 'id'>): string
  dismiss(id: string): void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const TONE_ICON: Record<ToastTone, IconName> = {
  neutral: 'Info',
  success: 'CheckCircle2',
  warning: 'TriangleAlert',
  danger: 'AlertCircle',
}

const TONE_CLASS: Record<ToastTone, string> = {
  neutral: 'text-text-muted',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setToasts((current) => [...current, { ...toast, id }])
      // An error stays until it is read; a confirmation gets out of the way.
      const duration = toast.duration ?? (toast.tone === 'danger' ? 8000 : 4000)
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      )
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* polite, not assertive: a toast reports what happened, it does not
          interrupt what the reader is doing, and it never takes focus. */}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className={cn(
          'pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4',
          'sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-auto sm:items-end',
        )}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border',
              'bg-surface-raised p-3.5 shadow-[var(--shadow-lg)]',
              'animate-[var(--animate-rise)] motion-reduce:animate-none',
            )}
          >
            <Icon name={TONE_ICON[toast.tone]} size="lg" className={cn('mt-px shrink-0', TONE_CLASS[toast.tone])} />
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-text">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-sm text-text-muted">{toast.description}</p>
              )}
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick()
                    dismiss(toast.id)
                  }}
                  className="mt-2 text-sm font-semibold text-accent-text underline-offset-4 hover:underline"
                >
                  {toast.action.label}
                </button>
              )}
            </div>
            <IconButton icon="X" label="Dismiss" size="sm" onClick={() => dismiss(toast.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside a ToastProvider')
  return value
}
