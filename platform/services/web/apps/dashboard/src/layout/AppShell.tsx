import { useState } from 'react'
import { Outlet } from 'react-router'
import { PageBody, cn } from '@twentyfour/ui'
import { Sidebar } from './Sidebar'
import { useSidebarCollapsed } from './useSidebar'
import { TopBar } from './TopBar'
import { DevToolbar } from '@twentyfour/shell'

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { collapsed, toggle } = useSidebarCollapsed()

  return (
    <div className="min-h-dvh bg-bg">
      {/* First thing in the tab order, invisible until it has focus. Without
          it a keyboard user walks the whole sidebar on every page. */}
      <a
        href="#main"
        className="sr-only-focusable absolute left-4 top-4 z-[100] rounded-lg bg-surface px-4 py-2 text-base font-medium shadow-[var(--shadow-lg)]"
      >
        Skip to content
      </a>

      <Sidebar collapsed={collapsed} onToggle={toggle} />

      <div
        className={cn(
          'flex min-h-dvh flex-col',
          'transition-[padding] duration-[var(--duration-base)] ease-[var(--ease-out)]',
          'motion-reduce:transition-none',
          collapsed ? 'lg:pl-16' : 'lg:pl-64',
        )}
      >
        <TopBar drawerOpen={drawerOpen} onToggleDrawer={setDrawerOpen} />
        <main id="main" className="flex-1">
          <PageBody>
            <Outlet />
          </PageBody>
        </main>
      </div>

      <DevToolbar />
    </div>
  )
}
