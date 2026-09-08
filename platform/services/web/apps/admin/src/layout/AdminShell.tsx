import { Outlet } from 'react-router'
import { PageBody, ThemeToggle } from '@twentyfour/ui'
import { Sidebar, SidebarContent } from './Sidebar'
import { SupportSessionBar } from './SupportSessionBar'
import { Drawer } from '../Drawer'

/**
 * The frame.
 *
 * A fixed sidebar and a scrolling document, like the merchant dashboard, and
 * for the same reason: this is a place people read, not a place they operate a
 * till. Nothing here collapses, because unlike the dashboard it is never used
 * on a phone at a counter, and a collapse control that nobody uses is a
 * control that has to be maintained anyway.
 */
export function AdminShell() {
  return (
    <div className="min-h-dvh bg-bg">
      <a
        href="#main"
        className="sr-only-focusable absolute left-4 top-4 z-[100] rounded-lg bg-surface px-4 py-2 text-base font-medium shadow-[var(--shadow-lg)]"
      >
        Skip to content
      </a>

      <Sidebar />

      <div className="flex min-h-dvh flex-col lg:pl-64">
        <SupportSessionBar />

        {/* Below lg the sidebar has nowhere to sit, so it becomes the top of
            the document rather than disappearing behind a control. The console
            is a desk tool and this is the fallback, not the design. */}
        <div className="border-b border-border bg-surface lg:hidden">
          <SidebarContent />
        </div>

        <div className="flex items-center justify-end px-4 pt-4 sm:px-6 lg:px-8">
          <ThemeToggle />
        </div>

        <main id="main" className="flex-1">
          <PageBody className="pt-2">
            <Outlet />
          </PageBody>
        </main>
      </div>

      <Drawer />
    </div>
  )
}
