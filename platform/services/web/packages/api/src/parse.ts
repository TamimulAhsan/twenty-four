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
  Order,
  OrderLine,
  Payment,
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
