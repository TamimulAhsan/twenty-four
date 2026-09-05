# TwentyFour Merchant Frontend

Four applications, one design system, one origin. What is built, why it is
shaped this way, and what comes next.

Reference: [`system-architecture.html`](system-architecture.html) §1, §4, §6, §7, §11, §14.
Rules this code must respect: [`CLAUDE.md`](CLAUDE.md). Backend sequencing: [`roadmap.md`](roadmap.md).

> **No backend yet.** Every screen runs against a stateful mock that speaks the
> intended Merchant BFF contract over real HTTP. Connecting the live gateway is
> deleting one dynamic import; no component changes.

---

## Four applications, not one dashboard

| Application | Path | Device it lives on | Bundle |
|---|---|---|---|
| **Merchant dashboard** | `/` | A desk. Analysis, money, configuration, the team. | 312 kB |
| **Point of sale** | `/pos` | A tablet at a counter, full screen, touched all day. | 162 kB |
| **Bookings and appointments** | `/bookings` | A screen behind a desk, watched all day. | 96 kB |
| **Sign in** | `/auth` | Wherever somebody arrives without a session. | 51 kB |

Four applications, four builds, four images, four Deployments. Taking one down
scales it to zero and Traefik serves the unavailable page in its place; the
other three are untouched.

**The catalog belongs to the applications, not the back office.** It is edited on
the device that sells from it, so the till owns it and the calendar owns the
bookable slice of it. Both read the same Catalog service; neither keeps its own
prices. The dashboard has no catalog screen at all, and an old link lands on a
page that points at whichever application the tenant holds.

**The team is inherited, not duplicated.** Seats, roles and invitations are one
thing in one place, and that place is the dashboard. The till and the calendar
show the team read-only, because both need to put a name against a sale or an
appointment, and neither should be able to grant access. Two screens that can
both grant access are two screens that can disagree.

The dashboard launches the other two into their own tab. It does not contain
them. A till and a calendar have nothing in common with a reporting screen
except the data underneath, and putting all three behind one sidebar
compromises each of them for the other two.

**Separate bundles, one origin.** Separate bundles because the till should not
carry the reporting code. One origin because the session cookie is issued on the
parent domain: put the till on another origin and a merchant who opens it from
the dashboard has to sign in again. This is exactly what the NGINX frontend pod
in §1 serves.

Shared vendor chunk is 312 kB (99 kB gzipped). MSW itself is behind an
`import.meta.env.DEV` guard and a dynamic import in `boot`, so the service
worker and the handlers never reach a merchant.

**The fixtures still do.** `DevToolbar` imports `@twentyfour/mock` statically,
and its `lazy()` splits nothing because the component sits in the same module,
so the stateful store, the seed data and all three tenants are bundled into
every application behind a component that returns `null` in production. Fixing
it is moving that import inside the lazy factory. Until then the claim that
none of the mock reaches a merchant is true only of MSW.

---

## Four rules the frontend inherits

These come from `CLAUDE.md`. Each is cheap to enforce structurally on day one
and expensive to retrofit later.

| Rule | How it is held |
|---|---|
| **Money is integer minor units, never a float** | A branded `MinorUnits` type. All arithmetic in `packages/money`, a port of `pricing.go` including `divRoundHalfUp`. Its Go test cases are ported to TypeScript, so both implementations must agree. |
| **A display term is never a key** | Routes, query keys and API paths stay semantic. Words come from `useTerm()` at render. A test walks every route and rejects trade words. |
| **A trade word names an operational concept, not an administrative one** | "Who is doing this appointment" is a Stylist. "Who has a login" is not, because that list holds the owner and the bookkeeper. Account screens use fixed labels and never call the resolver. |
| **Nav renders from the entitlement record** | One bootstrap call returns entitlements, term set and profile. `buildNav()` derives the sidebar. Documented as **UX only**: the gateway is the security control, and the mock refuses unentitled calls so the app cannot drift into relying on its own gates. |
| **No country logic** | Currency, locale and tax arrive on the tenant profile. Reporting state is a generic enum, never a tax authority's name. Payment methods are data, so the swappable Payments pod changes nothing here. |

A fifth, from §4: **core module screens must be trade-neutral.** Which is what
the fixtures are for.

---

## The fixtures are the trade-neutrality test

Three tenants, three trades, three tiers, switched live from a dev toolbar.

| Fixture | Trade | Tier | What it proves |
|---|---|---|---|
| Nyolcas Kávézó | Cafe | Growth | Kitchen display appears in POS, from the **profile**. Reads Menu, Dish, Server. |
| Aranyhíd Szalon | Hair salon | Starter | Short sidebar, no Grow group, seat quota bites at 3. Reads Service list, Treatment, Stylist. |
| Váci Butik | Boutique | Max | Full sidebar including the CRM launch. No kitchen anywhere. Reads Product list, Product. |

All three on HUF, exponent 0, which catches every place a `/100` was assumed.
Flipping between them changes every visible word, shows or hides the kitchen,
and lengthens or shortens the sidebar. It changes no layout and no behaviour.
If it ever does, that is the bug §4 warns about, visible here rather than in
production.

---

## One gutter, one definition

Every page goes through `PageBody`, which owns the gutter and the width cap.

| | Scale | Where |
|---|---|---|
| `PAGE_GUTTER` | 16 / 24 / 32 at 640 and 1024 | Every page, equal on all four sides |
| `DENSE_GUTTER` | 16 / 20 | The till and the prep screen |
| `PAGE_MAX_WIDTH` | 110rem | Only engages on an ultrawide |

The till and the prep screen stop one step short because they are not
documents: they never scroll past their own frame, they are read from a metre
away, and every pixel spent on margin is a key that does not fit. Two named
scales with a stated reason, rather than thirteen numbers nobody chose.

## Every row leads somewhere

A row in a table is a summary, and the question a merchant has about a summary
is always what was actually in it. So every list opens a detail view, and every
create button opens a form.

| From | Opens |
|---|---|
| Any order row, on three pages | The sale in full: lines with their own tax, what it kept, tenders, documents issued, and void or refund |
| A payment | The authorise to capture to refund timeline, provider reference, and the sale behind it |
| An invoice or receipt | The document as recorded, the immutability rule, and the correction flow |
| A product row | Its verdict and the action, trend, who buys it, what it sells with |
| A catalog row | The item form, with margin computed live as you type |
| A coupon | Its return, basket lift, and whether to pause it |
| A member, a role, a table, a booking, a person | Their own detail, each with the actions permitted to the viewer |

**Settings**, the last F2 item, in four tabs. Business details and the business
type behind a confirmation, because changing it changes what everything is
called and which screens exist. Tax rates, with the warning that flipping
"prices include tax" moves what you charge by the whole rate without a single
figure on screen changing. **Words**, which is the third cascade layer finally
reachable: a hotel that says Suite rather than Room changes one field and it
changes everywhere, including on receipts. Notifications with quiet hours.

**Create forms that existed only as buttons:** new coupon, new catalog item,
new role, loyalty programme settings, tier change, and a reach-out draft
written from the customer's segment.

**Custom roles.** Four built-ins plus whatever a tenant defines. Two guards
make it safe rather than a privilege-escalation surface: a role can only
contain permissions its author holds, and a custom role always sits below
Manager, because letting a tenant mint a rank above their own is escalation
with extra steps. Both are tested.

## Layout

```
platform/services/web/
├── apps/                    four builds, four images, one origin
│   ├── dashboard/           the back office
│   ├── pos/                 the till
│   ├── bookings/            the calendar
│   ├── auth/                the one sign-in form in the product
│   └── unavailable/         static page Traefik serves for a scaled-down app
└── packages/
    ├── tokens/              palette, type, motion, the Tailwind theme
    ├── ui/                  buttons, fields, tables, dialogs, toasts, charts, page shell
    ├── money/               MinorUnits, pricing, formatting   <- port of pricing.go
    ├── terms/               four-layer term cascade + useTerm()
    ├── entitlement/         modules, tiers, profiles, nav, launchers
    ├── rbac/                permissions, roles, lockout rules
    ├── analytics/           RFM, cohorts, Pareto, basket lift, discount return
    ├── api/                 typed Merchant BFF client
    ├── mock/                stateful store + MSW handlers (dev only)
    ├── runtime/             bootstrap providers shared by every app
    └── shell/               boot, session gate, dev toolbar, refunds, catalog, team
```

Anything two applications both do lives in `shell`, not in one of them with a
copy in the other. Refunding is the clearest case: the till does it with the
customer at the counter and the dashboard does it a week later at a desk, and
they must not be able to disagree about which lines have already gone back.

---

## What is built

**Foundation.** Design tokens on a three-layer architecture (primitives,
semantic roles, utilities) with a hand-built light and dark palette; Archivo and
IBM Plex Mono self-hosted; Lucide icons on one stroke weight; 80 tests green.

**Merchant dashboard.** Overview with app launchers and the day's figures;
Analytics; Catalog; Inventory with reasoned adjustments; Orders; Team with full
staff and role management; Payments; Invoices and receipts; Subscription with
tier comparison and the self-serve split. Marketing, Creative, Website, Payouts
and Settings are routed placeholders that name their phase.

**The analysis hub.** Five screens over one tested engine.

| Screen | Answers |
|---|---|
| **Overview** | What is worth doing something about this week, derived and ranked |
| **Financials** | Takings to margin line by line, revenue by day against the previous window, when the money arrives, and every transaction with its own cost and margin |
| **Products** | Which items to push, reprice or drop, on a quadrant whose dividers are the same thresholds the verdicts use, plus Pareto class, velocity, dead stock and basket affinity |
| **Customers** | Nine RFM segments each carrying its action, cohort retention, and a per-customer page with spend pattern, cadence and how overdue they are against their own rhythm |
| **Coupons and discounts** | What each code cost, what it brought back, and whether it paid for itself |
| **Loyalty** | Whether members come back more than everyone else, and what the points balance owes |

**`packages/analytics` is where the value is.** Pure functions, no React, 29
tests. It computes RFM quintiles, cohort retention, Pareto/ABC classing, a
volume-against-margin verdict, basket lift by market-basket affinity, discount
return against an undiscounted baseline, and period comparison. These are the
calculations that go wrong silently, so they are tested before they are drawn.

Three rules it holds to, each of which a dashboard usually breaks:

- **A partial margin is not a margin.** One line with no cost recorded makes the
  whole figure null rather than an average over the lines that happen to have one.
- **A change from zero is not a percentage.** It returns null, and the caller has
  to decide what to show.
- **Tax is never revenue.** It was collected on someone else's behalf, so it never
  sits inside a revenue figure or a margin.

**Charts are hand-built SVG on a validated palette.** Both light and dark sets
were run through the validator: worst adjacent CVD separation 9.1 light and 8.4
dark against an 8.0 target, worst normal-vision separation 19.6 and 19.3 against
a 15 floor. Three light-mode hues sit under 3:1 on white, so every chart using
them ships direct labels or a table beside it. Scatter forms are capped at three
series, because with every pair on screen at once no ordering of the full eight
clears the floors.

**Staff and roles.** Four built-in roles (owner, manager, bookkeeper, staff) over
26 permissions, with a side-by-side matrix so the comparative question, "what
changes if I make them a manager", is answerable at a glance. Directory covers
invite, role change, deactivate, restore, resend and withdraw. Two invariants are
enforced on both sides of the wire: **there is always at least one owner**, and
**nobody can change their own role**, which is what stops an account quietly
promoting itself. Permissions are filtered by entitlement, so a permission whose
module the tenant does not hold is absent rather than greyed out. The bill stays
with the owner: a manager who could change the plan could change what the
business is charged without being the person paying.

**Point of sale.** Till with category rail, item keys and a live cart; tender
with cash suggestions and change; receipt; orders with void and refund; the
catalog, named by the term set; the team, read-only; day close with the tax band
split. Two trade capabilities the profile switches on and nobody chooses:
**kitchen display** wherever food is made to order, and **tables** wherever
customers sit down. A food truck gets the first and not the second.

**Point of sale, F3.** Five things a counter cannot work without.

**Split tender.** A sale takes as many payments as it needs to. Each is applied
against what is still owed, so a split can never record more money than the
sale was worth, and only cash may be handed over in excess of the balance,
because change comes out of a drawer and no card gives any back.

**Parking a sale.** A rung-up sale set aside: a tab on a table, or a basket
held while somebody goes to the car for their card. It is an order with status
`open`, which the type already had and nothing had ever produced. It **reserves
stock rather than selling it**, which is what `StockLevel.reserved` was for and
had been zero everywhere until now: the goods are spoken for and must not be
sold twice, but they have not left, and an inventory count that treats a held
basket as gone is short every time a tab is abandoned. It issues no document,
appears in no order list, and counts towards no takings, no revenue and no
margin until somebody pays for it. Settling it keeps the same order: same id,
same number, same lines at the prices they were rung up at.

**Partial refunds.** A line goes back once, and the second attempt is refused
rather than paying it out twice. The credit note is for what actually went
back, not for the sale. The day's refunded figure is the sum of what was
returned rather than the total of every order whose status happens to read
*refunded*, and a refund is put back on the payment that took it, split across
the tenders in proportion to what each of them paid.

**Counting the drawer.** Expected cash is `opening float + cash taken − cash
refunded`, built from what was actually tendered rather than from the day's
total, because a card sale never went near the drawer. The variance is stated
as short or over, and a recount replaces rather than appends. There is
deliberately **no note and coin breakdown**: which denominations exist is the
one part of counting a drawer that differs per market, and a note table in
shared code is country logic wearing a hat.

**A tab on a table.** A table holds at most one open sale. A second one is
refused, and a table cannot be cleared while a tab is still on it, because
clearing it strands a sale nothing on the floor points at any more. Settling
takes the tab off and leaves the table exactly as it was: people sit on after
they have paid, and clearing it for them is the till guessing.

**Refunding is one implementation, used twice.** `packages/shell/refund` owns
which lines can still go back, what they come to, the confirmation copy and the
mutation. The till composes it into a list read at arm's length; the dashboard
composes it into its own table with a checkbox column, gated on `pos.refund`
and `pos.void`, so an owner can give back one line of a sale from their desk a
week later. Two implementations of "which lines have already gone back" is two
answers to it, and only one of them is right.

**Bookings.** Day calendar as staff columns, agenda list on a phone; new booking
with double-booking refusal; detail with arrived, completed, no-show and cancel;
the bookable slice of the catalog, with duration; the team, read-only; opening
hours and the rules behind the slots.

**Collapsible sidebar.** Icons only at 64px, group headings replaced by rules,
tooltips and accessible names carrying the labels. Persisted, because someone who
collapsed it to get more table on screen wants it collapsed tomorrow.

---

## Defects found and fixed while building

Worth recording, because each was invisible until the screen existed.

| Defect | Why it mattered |
|---|---|
| Term sets keyed by family, profiles by business type, nothing mapping between | Every tenant silently fell back to base vocabulary. A restaurant read "Item" and "Catalog". |
| `listOrders` claimed newest first, returned insertion order | The dashboard's own description was false. |
| Seeded history sold stock it had not stocked | Every tracked line showed negative on hand. |
| Receipt printed the applied amount as cash tendered | "Cash 14 000 / Change 6 000" does not reconcile for the person holding it. |
| Kitchen display showed the whole day, newest first | A kitchen works oldest first, and a rail of four-hour-old tickets is noise. |
| Sign-in brand panel flipped to white in dark mode | A brand canvas that inverts reads as a rendering fault. |
| MSW shipped in the production bundle | 300 kB of code that can never run in production. |
| Seat card read "6 of 15 in use" beside "10 seats left" | A deactivated account is in the list but does not hold a seat. Both figures now come from one function. |
| Pareto put a product that was 96% of the business into class C | Classing on the cumulative total *after* adding a row puts the row that crosses the threshold outside it. Measured before, now. |
| RFM could not award a 5 on a small sample | Nothing is greater than the maximum, so value cuts cannot. Ranked by position instead: a business with four customers still has a best one. |
| "Needs attention" was the largest segment in every fixture | It was the fall-through bucket, so the label told a merchant to act on half their book. Split into Occasional and Needs attention. |
| Basket lift was negative on every working code | It compared post-discount gross, so it measured the discount rather than behaviour. Measured before the code comes off, now. |
| The quadrant chart contradicted its own table | Dividers sat at half the maximum while verdicts were classed against the median, so a "hidden gem" could land in "consider dropping". Both use one threshold now. |
| Every loyalty member sat in Bronze | Tier thresholds assumed a different earn rate from the one the programme actually uses, and the label said "1 point per unit" for an arithmetic giving one per hundred. |
| A bakery sold "Dishes" to "Guests" served by "Servers" | One `food_service` vocabulary covered restaurants, cafes, bakeries, food trucks and caterers, and only the restaurant fits. A fourth cascade layer was added so a business type can correct its family. |
| The account screen was labelled "Servers" | It manages logins, and its rows include owners, managers and bookkeepers. The trade word was on a surface it does not describe. Administrative screens now use fixed labels. |
| Thirteen page containers, thirteen paddings | The dashboard ran 16/24/32 horizontally against 24/32 vertically; the till and the calendar ran 12/16 on all sides. Nothing looked wrong alone and nothing matched across two screens. One `PageBody` owns it now. |
| Content sat in a column with dead space either side | A `max-w-7xl` cap plus a spread of narrower inner caps meant a 1440 monitor showed 1280 of content. The cap is now well above any ordinary screen, so it only engages on an ultrawide. |
| Six tables looked clickable and were not | Rows carried the interactive style with no handler behind it, and twelve buttons did nothing at all. Every one now opens something. |
| An order's totals did not add up | Net plus tax equalled the total, and a discount row sat between them as if it were a further deduction. It is already inside every line, so it moved out of the sum and says so. |
| "Tap a item to start" | An article hardcoded in front of a word that varies by trade. Every trade saying Item, Order or Appointment hit it. The article is part of the vocabulary now and resolved with it. |
| Time inputs read "08:00 AM" on a Hungarian till | A native time input formats from the browser's locale, not the page's. `lang` is the one lever that moves it. |
| Sidebar collapse control sat under the dev toolbar | A floating dev chip was covering a real control. The toggle moved to the header, which is the better placement anyway. |
| Cash suggestion buttons wrote minor units into a decimal field | The button showed €10.00 and filled the field with `1000`, which parses as €1000. Invisible on the three HUF fixtures, where minor units and major units are the same number, and a hundredfold overcharge in any currency with an exponent. |
| A leftover `EDIT TEST:` string sat in the till's empty cart | Shipped in the empty state a cashier sees at the start of every sale. |
| A partial refund issued a credit note for the whole sale | The correction document was worth more than what went back, on every partial refund. |
| Nothing stopped a line being refunded twice | Two credit notes, two returns to stock and two payouts against a sale that happened once. |
| The day's refunded figure counted whole orders by status | A sale with one line of four returned counted as nothing. Now it is the sum of what was actually given back. |
| `frontend-plan.md` described a layout that no longer existed | It documented `apps/web/` with three entries in one build; the code has four applications with their own images and Deployments. |

---

## What is next

F3 is finished. What remains, in the order it earns its place:

| Phase | Work |
|---|---|
| **F4** | Week view, buffers, deposits taken at booking, rota grid |
| **F5** | The document viewer against the stored artifact rather than the recorded fields |
| **F6** | Marketing, Website builder, notification centre |
| **F7** | Marketing site in React, signup, and the 24-hour onboarding checklist |
| **Any** | Export: CSV, a print layout, a scheduled report |

## Open items

1. **The 24-hour onboarding flow is designed but not built.** The checklist
   fixture exists in the mock with the §11 hour 0/4/12/24 stages, including the
   two steps that cannot complete unattended. The screens are F7.
2. **Signup and the business type selector.** 43 industry profiles are defined
   and searchable; the form is not built.
3. **Offline till.** §7 says a third party being down must never block a sale.
   That is a backend guarantee, but a till that cannot queue a tender locally
   breaks it from the front. The tender flow is still shaped so queueing can be
   added without redesign: a payment is accepted against a balance and only the
   completed set is sent, so a queued one changes where the tenders go, not how
   they are taken.
4. **Document rendering.** The viewer must display a stored artifact, never a
   recomputation. Until Invoicing exists the mock must serve a fixed file, or
   the immutability rule gets designed away.
5. **Prices and seat counts** are still unset. They are Registry values and the
   apps read them from one place.
6. **Tables are a grid by area, not a drawn floor plan.** A real plan needs an
   editor and a canvas. A grid grouped by area answers the two questions a
   server actually has, which table is free and who has been waiting longest.
   A table now carries its open tab; what it still does not do is let a tab be
   moved between tables, or split between two parties.
7. **Exporting is still missing.** Every figure can be read and acted on, but
   nothing can be taken out: no CSV, no scheduled report, no print layout
   beyond what the browser gives. That is the next honest gap.
8. **Cost price is per item, not per batch.** Real margin moves with what you
   last paid a supplier. A single cost is right enough to make the analysis
   useful and wrong enough that a merchant reconciling to the penny will notice.
9. **The fixtures ship in the production bundle.** `DevToolbar` imports
   `@twentyfour/mock` statically, so the store, the seeds and all three tenants
   are in every application behind a component that renders nothing. MSW itself
   is correctly excluded. The fix is a dynamic import inside the lazy factory.
10. **A parked sale keeps one timestamp.** While it is parked, `placedAt` is
    when it was parked, and settling moves it to when it became a sale, so the
    receipt and the day's takings agree about which day it belongs to. Nothing
    then records how long the tab was open, which is a figure a restaurant
    would eventually want for table turn time.
11. **Roles are built in, not custom.** Four cover the shapes an SMB actually
    has. Custom permission sets are a real feature of the RBAC service and
    would need a builder screen, an audit trail per grant, and a rule
    preventing a role from granting more than its author holds. Not built until
    someone asks.
