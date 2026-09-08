import type { ReactNode } from 'react'
import { MODULES, industryProfile } from '@twentyfour/entitlement'
import { formatMoney, money, type Money } from '@twentyfour/money'
import type { TenantDailyRevenue, TenantDetail, TenantIntegration } from '@twentyfour/api'
import {
  Badge,
  Card,
  CardHeader,
  MoneyText,
  Skeleton,
  cn,
  useDateFormat,
  useFormat,
} from '@twentyfour/ui'
import { HealthNote, KeyValue, QuotaBar, Section } from '../common'
import { useTenant } from './useTenant'

/**
 * What this business is and how it is doing.
 *
 * Two kinds of figure sit on this page and they are deliberately never added
 * together or shown in the same tile: what the merchant sold, which is their
 * money, and what they pay us, which is ours. The design this came from put
 * "GMV" and "MRR" side by side in one strip with the same styling, which is
 * how a revenue number ends up in the wrong report.
 */
export function OverviewTab() {
  const { data, isPending } = useTenant()

  if (isPending || !data) return <Skeleton className="h-96" />

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader title="The business" />
        <div className="mt-3">
          <KeyValue
            rows={[
              { key: 'Owner', value: <Recorded value={data.ownerName} /> },
              {
                key: 'Email',
                value: <Recorded value={data.ownerEmail} className="break-all" />,
              },
              { key: 'Phone', value: <Recorded value={data.ownerPhone} /> },
              {
                key: 'Tax number',
                value: <Recorded value={data.taxId} className="font-mono text-sm" />,
              },
              { key: 'Address', value: <Recorded value={data.address} /> },
              {
                key: 'Business type',
                value: industryProfile(data.industry)?.name ?? data.industry,
              },
              { key: 'Currency and locale', value: `${data.currency} · ${data.locale}` },
              { key: 'Timezone', value: data.timezone },
              {
                key: 'Merchant code',
                value: <span className="font-mono text-sm">{data.merchantCode}</span>,
              },
            ]}
          />
        </div>
      </Card>

      <div className="flex flex-col gap-5 lg:col-span-2">
        <Card>
          <CardHeader
            title="Their trading, last 30 days"
            description="The merchant's own money. Nothing on this card is revenue to us."
          />
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label="Gross" value={<Amount value={data.gmv30d} />} />
            <Figure
              label="Orders"
              value={
                data.orders30d === null ? <Absent /> : data.orders30d.toLocaleString(data.locale)
              }
            />
            <Figure label="Refunded" value={<Amount value={data.refunded30d} />} />
            <Figure label="Average order" value={<AverageOrder detail={data} />} />
          </div>
          <RevenueBars days={data.revenue ?? []} />
        </Card>

        {data.subscription && (
          <Card>
            <CardHeader
              title="What we bill them"
              description="What the tier costs, and where the subscription stands."
            />
            <div className="mt-3">
              <KeyValue
                rows={[
                  { key: 'Monthly', value: <MoneyText value={data.subscription.amount} /> },
                  { key: 'Cycle', value: data.subscription.cycle },
                  {
                    key: 'Next charge',
                    value: data.subscription.nextChargeAt?.slice(0, 10) ?? 'not scheduled',
                  },
                  { key: 'Payment method', value: data.subscription.paymentMethod },
                  {
                    key: 'Being chased',
                    value: data.subscription.dunningState ?? (
                      <span className="text-text-subtle">no</span>
                    ),
                  },
                ]}
              />
            </div>
          </Card>
        )}
      </div>

      <Section
        title="What they hold"
        description="Resolved from the tier, their business type and any override a specialist recorded."
        className="lg:col-span-2"
      >
        <Card>
          <div className="flex flex-wrap gap-2">
            {data.modules.map((grant) => (
              <Badge
                key={grant.moduleId}
                tone={grant.source === 'override' ? 'warning' : 'neutral'}
                icon={grant.source === 'override' ? 'Pencil' : undefined}
              >
                {MODULES[grant.moduleId]?.name ?? grant.moduleId}
              </Badge>
            ))}
          </div>
          {data.modules.some((grant) => grant.source === 'override') && (
            <p className="mt-3 text-sm text-text-muted">
              Marked modules were granted against the tier by a specialist. An override is audited
              and it deliberately does not move the price.
            </p>
          )}

          {data.quotas.length > 0 && (
          <div className="mt-5 flex flex-col gap-4 border-t border-border pt-4">
            {data.quotas.map((quota) => (
              <QuotaBar
                key={quota.id}
                label={quota.label}
                used={quota.unit === 'money' ? (quota.amount?.minor ?? 0) : quota.used}
                limit={quota.unit === 'money' ? (quota.ceiling?.minor ?? null) : quota.limit}
                value={<QuotaValue quota={quota} />}
              />
            ))}
          </div>
          )}
        </Card>
      </Section>

      {/* Connection health is owned by the services doing the connecting, and
          most of them are not built. An empty card claiming nothing is
          connected would be a worse answer than no card. */}
      {data.integrations.length > 0 && (
        <Section
          title="Connections"
          description="Everything outside the platform this tenant depends on."
        >
          <Card padded={false}>
            <ul>
              {data.integrations.map((row, index) => (
                <li
                  key={row.id}
                  className={cn('px-4 py-3', index > 0 && 'border-t border-border')}
                >
                  <IntegrationRow row={row} />
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-[-0.02em] text-text">{value}</p>
    </div>
  )
}

/**
 * A figure whose source is not wired up yet.
 *
 * Not zero. A business that sold nothing and a business nobody has asked about
 * look identical if both render as an amount, and only one of them is a
 * problem.
 */
function Absent() {
  return <span className="text-md font-medium text-text-subtle">not recorded</span>
}

/**
 * A field somebody has to fill in, and nobody has.
 *
 * A blank row reads as a rendering fault; "not recorded" reads as a fact about
 * the business, which is what it is. These are all fields Invoicing will need
 * before this tenant can be sent a document.
 */
function Recorded({ value, className }: { value: string | undefined; className?: string }) {
  if (!value) return <span className="text-sm text-text-subtle">not recorded</span>
  return <span className={className}>{value}</span>
}

function Amount({ value }: { value: Money | null }) {
  if (!value) return <Absent />
  return <MoneyText value={value} deemphasiseSymbol />
}

function AverageOrder({ detail }: { detail: TenantDetail }) {
  const { gmv30d, orders30d } = detail
  if (gmv30d === null || orders30d === null) return <Absent />
  if (orders30d === 0) return <span className="text-text-subtle">no sales</span>
  // money(), not a spread with a fresh number. Minor units are a branded type
  // precisely so an amount cannot be assembled out of an arithmetic result
  // without going through the one constructor that knows the currency.
  return (
    <MoneyText
      value={money(Math.round(gmv30d.minor / orders30d), gmv30d.currency)}
      deemphasiseSymbol
    />
  )
}

function QuotaValue({ quota }: { quota: TenantDetail['quotas'][number] }) {
  if (quota.unit === 'money' && quota.amount) {
    return (
      <span>
        <MoneyText value={quota.amount} compact />
        {quota.ceiling && (
          <>
            {' of '}
            <MoneyText value={quota.ceiling} compact />
          </>
        )}
      </span>
    )
  }
  if (quota.unit === 'bytes') {
    const gb = (value: number) => `${(value / 1_000_000_000).toFixed(1)} GB`
    return <span>{quota.limit === null ? gb(quota.used) : `${gb(quota.used)} of ${gb(quota.limit)}`}</span>
  }
  return <span>{quota.limit === null ? `${quota.used}, no limit` : `${quota.used} of ${quota.limit}`}</span>
}

function IntegrationRow({ row }: { row: TenantIntegration }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-base text-text">{row.name}</p>
      <HealthNote health={row.health} note={row.state} />
    </div>
  )
}

/**
 * Thirty days of takings.
 *
 * Bars rather than a line, because these are discrete days and a line implies
 * a reading exists between two of them. A day with no trading is drawn as a
 * hairline rather than nothing, so a closed Sunday is visibly a closed Sunday
 * and not a gap in the data.
 */
function RevenueBars({ days }: { days: readonly TenantDailyRevenue[] }) {
  const dates = useDateFormat()
  const { locale } = useFormat()
  const peak = Math.max(1, ...days.map((day) => day.gross.minor))
  const total = days.reduce((sum, day) => sum + day.gross.minor, 0)

  if (total === 0) {
    return (
      <p className="mt-4 rounded-lg bg-bg-inset px-3 py-4 text-center text-sm text-text-subtle">
        Not trading yet. This tenant is still being set up.
      </p>
    )
  }

  return (
    <div className="mt-5">
      <div className="flex h-20 items-end gap-[3px]">
        {days.map((day) => (
          <div
            key={day.day}
            // formatMoney, not Intl directly: minor units are not major
            // units, and a currency with a subunit would read a hundred times
            // too high in this tooltip alone.
            title={`${dates.date(day.day)} · ${formatMoney(day.gross, { locale })}`}
            className="flex-1 rounded-t-sm bg-accent"
            style={{ height: `${Math.max(2, (day.gross.minor / peak) * 100)}%` }}
          />
        ))}
      </div>
      <p className="mt-2 text-sm text-text-subtle">
        Daily gross, {dates.date(days[0]?.day ?? '')} to today
      </p>
    </div>
  )
}
