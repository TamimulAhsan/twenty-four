import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { loyalty, queryKeys, type LoyaltyMember } from '@twentyfour/api'
import { customerMetrics, presetPeriod } from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Icon, MoneyText, PageHeader,
  ShareBar, Skeleton, Switch, Table, TableScroll, Td, Th, Tr, cn, useDateFormat, useFormat,
} from '@twentyfour/ui'
import { LoyaltyMemberDialog, LoyaltyProgrammeDialog } from './LoyaltyDialogs'
import { useTradeData } from '../analytics/useTradeData'

/**
 * The loyalty programme.
 *
 * Two questions decide whether it is working. Do members come back more than
 * non-members, and what does the points balance owe. Everything else on this
 * screen is in service of those.
 */
export function LoyaltyPage() {
  const terms = useTerms()
  const dates = useDateFormat()
  const { currency } = useFormat()
  const mayEdit = usePermission('settings.business')
  const period = useMemo(() => presetPeriod('90d'), [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [member, setMember] = useState<LoyaltyMember | null>(null)
  const data = useTradeData(period)

  const [programmeQuery, membersQuery] = useQueries({
    queries: [
      { queryKey: queryKeys.loyalty.programme(), queryFn: loyalty.programme },
      { queryKey: queryKeys.loyalty.members(), queryFn: loyalty.members },
    ],
  })

  const programme = programmeQuery?.data
  const members = useMemo(() => membersQuery?.data ?? [], [membersQuery?.data])

  const analysis = useMemo(() => {
    const metrics = customerMetrics({ orders: data.orders })
    const memberIds = new Set(members.map((member) => member.customerId))
    const inProgramme = metrics.filter((entry) => memberIds.has(entry.customerId))
    const outside = metrics.filter((entry) => !memberIds.has(entry.customerId))

    const average = (list: typeof metrics, pick: (entry: (typeof metrics)[number]) => number) =>
      list.length === 0 ? 0 : list.reduce((sum, entry) => sum + pick(entry), 0) / list.length

    // The only figure that justifies a programme. If members do not come back
    // more often than everyone else, the programme is a discount with a card.
    const memberVisits = average(inProgramme, (entry) => entry.orderCount)
    const otherVisits = average(outside, (entry) => entry.orderCount)

    const outstanding = members.reduce((sum, member) => sum + member.points, 0)

    return {
      enrolment: metrics.length === 0 ? 0 : inProgramme.length / metrics.length,
      memberVisits,
      otherVisits,
      visitLift: otherVisits === 0 ? null : (memberVisits - otherVisits) / otherVisits,
      memberBasket: average(inProgramme, (entry) => entry.averageBasketMinor),
      otherBasket: average(outside, (entry) => entry.averageBasketMinor),
      outstanding,
      // A points balance is money the business will owe when it is spent.
      liability: programme ? outstanding * programme.pointValue.minor : 0,
      redeemed: members.reduce((sum, member) => sum + member.redeemedPoints, 0),
      byTier: (programme?.tiers ?? []).map((tier) => ({
        tier,
        count: members.filter((member) => member.tierId === tier.id).length,
      })),
    }
  }, [data.orders, members, programme])

  if (programmeQuery?.isError || membersQuery?.isError || data.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Loyalty" />
        <ErrorState onRetry={() => { void programmeQuery?.refetch(); void membersQuery?.refetch() }} />
      </div>
    )
  }

  const loading = programmeQuery?.isPending || membersQuery?.isPending || data.isPending

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Loyalty"
        description="Whether the card is bringing people back, and what the points balance owes."
        actions={
          mayEdit && (
            <Button variant="outline" iconStart="Settings" onClick={() => setSettingsOpen(true)}>
              Programme settings
            </Button>
          )
        }
      />

      {programme && !programme.enabled && (
        <Card className="border-warning-border bg-warning-subtle">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-base text-text-muted">
              The programme is switched off. Members keep their balances and stop earning.
            </p>
            {mayEdit && (
              <Button size="sm" onClick={() => setSettingsOpen(true)}>
                Turn it back on
              </Button>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Members"
          value={String(members.length)}
          hint={`${Math.round(analysis.enrolment * 100)}% of known ${terms.t('customer', { plural: true, case: 'lower' })}`}
          loading={loading}
        />
        <Tile
          label="Visit lift"
          value={
            analysis.visitLift === null
              ? 'no comparison'
              : `${analysis.visitLift > 0 ? '+' : ''}${Math.round(analysis.visitLift * 100)}%`
          }
          hint={`${analysis.memberVisits.toFixed(1)} visits against ${analysis.otherVisits.toFixed(1)}`}
          tone={analysis.visitLift !== null && analysis.visitLift > 0 ? 'good' : 'warn'}
          loading={loading}
        />
        <Tile
          label="Points outstanding"
          value={analysis.outstanding.toLocaleString()}
          hint="Not yet spent"
          loading={loading}
        />
        <Tile
          label="What that owes"
          value={<MoneyText value={money(analysis.liability, currency)} deemphasiseSymbol />}
          hint="If every point were spent tomorrow"
          tone="warn"
          loading={loading}
        />
      </div>

      {/* The question a merchant actually has, answered in one sentence. */}
      {!loading && analysis.visitLift !== null && (
        <Card
          className={cn(
            analysis.visitLift > 0.1
              ? 'border-success-border bg-success-subtle'
              : 'border-warning-border bg-warning-subtle',
          )}
        >
          <div className="flex gap-3">
            <Icon
              name={analysis.visitLift > 0.1 ? 'CheckCircle2' : 'TriangleAlert'}
              size="lg"
              className={cn('mt-0.5 shrink-0', analysis.visitLift > 0.1 ? 'text-success-text' : 'text-warning-text')}
            />
            <div>
              <p className="text-base font-medium text-text">
                {analysis.visitLift > 0.1
                  ? 'The card is bringing people back'
                  : 'The card is not changing behaviour much'}
              </p>
              <p className="mt-1 text-base text-text-muted">
                Members come {analysis.memberVisits.toFixed(1)} times against{' '}
                {analysis.otherVisits.toFixed(1)} for everyone else.{' '}
                {analysis.visitLift > 0.1
                  ? 'That difference is what the points are buying. Enrolling more people is the highest-return thing on this page.'
                  : 'Members may simply be your regulars, who would have come anyway. Try making the reward worth more, or easier to reach.'}
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader title="How it works" description="What members earn and what it is worth." />
          {programme ? (
            <dl className="mt-4 flex flex-col divide-y divide-border">
              <Row label="Programme">{programme.name}</Row>
              <Row label="Earning">
                {/* earnBasisPoints is basis points of a point per minor unit,
                    so 100 is one point per hundred. Rendering it as a bare
                    division said "1 point per unit" for an arithmetic that
                    gives one per hundred. */}
                {programme.earnBasisPoints >= 10_000
                  ? `${programme.earnBasisPoints / 10_000} points per unit spent`
                  : `1 point per ${Math.round(10_000 / programme.earnBasisPoints)} spent`}
              </Row>
              <Row label="A point is worth">
                <MoneyText value={programme.pointValue} />
              </Row>
              <Row label="Points redeemed">{analysis.redeemed.toLocaleString()}</Row>
              <Row label="Status">
                <Switch
                  checked={programme.enabled}
                  onChange={() => undefined}
                  disabled={!mayEdit}
                  label={programme.enabled ? 'Running' : 'Paused'}
                />
              </Row>
            </dl>
          ) : (
            <Skeleton className="mt-4 h-40 w-full" />
          )}
        </Card>

        <Card>
          <CardHeader title="Tiers" description="Where members sit, and what each tier gives them." />
          {analysis.byTier.length > 0 && members.length > 0 && (
            <ShareBar
              className="mt-4"
              segments={analysis.byTier.map((entry) => ({
                key: entry.tier.id,
                label: entry.tier.name,
                value: entry.count,
                display: String(entry.count),
              }))}
            />
          )}
          <ul className="mt-5 flex flex-col divide-y divide-border">
            {analysis.byTier.map((entry) => (
              <li key={entry.tier.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-text">{entry.tier.name}</p>
                  <p className="text-sm text-text-subtle">
                    From {entry.tier.threshold.toLocaleString()} points ·{' '}
                    {entry.tier.earnMultiplier}x earning
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    {entry.tier.perks.map((perk) => (
                      <li key={perk} className="flex items-center gap-1 text-sm text-text-muted">
                        <Icon name="Check" size="sm" className="text-success-text" />
                        {perk}
                      </li>
                    ))}
                  </ul>
                </div>
                <Badge tone="neutral">{entry.count}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader className="p-5" title="Members" description="Sorted by what they have earned." />
        {loading ? (
          <div className="flex flex-col gap-3 p-5 pt-0">
            {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        ) : members.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState icon="Sparkles" title="Nobody has joined yet" />
          </div>
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th>Tier</Th>
                  <Th numeric>Points</Th>
                  <Th numeric className="hidden sm:table-cell">Earned</Th>
                  <Th numeric className="hidden md:table-cell">Spent</Th>
                  <Th className="hidden lg:table-cell">Joined</Th>
                </tr>
              </thead>
              <tbody>
                {[...members]
                  .sort((a, b) => b.lifetimePoints - a.lifetimePoints)
                  .slice(0, 40)
                  .map((member: LoyaltyMember) => (
                    <Tr key={member.id} interactive onClick={() => setMember(member)}>
                      <Td className="font-medium">{member.customerName}</Td>
                      <Td>
                        <Badge tone={member.tierId === 'gold' ? 'warning' : member.tierId === 'silver' ? 'accent' : 'neutral'}>
                          {programme?.tiers.find((tier) => tier.id === member.tierId)?.name ?? '—'}
                        </Badge>
                      </Td>
                      <Td numeric className="font-medium">{member.points.toLocaleString()}</Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">
                        {member.lifetimePoints.toLocaleString()}
                      </Td>
                      <Td numeric className="hidden text-text-muted md:table-cell">
                        {member.redeemedPoints.toLocaleString()}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-text-muted lg:table-cell">
                        {dates.date(member.joinedAt)}
                      </Td>
                    </Tr>
                  ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>
      <LoyaltyProgrammeDialog
        programme={programme}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <LoyaltyMemberDialog member={member} programme={programme} onClose={() => setMember(null)} />
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-base text-text-muted">{label}</dt>
      <dd className="text-base font-medium text-text">{children}</dd>

    </div>
  )
}

function Tile({
  label, value, hint, tone, loading,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'good' | 'warn'
  loading: boolean
}) {
  return (
    <Card className={cn(tone === 'warn' && 'border-warning-border')}>
      <p className="text-sm font-medium text-text-muted">{label}</p>
      <div
        className={cn(
          'mt-2 text-2xl font-semibold tracking-[-0.02em]',
          tone === 'good' ? 'text-success-text' : 'text-text',
        )}
      >
        {loading ? <Skeleton className="h-8 w-24" /> : <span className="tnum">{value}</span>}
      </div>
      {hint && <p className="mt-1 text-sm text-text-subtle">{hint}</p>}
    </Card>
  )
}
