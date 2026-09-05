import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * The gutter every page sits inside.
 *
 * Equal on all four sides, and defined once. It was copied into thirteen
 * places before this existed, and had already drifted: the dashboard ran
 * 16/24/32 horizontally against 24/32 vertically, while the till and the
 * calendar ran 12/16 on every side. Nothing looked wrong on its own screen
 * and nothing matched across two.
 *
 * The step is 16 / 24 / 32. A phone gives up horizontal room grudgingly, a
 * desk has it to spare.
 */
export const PAGE_GUTTER = 'p-4 sm:p-6 lg:p-8'

/**
 * The widest a page's content grows before it starts centring.
 *
 * Well above any ordinary monitor, so on a laptop or a 1440 the content uses
 * the width it has instead of sitting in a column with dead space either side.
 * The cap only engages on an ultrawide, where a table spanning 2500px makes
 * the eye travel further than reading it is worth.
 */
export const PAGE_MAX_WIDTH = 'max-w-[110rem]'

/**
 * The tighter gutter, for a fixed-height operational pane.
 *
 * The till and the prep screen are not documents: they never scroll past
 * their own frame, they are read from a metre away, and every pixel spent on
 * margin is a key that does not fit. They stop one step short of the page
 * scale rather than inventing their own number.
 */
export const DENSE_GUTTER = 'p-4 sm:p-5'

export interface PageBodyProps {
  children: ReactNode
  /** Fills its parent and scrolls internally. For the till and the calendar,
   *  which are fixed-height applications rather than scrolling documents. */
  scroll?: boolean
  className?: string
  /** Drops the gutter, for a view that manages its own edges. */
  bare?: boolean
  /** Overrides the scale. Only DENSE_GUTTER, and only for an operational
   *  pane: anything else here is how thirteen different paddings started. */
  gutter?: string
}

export function PageBody({ children, scroll, className, bare, gutter }: PageBodyProps) {
  return (
    <div
      className={cn(
        scroll ? 'h-full overflow-y-auto' : 'w-full',
        !bare && (gutter ?? PAGE_GUTTER),
        className,
      )}
    >
      <div className={cn('mx-auto w-full', PAGE_MAX_WIDTH)}>{children}</div>
    </div>
  )
}
