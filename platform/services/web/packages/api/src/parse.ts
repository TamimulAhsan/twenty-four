/**
 * The boundary.
 *
 * Everything the API returns passes through here before any component sees it.
 * The reason is money: protobuf's JSON mapping sends int64 as a string, and a
 * naive JSON.parse turns it into a double that has already lost its last
 * digits by the time anything notices. parseMoney refuses that, here, where
 * the request is still identifiable.
 */
import { parseMoney, type Money } from '@twentyfour/money'
import type {
  Booking,
  DayClose,
  Discount,
  LoyaltyProgramme,
  Bootstrap,
  CatalogItem,
  FiscalDocument,
  CheckoutResult,
  Order,
  OrderLine,
  PaymentPending,
  Payment,
  ReportBreakdown,
  ReportHeatmap,
  ReportSeries,
  ReportSlice,
  ReportSummary,
  ReportTotals,
  Subscription,
  Takings,
  Tender,
} from './types'

type Raw = Record<string, unknown>

const asRecord = (value: unknown, what: string): Raw => {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${what} was not an object`)
  }
  return value as Raw
}

/** A string field, defaulting to empty rather than throwing: an absent optional
 *  string is an absence, not a malformed response. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const optionalMoney = (value: unknown): Money | null =>
  value === null || value === undefined ? null : parseMoney(value)

const asArray = (value: unknown, what: string): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what} was not an array`)
  return value
}

export function parseCatalogItem(value: unknown): CatalogItem {
  const raw = asRecord(value, 'catalog item')
  return {
    ...(raw as unknown as CatalogItem),
    unitPrice: parseMoney(raw['unitPrice']),
    costPrice: optionalMoney(raw['costPrice']),
  }
}

export function parseOrderLine(value: unknown): OrderLine {
  const raw = asRecord(value, 'order line')
  return {
    ...(raw as unknown as OrderLine),
    unitPrice: parseMoney(raw['unitPrice']),
    discount: optionalMoney(raw['discount']),
    gross: parseMoney(raw['gross']),
    net: parseMoney(raw['net']),
    tax: parseMoney(raw['tax']),
  }
}

export function parseTender(value: unknown): Tender {
  const raw = asRecord(value, 'tender')
  return {
    ...(raw as unknown as Tender),
    amount: parseMoney(raw['amount']),
    tendered: optionalMoney(raw['tendered']),
    change: optionalMoney(raw['change']),
  }
}

export function parseOrder(value: unknown): Order {
  const raw = asRecord(value, 'order')
  return {
    ...(raw as unknown as Order),
    lines: asArray(raw['lines'], 'order lines').map(parseOrderLine),
    tenders: asArray(raw['tenders'], 'tenders').map(parseTender),
    gross: parseMoney(raw['gross']),
    net: parseMoney(raw['net']),
    tax: parseMoney(raw['tax']),
    discount: optionalMoney(raw['discount']),
    refunded: parseMoney(raw['refunded']),
  }
}

/**
 * Reads either half of a checkout's answer.
 *
 * The discriminant is in the body rather than the status code, because a client
 * that has to remember which codes mean what is a client that will one day
 * print a receipt for a sale that has not happened.
 */
export function parseCheckoutResult(value: unknown): CheckoutResult {
  const raw = asRecord(value, 'checkout')
  if (raw['status'] !== 'awaiting_payment') return parseOrder(raw)
  return {
    ...(raw as unknown as PaymentPending),
    amount: parseMoney(raw['amount']),
  }
}

export function parseTakings(value: unknown): Takings {
  const raw = asRecord(value, 'takings')
  return {
    ...(raw as unknown as Takings),
    gross: parseMoney(raw['gross']),
    net: parseMoney(raw['net']),
    tax: parseMoney(raw['tax']),
    refunded: parseMoney(raw['refunded']),
    byMethod: asArray(raw['byMethod'], 'takings by method').map((entry) => {
      const row = asRecord(entry, 'takings row')
      return { ...(row as unknown as Takings['byMethod'][number]), amount: parseMoney(row['amount']) }
    }),
    byTaxBand: asArray(raw['byTaxBand'], 'takings by tax band').map((entry) => {
      const row = asRecord(entry, 'tax band')
      return {
        ...(row as unknown as Takings['byTaxBand'][number]),
        net: parseMoney(row['net']),
        tax: parseMoney(row['tax']),
        gross: parseMoney(row['gross']),
      }
    }),
  }
}

export function parseBooking(value: unknown): Booking {
  const raw = asRecord(value, 'booking')
  return { ...(raw as unknown as Booking), deposit: optionalMoney(raw['deposit']) }
}

export function parsePayment(value: unknown): Payment {
  const raw = asRecord(value, 'payment')
  return {
    ...(raw as unknown as Payment),
    amount: parseMoney(raw['amount']),
    refunded: parseMoney(raw['refunded']),
  }
}

export function parseDocument(value: unknown): FiscalDocument {
  const raw = asRecord(value, 'document')
  return {
    ...(raw as unknown as FiscalDocument),
    gross: parseMoney(raw['gross']),
    net: parseMoney(raw['net']),
    tax: parseMoney(raw['tax']),
  }
}

export function parseDayClose(value: unknown): DayClose {
  const raw = asRecord(value, 'day close')
  return {
    ...(raw as unknown as DayClose),
    openingFloat: parseMoney(raw['openingFloat']),
    cashTaken: parseMoney(raw['cashTaken']),
    cashRefunded: parseMoney(raw['cashRefunded']),
    expectedCash: parseMoney(raw['expectedCash']),
    countedCash: optionalMoney(raw['countedCash']),
    variance: optionalMoney(raw['variance']),
  }
}

export function parseSubscription(value: unknown): Subscription {
  const raw = asRecord(value, 'subscription')
  return { ...(raw as unknown as Subscription), amount: parseMoney(raw['amount']) }
}

export function parseBootstrap(value: unknown): Bootstrap {
  const raw = asRecord(value, 'bootstrap')
  asRecord(raw['session'], 'session')
  asRecord(raw['profile'], 'profile')
  asRecord(raw['entitlement'], 'entitlement')
  return raw as unknown as Bootstrap
}

export function parseList<T>(value: unknown, parse: (entry: unknown) => T, what: string): T[] {
  return asArray(value, what).map(parse)
}

export function parseDiscount(value: unknown): Discount {
  const raw = asRecord(value, 'discount')
  return { ...(raw as unknown as Discount), minimumBasket: optionalMoney(raw['minimumBasket']) }
}

export function parseLoyaltyProgramme(value: unknown): LoyaltyProgramme {
  const raw = asRecord(value, 'loyalty programme')
  return { ...(raw as unknown as LoyaltyProgramme), pointValue: parseMoney(raw['pointValue']) }
}

/* -------------------------------------------------------------- analytics */

const parseFreshness = (value: unknown) => {
  if (value === null || value === undefined) return { through: null }
  const raw = asRecord(value, 'freshness')
  return { through: typeof raw['through'] === 'string' ? raw['through'] : null }
}

const count = (value: unknown): number => {
  // Counts cross the wire as numbers, but a 64-bit one from protobuf arrives
  // as a string. Both are counts of sales, so both are read the same way.
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0
}

function parseTotals(value: unknown): ReportTotals {
  const raw = asRecord(value, 'totals')
  return {
    gross: parseMoney(raw['gross']),
    net: parseMoney(raw['net']),
    tax: parseMoney(raw['tax']),
    discount: parseMoney(raw['discount']),
    refunded: parseMoney(raw['refunded']),
    // Null here means "not answerable", never "zero". optionalMoney keeps the
    // two apart, which is the whole point of the field.
    cost: optionalMoney(raw['cost']),
    margin: optionalMoney(raw['margin']),
    orders: count(raw['orders']),
    customers: count(raw['customers']),
    averageBasket: parseMoney(raw['averageBasket']),
    averageLinesPerOrderMilli: count(raw['averageLinesPerOrderMilli']),
  }
}

export function parseReportSummary(value: unknown): ReportSummary {
  const raw = asRecord(value, 'summary')
  const before = asRecord(raw['previousPeriod'], 'previousPeriod')
  return {
    current: parseTotals(raw['current']),
    previous: parseTotals(raw['previous']),
    previousPeriod: { from: String(before['from']), to: String(before['to']) },
    freshness: parseFreshness(raw['freshness']),
  }
}

export function parseReportSeries(value: unknown): ReportSeries {
  const raw = asRecord(value, 'series')
  return {
    points: asArray(raw['points'], 'points').map((point) => {
      const day = asRecord(point, 'day')
      return {
        date: String(day['date']),
        gross: parseMoney(day['gross']),
        net: parseMoney(day['net']),
        tax: parseMoney(day['tax']),
        margin: optionalMoney(day['margin']),
        orders: count(day['orders']),
        customers: count(day['customers']),
      }
    }),
    freshness: parseFreshness(raw['freshness']),
  }
}

function parseSlice(value: unknown): ReportSlice {
  const raw = asRecord(value, 'slice')
  return {
    key: String(raw['key'] ?? ''),
    label: String(raw['label'] ?? ''),
    gross: parseMoney(raw['gross']),
    shareBasisPoints: count(raw['shareBasisPoints']),
    orders: count(raw['orders']),
  }
}

export function parseReportBreakdown(value: unknown): ReportBreakdown {
  const raw = asRecord(value, 'breakdown')
  return {
    slices: asArray(raw['slices'], 'slices').map(parseSlice),
    other: raw['other'] === null || raw['other'] === undefined ? null : parseSlice(raw['other']),
    freshness: parseFreshness(raw['freshness']),
  }
}

export function parseReportHeatmap(value: unknown): ReportHeatmap {
  const raw = asRecord(value, 'heatmap')
  return {
    cells: asArray(raw['cells'], 'cells').map((cell) => {
      const c = asRecord(cell, 'cell')
      return {
        weekday: count(c['weekday']),
        hour: count(c['hour']),
        orders: count(c['orders']),
        gross: parseMoney(c['gross']),
      }
    }),
    freshness: parseFreshness(raw['freshness']),
  }
}

/* ------------------------------------------------------------------ ledger */

export type AccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export interface LedgerAccount {
  readonly code: string
  readonly name: string
  readonly kind: AccountKind
  readonly builtin: boolean
}

export interface TrialBalanceRow {
  readonly account: LedgerAccount
  readonly balance: Money
  readonly debit: Money
  readonly credit: Money
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[]
  readonly totalDebits: Money
  readonly totalCredits: Money
  readonly balanced: boolean
}

export interface JournalLine {
  readonly account: string
  /** A signed debit: positive is a debit, negative is a credit. */
  readonly amount: Money
  readonly memo: string
}

export interface JournalEntry {
  readonly id: string
  readonly kind: string
  readonly memo: string
  readonly referenceType: string
  readonly referenceId: string
  readonly reversesId: string
  readonly reversedById: string
  readonly lines: readonly JournalLine[]
  readonly occurredAt: string
}

const parseAccount = (value: unknown): LedgerAccount => {
  const raw = asRecord(value, 'account')
  return {
    code: text(raw['code']),
    name: text(raw['name']),
    kind: text(raw['kind']) as LedgerAccount['kind'],
    builtin: raw['builtin'] === true,
  }
}

/**
 * The trial balance, with every amount through parseMoney.
 *
 * The wire carries minor units as a string, because an int64 through JSON is a
 * number that quietly loses digits. Typing the response as Money without
 * parsing it would compile and would be a lie: the field would say number and
 * hold a string, and the first arithmetic on it would concatenate.
 */
export function parseTrialBalance(value: unknown): TrialBalance {
  const raw = asRecord(value, 'trial balance')
  const rows = Array.isArray(raw['rows']) ? raw['rows'] : []
  return {
    rows: rows.map((row) => {
      const r = asRecord(row, 'trial balance row')
      return {
        account: parseAccount(r['account']),
        balance: parseMoney(r['balance']),
        debit: parseMoney(r['debit']),
        credit: parseMoney(r['credit']),
      }
    }),
    totalDebits: parseMoney(raw['totalDebits']),
    totalCredits: parseMoney(raw['totalCredits']),
    // Taken as the service reported it. A screen that worked this out for
    // itself would be a second opinion, and the one thing a set of books must
    // not have is two answers.
    balanced: raw['balanced'] === true,
  }
}

export function parseJournalEntry(value: unknown): JournalEntry {
  const raw = asRecord(value, 'journal entry')
  const lines = Array.isArray(raw['lines']) ? raw['lines'] : []
  return {
    id: text(raw['id']),
    kind: text(raw['kind']),
    memo: text(raw['memo']),
    referenceType: text(raw['referenceType']),
    referenceId: text(raw['referenceId']),
    reversesId: text(raw['reversesId']),
    reversedById: text(raw['reversedById']),
    lines: lines.map((line) => {
      const l = asRecord(line, 'journal line')
      return {
        account: text(l['account']),
        amount: parseMoney(l['amount']),
        memo: text(l['memo']),
      }
    }),
    occurredAt: text(raw['occurredAt']),
  }
}
