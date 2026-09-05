import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { billing, queryKeys } from '@twentyfour/api'
import {
  MODULES, TIER_IDS, TIERS, planDowngrade, planUpgrade, tierRank, useEntitlement,
  type TierId,
} from '@twentyfour/entitlement'
import {
  Badge, Button, Card, CardHeader, Icon, MoneyText, PageHeader, Skeleton, cn, useDateFormat,
} from '@twentyfour/ui'
import { money } from '@twentyfour/money'
import { TierChangeDialog } from './TierChangeDialog'

export function SubscriptionPage() {
  const dates = useDateFormat()
  const { record } = useEntitlement()
  const [changing, setChanging] = useState<TierId | null>(null)
  const subscription = useQuery({
    queryKey: queryKeys.billing.subscription(),
    queryFn: billing.subscription,
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Subscription"
        description="What you are on, what it includes, and what changing it would do."
      />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-text">{TIERS[record.tier].name}</h2>
              <Badge tone="success" dot>{subscription.data?.status ?? 'active'}</Badge>
            </div>
            <p className="mt-1 text-base text-text-muted">{TIERS[record.tier].tagline}</p>
            {subscription.data && (
              <p className="mt-3 text-base text-text-muted">
                Renews {dates.dateLong(subscription.data.renewsAt)}
                {' · '}
                {record.seats.limit === null
                  ? 'Seats negotiated'
                  : `${record.seats.used} of ${record.seats.limit} seats`}
              </p>
            )}
          </div>
          <div className="text-right">
            {subscription.isPending ? (
              <Skeleton className="h-9 w-28" />
            ) : subscription.data ? (
              <>
                <p className="text-2xl font-semibold text-text">
                  <MoneyText value={subscription.data.amount} deemphasiseSymbol />
                </p>
                <p className="text-sm text-text-subtle">per month, ex VAT</p>
              </>
            ) : null}
          </div>
        </div>
      </Card>

      <div>
        <CardHeader
          title="Plans"
          description="Changing plan is what changes the bill. Modules are never priced individually."
        />
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {TIER_IDS.map((tier) => (
            <TierCard key={tier} tier={tier} current={record.tier} onChoose={setChanging} />
          ))}
        </div>
      </div>

      <TierChangeDialog tier={changing} onClose={() => setChanging(null)} />
    </div>
  )
}

function TierCard({
  tier,
  current,
  onChoose,
}: {
  tier: TierId
  current: TierId
  onChoose: (tier: TierId) => void
}) {
  const { record } = useEntitlement()
  const definition = TIERS[tier]
  const isCurrent = tier === current
  const isUp = tierRank(tier) > tierRank(current)

  const plan = isUp ? planUpgrade(record, tier) : null
  const losing = !isUp && !isCurrent ? planDowngrade(record, tier) : []

  return (
    <Card
      className={cn(
        'flex flex-col',
        isCurrent && 'border-accent ring-1 ring-accent/25',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-md font-semibold text-text">{definition.name}</h3>
        {isCurrent ? <Badge tone="accent">Current</Badge> : definition.recommended ? <Badge>Popular</Badge> : null}
      </div>

      <p className="mt-1 min-h-10 text-sm text-text-muted">{definition.tagline}</p>

      <p className="mt-3 text-2xl font-semibold text-text">
        {definition.monthlyMinor === null ? (
          <span className="text-lg">On request</span>
        ) : (
          <MoneyText value={money(definition.monthlyMinor, definition.currency)} deemphasiseSymbol />
        )}
      </p>
      <p className="text-sm text-text-subtle">
        {definition.seats === null ? 'Seats negotiated' : `${definition.seats} staff seats`}
      </p>

      <ul className="mt-4 flex flex-1 flex-col gap-1.5">
        {definition.grants.map((moduleId) => (
          <li key={moduleId} className="flex items-start gap-2 text-sm text-text-muted">
            <Icon name="Check" size="sm" className="mt-0.5 shrink-0 text-success-text" />
            {MODULES[moduleId].name}
          </li>
        ))}
        {definition.perks.map((perk) => (
          <li key={perk.label} className="flex items-start gap-2 text-sm text-text-muted">
            <Icon
              name={perk.comingSoon ? 'Clock' : 'Check'}
              size="sm"
              className={cn('mt-0.5 shrink-0', perk.comingSoon ? 'text-text-subtle' : 'text-success-text')}
            />
            <span>
              {perk.label}
              {/* Advertised rather than deferred silently. The Registry carries
                  this per perk, so the label disappears when the work lands and
                  no release is needed. */}
              {perk.comingSoon && <span className="ml-1.5 text-text-subtle">coming soon</span>}
            </span>
          </li>
        ))}
      </ul>

      {/* A self-serve upgrade completes unattended only if every step it
          triggers can. KYC approval and ad-account consent cannot, so they are
          named here rather than discovered halfway through checkout. */}
      {plan && plan.queuedToSpecialist.length > 0 && (
        <p className="mt-4 rounded-lg bg-warning-subtle p-2.5 text-sm text-text-muted">
          {plan.queuedToSpecialist.map((id) => MODULES[id].name).join(' and ')}
          {plan.queuedToSpecialist.length === 1 ? ' needs' : ' need'} a specialist to finish setting
          up. Everything else switches on straight away.
        </p>
      )}

      {losing.length > 0 && (
        <p className="mt-4 rounded-lg bg-danger-subtle p-2.5 text-sm text-text-muted">
          You would lose {losing.map((id) => MODULES[id].name).join(', ')}.
        </p>
      )}

      <Button
        className="mt-4"
        block
        variant={isCurrent ? 'outline' : isUp ? 'primary' : 'outline'}
        disabled={isCurrent}
        onClick={() => onChoose(tier)}
      >
        {isCurrent ? 'Your plan' : tier === 'enterprise' ? 'Talk to us' : isUp ? 'Upgrade' : 'Downgrade'}
      </Button>
    </Card>
  )
}
