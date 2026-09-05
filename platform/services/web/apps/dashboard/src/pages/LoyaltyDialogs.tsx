import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { loyalty, type LoyaltyMember, type LoyaltyProgramme } from '@twentyfour/api'
import { MoneyError, parseDecimalInput, toDecimalString } from '@twentyfour/money'
import {
  Badge, Button, Card, Dialog, Icon, Input, MoneyText, Switch, cn, useDateFormat, useFormat,
  useToast,
} from '@twentyfour/ui'

/**
 * How the card works.
 *
 * The earn rate and the point value together decide what the programme costs,
 * so they are edited side by side with the result spelled out underneath.
 * Setting them apart is how a business ends up owing more per visit than the
 * visit is worth.
 */
export function LoyaltyProgrammeDialog({
  programme,
  open,
  onClose,
}: {
  programme: LoyaltyProgramme | undefined
  open: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { currency } = useFormat()
  const [name, setName] = useState('')
  const [per, setPer] = useState('')
  const [pointValue, setPointValue] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!open || !programme) return
    setError(undefined)
    setName(programme.name)
    setPer(String(Math.round(10_000 / Math.max(programme.earnBasisPoints, 1))))
    setPointValue(toDecimalString(programme.pointValue))
    setEnabled(programme.enabled)
  }, [open, programme])

  const save = useMutation({
    mutationFn: (input: Partial<LoyaltyProgramme>) => loyalty.updateProgramme(input),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: 'Programme saved' })
      onClose()
    },
    onError: (problem) =>
      toast.show({ tone: 'danger', title: 'That did not save', description: problem.message }),
  })

  const submit = () => {
    const spend = Number(per)
    if (!name.trim()) return setError('Give the programme a name. Members will see it.')
    if (!Number.isFinite(spend) || spend < 1) return setError('Enter how much earns a point.')

    let value
    try {
      value = parseDecimalInput(pointValue, currency)
    } catch (problem) {
      return setError(problem instanceof MoneyError ? problem.message : 'Enter what a point is worth.')
    }

    save.mutate({
      name: name.trim(),
      enabled,
      earnBasisPoints: Math.round(10_000 / spend),
      pointValue: value as never,
    })
  }

  // What the programme actually costs, as a share of what people spend. The
  // number nobody works out by hand and everybody should see.
  const cost = (() => {
    const spend = Number(per)
    try {
      const value = parseDecimalInput(pointValue, currency)
      if (!Number.isFinite(spend) || spend < 1) return null
      return value.minor / spend
    } catch {
      return null
    }
  })()

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Programme settings"
      description="What members earn, and what it costs you."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={submit}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div role="alert" className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-base text-text-muted">
            {error}
          </div>
        )}

        <Input
          label="Name"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError(undefined)
          }}
          hint="Members see this on their card and in emails."
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Spend that earns one point"
            numeric
            inputMode="numeric"
            suffix={currency}
            value={per}
            onChange={(event) => setPer(event.target.value)}
          />
          <Input
            label="What one point is worth"
            numeric
            inputMode="decimal"
            suffix={currency}
            value={pointValue}
            onChange={(event) => setPointValue(event.target.value)}
          />
        </div>

        {cost !== null && (
          <Card className={cn('bg-surface-sunken', cost > 0.1 && 'border-warning-border bg-warning-subtle')}>
            <p className="text-base text-text-muted">
              This gives back{' '}
              <span className="font-medium text-text">{(cost * 100).toFixed(1)}%</span> of everything
              a member spends.
              {cost > 0.1 && ' That is more than most margins can carry.'}
            </p>
          </Card>
        )}

        <div className="border-t border-border pt-4">
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label="Running"
            description="Off stops earning. Members keep the balance they already have."
          />
        </div>
      </div>
    </Dialog>
  )
}

/** One member: what they have, and how far off the next tier. */
export function LoyaltyMemberDialog({
  member,
  programme,
  onClose,
}: {
  member: LoyaltyMember | null
  programme: LoyaltyProgramme | undefined
  onClose: () => void
}) {
  const navigate = useNavigate()
  const dates = useDateFormat()
  const { currency } = useFormat()

  const tier = programme?.tiers.find((entry) => entry.id === member?.tierId)
  const next = programme?.tiers.find((entry) => entry.threshold > (member?.lifetimePoints ?? 0))
  const toGo = next ? next.threshold - (member?.lifetimePoints ?? 0) : null
  const worth =
    member && programme ? member.points * programme.pointValue.minor : 0

  return (
    <Dialog
      open={member !== null}
      onClose={onClose}
      title={member?.customerName ?? ''}
      description={member ? `Joined ${dates.date(member.joinedAt)}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {member && (
            <Button
              variant="outline"
              iconEnd="ArrowRight"
              onClick={() => navigate(`/customers/${member.customerId}`)}
            >
              Their whole history
            </Button>
          )}
        </>
      }
    >
      {member && (
        <div className="flex flex-col gap-5">
          <div className="rounded-xl bg-surface-sunken p-4 text-center">
            <p className="text-sm font-medium text-text-muted">Points to spend</p>
            <p className="tnum mt-1 text-3xl font-semibold tracking-[-0.03em] text-text">
              {member.points.toLocaleString()}
            </p>
            <p className="mt-1 text-base text-text-muted">
              worth <MoneyText value={{ minor: worth as never, currency }} />
            </p>
          </div>

          {tier && (
            <div>
              <div className="flex items-center justify-between gap-3">
                <Badge tone={tier.id === 'gold' ? 'warning' : tier.id === 'silver' ? 'accent' : 'neutral'}>
                  {tier.name}
                </Badge>
                {next && toGo !== null && (
                  <span className="tnum text-sm text-text-muted">
                    {toGo.toLocaleString()} more for {next.name}
                  </span>
                )}
              </div>
              {next && toGo !== null && (
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{
                      width: `${Math.min(100, (member.lifetimePoints / next.threshold) * 100)}%`,
                    }}
                  />
                </div>
              )}
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {tier.perks.map((perk) => (
                  <li key={perk} className="flex items-center gap-1.5 text-sm text-text-muted">
                    <Icon name="Check" size="sm" className="text-success-text" />
                    {perk}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className="flex flex-col divide-y divide-border border-t border-border">
            <Row label="Earned in total">{member.lifetimePoints.toLocaleString()}</Row>
            <Row label="Already spent">{member.redeemedPoints.toLocaleString()}</Row>
            <Row label="Last earned">
              {member.lastEarnedAt ? dates.date(member.lastEarnedAt) : 'Never'}
            </Row>
          </dl>
        </div>
      )}
    </Dialog>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-base text-text-muted">{label}</dt>
      <dd className="tnum text-base font-medium text-text">{children}</dd>
    </div>
  )
}
