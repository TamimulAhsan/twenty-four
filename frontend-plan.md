# TwentyFour Frontend

Five applications, two planes, one design system. What is built, why it is
shaped this way, and what comes next.

Reference: [`system-architecture.html`](system-architecture.html) §1, §4, §6, §7, §10, §11, §14.
Rules this code must respect: [`CLAUDE.md`](CLAUDE.md). Backend sequencing: [`roadmap.md`](roadmap.md).

> **No backend yet.** Every screen runs against a stateful mock that speaks the
> intended contract over real HTTP. Connecting the live gateway is deleting one
> dynamic import; no component changes.

---

## Five applications, two planes

| Application | Host and path | Device it lives on | Bundle |
|---|---|---|---|
| **Merchant dashboard** | `app` `/` | A desk. Analysis, money, configuration, the team. | 327 kB |
| **Point of sale** | `app` `/pos` | A tablet at a counter, full screen, touched all day. | 172 kB |
| **Bookings and appointments** | `app` `/bookings` | A screen behind a desk, watched all day. | 132 kB |
| **Sign in and sign up** | `app` `/auth` | Wherever somebody arrives without a session. | 97 kB |
| **Admin console** | `admin` `/` | A specialist's desk, inside the office network. | 172 kB |

Five applications, five builds, five images, five Deployments. Taking one down
scales it to zero and Traefik serves the unavailable page in its place; the
others are untouched.

**The fifth one is on a different host, and that is the point.** The four
merchant applications share `app.` so the session cookie issued on the parent
domain carries between them, which is what lets the dashboard launch the till
without a second sign-in. The admin console is the plane that can see every
merchant, and putting it inside that cookie's namespace would be handing the
staff plane to the merchant one. It gets its own host, its own gateway
(`/admin/api`), its own auth realm and its own sign-in screen, and it shares
the design system, the money package and the module registry and nothing
else.

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

**Separate bundles, one origin per plane.** Separate bundles because the till
should not carry the reporting code. One origin *within* the merchant plane
because the session cookie is issued on the parent domain: put the till on
another origin and a merchant who opens it from the dashboard has to sign in
again. A *different* origin for the admin console, for exactly the same reason
read the other way round. This is what the NGINX frontend pod in §1 serves and
what §14 means by the two consoles owning different things.

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
IBM Plex Mono self-hosted; Lucide icons on one stroke weight; 309 tests green.

Most of those run in node against the two stores, because most of what is worth
asserting here is a rule rather than a rendering, and on the admin side the
rules that matter are refusals. Three files are the exception and run in jsdom:
a four-step signup form that sends the wrong trade or the wrong tier is not
visibly broken, and neither is a tier matrix that writes on click instead of
staging. A file asks for jsdom in its own docblock, so the rest do not pay
for it.

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

**Signing out.** One implementation in `shell`, on all three surfaces: a
labelled row under Settings in the dashboard sidebar, where people look for it,
and an icon button in the till and calendar headers, because a counter device is
shared and ending a shift has to be one press from where the person is standing.
The server ends the session and the browser is sent to the sign-in application;
there is nothing for JavaScript to delete, since the cookie is httpOnly.

It returns to the application's **own front door**, never to the page it was on:
whoever signs in next at a till should get the till, and should not be dropped
into the last person's screen. A failed sign-out does not redirect, because the
cookie would still be valid and the gate would send the browser straight back,
which reads as a flicker rather than a refusal.

---

## Signing up, and the twenty-four hours after it

The commercial model is the product, so the two screens that carry it are the
signup form and the checklist that follows it. They are one flow across two
applications: the form lives in `/auth`, which is where somebody with no session
already is, and the checklist lives in the dashboard, because by then they have
one.

### Four questions, one at a time

**The business type is asked first**, before the email and before the plan. It is
the single most consequential field in the product: it decides which capabilities
switch on, what things are called, which catalog template seeds and which tax
categories exist. Asking it first means nothing after it has to be revisited.
Forty-three trades are searchable and grouped by family, because it is a question
a merchant answers in four seconds and a dropdown of forty makes it a chore.

A wizard rather than one long page, for a specific reason: the two decisions that
cost money are the trade and the tier, and on one page with an email field both
of them get scrolled past.

| Step | Asks | Why it is where it is |
|---|---|---|
| 1 | Business type | Everything trade-specific follows from it |
| 2 | Business name, your name, email, password | The account, and the owner who holds the first seat |
| 3 | Plan | Four cards showing what each includes, never priced per module |
| 4 | Review | What will be switched on, said before anything is created |

The pricing page can link straight in with `?tier=` and `?industry=` already set.
Both are validated against the registry rather than trusted: a query string is
whatever the person holding the address bar typed, and an unknown value falls
back rather than throwing.

**The review step lists what switches on**, resolved from the same registry the
gateway enforces against, so a card cannot promise something entitlement will
then refuse. It also names the capabilities the trade switches on for free, which
is the clearest place in the product to see that a restaurant and a candy shop
buy the same POS and get different tills.

### The form is not the control

Every rule the form checks is checked again on the way in, and the answer comes
back **per field** so it lands under the input that caused it rather than in a
banner above all of them. A rejection also **sends the merchant back to the step
that owns the field**: an email already in use is no use as a message on the
review screen, because the email is not on it. `MIN_PASSWORD_LENGTH` lives in
`packages/api` beside the contract, so the form and the gateway read one number.

The owner is written to two places at once, the session and the staff record that
holds their seat. Renaming one and not the other puts two different people's
names on the same person's sales depending on which surface rendered them.

### The checklist is a to-do list, not a progress bar

`§11` gives twelve provisioning steps across the 0 / 4 / 12 / 24 hour stages, and
two of them cannot complete unattended: processor KYC is an external approval and
terminal pairing needs somebody holding the hardware. The screen is built around
that fact rather than around it.

**Every step carries an owner** as well as a status, which is a contract addition:
`platform`, `specialist` or `merchant`. Status is what state a step is in; owner
is who it is waiting on, and they are orthogonal. Without it, twelve steps cannot
answer the only question the merchant actually has, which is which of them are
theirs. Three are, and each offers somewhere to go: the team page, the catalog,
and the till itself.

Two things the screen refuses to do. It shows **no single percentage**, because
most of the twelve are somebody else's and a merchant staring at 58% cannot tell
whether they are the hold-up; the bar is twelve segments, one per step. And it
never dresses a step that needs a person as one that is running. A specialist step
can be nudged, which is the retry endpoint the architecture already specifies,
and a failed one can be retried; neither pretends to be progress.

The countdown is real, ticking every thirty seconds against `dueAt`, and past the
deadline it says so and says the first month is free rather than hiding.

**It appears in three places while it is running and nowhere afterwards**: a row at
the top of the sidebar with the step count, a strip on the overview, and the page
itself. None of the three is derived from entitlement, because this is not a
module: nobody buys it and every tenant passes through it once.

### The mock earns its keep here

The checklist would be a screenshot if the fixture never moved, so the store
advances it: a step that would genuinely run itself completes after eight seconds
and the next one starts. **Merchant steps never auto-complete**, and the two that
need a person stay put until somebody asks for an update. A mock that ticked all
twelve off on a timer would demonstrate the opposite of the design.

Signing up now applies what was typed rather than dropping the merchant into a
fixture wearing somebody else's name: the business name, the trade, the owner and
the tier all land on the store, and the entitlement record is rebuilt by the same
`resolveEntitlement` the gateway runs. What stays fixture-shaped is the catalog,
which is the `catalog_seed` step's job and is called out as such.

The salon fixture now carries a run in progress, so all three screens can be
looked at without signing up first.

---

## The admin console

The staff plane. One market per deployment, so it sees every merchant in this
environment and cannot be pointed at another one: the other market is a
different VPS with its own database, its own event bus, its own books and its
own console.

Built from a design import, and the interesting decisions were the ones about
what not to build.

### Two planes, and nothing shared between them

| | Merchant plane | Admin plane |
|---|---|---|
| Host | `app.twentyfour.localhost` | `admin.twentyfour.localhost` |
| Gateway | `/api` | `/admin/api` |
| Sign-in | Email and password at `/auth` | Staff SSO, MFA, IP allowlist |
| Gate component | `SessionGate`, redirects to `/auth` | `AdminGate`, renders its own sign-in |
| Query cache | `queryKeys.*` | `adminKeys.*`, prefixed `admin` |
| Mock handlers | `handlers` | `adminHandlers` |

The transport is shared and nothing else is. `request()` goes to the tenant
gateway and `adminRequest()` to the admin one, picked per call rather than per
module, so sending a merchant token to the staff plane would be a compile error
at the call site rather than a runtime surprise.

The dev worker registers **one plane's handlers, not both**. `boot(<App/>, {
plane: 'admin' })` is what selects them, so an admin screen that reached for
`/api` fails in development instead of quietly working against the wrong
gateway.

### What the console shows

| Screen | What it answers |
|---|---|
| **Tenants** | Every merchant here, filtered by status, health, tier or module held |
| **Tenant → Overview** | What this business is, what it sold, what it pays us, what it holds, what it is connected to |
| **Tenant → Sales** | One order, found by number, when a support call is about one order |
| **Tenant → Modules and tier** | Move a tier, or grant a module against it |
| **Tenant → Billing** | The subscription and every document we issued them |
| **Tenant → Getting live** | The saga, step by step, with a re-run on the stuck one |
| **Tenant → Audit** | Everything that has happened to this account |
| **Getting live** | Every run still in flight, closest deadline first |
| **Tiers and modules** | The registry: what each tier grants, and what that resolves to |
| **Platform billing** | Recurring revenue, the tier mix, and who is being chased |
| **Impersonation** | Who is inside a merchant account, and everyone who has been |
| **Audit log** | Every automated and human decision, refusals included |
| **Team and roles** | Who can see every merchant, and what each of them may do |
| **Settings** | What this deployment is and what it promises |

### The registry is the product, so the console reads it

The imported design carried its own list of twenty-one modules, its own
dependency graph, its own four tiers and its own prices. Every one of those is
already a value in `@twentyfour/entitlement`, which is the same registry the
gateway enforces against.

So none of it was transcribed. The tier cards, the entitlement table, the
matrix and the dependency resolution all read `MODULES`, `TIERS` and
`resolveDependencies`. A console with its own module list is a console that
starts lying the first time the registry changes, and it would lie
convincingly, because it would still render.

The same rule caught two smaller things. The design's saga steps were a second
twelve-step model of provisioning; onboarding lives *inside* Provisioning, so
the console renders the merchant's own `OnboardingStep` rows and a step a
specialist re-runs is the step the merchant watches turn green. And the design
priced Enterprise at a figure; the registry carries no list price for it,
because it is quoted, so the card says so rather than showing a number.

### Impersonation hands off; it does not draw a copy

The largest single piece of the imported design was a takeover screen: a
hand-built merchant dashboard rendered inside the console, with its own
sidebar, its own takings figure and its own list of open tickets.

That was not built. It is a second implementation of a surface that already
ships as its own application, it would have drifted from the real one within a
release, and the thing a specialist on a support call most needs is to see
*exactly* what the merchant is seeing, which is the one thing a lookalike
cannot do.

What was built is the part that is genuinely admin-plane work:

- A **read-only token by default**, whatever the role allows. Write is a second,
  deliberate step, because the reason for writing is never known before you have
  looked, and a reason given in advance is a reason invented in advance.
- **A reason on every session**, and a second one to elevate. Elevating issues a
  *new* token at the wider scope and re-emits `impersonation.started`, so the
  audit log carries two records with two reasons rather than one record whose
  scope quietly changed.
- **A shorter window when the scope widens.** Thirty minutes read, fifteen write.
- **One session at a time.** Two open tokens mean the audit log has to guess
  which tenant an action belonged to, and not guessing is the whole point.
- **A strip across the top of every screen** while one is open, with the
  countdown, and a link that opens the merchant's real dashboard.
- **Signing out kills every token it holds.** A specialist who signs out and
  leaves a write token alive is the exact failure the time box exists to prevent.

### The customer directory was removed

The design's tenant page had a Customers tab: every one of a merchant's
customers, with email, phone and lifetime spend, sorted by who had spent the
most, plus a full customer record with a CRM timeline.

That is not support. It is a marketing list assembled out of somebody else's
customer base, and it is the one screen in the design that could not be
justified to the person whose data is in it. The legitimate need behind it is a
data subject request, which is finding *one* record by exact address, not
browsing a ranked directory. The orders table stayed, because a support call
really is about one order; the browse did not.

Also removed, for smaller reasons: a feature-flag panel and a module attach-rate
table (both computed in the design's own source and never rendered by it), a
"New tenant" button with no flow behind it, and the density and accent-colour
knobs, which are design-canvas controls rather than product.

### Market variation stays in the deployment

The design named a specific tax authority in eight places, its invoice
numbering, its card scheme and its national payment card. None of that is in
the code. The console reads a `fiscalAuthority` **label** off the environment
and repeats it back, and the document number is the platform-wide
`year-merchantcode-sequence`. There is no country code and no branch on market
anywhere in the application, which is the constraint that makes swapping the
Payments and Invoicing pods work at all.

### Every write leaves a trail, in the same call

The store writes an audit event in the transaction that makes the change, and
refuses the things the real services would refuse:

| Refused | Because |
|---|---|
| Anything at all, signed out | 401, including the reads |
| Any write, as a read-only auditor | The role is the whole point of the role |
| Withdrawing a module something held depends on | The record would not resolve |
| Switching off an always-on module | It ships with every tenant at any price |
| A change with no reason | It is the only part of the record a reader cannot reconstruct |
| A downgrade below the seats in use | The gateway would start refusing staff logins |
| Suspending a tenant mid-provisioning | Finish or cancel the run first |
| A second open support session | The log would have to guess |
| Editing the tier registry, as anyone but the owner | Blast radius is every tenant on the tier |
| A registry change that makes an upgrade take something away | An upgrade that removes a screen |

That last one is worth naming. Tiers are a ladder, so if Starter ends up
granting something Growth does not, upgrading *takes a module away*, and the
tenant it happens to finds out when a screen disappears. The registry checks the
whole ladder after every edit and rolls back rather than accepting it.

### The most destructive screen stages, it does not write

A cell in the tier matrix decides what every tenant on that tier holds. So
nothing applies as you click: changes stage, a sticky bar names how many
businesses would be rewritten, and applying is a separate confirmation that
lists what is added and removed per tier. The design wrote each cell through on
click with an apply banner that had already been overtaken by the write.

Three kinds of cell cannot be clicked at all, and the reason differs: an
always-on module ships with every tenant, a dependency arrives because something
else needed it, and both are facts about the platform rather than choices about
a tier.

**Self-serve capability is derived, not toggled.** The design had a per-tier
switch for "auto-provision on signup". It is not a policy: a tier goes live
unattended exactly when every module it resolves to can, so adding one that
needs KYC or an OAuth consent flips it and nobody has to remember to. The card
names the module responsible rather than just saying a specialist is needed.

### The fixture is the same three businesses

The console's tenant directory holds thirteen businesses, and the first three
are the cafe, the salon and the shop the merchant applications already run on,
with their real ids, names, tiers and business types read from the seeds rather
than restated. So opening a support session on the cafe and following the
handoff lands in the cafe the till is already showing. A directory of thirteen
invented businesses would demo just as well and be wrong in the one way that
matters.

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
| Signup ignored almost everything it was sent | Only the trade was read. A merchant signed up as their own business and landed in a fixture wearing somebody else's name, email and tier. |
| Every live tenant would have been shown a setup checklist | `GET /onboarding` fell back to the mid-flight fixture when a tenant had no run, so a business live for two years had one that never finished. |
| A live tenant would have sat on a loading skeleton forever | The onboarding query is disabled when there is no run, and a disabled query never leaves pending, so "loading" and "nothing to load" looked identical. |
| The countdown read an hour short | Flooring the hours says "18 h left" for the whole of the nineteenth. On a promise measured in hours that is the wrong direction to be wrong in. |
| `npm run dev` could not start the mock gateway | All four applications declared `msw.workerDirectory` and none of them contained `mockServiceWorker.js`. Generated for each. |
| Two merchant codes in the admin fixture contained `L` | Crockford base32 excludes `I`, `L`, `O` and `U` because the first three are misread off a printed invoice. Caught by a test asserting the alphabet rather than by reading them. |
| The tier registry had no ladder check | Nothing stopped a lower tier granting something a higher one does not, which turns an upgrade into a downgrade: the tenant it happens to finds out when a screen disappears. Checked across the whole ladder now, and rolled back rather than accepted. |
| `<dialog>` threw in every component test | jsdom implements neither `showModal` nor `close`, so any test rendering a design-system `Dialog` failed on first render rather than on an assertion. Stubbed in `vitest.setup.ts`, honestly enough that the component's own `open` check still works. |

---

## What is next

F3 is finished, so are the two halves of F7 a merchant touches (signup and the
24-hour checklist), and the admin console now covers §14's half of the split.
What remains, in the order it earns its place:

| Phase | Work |
|---|---|
| **F4** | Week view, buffers, deposits taken at booking, rota grid |
| **F5** | The document viewer against the stored artifact rather than the recorded fields |
| **F6** | Marketing, Website builder, notification centre |
| **F7** | Marketing site in React, and the password reset and invite flows |
| **Any** | Export: CSV, a print layout, a scheduled report |

The console's own gap is the gateway behind it. `admin-gateway` is now in
`deploy/inventory.tsv` as `later`, so status displays show it as not built
rather than not existing. Until it does, the console's nginx answers
`/admin/api` with a JSON 503 rather than letting the catch-all hand an API call
the index document and a 200.

## Open items

1. **Signup collects no billing period.** The tier page states an annual
   discount and the subscription record carries a period, but `SignupInput` has
   no field for one, so the form shows the monthly figure and says billing
   starts at go-live. Adding it is one field on the contract and a toggle on the
   plan step; it was left out rather than shown as a control that sends nothing.
2. **Signing up does not verify the email.** `auth.proto` is explicit that
   signup issues a verification token and does not sign you in. The BFF contract
   here returns a session, because the Notification service does not exist and a
   wall nobody can get past is worse than no wall. When mail can be delivered
   this becomes a fifth step, not a redesign: the checklist already models a
   step nobody can complete unattended.
3. **Password reset and invite acceptance are still routed placeholders.** Both
   need the same thing, which is somewhere for a link to be delivered to.
4. **The checklist has no per-step history.** A step that failed, was retried
   and then succeeded shows as done, with nothing saying it took three attempts.
   That is a question a specialist will eventually ask on behalf of a merchant
   who says the setup was rough.
5. **Offline till.** §7 says a third party being down must never block a sale.
   That is a backend guarantee, but a till that cannot queue a tender locally
   breaks it from the front. The tender flow is still shaped so queueing can be
   added without redesign: a payment is accepted against a balance and only the
   completed set is sent, so a queued one changes where the tenders go, not how
   they are taken.
6. **Document rendering.** The viewer must display a stored artifact, never a
   recomputation. Until Invoicing exists the mock must serve a fixed file, or
   the immutability rule gets designed away.
7. **Prices and seat counts** are still unset. They are Registry values and the
   apps read them from one place.
8. **Tables are a grid by area, not a drawn floor plan.** A real plan needs an
   editor and a canvas. A grid grouped by area answers the two questions a
   server actually has, which table is free and who has been waiting longest.
   A table now carries its open tab; what it still does not do is let a tab be
   moved between tables, or split between two parties.
9. **Exporting is still missing.** Every figure can be read and acted on, but
   nothing can be taken out: no CSV, no scheduled report, no print layout
   beyond what the browser gives. That is the next honest gap.
10. **Cost price is per item, not per batch.** Real margin moves with what you
    last paid a supplier. A single cost is right enough to make the analysis
    useful and wrong enough that a merchant reconciling to the penny will notice.
11. **The fixtures ship in the production bundle.** `DevToolbar` imports
    `@twentyfour/mock` statically, so the store, the seeds and all three tenants
    are in every application behind a component that renders nothing. MSW itself
    is correctly excluded. The fix is a dynamic import inside the lazy factory.
12. **A parked sale keeps one timestamp.** While it is parked, `placedAt` is
    when it was parked, and settling moves it to when it became a sale, so the
    receipt and the day's takings agree about which day it belongs to. Nothing
    then records how long the tab was open, which is a figure a restaurant
    would eventually want for table turn time.
13. **Roles are built in, not custom.** Four cover the shapes an SMB actually
    has. Custom permission sets are a real feature of the RBAC service and
    would need a builder screen, an audit trail per grant, and a rule
    preventing a role from granting more than its author holds. Not built until
    someone asks.
14. **The signup redirect only lands in production.** All four applications sit
    on one origin behind Traefik, which is what makes the session cookie and
    these cross-application redirects work. In development they are four dev
    servers on four ports, so `/onboarding` after signup, and `/auth/` after
    sign-out, resolve to nothing. A `server.proxy` block in each Vite config
    would fix the whole family of them at once.
15. **The MSW worker was missing from every app.** All four declared
    `msw.workerDirectory` and none of them had the file, so `npm run dev` could
    not start the mock gateway at all. Generated with `npx msw init` for each.
16. **The admin gateway does not exist.** The console speaks a full
    `/admin/api` contract that only the mock answers. Nothing about the
    application changes when it lands: `adminRequest` already goes over fetch to
    the right base, and the nginx block that returns a 503 becomes a
    `proxy_pass`.
17. **Staff SSO, MFA and the IP allowlist are claims, not code.** The console
    renders a sign-in that says all three and a session that reports which
    authenticator and which address, but every one of those is enforced at a
    gateway that is not built. This is the right split, and it is worth being
    explicit that the console currently asserts a security posture it does not
    implement.
18. **The console cannot create a tenant.** Provisioning is a saga owned by a
    service, and a specialist-led intake needs a form that starts one. Both
    routes into a tier converge on the same saga, so the self-serve half is
    built and the specialist half is not.
19. **Data subject requests have no screen.** The customer browse was removed
    deliberately, and the thing that should replace it, finding one record by
    exact address so it can be exported or erased, is not built either. Until
    it is, an erasure request has no answer in the console at all.
20. **A support session cannot actually reach the merchant plane.** The handoff
    opens the real dashboard, which is correct, but the dashboard has no notion
    of a support token: it will show whoever is signed in on that browser. Making
    it real needs the token accepted at the tenant gateway and a banner in the
    dashboard saying who is really driving.
21. **The provisioning queue polls rather than subscribes.** Thirty seconds is
    fine for a saga measured in hours, but the events already exist on the bus
    and a specialist watching a stuck run wants it to clear when it clears.
22. **The icon registry costs every application.** It is one object literal, so
    nothing tree-shakes: the six icons the console needed added about 5 kB to
    the till, which renders none of them. Splitting per application would break
    the property that a typo in an icon name is a compile error, so it stands
    until the number is worth the trade.
