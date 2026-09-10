import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { orders, queryKeys, type DayClose as DayCloseRecord } from '@twentyfour/api'
import {
  PageBody, Badge, Button, Card, CardHeader, ErrorState, MoneyText, Skeleton, StatTile, Table,
  TableScroll, Td, Th, Tr, cn, useDateFormat, useFormat, useToast,
} from '@twentyfour/ui'
import { DEFAULT_PAPER, PrintableDayReport, printReceipt } from '@twentyfour/shell'
import { money, parseDecimalInput, serialiseMoney, toDecimalString } from '@twentyfour/money'

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

            <DrawerCount />

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
              disabled={!takings.data}
              onClick={() => printReceipt(DEFAULT_PAPER)}
            >
              Print the day report
            </Button>

            {/*
              The sheet that actually prints, on the same roll as the receipts
              and rendered at the end of body rather than here. Without it
              window.print() sends the whole application to the printer, which
              is what it used to do.
            */}
            {takings.data && <PrintableDayReport takings={takings.data} date={today()} />}
          </>
        )}
      </div>
    </PageBody>
  )
}

/**
 * Counting the drawer.
 *
 * The expected figure is built from what was actually tendered in cash, not
 * from the day's total: a card sale never went near the drawer. Refunds come
 * back out of it, because money goes back the way it came.
 *
 * There is no note and coin breakdown, and that is deliberate. Which
 * denominations exist is the one part of counting a drawer that differs per
 * market, and a note table in shared code is country logic wearing a hat.
 */
function DrawerCount() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { currency } = useFormat()
  const dates = useDateFormat()

  const [float, setFloat] = useState('')
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')

  const drawer = useQuery({
    queryKey: queryKeys.orders.dayClose(today()),
    queryFn: () => orders.dayClose(today()),
  })

  // Prefilled from what came back: the float carried over from the last count
  // when the day is still open, and the recorded figures once it is closed.
  useEffect(() => {
    const data = drawer.data
    if (!data) return
    setFloat(toDecimalString(data.openingFloat))
    if (data.countedCash) setCounted(toDecimalString(data.countedCash))
    setNote(data.note)
  }, [drawer.data])

  const close = useMutation({
    mutationFn: (input: { openingFloat: ReturnType<typeof money>; countedCash: ReturnType<typeof money> }) =>
      orders.closeDay({
        date: today(),
        openingFloat: serialiseMoney(input.openingFloat),
        countedCash: serialiseMoney(input.countedCash),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (record) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.dayClose(today()) })
      toast.show({
        tone: record.variance && record.variance.minor !== 0 ? 'warning' : 'success',
        title: 'Drawer counted',
        description:
          record.variance && record.variance.minor !== 0
            ? 'The count is recorded, with the difference against what was expected.'
            : 'The drawer matches what the till expected.',
      })
    },
    onError: (error) => {
      toast.show({ tone: 'danger', title: 'That count was not recorded', description: error.message })
    },
  })

  if (drawer.isError) {
    return <ErrorState description="The drawer figures did not load." onRetry={() => void drawer.refetch()} />
  }

  if (drawer.isPending) {
    return (
      <Card>
        <Skeleton className="h-40 w-full" />
      </Card>
    )
  }

  const data: DayCloseRecord = drawer.data

  let openingFloat = data.openingFloat
  let floatError: string | undefined
  try {
    if (float.trim() !== '') openingFloat = parseDecimalInput(float, currency)
  } catch (error) {
    floatError = error instanceof Error ? error.message : 'Enter an amount.'
  }

  let countedCash: ReturnType<typeof money> | null = null
  let countedError: string | undefined
  try {
    if (counted.trim() !== '') countedCash = parseDecimalInput(counted, currency)
  } catch (error) {
    countedError = error instanceof Error ? error.message : 'Enter an amount.'
  }

  // Recomputed here rather than waiting for the server, so the difference moves
  // as the float is corrected. The recorded figure is still the server's.
  const expected = money(
    openingFloat.minor + data.cashTaken.minor - data.cashRefunded.minor,
    currency,
  )
  const variance = countedCash ? money(countedCash.minor - expected.minor, currency) : null
  const ready = countedCash !== null && !floatError && !countedError

  return (
    <Card padded={false}>
      <CardHeader
        className="p-5"
        title="Count the drawer"
        description="What the till expects to be in it, against what is actually in it."
        action={
          data.closed ? (
            <Badge tone={data.variance && data.variance.minor !== 0 ? 'warning' : 'success'} dot>
              Counted
            </Badge>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-5 border-t border-border p-5 lg:grid-cols-2">
        <dl className="flex flex-col gap-2 text-base">
          <Row label="Opening float" value={<MoneyText value={openingFloat} display="none" />} muted />
          <Row label="Cash taken" value={<MoneyText value={data.cashTaken} display="none" />} muted />
          <Row
            label="Cash refunded"
            value={<MoneyText value={data.cashRefunded} display="none" />}
            muted
          />
          <div className="border-t border-border pt-2">
            <Row
              label="Expected in the drawer"
              value={
                <span className="text-md font-semibold">
                  <MoneyText value={expected} />
                </span>
              }
            />
          </div>
        </dl>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">Opening float</span>
            <input
              inputMode="decimal"
              value={float}
              onChange={(event) => setFloat(event.target.value)}
              aria-invalid={floatError ? true : undefined}
              className={cn(
                'tnum h-12 w-full rounded-lg border bg-surface px-3 text-right text-md font-semibold',
                'focus:outline-none focus:ring-[3px] focus:ring-accent/18',
                floatError ? 'border-danger' : 'border-border-strong focus:border-accent',
              )}
            />
            {floatError && <span role="alert" className="text-sm text-danger-text">{floatError}</span>}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">Counted in the drawer</span>
            <input
              inputMode="decimal"
              value={counted}
              onChange={(event) => setCounted(event.target.value)}
              aria-invalid={countedError ? true : undefined}
              placeholder="0"
              className={cn(
                'tnum h-14 w-full rounded-lg border bg-surface px-3 text-right text-2xl font-semibold',
                'focus:outline-none focus:ring-[3px] focus:ring-accent/18',
                countedError ? 'border-danger' : 'border-border-strong focus:border-accent',
              )}
            />
            {countedError && (
              <span role="alert" className="text-sm text-danger-text">{countedError}</span>
            )}
          </label>

          {/* Over and short are different problems, so they do not share a
              colour. Zero is its own answer and says so rather than showing a
              blank where a figure should be. */}
          {variance && (
            <div
              className={cn(
                'flex items-baseline justify-between rounded-xl p-4',
                variance.minor === 0
                  ? 'bg-success-subtle'
                  : variance.minor < 0
                    ? 'bg-danger-subtle'
                    : 'bg-warning-subtle',
              )}
            >
              <span className="text-base font-medium text-text-muted">
                {variance.minor === 0 ? 'Balanced' : variance.minor < 0 ? 'Short by' : 'Over by'}
              </span>
              <span className="text-2xl font-semibold text-text">
                <MoneyText
                  value={money(Math.abs(variance.minor), currency)}
                  deemphasiseSymbol
                />
              </span>
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">Note</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Anything that explains a difference"
              className={cn(
                'h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-base',
                'placeholder:text-text-subtle',
                'focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/18',
              )}
            />
          </label>

          <Button
            size="lg"
            loading={close.isPending}
            disabled={!ready}
            onClick={() =>
              countedCash && close.mutate({ openingFloat, countedCash })
            }
          >
            {data.closed ? 'Record the recount' : 'Record the count'}
          </Button>

          {data.closed && data.countedAt && (
            <p className="text-sm text-text-subtle">
              Counted by {data.countedBy} at {dates.time(data.countedAt)}. Counting again replaces
              this: the figure that stands is the one somebody arrived at last.
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function Row({
  label,
  value,
  muted,
}: {
  label: string
  value: React.ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={muted ? 'text-text-muted' : 'text-text'}>{label}</dt>
      <dd className="tnum">{value}</dd>
    </div>
  )
}
