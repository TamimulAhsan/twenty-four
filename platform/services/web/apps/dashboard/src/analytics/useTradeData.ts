import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { catalog, customers, orders, queryKeys, type CatalogItem, type Order } from '@twentyfour/api'
import {
  previousPeriod,
  type AnalysedOrder,
  type Period,
} from '@twentyfour/analytics'

/**
 * Everything the analysis needs, for a period and the one before it.
 *
 * Assembled once here rather than in each page, because every screen wants the
 * same joined shape: orders with their lines costed from the catalog. Joining
 * per page would mean five slightly different versions of the same mapping,
 * and the first one to drift would be a figure that disagrees with the figure
 * on the next screen.
 */
export interface TradeData {
  readonly orders: AnalysedOrder[]
  readonly previousOrders: AnalysedOrder[]
  readonly rawOrders: Order[]
  readonly items: CatalogItem[]
  readonly customers: ReturnType<typeof customers.list> extends Promise<infer T> ? T : never
  readonly isPending: boolean
  readonly isError: boolean
  readonly refetch: () => void
}

/** Costs come from the catalog, because an order line records what was
 *  charged and not what it cost. A line whose item has no cost recorded
 *  carries null, and every margin figure downstream refuses to guess. */
function analyse(list: readonly Order[], items: readonly CatalogItem[]): AnalysedOrder[] {
  const costs = new Map(items.map((item) => [item.id, item.costPrice?.minor ?? null] as const))
  const categories = new Map(items.map((item) => [item.id, item.categoryId] as const))

  return list.map((order) => ({
    id: order.id,
    placedAt: order.placedAt,
    status: order.status,
    customerId: order.customerId,
    discountCode: order.discountCode,
    discountMinor: order.discount?.minor ?? 0,
    grossMinor: order.gross.minor,
    netMinor: order.net.minor,
    taxMinor: order.tax.minor,
    method: order.tenders[0]?.method ?? 'card',
    staffId: order.staffId,
    lines: order.lines.map((line) => {
      const unitCost = costs.get(line.itemId) ?? null
      return {
        itemId: line.itemId,
        name: line.name,
        categoryId: categories.get(line.itemId) ?? null,
        quantity: line.quantity,
        grossMinor: line.gross.minor,
        netMinor: line.net.minor,
        taxMinor: line.tax.minor,
        costMinor: unitCost === null ? null : unitCost * line.quantity,
      }
    }),
  }))
}

export function useTradeData(period: Period): TradeData {
  const before = useMemo(() => previousPeriod(period), [period])

  const results = useQueries({
    queries: [
      {
        queryKey: queryKeys.orders.list({ from: period.from, to: period.to }),
        queryFn: () => orders.list({ from: period.from, to: period.to }),
      },
      {
        queryKey: queryKeys.orders.list({ from: before.from, to: before.to }),
        queryFn: () => orders.list({ from: before.from, to: before.to }),
      },
      {
        queryKey: queryKeys.catalog.items({ includeInactive: true }),
        queryFn: () => catalog.items({ includeInactive: true }),
      },
      { queryKey: queryKeys.customers.list(), queryFn: () => customers.list() },
    ],
  })

  const [current, prior, itemsQuery, customerQuery] = results
  const items = itemsQuery?.data ?? []

  return useMemo(
    () => ({
      orders: analyse(current?.data ?? [], items),
      previousOrders: analyse(prior?.data ?? [], items),
      rawOrders: current?.data ?? [],
      items,
      customers: (customerQuery?.data ?? []) as never,
      isPending: results.some((result) => result.isPending),
      isError: results.some((result) => result.isError),
      refetch: () => results.forEach((result) => void result.refetch()),
    }),
    // results is a new array each render; the data references inside it are
    // stable, which is what the memo actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.data, prior?.data, itemsQuery?.data, customerQuery?.data, results.some((r) => r.isPending)],
  )
}
