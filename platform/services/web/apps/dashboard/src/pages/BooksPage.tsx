import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ledger, queryKeys, type AccountKind, type TrialBalanceRow } from '@twentyfour/api'
import {
  Badge, Card, CardHeader, EmptyState, ErrorState, Icon, MoneyText, PageHeader,
  Skeleton, Table, TableScroll, Td, Th, Tr,
} from '@twentyfour/ui'

/**
 * The five kinds, in the order a set of books is read.
 *
 * What the business has, what it owes, what is left over, what it earned and
 * what it spent. Ordering by kind rather than alphabetically is the difference
 * between a trial balance and a list of accounts.
 */
const ORDER: readonly AccountKind[] = ['asset', 'liability', 'equity', 'revenue', 'expense']

const KIND_LABEL: Record<AccountKind, string> = {
  asset: 'What you have',
  liability: 'What you owe',
  equity: 'Capital',
  revenue: 'What you earned',
  expense: 'What you spent',
}

/** The first day of the current month, as a date the API takes. */
function monthStart(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The books.
 *
 * Read-only, and it is not a limitation: nothing posts to the ledger by hand in
 * the normal course of business. Every line here was derived from something
 * that actually happened at the till, which is what stops the books being a
 * second opinion about whether a sale took place.
 */
export function BooksPage() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())

  const balance = useQuery({
    queryKey: queryKeys.ledger.trialBalance(from, to),
    queryFn: () => ledger.trialBalance({ from, to }),
  })

  const data = balance.data
  // Accounts with nothing on them are every account in the chart, and a trial
  // balance listing eighteen zeroes is one nobody reads.
  const shown = (data?.rows ?? []).filter((row) => row.debit.minor !== 0 || row.credit.minor !== 0)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Books"
        description="Double-entry, derived from what happened rather than typed in."
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="h-11 rounded-lg border border-border bg-surface px-3 text-base"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={today()}
              onChange={(event) => setTo(event.target.value)}
              className="h-11 rounded-lg border border-border bg-surface px-3 text-base"
            />
          </label>
        </div>

        {balance.isLoading && <Skeleton className="m-4 h-56" />}
        {balance.isError && (
          <ErrorState
            title="The books could not be read"
            description="Nothing has been changed. Try again."
            className="m-4"
          />
        )}

        {data && shown.length === 0 && (
          <EmptyState
            icon="ReceiptText"
            title="Nothing in this period"
            description="Entries appear as sales are rung up and payments settle. Try a wider range."
            className="m-4"
          />
        )}

        {data && shown.length > 0 && (
          <>
            <TableScroll>
              <Table>
                <thead>
                  <Tr>
                    <Th>Account</Th>
                    <Th numeric>Debit</Th>
                    <Th numeric>Credit</Th>
                  </Tr>
                </thead>
                <tbody>
                  {ORDER.flatMap((kind) => {
                    const group = shown.filter((row) => row.account.kind === kind)
                    if (group.length === 0) return []
                    return [
                      <Tr key={`head-${kind}`}>
                        <Td colSpan={3} className="bg-surface-sunken text-sm font-medium text-text-subtle">
                          {KIND_LABEL[kind]}
                        </Td>
                      </Tr>,
                      ...group.map((row) => <BalanceRow key={row.account.code} row={row} />),
                    ]
                  })}
                </tbody>
              </Table>
            </TableScroll>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <div className="flex items-center gap-6">
                <Total label="Total debits" value={data.totalDebits} />
                <Total label="Total credits" value={data.totalCredits} />
              </div>
              {/*
                Said out loud, and taken from the service rather than compared
                here. A trial balance that silently does not balance is the
                failure the whole ledger is arranged to prevent, and it is only
                prevented if somebody is told when it happens.
              */}
              {data.balanced ? (
                <Badge tone="success">
                  <Icon name="CheckCircle2" size="sm" /> In balance
                </Badge>
              ) : (
                <Badge tone="danger">
                  <Icon name="AlertCircle" size="sm" /> Out of balance, and that is a fault to report
                </Badge>
              )}
            </div>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Where these come from"
          description="Nothing is typed into the books."
        />
        <p className="mt-3 text-base text-text-subtle">
          Every entry here was derived from something that happened: a sale rung up, a sale
          voided, a payment refunded. Tax collected is held as money you owe rather than counted
          as income, and a card sale sits in settlements until the money actually arrives, so
          what you see as cash is cash.
        </p>
      </Card>
    </div>
  )
}

function BalanceRow({ row }: { row: TrialBalanceRow }) {
  const isDebit = row.debit.minor !== 0
  return (
    <Tr>
      <Td>
        <span className="font-medium text-text">{row.account.name}</span>
        {row.account.builtin && (
          <span className="ml-2 text-sm text-text-subtle">{row.account.code}</span>
        )}
      </Td>
      <Td numeric>{isDebit ? <MoneyText value={row.debit} /> : null}</Td>
      <Td numeric>{!isDebit ? <MoneyText value={row.credit} /> : null}</Td>
    </Tr>
  )
}

function Total({ label, value }: { label: string; value: TrialBalanceRow['debit'] }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-sm text-text-subtle">{label}</span>
      <span className="text-base font-semibold text-text">
        <MoneyText value={value} />
      </span>
    </span>
  )
}
