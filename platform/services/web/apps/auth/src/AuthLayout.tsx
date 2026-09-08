import type { ReactNode } from 'react'
import { Wordmark } from '@twentyfour/runtime'
import { ThemeToggle, cn } from '@twentyfour/ui'

/**
 * The frame both auth screens sit in.
 *
 * One layout, so sign-in and sign-up cannot drift into looking like two
 * products. The brand panel is deliberately one look in both themes: it is a
 * canvas, not a surface, and a panel that flips to white in dark mode reads as
 * a rendering fault rather than a choice. It is painted explicitly so it never
 * borrows a colour from the theme.
 *
 * On a phone the panel is dropped entirely rather than stacked above the
 * fields. It is decorative; the form is the point, and a visitor who has to
 * scroll past a poster to reach the first input has been sold to twice.
 */
export function AuthLayout({
  aside,
  wide,
  children,
}: {
  /** Replaces the marketing copy. Sign-up puts its progress here. */
  aside?: ReactNode
  /** Sign-up needs the room: forty-three trades and four plans do not fit in
   *  the width of a two-field form. */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'grid min-h-dvh',
        wide ? 'lg:grid-cols-[1fr_minmax(0,54rem)]' : 'lg:grid-cols-[1fr_minmax(0,42rem)]',
      )}
    >
      <aside className="relative hidden overflow-hidden bg-neutral-950 p-12 lg:flex lg:flex-col">
        <Wordmark tone="light" />
        <div className={cn('max-w-md', aside ? 'mt-12' : 'mt-auto')}>
          {aside ?? (
            <>
              <p className="text-3xl font-semibold leading-[1.15] tracking-[-0.03em] text-white">
                Website, bookings, till and payments. One system, live in a day.
              </p>
              <p className="mt-4 text-md text-neutral-400">
                Configured for your trade by a specialist, not assembled by you.
              </p>
            </>
          )}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent/25 blur-3xl"
        />
      </aside>

      <main className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className={cn('mx-auto w-full', wide ? 'max-w-2xl' : 'max-w-sm')}>
          <div className="mb-8 flex items-center justify-between lg:hidden">
            <Wordmark />
            <ThemeToggle />
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
