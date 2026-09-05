import { useQuery } from '@tanstack/react-query'
import { orders, queryKeys } from '@twentyfour/api'
import {
  PageBody, Button, Card, CardHeader, ErrorState, MoneyText, Skeleton, StatTile, Table, TableScroll,
  Td, Th, Tr, useDateFormat, useFormat,
} from '@twentyfour/ui'
import { money } from '@twentyfour/money'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * The end of the day.
 *
 * Everything a cashier needs to count the drawer and hand over: what was taken,
 * how it arrived, and the tax split the books will want. Cash is separated from
 * everything else because cash is the only figure anyone counts by hand.
 */
export function DayClose() {
  const dates = useDateFormat()
  const { currency } = useFormat()

  const takings = useQuery({
    queryKey: queryKeys.orders.takings(today()),
    queryFn: () => orders.takings(today()),
  })

  const zero = money(0, currency)
  const cash = takings.data?.byMethod.find((row) => row.method === 'cash')?.amount ?? zero
  const other = money((takings.data?.gross.minor ?? 0) - cash.minor, currency)

  return (
    <PageBody scroll>
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.025em] text-text">Close the day</h1>
          <p className="mt-1 text-base text-text-muted">{dates.dateLong(new Date())}</p>
        </div>

        {takings.isError ? (
          <ErrorState onRetry={() => void takings.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label="Cash to count" icon="Wallet" money={cash} loading={takings.isPending} />
              <StatTile label="Everything else" icon="CreditCard" money={other} loading={takings.isPending} />
              <StatTile label="Taken in total" icon="ReceiptText" money={takings.data?.gross ?? zero} loading={takings.isPending} />
            </div>

            {/* Side by side on a counter screen: both are read at the same
                moment, when someone is counting the drawer. */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card padded={false}>
              <CardHeader className="p-5" title="By method" />
              {takings.isPending ? (
                <div className="p-5 pt-0"><Skeleton className="h-24 w-full" /></div>
              ) : (
                <TableScroll>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Method</Th>
                        <Th numeric>Count</Th>
                        <Th numeric>Amount</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {(takings.data?.byMethod ?? []).map((row) => (
                        <Tr key={row.method}>
                          <Td className="capitalize font-medium">{row.method}</Td>
                          <Td numeric className="text-text-muted">{row.count}</Td>
                          <Td numeric><MoneyText value={row.amount} /></Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableScroll>
              )}
            </Card>

            <Card padded={false}>
              <CardHeader
                className="p-5"
                title="Tax bands"
                description="Totalled from each line as it was priced, not re-derived from the day’s total."
              />
              <TableScroll>
                <Table>
                  <thead>
                    <tr>
                      <Th>Rate</Th>
                      <Th numeric>Net</Th>
                      <Th numeric>Tax</Th>
                      <Th numeric>Gross</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(takings.data?.byTaxBand ?? []).map((band) => (
                      <Tr key={band.basisPoints}>
                        <Td className="font-medium">{band.basisPoints / 100}%</Td>
                        <Td numeric><MoneyText value={band.net} display="none" /></Td>
                        <Td numeric><MoneyText value={band.tax} display="none" /></Td>
                        <Td numeric className="font-medium"><MoneyText value={band.gross} display="none" /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            </Card>

            </div>

            <Button
              size="lg"
              iconStart="Printer"
              className="self-start"
              onClick={() => window.print()}
            >
              Print the day report
            </Button>
          </>
        )}
      </div>
    </PageBody>
  )
}
