import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys, settings, type NotificationChannel, type NotificationPreferences } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { useBootstrap } from '@twentyfour/runtime'
import { usePermission } from '@twentyfour/rbac'
import {
  Button, Card, CardHeader, Icon, Skeleton, Switch, cn, useToast,
} from '@twentyfour/ui'

const CHANNELS: Array<{ id: NotificationChannel; label: string; note: string }> = [
  { id: 'email', label: 'Email', note: 'Receipts, reminders and anything long.' },
  { id: 'sms', label: 'SMS', note: 'Reminders. Costs money per message, so keep it for what matters.' },
  { id: 'push', label: 'Push', note: 'Only reaches people who installed your site as an app.' },
]

export function NotificationsTab() {
  const toast = useToast()
  const terms = useTerms()
  const queryClient = useQueryClient()
  const { profile } = useBootstrap()
  const mayEdit = usePermission('settings.business')

  const query = useQuery({
    queryKey: queryKeys.settings.notifications(),
    queryFn: settings.notifications,
  })

  const [draft, setDraft] = useState<NotificationPreferences | null>(null)
  useEffect(() => {
    if (query.data) setDraft(query.data)
  }, [query.data])

  const save = useMutation({
    mutationFn: () => settings.updateNotifications(draft as NotificationPreferences),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.notifications() })
      toast.show({ tone: 'success', title: 'Notification settings saved' })
    },
  })

  if (!draft) return <Skeleton className="h-64 w-full" />

  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data)
  const toggleChannel = (id: NotificationChannel) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            channels: current.channels.includes(id)
              ? current.channels.filter((entry) => entry !== id)
              : [...current.channels, id],
          }
        : current,
    )

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Channels" description="How you are willing to reach people at all." />
        <div className="mt-4 flex flex-col gap-3">
          {CHANNELS.map((channel) => (
            <Switch
              key={channel.id}
              checked={draft.channels.includes(channel.id)}
              onChange={() => toggleChannel(channel.id)}
              disabled={!mayEdit}
              label={channel.label}
              description={channel.note}
            />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Quiet hours"
          description={`Nothing goes out between these, in ${profile.timezone}.`}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="time"
            lang={profile.locale}
            aria-label="Quiet from"
            value={draft.quietFrom}
            disabled={!mayEdit}
            onChange={(event) => setDraft({ ...draft, quietFrom: event.target.value })}
            className="h-11 rounded-lg border border-border-strong bg-surface px-3 text-base"
          />
          <span className="text-text-subtle">until</span>
          <input
            type="time"
            lang={profile.locale}
            aria-label="Quiet until"
            value={draft.quietTo}
            disabled={!mayEdit}
            onChange={(event) => setDraft({ ...draft, quietTo: event.target.value })}
            className="h-11 rounded-lg border border-border-strong bg-surface px-3 text-base"
          />
        </div>
        {/* The reason this setting exists at all, said once. */}
        <p className="mt-3 flex items-start gap-2 text-sm text-text-muted">
          <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
          A reminder that arrives at two in the morning does more harm than one that never
          arrives. Anything due inside quiet hours waits until they end.
        </p>
      </Card>

      <Card>
        <CardHeader title="What gets sent" />
        <div className="mt-4 flex flex-col gap-3">
          <Switch
            checked={draft.bookingReminders}
            onChange={(value) => setDraft({ ...draft, bookingReminders: value })}
            disabled={!mayEdit}
            label={`${terms.t('booking')} reminders`}
            description="The single most effective thing you can send. It is how no-shows come down."
          />
          <Switch
            checked={draft.receiptByEmail}
            onChange={(value) => setDraft({ ...draft, receiptByEmail: value })}
            disabled={!mayEdit}
            label={`${terms.t('receipt')} by email`}
            description="Offered at the till when you have an address."
          />
          <Switch
            checked={draft.marketing}
            onChange={(value) => setDraft({ ...draft, marketing: value })}
            disabled={!mayEdit}
            label="Marketing messages"
            description="Only ever to people who agreed to it. Their consent is recorded on their record and always wins."
          />
        </div>
      </Card>

      {mayEdit && (
        <div className={cn('flex items-center gap-3')}>
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            Save changes
          </Button>
          {dirty && <span className="text-sm text-text-subtle">You have unsaved changes.</span>}
        </div>
      )}
    </div>
  )
}
