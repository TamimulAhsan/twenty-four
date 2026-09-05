import { useEffect, useRef } from 'react'
import { Icon, IconButton, ThemeToggle, cn } from '@twentyfour/ui'
import { SidebarContent } from './Sidebar'
import { Wordmark } from '@twentyfour/runtime'

export function TopBar({
  drawerOpen,
  onToggleDrawer,
}: {
  drawerOpen: boolean
  onToggleDrawer: (open: boolean) => void
}) {
  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b border-border',
          'bg-surface/85 px-4 backdrop-blur-md',
        )}
      >
        <IconButton
          icon="Menu"
          label="Open navigation"
          className="lg:hidden"
          onClick={() => onToggleDrawer(true)}
        />
        <span className="lg:hidden">
          <Wordmark />
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <label className="relative hidden md:block">
            <span className="sr-only">Search</span>
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle">
              <Icon name="Search" size="md" />
            </span>
            <input
              type="search"
              placeholder="Search"
              className={cn(
                'h-10 w-56 rounded-lg border border-border bg-surface-sunken pl-9 pr-3',
                'text-base placeholder:text-text-subtle',
                'focus:border-accent focus:bg-surface focus:outline-none focus:ring-[3px] focus:ring-accent/18',
              )}
            />
          </label>
          <IconButton icon="Search" label="Search" className="md:hidden" />
          <IconButton icon="Bell" label="Notifications" />
          <ThemeToggle className="ml-1" />
        </div>
      </header>

      <MobileDrawer open={drawerOpen} onClose={() => onToggleDrawer(false)} />
    </>
  )
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
      aria-label="Navigation"
      className={cn(
        'm-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-text',
        'backdrop:bg-scrim lg:hidden',
      )}
    >
      <div
        className={cn(
          'h-full w-72 max-w-[85vw] border-r border-border bg-surface',
          'animate-[var(--animate-fade-in)] motion-reduce:animate-none',
        )}
      >
        <div className="flex justify-end p-2">
          <IconButton icon="X" label="Close navigation" size="sm" onClick={onClose} />
        </div>
        <div className="h-[calc(100%-3rem)]">
          <SidebarContent onNavigate={onClose} />
        </div>
      </div>
    </dialog>
  )
}
