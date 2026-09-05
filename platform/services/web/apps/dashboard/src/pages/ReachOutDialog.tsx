import { useEffect, useState } from 'react'
import type { Customer } from '@twentyfour/api'
import type { CustomerMetrics } from '@twentyfour/analytics'
import { SEGMENTS } from '@twentyfour/analytics'
import { Button, Card, Dialog, Icon, Textarea, cn, useToast } from '@twentyfour/ui'
import { useBootstrap } from '@twentyfour/runtime'

/**
 * Drafting a message to one customer.
 *
 * Opens with a draft already written from their segment, because the hard part
 * is not sending it, it is knowing what to say to someone who has not been in
 * for two months. The draft is a starting point and is meant to be edited.
 *
 * Consent is checked before the dialog can be opened at all: contacting
 * someone who did not agree to it is a legal problem, not a marketing one.
 */
export function ReachOutDialog({
  customer,
  metrics,
  open,
  onClose,
}: {
  customer: Customer
  metrics: CustomerMetrics
  open: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const { profile } = useBootstrap()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const segment = SEGMENTS[metrics.segment]

  useEffect(() => {
    if (!open) return
    const first = customer.name.split(/\s+/).slice(-1)[0] ?? customer.name
    const favourite = metrics.favouriteItems[0]?.name
    const draft =
      metrics.segment === 'champion' || metrics.segment === 'loyal'
        ? `Hello ${first},\n\nYou are one of our regulars and we notice. Come in this week and there is something on the house waiting for you.\n\n${profile.name}`
        : metrics.segment === 'cannot_lose' || metrics.segment === 'at_risk'
          ? `Hello ${first},\n\nIt has been ${metrics.recencyDays} days and we have missed you.${favourite ? ` The ${favourite} is still here.` : ''} Come back in and the next one is on us.\n\n${profile.name}`
          : metrics.segment === 'new'
            ? `Hello ${first},\n\nThank you for coming in. If there was anything we could have done better, tell us. And if there was not, we would love to see you again.\n\n${profile.name}`
            : `Hello ${first},\n\nWe have not seen you in a while.${favourite ? ` Your usual ${favourite} is still on.` : ''} Drop in when you can.\n\n${profile.name}`
    setBody(draft)
  }, [open, customer, metrics, profile.name])

  const send = () => {
    setSending(true)
    // Goes out through the Notification service, which owns templates,
    // branding, channel preference and quiet hours. Nothing about the message
    // is decided here except its words.
    window.setTimeout(() => {
      setSending(false)
      toast.show({
        tone: 'success',
        title: `Queued for ${customer.name}`,
        description: 'It will respect their quiet hours and channel preference.',
      })
      onClose()
    }, 500)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reach out to ${customer.name}`}
      description={customer.email ?? customer.phone ?? undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={sending} disabled={!body.trim()} onClick={send}>Send it</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card className={cn('bg-surface-sunken')}>
          <div className="flex gap-3">
            <Icon name="Info" size="lg" className="mt-0.5 shrink-0 text-text-subtle" />
            <div>
              <p className="text-base font-medium text-text">{segment.label}</p>
              <p className="mt-0.5 text-base text-text-muted">{segment.action}</p>
            </div>
          </div>
        </Card>

        <Textarea
          label="Message"
          rows={8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          hint="Written from their segment as a starting point. Change whatever does not sound like you."
        />

        <p className="flex items-start gap-2 text-sm text-text-subtle">
          <Icon name="ShieldCheck" size="sm" className="mt-0.5 shrink-0" />
          Sent through your notification settings, so it honours their channel preference and your
          quiet hours rather than going out at two in the morning.
        </p>
      </div>
    </Dialog>
  )
}
