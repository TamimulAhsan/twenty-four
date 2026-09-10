import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HttpError, bookings, catalog, queryKeys, type Booking } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { Badge, Button, Dialog, Field, Input, MoneyText, Select, useDateFormat, useToast } from '@twentyfour/ui'

/** The local date part of an instant, which is what availability is asked by. */
function dayOf(iso: string): string {
  const at = new Date(iso)
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

export function NewBookingDialog({
  open, startsAt, resourceId, onClose,
}: { open: boolean; startsAt: string | null; resourceId: string | null; onClose: () => void }) {
  const terms = useTerms()
  const toast = useToast()
  const dates = useDateFormat()
  const queryClient = useQueryClient()

  const [itemId, setItemId] = useState('')
  const [resource, setResource] = useState(resourceId ?? '')
  const [when, setWhen] = useState<string | null>(startsAt)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')

  const services = useQuery({
    queryKey: queryKeys.catalog.items({ kind: 'service' }),
    queryFn: () => catalog.items({ kind: 'service' }),
    enabled: open,
  })
  const resources = useQuery({
    queryKey: queryKeys.bookings.resources(),
    queryFn: () => bookings.resources(),
    enabled: open,
  })

  const day = startsAt ? dayOf(startsAt) : ''
  /**
   * The free times, asked of the service rather than worked out here.
   *
   * That is the point of asking: availability is the opening pattern minus
   * what is already booked, and a browser computing it would compute it from a
   * list it fetched a moment ago. The service answers from the same rows it
   * will lock against when the booking is written, so a slot it offers is a
   * slot it can still honour.
   */
  const slots = useQuery({
    queryKey: queryKeys.bookings.availability(itemId, day, resource || undefined),
    queryFn: () => bookings.availability(itemId, day, resource || undefined),
    enabled: open && Boolean(itemId) && Boolean(day),
  })

  useEffect(() => {
    if (open) {
      setResource(resourceId ?? '')
      setWhen(startsAt)
      setItemId(services.data?.[0]?.id ?? '')
    }
  }, [open, resourceId, startsAt, services.data])

  const create = useMutation({
    mutationFn: () =>
      bookings.create({
        itemId,
        resourceId: resource || null,
        customerName: name,
        customerPhone: phone,
        startsAt: when!,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: `${terms.t('booking')} confirmed`, description: `${name} is booked in.` })
      setName('')
      setPhone('')
      onClose()
    },
  })

  const error = create.error instanceof HttpError ? create.error : undefined

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`New ${terms.t('booking', { case: 'lower' })}`}
      description={startsAt ? new Date(startsAt).toLocaleString() : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={!itemId || !name || !when} onClick={() => create.mutate()}>
            Book it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Never double-book a person. The server refuses it; this is where
            the refusal gets explained rather than surfacing as a raw 409. */}
        {error?.code === 'double_booked' && (
          <div role="alert" className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-base text-text-muted">
            {error.message} Pick another time or another {terms.t('staff_member', { case: 'lower' })}.
          </div>
        )}

        <Field label={terms.t('catalog_item')} htmlFor="service">
          <Select id="service" value={itemId} onChange={(event) => setItemId(event.target.value)}>
            {(services.data ?? []).map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} · {service.durationMinutes} min
              </option>
            ))}
          </Select>
        </Field>

        <Field label={terms.t('staff_member')} htmlFor="resource">
          <Select id="resource" value={resource} onChange={(event) => setResource(event.target.value)}>
            <option value="">Anyone available</option>
            {(resources.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </Select>
        </Field>

        <Field label="Time" htmlFor="slot">
          {slots.isLoading && <p className="text-base text-text-subtle">Looking for free times...</p>}
          {slots.data && slots.data.length === 0 && (
            /* Closed and full are different answers and the service tells them
               apart, but on this screen either way there is nothing to pick. */
            <p className="text-base text-text-subtle">
              Nothing free that day. Try another day or another {terms.t('staff_member', { case: 'lower' })}.
            </p>
          )}
          {slots.data && slots.data.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {slots.data.map((slot) => (
                <button
                  key={`${slot.resourceId}-${slot.startsAt}`}
                  type="button"
                  onClick={() => {
                    setWhen(slot.startsAt)
                    // Taking the offered slot's resource too, so "anyone" turns
                    // into the one that was actually free at that moment.
                    setResource(slot.resourceId)
                  }}
                  className={
                    when === slot.startsAt
                      ? 'rounded-lg border border-accent bg-accent-subtle px-3 py-2 text-base text-text'
                      : 'rounded-lg border border-border px-3 py-2 text-base text-text-muted hover:border-accent'
                  }
                >
                  {dates.time(slot.startsAt)}
                </button>
              ))}
            </div>
          )}
        </Field>

        <Input label={`${terms.t('customer')} name`} required value={name} onChange={(event) => setName(event.target.value)} />
        <Input label="Phone" type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
      </div>
    </Dialog>
  )
}

const STATUS_TONE = {
  confirmed: 'accent', arrived: 'success', completed: 'neutral',
  cancelled: 'neutral', no_show: 'danger',
} as const

export function BookingDetailDialog({
  booking, onClose,
}: { booking: Booking | null; onClose: () => void }) {
  const terms = useTerms()
  const toast = useToast()
  const dates = useDateFormat()
  const queryClient = useQueryClient()

  const update = useMutation({
    mutationFn: (status: Booking['status']) => bookings.update(booking!.id, { status }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: `Marked ${updated.status.replace(/_/g, ' ')}` })
      onClose()
    },
  })

  return (
    <Dialog
      open={booking !== null}
      onClose={onClose}
      title={booking?.customerName ?? ''}
      description={booking ? `${booking.itemName} · ${dates.dateTime(booking.startsAt)}` : undefined}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {booking && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge dot tone={STATUS_TONE[booking.status]}>{booking.status.replace(/_/g, ' ')}</Badge>
            <span className="font-mono text-sm text-text-muted">{booking.reference}</span>
            {booking.deposit && (
              <Badge tone="success">
                Deposit <MoneyText value={booking.deposit} />
              </Badge>
            )}
          </div>

          {booking.customerPhone && (
            <p className="text-base text-text-muted">{booking.customerPhone}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" iconStart="Check" loading={update.isPending}
              onClick={() => update.mutate('arrived')}>
              Arrived
            </Button>
            <Button size="sm" variant="outline" iconStart="CheckCircle2" loading={update.isPending}
              onClick={() => update.mutate('completed')}>
              Completed
            </Button>
            {/* A no-show is not a cancellation: it is what the deposit rules
                and the reporting both hang off, so it gets its own action. */}
            <Button size="sm" variant="outline" iconStart="Ban" loading={update.isPending}
              onClick={() => update.mutate('no_show')}>
              {terms.t('no_show')}
            </Button>
            <Button size="sm" variant="danger" iconStart="X" loading={update.isPending}
              onClick={() => update.mutate('cancelled')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
