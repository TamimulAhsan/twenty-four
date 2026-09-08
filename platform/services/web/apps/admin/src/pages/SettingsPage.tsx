import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminPlatform } from '@twentyfour/api'
import { MODULES, TIERS } from '@twentyfour/entitlement'
import { Badge, Button, Card, CardHeader, PageHeader, Skeleton, useDateFormat } from '@twentyfour/ui'
import { KeyValue, Preamble, ROLE_LABELS, Section } from '../common'
import { useAdminSession, useEnvironment, useSignOut } from '../session'

/**
 * What this deployment is, and what it does by default.
 *
 * Read-only, deliberately. Every value on this page is either a property of
 * the deployment (its market, its currency, its release) or derived from the
 * registry (which tiers go live unattended), and both are changed by deploying
 * or by editing the registry, not by typing into a console. A settings page
 * full of inputs that write nowhere is worse than one that admits it.
 */
export function SettingsPage() {
  const environment = useEnvironment()
  const session = useAdminSession()
  const dates = useDateFormat()
  const { signOut, pending } = useSignOut()

  const tiers = useQuery({ queryKey: adminKeys.tiers(), queryFn: adminPlatform.tiers })

  const unattended = (tiers.data ?? []).filter((row) => row.autoProvision)
  const attended = (tiers.data ?? []).filter((row) => !row.autoProvision)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="What this deployment is, what it promises, and who is signed in."
      />

      <Preamble>
        One market per deployment. Nothing here reaches another market and nothing here can be
        pointed at one: the other environment is a different VPS with its own database, its own
        event bus, its own books and its own console.
      </Preamble>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="This deployment" />
          <div className="mt-3">
            <KeyValue
              rows={[
                { key: 'Market', value: environment.market },
                { key: 'Environment', value: environment.environment },
                { key: 'Currency', value: environment.currency },
                { key: 'Locale', value: environment.locale },
                { key: 'Timezone', value: environment.timezone },
                { key: 'Release', value: <span className="font-mono text-sm">{environment.release}</span> },
                { key: 'Documents submitted to', value: environment.fiscalAuthority },
                { key: 'Data residency', value: `${environment.market}, on this deployment's own host` },
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="You" description="Signed in through your staff account." />
          <div className="mt-3">
            <KeyValue
              rows={[
                { key: 'Name', value: session.name },
                { key: 'Email', value: session.email },
                {
                  key: 'Role',
                  value: (
                    <Badge tone={session.role === 'platform_admin' ? 'accent' : 'neutral'}>
                      {ROLE_LABELS[session.role]}
                    </Badge>
                  ),
                },
                { key: 'Second factor', value: session.mfa },
                { key: 'Address', value: <span className="font-mono text-sm">{session.sourceIp}</span> },
                { key: 'Signed in', value: dates.dateTime(session.signedInAt) },
              ]}
            />
          </div>
          <Button variant="outline" className="mt-4" loading={pending} iconStart="LogOut" onClick={signOut}>
            Sign out
          </Button>
          <p className="mt-2 text-sm text-text-subtle">
            Signing out revokes every support token this session is holding.
          </p>
        </Card>
      </div>

      <Section
        title="Going live"
        description={`What every new tenant in this environment gets by default.`}
      >
        <Card>
          <KeyValue
            rows={[
              { key: 'The promise', value: `${environment.goLiveHours} hours, or the first month is free` },
              { key: 'When the clock starts', value: 'At the intake call, not at signup' },
              {
                key: 'Business type',
                value: 'From the selector on the signup form, or recorded by a specialist',
              },
              {
                key: 'Seat quota',
                value: 'Hard. The gateway refuses the invite rather than the dashboard hiding it',
              },
              { key: 'Saga retries', value: 'Five attempts, backing off, then queued to a specialist' },
            ]}
          />
        </Card>
      </Section>

      <Section
        title="Which tiers go live unattended"
        description="Derived from the module set, not a switch. A tier needs a specialist exactly when something it grants does."
      >
        {tiers.isPending ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <p className="text-base font-medium text-success-text">Unattended</p>
              <p className="mt-1 text-base text-text-muted">
                {unattended.length === 0
                  ? 'None. Every tier grants something that needs a person.'
                  : unattended.map((row) => TIERS[row.tier].name).join(', ')}
              </p>
            </Card>
            <Card>
              <p className="text-base font-medium text-warning-text">Needs a specialist</p>
              {attended.length === 0 ? (
                <p className="mt-1 text-base text-text-muted">None.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {attended.map((row) => (
                    <li key={row.tier} className="text-base text-text-muted">
                      <span className="font-medium text-text">{TIERS[row.tier].name}</span>:{' '}
                      {row.needsSpecialist.map((id) => MODULES[id].name).join(', ')}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
        <p className="mt-3 text-sm text-text-subtle">
          A self-serve signup on an attended tier still completes as far as it can: the payment is
          taken, everything that provisioned cleanly is granted, and the rest is queued with the
          merchant told what is still coming. It never half-completes silently.
        </p>
      </Section>

      <Section
        title="Impersonation policy"
        description="Applied by the admin gateway, not by this console."
      >
        <Card>
          <KeyValue
            rows={[
              { key: 'Read-only token', value: `${environment.readTokenMinutes} minutes` },
              { key: 'Write token', value: `${environment.writeTokenMinutes} minutes` },
              { key: 'Reason to raise to write', value: 'Required' },
              { key: 'Concurrent sessions per specialist', value: 'One' },
              { key: 'Merchant notified', value: 'When a session is raised to write' },
              { key: 'Audit retention', value: `${environment.auditRetentionYears} years, append-only` },
            ]}
          />
        </Card>
      </Section>

      <Section title="Security" description="The admin plane has its own gateway and its own realm.">
        <Card>
          <KeyValue
            rows={[
              { key: 'Sign-in', value: 'Staff single sign-on. No password reaches this console' },
              { key: 'Second factor', value: 'Enforced on every session' },
              { key: 'Network', value: 'IP allowlist at the gateway' },
              { key: 'Origin', value: 'Its own host. No cookie is shared with the merchant applications' },
              { key: 'Tier registry', value: 'Editable by the platform owner only' },
            ]}
          />
        </Card>
      </Section>
    </div>
  )
}
