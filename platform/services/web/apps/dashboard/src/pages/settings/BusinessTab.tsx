import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settings, type OpeningHours } from '@twentyfour/api'
import { industryProfile, useEntitlement } from '@twentyfour/entitlement'
import { useBootstrap } from '@twentyfour/runtime'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, CardHeader, Dialog, Icon, Input, cn, useToast,
} from '@twentyfour/ui'
import { BusinessTypeSelector } from '@twentyfour/shell'
import { MediaField } from '../../media/MediaField'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDER = [1, 2, 3, 4, 5, 6, 0]

export function BusinessTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { profile } = useBootstrap()
  const { record } = useEntitlement()
  const mayEdit = usePermission('settings.business')

  const [name, setName] = useState(profile.name)
  const [hours, setHours] = useState<OpeningHours[]>([...profile.openingHours])
  const [changingType, setChangingType] = useState(false)

  const save = useMutation({
    mutationFn: () => settings.updateProfile({ name: name.trim(), openingHours: hours }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: 'Saved' })
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'That did not save', description: error.message }),
  })

  const current = industryProfile(profile.industry)
  const dirty =
    name.trim() !== profile.name ||
    JSON.stringify(hours) !== JSON.stringify(profile.openingHours)

  const setDay = (weekday: number, patch: Partial<OpeningHours>) => {
    setHours((entries) =>
      entries.map((entry) => (entry.weekday === weekday ? { ...entry, ...patch } : entry)),
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="The business" description="What customers see on receipts, emails and your site." />
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Input
            label="Name"
            value={name}
            disabled={!mayEdit}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">What kind of business</span>
            <div className="flex items-center gap-2">
              <span className="flex h-11 flex-1 items-center rounded-lg border border-border bg-surface-sunken px-3 text-base">
                {current?.name ?? profile.industry}
              </span>
              {mayEdit && (
                <Button variant="outline" onClick={() => setChangingType(true)}>Change</Button>
              )}
            </div>
            <p className="text-sm text-text-muted">
              Decides what things are called and which screens exist.
            </p>
          </div>
        </div>

        {/* Not editable, and the reason is worth stating: it is a property of
            the deployment, not of the account. */}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4">
          <Fact label="Currency" value={profile.currency} />
          <Fact label="Language" value={profile.locale} />
          <Fact label="Time zone" value={profile.timezone} />
          <Fact label="Plan" value={record.tier.charAt(0).toUpperCase() + record.tier.slice(1)} />
        </div>
        <p className="mt-2 flex items-start gap-2 text-sm text-text-subtle">
          <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
          Currency and language come from the market this account was set up in and cannot be
          changed here. Moving market means a new account.
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Your mark"
          description="Appears on documents, on emails and on your site."
        />
        <div className="mt-4">
          <MediaField
            purpose="brand_logo"
            label="Logo"
            hint="PNG, JPEG, WebP or AVIF, up to 4 MB. It is stored once and used everywhere."
            disabled={!mayEdit}
          />
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader
          className="p-5"
          title="Opening hours"
          description="The outer limit for every booking slot, and what your site shows."
        />
        <div className="flex flex-col divide-y divide-border">
          {ORDER.map((weekday) => {
            const day = hours.find((entry) => entry.weekday === weekday)
            const closed = !day?.opens
            return (
              <div key={weekday} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="w-24 shrink-0 text-base font-medium text-text">
                  {WEEKDAYS[weekday]}
                </span>
                {closed ? (
                  <Badge tone="neutral">Closed</Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      lang={profile.locale}
                      value={day?.opens ?? ''}
                      disabled={!mayEdit}
                      onChange={(event) => setDay(weekday, { opens: event.target.value })}
                      className="h-10 rounded-lg border border-border-strong bg-surface px-2.5 text-base"
                    />
                    <span className="text-text-subtle">to</span>
                    <input
                      type="time"
                      lang={profile.locale}
                      value={day?.closes ?? ''}
                      disabled={!mayEdit}
                      onChange={(event) => setDay(weekday, { closes: event.target.value })}
                      className="h-10 rounded-lg border border-border-strong bg-surface px-2.5 text-base"
                    />
                  </div>
                )}
                {mayEdit && (
                  <button
                    type="button"
                    onClick={() =>
                      setDay(weekday, closed ? { opens: '09:00', closes: '17:00' } : { opens: null, closes: null })
                    }
                    className={cn(
                      'ml-auto text-sm font-medium text-accent-text underline-offset-4 hover:underline',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                    )}
                  >
                    {closed ? 'Open this day' : 'Mark closed'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {mayEdit && (
        <div className="flex items-center gap-3">
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            Save changes
          </Button>
          {dirty && <span className="text-sm text-text-subtle">You have unsaved changes.</span>}
        </div>
      )}

      <ChangeTypeDialog
        open={changingType}
        currentId={profile.industry}
        onClose={() => setChangingType(false)}
      />
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-text-muted">{label}</p>
      <p className="text-base font-medium text-text">{value}</p>
    </div>
  )
}

/**
 * Changing what kind of business this is.
 *
 * Behind a confirmation because it is not a preference: it changes what
 * everything is called, which screens appear, and which capabilities switch
 * on. A merchant who picks it idly from a dropdown finds their menu has become
 * a price list.
 */
function ChangeTypeDialog({
  open,
  currentId,
  onClose,
}: {
  open: boolean
  currentId: string
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [chosen, setChosen] = useState(currentId)

  const save = useMutation({
    mutationFn: () => settings.updateProfile({ industry: chosen }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: 'Business type changed',
        description: 'Words and screens have moved with it.',
      })
      onClose()
    },
  })

  const before = industryProfile(currentId)
  const after = industryProfile(chosen)
  const changed = chosen !== currentId

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="What kind of business is this"
      description="It decides the vocabulary, the screens and the starting catalog."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!changed} onClick={() => save.mutate()}>
            Change it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <BusinessTypeSelector value={chosen} onChange={setChosen} autoFocus />

        {changed && (
          <Card className="border-warning-border bg-warning-subtle">
            <div className="flex gap-3">
              <Icon name="TriangleAlert" size="lg" className="mt-0.5 shrink-0 text-warning-text" />
              <div className="text-base text-text-muted">
                <p className="font-medium text-text">
                  {before?.name} becomes {after?.name}
                </p>
                <p className="mt-1">
                  Everything keeps its data. What changes is what it is called, and which screens
                  appear: a change out of food service takes the prep screens with it.
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>
    </Dialog>
  )
}
