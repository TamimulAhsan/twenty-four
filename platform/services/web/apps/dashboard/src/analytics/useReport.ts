import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  analytics,
  queryKeys,
  type ReportBreakdown,
  type ReportHeatmap,
  type ReportSeries,
  type ReportSummary,
} from '@twentyfour/api'
import type { Period } from '@twentyfour/analytics'

/**
 * Everything an analytics screen asks for, in one hook.
 *
 * The figures are computed where the data is, over a projection kept by change
 * capture off the operational stores. The alternative, which this replaced, was
 * to fetch every order in the period and add them up in the browser: correct at
 * eight sales a day and hopeless at eight hundred, because the cost of the
 * screen grows with the size of the business using it.
 *
 * Five questions rather than one endpoint answering all of them. They cache
 * separately, so changing the breakdown does not refetch the totals, and the
 * one that is slow to come back does not hold up the four that are not.
 */
export interface Report {
  readonly summary: ReportSummary | undefined
  readonly series: ReportSeries | undefined
  /** The same shape for the window before, so a chart can lay one over the
   *  other. Asked for separately rather than returned alongside, because most
   *  screens want the totals compared and only one wants the whole line. */
  readonly previousSeries: ReportSeries | undefined
  readonly byMethod: ReportBreakdown | undefined
  readonly byCategory: ReportBreakdown | undefined
  readonly heatmap: ReportHeatmap | undefined
  readonly isPending: boolean
  readonly isError: boolean
  readonly refetch: () => void
  /** The newest change any of these answers includes, or null when the
   *  projection holds nothing yet. The oldest of the five, because the screen
   *  is only as current as its least current part. */
  readonly through: string | null
}

export function useReport(period: Period, comparison: Period): Report {
  const results = useQueries({
    queries: [
      {
        queryKey: queryKeys.analytics.summary(period.from, period.to),
        queryFn: () => analytics.summary(period),
      },
      {
        queryKey: queryKeys.analytics.series(period.from, period.to),
        queryFn: () => analytics.series(period),
      },
      {
        queryKey: queryKeys.analytics.series(comparison.from, comparison.to),
        queryFn: () => analytics.series(comparison),
      },
      {
        queryKey: queryKeys.analytics.breakdown(period.from, period.to, 'method'),
        // Four is what fits across a bar without the labels colliding. The
        // rest is folded into a remainder rather than dropped, so the shares
        // still add up to the total shown above them.
        queryFn: () => analytics.breakdown(period, 'method', 4),
      },
      {
        queryKey: queryKeys.analytics.breakdown(period.from, period.to, 'category'),
        queryFn: () => analytics.breakdown(period, 'category', 6),
      },
      {
        queryKey: queryKeys.analytics.heatmap(period.from, period.to),
        queryFn: () => analytics.heatmap(period),
      },
    ],
  })

  const [summary, series, priorSeries, byMethod, byCategory, heatmap] = results

  return useMemo(() => {
    const stamps = [
      summary?.data?.freshness.through,
      series?.data?.freshness.through,
      byMethod?.data?.freshness.through,
      byCategory?.data?.freshness.through,
      heatmap?.data?.freshness.through,
    ].filter((value): value is string => typeof value === 'string')

    return {
      summary: summary?.data as ReportSummary | undefined,
      series: series?.data as ReportSeries | undefined,
      previousSeries: priorSeries?.data as ReportSeries | undefined,
      byMethod: byMethod?.data as ReportBreakdown | undefined,
      byCategory: byCategory?.data as ReportBreakdown | undefined,
      heatmap: heatmap?.data as ReportHeatmap | undefined,
      isPending: results.some((result) => result.isPending),
      isError: results.some((result) => result.isError),
      refetch: () => results.forEach((result) => void result.refetch()),
      through: stamps.length === 0 ? null : stamps.reduce((a, b) => (a < b ? a : b)),
    }
    // results is a new array each render; the data inside it is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    summary?.data, series?.data, priorSeries?.data,
    byMethod?.data, byCategory?.data, heatmap?.data,
    results.some((result) => result.isPending),
    results.some((result) => result.isError),
  ])
}
