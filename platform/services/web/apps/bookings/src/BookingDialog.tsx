import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HttpError, bookings, catalog, queryKeys, staff, type Booking } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { Badge, Button, Dialog, Field, Input, MoneyText, Select, useDateFormat, useToast } from '@twentyfour/ui'

export function NewBookingDialog({
  open, startsAt, staffId, onClose,
}: { open: boolean; startsAt: string | null; staffId: string | null; onClose: () => void }) {
  const terms = useTerms()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [itemId, setItemId] = useState('')
  const [person, setPerson] = useState(staffId ?? '')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')

  const services = useQuery({
    queryKey: queryKeys.catalog.items({ kind: 'service' }),
    queryFn: () => catalog.items({ kind: 'service' }),
    enabled: open,
  })
  const people = useQuery({ queryKey: queryKeys.staff.list(), queryFn: staff.list, enabled: open })

  useEffect(() => {
    if (open) {
      setPerson(staffId ?? '')
      setItemId(services.data?.[0]?.id ?? '')
    }
  }, [open, staffId, services.data])

  const create = useMutation({
    mutationFn: () =>
      bookings.create({
        itemId,
        staffId: person || null,
        customerName: name,
        customerPhone: phone,
        startsAt: startsAt!,
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
          <Button loading={create.isPending} disabled={!itemId || !name} onClick={() => create.mutate()}>
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

        <Field label={terms.t('staff_member')} htmlFor="person">
          <Select id="person" value={person} onChange={(event) => setPerson(event.target.value)}>
            <option value="">Anyone available</option>
            {(people.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </Select>
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
