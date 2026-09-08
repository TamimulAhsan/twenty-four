import { useState, type ReactNode } from 'react'
import {
  HttpError,
  type AdminRole,
  type TenantHealth,
  type TenantStatus,
} from '@twentyfour/api'
import { MODULES, TIERS, type ModuleId, type TierId } from '@twentyfour/entitlement'
import { Badge, Button, Card, Dialog, Icon, Textarea, cn, type BadgeTone } from '@twentyfour/ui'

/**
 * The console's shared vocabulary.
 *
 * Every one of these maps a value from the contract onto a tone in the design
 * system, in one place. The design this was built from carried hex colours
 * inline at each of about ninety call sites, which is how "suspended" ends up
 * a different red on two screens and how a theme becomes impossible.
 */

/* ------------------------------------------------------------------ tiers */

/**
 * Tier, as a label.
 *
 * Deliberately toneless. A tier is not a status and colouring it makes a
 * directory look like a heat map of nothing: Enterprise is not better news
 * than Starter, it is a different contract.
 */
export function TierBadge({ tier }: { tier: TierId }) {
  return <Badge>{TIERS[tier].name}</Badge>
}

const STATUS: Readonly<Record<TenantStatus, { label: string; tone: BadgeTone }>> = {
  live: { label: 'Live', tone: 'success' },
  provisioning: { label: 'Setting up', tone: 'accent' },
  suspended: { label: 'Suspended', tone: 'danger' },
  trial: { label: 'Trial', tone: 'warning' },
}

export function StatusBadge({ status }: { status: TenantStatus }) {
  const entry = STATUS[status]
  return (
    <Badge tone={entry.tone} dot>
      {entry.label}
    </Badge>
  )
}

const HEALTH: Readonly<Record<TenantHealth, { tone: BadgeTone; icon: 'CheckCircle2' | 'AlertTriangle' | 'AlertCircle' }>> = {
  ok: { tone: 'success', icon: 'CheckCircle2' },
  attention: { tone: 'warning', icon: 'AlertTriangle' },
  failing: { tone: 'danger', icon: 'AlertCircle' },
}

/**
 * How worried to be, and why.
 *
 * The icon carries the level and the sentence carries the reason, because they
 * are different facts. The design this replaces derived the level by searching
 * the sentence for the word "fail", which quietly disagrees with itself the
 * first time somebody writes "no failures".
 */
export function HealthNote({ health, note }: { health: TenantHealth; note: string }) {
  const entry = HEALTH[health]
  const colour =
    health === 'ok' ? 'text-success-text' : health === 'attention' ? 'text-warning-text' : 'text-danger-text'
  return (
    <span className="flex items-start gap-1.5">
      <Icon name={entry.icon} size="sm" className={cn('mt-0.5 shrink-0', colour)} />
      <span className={cn('text-sm', health === 'ok' ? 'text-text-muted' : colour)}>{note}</span>
    </span>
  )
}

/* ---------------------------------------------------------------- modules */

const KIND_TONE: Readonly<Record<string, BadgeTone>> = {
  always_on: 'success',
  sold: 'accent',
  dependency: 'warning',
}

/**
 * What kind of thing a module is.
 *
 * Read from the registry rather than restated, so a module that changes kind
 * changes here too. The kinds matter commercially: only a sold module belongs
 * to a tier, a dependency arrives because something else needed it, and an
 * always-on module is not for sale at any price.
 */
export function ModuleKind({ id }: { id: ModuleId }) {
  const kind = MODULES[id].kind
  const label = kind === 'always_on' ? 'Always on' : kind === 'sold' ? 'Sold' : 'Dependency'
  return <Badge tone={KIND_TONE[kind] ?? 'neutral'}>{label}</Badge>
}

export function moduleNames(ids: readonly ModuleId[]): string {
  return ids.map((id) => MODULES[id].name).join(', ')
}

/* ------------------------------------------------------------------ roles */

/**
 * The role names, as RBAC ships them.
 *
 * Not a vocabulary of the console's own. These are the system role keys the
 * admin gateway checks against, so a label here and a refusal there always
 * describe the same thing.
 */
export const ROLE_LABELS: Readonly<Record<AdminRole, string>> = {
  platform_admin: 'Platform admin',
  specialist: 'Specialist',
  support: 'Support',
}

/* ------------------------------------------------------------- structures */

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-text">{title}</h2>
          {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Label and value, aligned, for a record somebody reads rather than scans. */
export function KeyValue({ rows }: { rows: ReadonlyArray<{ key: string; value: ReactNode }> }) {
  return (
    <dl className="flex flex-col">
      {rows.map((row, index) => (
        <div
          key={row.key}
          className={cn(
            'flex items-baseline justify-between gap-6 py-2',
            index > 0 && 'border-t border-border',
          )}
        >
          <dt className="shrink-0 text-sm text-text-muted">{row.key}</dt>
          <dd className="min-w-0 text-right text-base text-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A quota, as a bar.
 *
 * Turns red at the limit rather than near it, because the limit is where the
 * gateway starts refusing and anything softer would be the console inventing
 * a policy the enforcement does not have. A quota with no limit gets no bar:
 * there is nothing to be a fraction of.
 */
export function QuotaBar({
  used,
  limit,
  label,
  value,
}: {
  used: number
  limit: number | null
  label: string
  value: ReactNode
}) {
  const pct = limit === null || limit === 0 ? null : Math.min(100, Math.round((used / limit) * 100))
  const full = pct !== null && pct >= 100
  const near = pct !== null && pct >= 80
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-text-muted">{label}</p>
        <p className={cn('tnum text-sm', full ? 'text-danger-text' : 'text-text')}>{value}</p>
      </div>
      {pct !== null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-inset">
          <div
            className={cn('h-full rounded-full', full ? 'bg-danger' : near ? 'bg-warning' : 'bg-success')}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- the ask */

/**
 * The reason box.
 *
 * Every write in this console reaches into somebody else's business, and the
 * only part of the audit record a reader cannot reconstruct from the change
 * itself is why it happened. So the reason is a required field on the request
 * rather than an optional note, and this is the one dialog that collects it.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string
  onConfirm: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={pending}
            disabled={reason.trim().length === 0}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <Textarea
        label="Reason"
        hint="Written to the audit log with your staff id. The merchant's own record shows it too."
        value={reason}
        error={error}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Ticket 4821, refund stuck in pending"
        rows={3}
      />
    </Dialog>
  )
}

/** The message a failed call should show. Never a raw stack or a status code. */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** A card that explains a screen before the screen starts making claims. */
export function Preamble({ children }: { children: ReactNode }) {
  return (
    <Card className="border-accent-border bg-accent-subtle">
      <p className="flex items-start gap-2.5 text-base text-accent-text">
        <Icon name="Info" size="md" className="mt-0.5 shrink-0" />
        <span>{children}</span>
      </p>
    </Card>
  )
}
