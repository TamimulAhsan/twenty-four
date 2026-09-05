import type { PartialTermSet, TermSet } from './keys'

/**
 * The base set. Complete, trade-neutral, and deliberately dull: every word here
 * is one a merchant in any trade would understand, even if it is not the word
 * they would choose.
 */
export const BASE_TERMS: TermSet = {
  catalog: { one: 'Catalog', other: 'Catalogs' },
  catalog_item: { one: 'Item', other: 'Items' },
  catalog_category: { one: 'Category', other: 'Categories' },
  catalog_modifier: { one: 'Option', other: 'Options' },
  order: { one: 'Order', other: 'Orders' },
  order_line: { one: 'Line', other: 'Lines' },
  booking: { one: 'Booking', other: 'Bookings' },
  customer: { one: 'Customer', other: 'Customers' },
  staff_member: { one: 'Staff member', other: 'Staff' },
  location: { one: 'Location', other: 'Locations' },
  resource: { one: 'Resource', other: 'Resources' },
  duration: { one: 'Duration', other: 'Durations' },
  receipt: { one: 'Receipt', other: 'Receipts' },
  no_show: { one: 'No-show', other: 'No-shows' },
}

/**
 * Trade vocabularies. Each supplies only what differs from base.
 *
 * These are content, versioned with the industry templates, not a service and
 * not a deployment. Onboarding trade 41 adds an entry here and ships.
 */
export const INDUSTRY_TERMS: Readonly<Record<string, PartialTermSet>> = {
  food_service: {
    catalog: { one: 'Menu', other: 'Menus' },
    catalog_item: { one: 'Dish', other: 'Dishes' },
    catalog_category: { one: 'Course', other: 'Courses' },
    catalog_modifier: { one: 'Extra', other: 'Extras' },
    order: { one: 'Order', other: 'Orders' },
    booking: { one: 'Reservation', other: 'Reservations' },
    customer: { one: 'Guest', other: 'Guests' },
    staff_member: { one: 'Server', other: 'Servers' },
    resource: { one: 'Table', other: 'Tables' },
    duration: { one: 'Prep time', other: 'Prep times' },
    receipt: { one: 'Bill', other: 'Bills' },
  },

  salon: {
    catalog: { one: 'Service list', other: 'Service lists' },
    catalog_item: { one: 'Treatment', other: 'Treatments' },
    catalog_category: { one: 'Service type', other: 'Service types' },
    catalog_modifier: { one: 'Add-on', other: 'Add-ons' },
    booking: { one: 'Appointment', other: 'Appointments' },
    customer: { one: 'Client', other: 'Clients' },
    staff_member: { one: 'Stylist', other: 'Stylists' },
    resource: { one: 'Chair', other: 'Chairs' },
    duration: { one: 'Treatment time', other: 'Treatment times' },
  },

  retail: {
    catalog: { one: 'Product list', other: 'Product lists' },
    catalog_item: { one: 'Product', other: 'Products' },
    catalog_category: { one: 'Department', other: 'Departments' },
    catalog_modifier: { one: 'Variant', other: 'Variants' },
    order: { one: 'Sale', other: 'Sales' },
    staff_member: { one: 'Team member', other: 'Team' },
    location: { one: 'Store', other: 'Stores' },
  },

  accommodation: {
    catalog: { one: 'Room types', other: 'Room types' },
    catalog_item: { one: 'Room', other: 'Rooms' },
    catalog_category: { one: 'Room class', other: 'Room classes' },
    booking: { one: 'Reservation', other: 'Reservations' },
    customer: { one: 'Guest', other: 'Guests' },
    resource: { one: 'Room', other: 'Rooms' },
    duration: { one: 'Length of stay', other: 'Lengths of stay' },
  },

  trades: {
    catalog: { one: 'Price list', other: 'Price lists' },
    catalog_item: { one: 'Job type', other: 'Job types' },
    booking: { one: 'Job', other: 'Jobs' },
    staff_member: { one: 'Technician', other: 'Technicians' },
    resource: { one: 'Vehicle', other: 'Vehicles' },
    duration: { one: 'Time on site', other: 'Times on site' },
  },
}

/**
 * Per-trade corrections on top of the family.
 *
 * A vocabulary family is a useful approximation and a bad final answer. One
 * food_service set covers restaurants, cafes, bakeries, food trucks and
 * caterers, and only the restaurant actually says Dish, Guest and Server. A
 * bakery selling dishes to guests reads like software that has never seen a
 * bakery.
 *
 * So a profile may correct its family. Most do not need to; the ones that do
 * only name the handful of words that are wrong for them.
 */
export const PROFILE_TERMS: Readonly<Record<string, PartialTermSet>> = {
  cafe: {
    // The menu is right. Everything else in the restaurant set is not: a flat
    // white is not a dish, a counter has no covers, and nobody waits tables.
    catalog_item: { one: 'Item', other: 'Items' },
    catalog_category: { one: 'Category', other: 'Categories' },
    customer: { one: 'Customer', other: 'Customers' },
    staff_member: { one: 'Barista', other: 'Baristas' },
    receipt: { one: 'Receipt', other: 'Receipts' },
  },
  bakery: {
    catalog: { one: 'Range', other: 'Ranges' },
    catalog_item: { one: 'Product', other: 'Products' },
    catalog_category: { one: 'Category', other: 'Categories' },
    customer: { one: 'Customer', other: 'Customers' },
    staff_member: { one: 'Team member', other: 'Team' },
    receipt: { one: 'Receipt', other: 'Receipts' },
  },
  food_truck: {
    catalog_item: { one: 'Item', other: 'Items' },
    catalog_category: { one: 'Category', other: 'Categories' },
    customer: { one: 'Customer', other: 'Customers' },
    staff_member: { one: 'Team member', other: 'Team' },
    receipt: { one: 'Receipt', other: 'Receipts' },
  },
  ice_cream: {
    catalog_item: { one: 'Flavour', other: 'Flavours' },
    catalog_category: { one: 'Category', other: 'Categories' },
    customer: { one: 'Customer', other: 'Customers' },
    staff_member: { one: 'Team member', other: 'Team' },
    receipt: { one: 'Receipt', other: 'Receipts' },
  },
  catering: {
    customer: { one: 'Client', other: 'Clients' },
    booking: { one: 'Event', other: 'Events' },
    staff_member: { one: 'Team member', other: 'Team' },
  },
  bar_pub: {
    catalog_item: { one: 'Item', other: 'Items' },
    staff_member: { one: 'Bartender', other: 'Bartenders' },
  },
  pizzeria: {
    catalog_item: { one: 'Pizza', other: 'Pizzas' },
  },
  barbershop: {
    staff_member: { one: 'Barber', other: 'Barbers' },
    catalog_item: { one: 'Service', other: 'Services' },
  },
  gym: {
    catalog_item: { one: 'Class', other: 'Classes' },
    customer: { one: 'Member', other: 'Members' },
    staff_member: { one: 'Instructor', other: 'Instructors' },
    booking: { one: 'Session', other: 'Sessions' },
  },
  yoga_studio: {
    catalog_item: { one: 'Class', other: 'Classes' },
    customer: { one: 'Member', other: 'Members' },
    staff_member: { one: 'Teacher', other: 'Teachers' },
    booking: { one: 'Session', other: 'Sessions' },
  },
  dental_clinic: {
    catalog_item: { one: 'Procedure', other: 'Procedures' },
    customer: { one: 'Patient', other: 'Patients' },
    staff_member: { one: 'Clinician', other: 'Clinicians' },
  },
  veterinary: {
    catalog_item: { one: 'Procedure', other: 'Procedures' },
    customer: { one: 'Client', other: 'Clients' },
    staff_member: { one: 'Vet', other: 'Vets' },
  },
  physiotherapy: {
    customer: { one: 'Patient', other: 'Patients' },
    staff_member: { one: 'Physiotherapist', other: 'Physiotherapists' },
  },
  pharmacy: {
    customer: { one: 'Patient', other: 'Patients' },
    staff_member: { one: 'Pharmacist', other: 'Pharmacists' },
  },
  photographer: {
    catalog_item: { one: 'Package', other: 'Packages' },
    booking: { one: 'Shoot', other: 'Shoots' },
  },
  hostel: {
    catalog_item: { one: 'Bed', other: 'Beds' },
    resource: { one: 'Bed', other: 'Beds' },
  },
  apartment_rental: {
    catalog_item: { one: 'Apartment', other: 'Apartments' },
    resource: { one: 'Apartment', other: 'Apartments' },
  },
}

export function industryTerms(industry: string): PartialTermSet {
  return INDUSTRY_TERMS[industry] ?? {}
}

export function profileTerms(profile: string): PartialTermSet {
  return PROFILE_TERMS[profile] ?? {}
}
