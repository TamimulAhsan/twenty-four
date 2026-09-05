/**
 * The semantic vocabulary of the product.
 *
 * A hotel calls a catalog item a Room, a spa a Service, a restaurant a Dish and
 * a shop a Product. Same concept, same tables, same API, different word on
 * screen. These are the keys; the words are content.
 *
 * The rule that makes this safe: a display term is never a key. Database
 * columns, API paths, event payloads, analytics dimensions and search fields
 * stay semantic. If /api/rooms ever exists, hotel vocabulary is welded into the
 * platform and renaming a term implies a migration.
 *
 * Adding a trade means adding the dozen terms that differ from base. It is a
 * content change, not a release.
 */
export const TERM_KEYS = [
  /** The collection of what the business sells. Menu, price list, treatment list. */
  'catalog',
  /** One thing in it. Dish, product, treatment, room. */
  'catalog_item',
  /** How items are grouped. Category, course, department. */
  'catalog_category',
  /** An optional addition to an item. Extra, add-on, topping. */
  'catalog_modifier',
  /** A registered sale. Order, ticket, sale, tab. */
  'order',
  /** One row of it. */
  'order_line',
  /** A held slot in time. Booking, appointment, reservation. */
  'booking',
  /** The person paying. Customer, guest, client. */
  'customer',
  /** The person serving. Stylist, server, technician, therapist. */
  'staff_member',
  /** Where trade happens. Branch, store, salon, site. */
  'location',
  /** A bookable thing that is not a person. Table, chair, bay, room. */
  'resource',
  /** How long an item occupies a resource. Duration, prep time. */
  'duration',
  /** The document handed over at the end. Receipt, bill, check. */
  'receipt',
  /** What staff do to a booking when the customer never arrives. */
  'no_show',
] as const

export type TermKey = (typeof TERM_KEYS)[number]

/** Singular and plural, written as they appear at the start of a label. */
export interface Term {
  readonly one: string
  readonly other: string
}

/** A complete set. Only the base set is required to be complete. */
export type TermSet = Readonly<Record<TermKey, Term>>

/** What a trade or a tenant contributes: only the terms that differ. */
export type PartialTermSet = Readonly<Partial<Record<TermKey, Term>>>
