import { useMutation, useQueryClient } from '@tanstack/react-query'
import { billing } from '@twentyfour/api'
import {
  MODULES, TIERS, isUpgrade, planDowngrade, planUpgrade, useEntitlement, type TierId,
} from '@twentyfour/entitlement'
import { money } from '@twentyfour/money'
import {
  Badge, Button, Card, Dialog, Icon, MoneyText, useToast,
} from '@twentyfour/ui'

/**
 * Changing plan.
 *
 * The self-serve split is the point. Both routes converge on the same
 * provisioning saga, but not every module can finish unattended: KYC approval
 * and ad-account consent need a person. So this says which parts switch on
 * straight away and which are queued, before the money moves rather than
 * after.
 */
export function TierChangeDialog({
  tier,
  onClose,
}: {
  tier: TierId | null
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { record } = useEntitlement()

  const change = useMutation({
    mutationFn: () => billing.changeTier(tier as TierId, 'monthly'),
    onSuccess: (result) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: `You are on ${TIERS[tier as TierId].name}`,
        description:
          result.queued.length > 0
            ? 'Most of it is on now. A specialist is finishing the rest.'
            : 'Everything switched on straight away.',
      })
      onClose()
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'That change was refused', description: error.message }),
  })

  if (!tier) return <Dialog open={false} onClose={onClose} title="">{null}</Dialog>

  const target = TIERS[tier]
  const up = isUpgrade(record.tier, tier)
  const plan = up ? planUpgrade(record, tier) : null
  const losing = up ? [] : planDowngrade(record, tier)
  const quoted = target.monthlyMinor === null

  return (
    <Dialog
      open={tier !== null}
      onClose={onClose}
      size="lg"
      title={quoted ? 'Talk to us about Enterprise' : `Move to ${target.name}`}
      description={target.tagline}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {quoted ? (
            <Button
              onClick={() => {
                // Enterprise is provisioned per customer, so there is nothing
                // to switch on here. It raises a request for a specialist.
                toast.show({
                  tone: 'success',
                  title: 'A specialist will be in touch',
                  description: 'Enterprise is put together per business, so it starts with a conversation.',
                })
                onClose()
              }}
            >
              Request a call
            </Button>
          ) : (
            <Button
              variant={up ? 'primary' : 'danger'}
              loading={change.isPending}
              onClick={() => change.mutate()}
            >
              {up ? `Move to ${target.name}` : `Downgrade to ${target.name}`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {!quoted && (
          <div className="flex items-baseline justify-between gap-4 rounded-xl bg-surface-sunken p-4">
            <span className="text-base text-text-muted">New monthly price, ex VAT</span>
            <span className="text-2xl font-semibold text-text">
              <MoneyText value={money(target.monthlyMinor as number, target.currency)} deemphasiseSymbol />
            </span>
          </div>
        )}

        {plan && plan.grantedImmediately.length > 0 && (
          <section>
            <h3 className="flex items-center gap-2 text-sm font-medium text-text">
              <Icon name="CheckCircle2" size="sm" className="text-success-text" />
              On straight away
            </h3>
            <ul className="mt-2 flex flex-col gap-1">
              {plan.grantedImmediately.map((id) => (
                <li key={id} className="text-base text-text-muted">
                  {MODULES[id].name}
                  <span className="block text-sm text-text-subtle">{MODULES[id].summary}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Never silently half-completes. Payment is taken, everything that
            provisioned cleanly is granted, and the rest is named here. */}
        {plan && plan.queuedToSpecialist.length > 0 && (
          <Card className="border-warning-border bg-warning-subtle">
            <div className="flex gap-3">
              <Icon name="Clock" size="lg" className="mt-0.5 shrink-0 text-warning-text" />
              <div>
                <p className="text-base font-medium text-text">
                  A specialist has to finish {plan.queuedToSpecialist.length === 1 ? 'one part' : 'some parts'}
                </p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {plan.queuedToSpecialist.map((id) => (
                    <li key={id} className="text-base text-text-muted">
                      <span className="font-medium text-text">{MODULES[id].name}</span>
                      {id === 'payments'
                        ? ' needs your processor to verify the business, which is on their clock.'
                        : id === 'marketing_ads'
                          ? ' needs you to connect an ad account, which only you can approve.'
                          : ' needs a step that cannot complete on its own.'}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-base text-text-muted">
                  You are charged for the whole plan now, and told the moment each one is ready.
                </p>
              </div>
            </div>
          </Card>
        )}

        {losing.length > 0 && (
          <Card className="border-danger-border bg-danger-subtle">
            <div className="flex gap-3">
              <Icon name="TriangleAlert" size="lg" className="mt-0.5 shrink-0 text-danger-text" />
              <div>
                <p className="text-base font-medium text-text">You would lose access to</p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {losing.map((id) => (
                    <li key={id} className="text-base text-text-muted">{MODULES[id].name}</li>
                  ))}
                </ul>
                <p className="mt-2 text-base text-text-muted">
                  Nothing is deleted. The screens go, and the data is there if you come back.
                </p>
              </div>
            </div>
          </Card>
        )}

        {plan && plan.seatsBefore !== plan.seatsAfter && (
          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <span className="text-base text-text-muted">Staff seats</span>
            <span className="flex items-center gap-2 text-base">
              <span className="tnum text-text-subtle line-through">{plan.seatsBefore ?? 'custom'}</span>
              <Icon name="ArrowRight" size="sm" className="text-text-subtle" />
              <Badge tone="success">{plan.seatsAfter ?? 'negotiated'}</Badge>
            </span>
          </div>
        )}

        {target.perks.some((perk) => perk.comingSoon) && (
          <p className="flex items-start gap-2 text-sm text-text-muted">
            <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
            {target.perks.filter((perk) => perk.comingSoon).map((perk) => perk.label).join(' and ')}{' '}
            {target.perks.filter((perk) => perk.comingSoon).length === 1 ? 'is' : 'are'} advertised
            as coming soon and not built yet. You are not charged differently for it.
          </p>
        )}
      </div>
    </Dialog>
  )
}
