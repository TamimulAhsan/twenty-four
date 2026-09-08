import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminKeys, adminPlatform, type TierRegistryEntry } from '@twentyfour/api'
import {
  MODULES,
  MODULE_IDS,
  TIERS,
  TIER_IDS,
  resolveDependencies,
  type ModuleId,
  type TierId,
} from '@twentyfour/entitlement'
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  Icon,
  MoneyText,
  PageHeader,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  cn,
  useToast,
} from '@twentyfour/ui'
import { ModuleKind, Preamble, Section, errorMessage, moduleNames } from '../common'

/**
 * The tier registry.
 *
 * The most destructive screen in the console. A cell here decides what every
 * tenant on that tier holds, so ticking one rewrites their entitlement records
 * and invalidates the gateway's policy cache, and unticking one takes a screen
 * away from businesses that are open right now.
 *
 * Which is why nothing applies as you click. Changes stage, the affected
 * count is shown before anything is written, and applying is a separate,
 * deliberate act. The design this came from wrote each cell straight through
 * on click, with an "apply" banner that had already been overtaken.
 *
 * Three kinds of cell cannot be clicked at all, and the reason differs:
 * an always-on module ships with every tenant at any price, a dependency
 * arrives because something else needed it, and both are facts about the
 * platform rather than choices about a tier.
 */
export function TiersPage() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [staged, setStaged] = useState<Partial<Record<TierId, ModuleId[]>>>({})
  const [confirming, setConfirming] = useState(false)

  const query = useQuery({ queryKey: adminKeys.tiers(), queryFn: adminPlatform.tiers })

  const apply = useMutation({
    mutationFn: async () => {
      // One tier at a time, in ladder order, because the registry refuses a
      // state where a higher tier grants less than a lower one and applying
      // Max before Growth would trip that on the way through.
      let latest = query.data ?? []
      for (const tier of TIER_IDS) {
        const grants = staged[tier]
        if (!grants) continue
        latest = await adminPlatform.setTierGrants(tier, grants)
      }
      return latest
    },
    onSuccess: (rows) => {
      queryClient.setQueryData(adminKeys.tiers(), rows)
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.list() })
      void queryClient.invalidateQueries({ queryKey: adminKeys.audit() })
      setStaged({})
      setConfirming(false)
      toast.show({
        tone: 'success',
        title: 'Registry updated',
        description: 'Entitlement records rewritten and the gateway cache invalidated.',
      })
    },
    onError: (error) => {
      setConfirming(false)
      toast.show({ tone: 'danger', title: 'Nothing changed', description: errorMessage(error) })
    },
  })

  const rows = query.data ?? []
  const grantsOf = (tier: TierId): ModuleId[] =>
    staged[tier] ?? rows.find((row) => row.tier === tier)?.grants.slice() ?? []

  const toggle = (tier: TierId, id: ModuleId) => {
    const current = grantsOf(tier)
    setStaged((previous) => ({
      ...previous,
      [tier]: current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    }))
  }

  const dirty = Object.keys(staged).length > 0
  const affected = useMemo(
    () =>
      rows
        .filter((row) => staged[row.tier] !== undefined)
        .reduce((sum, row) => sum + row.tenants, 0),
    [rows, staged],
  )

  if (query.isError) {
    return (
      <ErrorState
        title="The registry did not load"
        description={errorMessage(query.error)}
        onRetry={() => void query.refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tiers and modules"
        description="A tier is the unit of sale. Nothing here is priced per module, and the module count never enters a price."
      />

      <Preamble>
        Whatever a tier grants is what a merchant provisioned on it receives, with dependencies
        resolved on top. The gateway enforces the result on every request, so this table is not a
        description of the product: it is the product.
      </Preamble>

      {query.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map((row) => (
            <TierCard key={row.tier} row={row} staged={staged[row.tier]} />
          ))}
        </div>
      )}

      {dirty && (
        <Card className="sticky bottom-4 z-20 border-warning-border bg-warning-subtle shadow-[var(--shadow-lg)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-base text-warning-text">
              <span className="font-semibold">
                {Object.keys(staged).length === 1
                  ? 'One tier changed'
                  : `${Object.keys(staged).length} tiers changed`}
              </span>
              . Applying rewrites the entitlement record of{' '}
              {affected === 1 ? 'one tenant' : `${affected} tenants`} and invalidates the gateway
              cache immediately.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStaged({})}>
                Discard
              </Button>
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Apply to every tenant
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Section
        title="What each tier grants"
        description="Click a cell to include or exclude. Dependencies resolve on top and cannot be unticked on their own."
      >
        {query.isPending ? (
          <Skeleton className="h-96" />
        ) : (
          <Card padded={false}>
            <Matrix grantsOf={grantsOf} staged={staged} onToggle={toggle} />
          </Card>
        )}
      </Section>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Apply to every tenant on these tiers"
        description={
          <>
            This is not reversible by undoing it. Withdrawing a module takes screens away from
            businesses that are trading right now; their data stays, but the module goes on their
            next request.
          </>
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={apply.isPending} onClick={() => apply.mutate()}>
              Apply to {affected === 1 ? '1 tenant' : `${affected} tenants`}
            </Button>
          </div>
        }
      >
        <ul className="flex flex-col gap-3">
          {(Object.keys(staged) as TierId[]).map((tier) => {
            const before = rows.find((row) => row.tier === tier)?.grants ?? []
            const after = staged[tier] ?? []
            const added = after.filter((id) => !before.includes(id))
            const removed = before.filter((id) => !after.includes(id))
            return (
              <li key={tier} className="rounded-lg border border-border p-3">
                <p className="text-base font-medium text-text">{TIERS[tier].name}</p>
                {added.length > 0 && (
                  <p className="mt-1 text-sm text-success-text">Adds {moduleNames(added)}</p>
                )}
                {removed.length > 0 && (
                  <p className="mt-1 text-sm text-danger-text">Removes {moduleNames(removed)}</p>
                )}
                {added.length === 0 && removed.length === 0 && (
                  <p className="mt-1 text-sm text-text-subtle">No change after all</p>
                )}
              </li>
            )
          })}
        </ul>
      </Dialog>
    </div>
  )
}

function TierCard({ row, staged }: { row: TierRegistryEntry; staged?: ModuleId[] }) {
  const definition = TIERS[row.tier]
  const modules = staged ? resolveDependencies(staged) : row.modules
  return (
    <Card className={cn(staged && 'border-warning-border')}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-md font-semibold text-text">{definition.name}</p>
        <Badge tone={staged ? 'warning' : 'neutral'}>
          {staged ? 'staged' : `${row.tenants} ${row.tenants === 1 ? 'tenant' : 'tenants'}`}
        </Badge>
      </div>

      <p className="mt-2 text-xl font-semibold tracking-[-0.02em] text-text">
        {row.monthly === null ? (
          <span className="text-md font-medium text-text-muted">Quoted per customer</span>
        ) : (
          <MoneyText value={row.monthly} deemphasiseSymbol />
        )}
      </p>
      <p className="mt-1 text-sm text-text-muted">
        {definition.seats === null ? 'Seats negotiated' : `${definition.seats} staff seats`} ·{' '}
        {modules.length} modules
      </p>

      <ul className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
        {definition.perks.map((perk) => (
          <li key={perk.label} className="flex items-start gap-2 text-sm">
            <Icon
              name={perk.comingSoon ? 'Clock' : 'Check'}
              size="sm"
              className={cn('mt-0.5 shrink-0', perk.comingSoon ? 'text-warning-text' : 'text-success-text')}
            />
            <span className={perk.comingSoon ? 'text-text-muted' : 'text-text'}>
              {perk.label}
              {perk.comingSoon && <span className="text-text-subtle"> (coming soon)</span>}
            </span>
          </li>
        ))}
      </ul>

      {/* Derived, not a switch. A tier stops being self-serve exactly when a
          module it grants needs a person, which is a fact about the module. */}
      <div className="mt-4 border-t border-border pt-3">
        <p className="flex items-center gap-2 text-sm">
          <Icon
            name={row.autoProvision ? 'CheckCircle2' : 'User'}
            size="sm"
            className={cn('shrink-0', row.autoProvision ? 'text-success-text' : 'text-warning-text')}
          />
          <span className="font-medium text-text">
            {row.autoProvision ? 'Goes live unattended' : 'Needs a specialist'}
          </span>
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {row.autoProvision
            ? 'A self-serve signup on this tier completes on its own.'
            : `${moduleNames(row.needsSpecialist)} cannot finish without a person. The payment is taken, what provisioned cleanly is granted, and the rest is queued.`}
        </p>
      </div>
    </Card>
  )
}

function Matrix({
  grantsOf,
  staged,
  onToggle,
}: {
  grantsOf: (tier: TierId) => ModuleId[]
  staged: Partial<Record<TierId, ModuleId[]>>
  onToggle: (tier: TierId, id: ModuleId) => void
}) {
  const resolved = new Map(
    TIER_IDS.map((tier) => [tier, new Set(resolveDependencies(grantsOf(tier)))]),
  )

  return (
    <TableScroll>
      <Table>
        <thead>
          <tr>
            <Th>Module</Th>
            <Th>Kind</Th>
            <Th>Needs</Th>
            {TIER_IDS.map((tier) => (
              <Th key={tier} className="text-center">
                {TIERS[tier].name}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MODULE_IDS.map((id) => {
            const definition = MODULES[id]
            const sellable = definition.kind === 'sold'
            return (
              <Tr key={id}>
                <Td>
                  <p className="font-medium text-text">{definition.name}</p>
                  <p className="font-mono text-xs text-text-subtle">{id}</p>
                </Td>
                <Td>
                  <ModuleKind id={id} />
                </Td>
                <Td className="text-sm text-text-muted">
                  {definition.requires.length === 0 ? 'nothing' : moduleNames(definition.requires)}
                </Td>
                {TIER_IDS.map((tier) => {
                  const granted = grantsOf(tier).includes(id)
                  const held = resolved.get(tier)?.has(id) ?? false
                  const dirty = staged[tier] !== undefined
                  return (
                    <Td key={tier} className="text-center">
                      <Cell
                        granted={granted}
                        held={held}
                        sellable={sellable}
                        dirty={dirty}
                        kind={definition.kind}
                        onClick={() => onToggle(tier, id)}
                        label={`${definition.name} on ${TIERS[tier].name}`}
                      />
                    </Td>
                  )
                })}
              </Tr>
            )
          })}
        </tbody>
      </Table>
    </TableScroll>
  )
}

function Cell({
  granted,
  held,
  sellable,
  dirty,
  kind,
  onClick,
  label,
}: {
  granted: boolean
  held: boolean
  sellable: boolean
  dirty: boolean
  kind: string
  onClick: () => void
  label: string
}) {
  if (!sellable) {
    return (
      <span
        title={
          kind === 'always_on'
            ? 'Ships with every tenant. Not sold per tier.'
            : 'Pulled in by whatever needs it. Not sold per tier.'
        }
        className="text-sm text-text-subtle"
      >
        {kind === 'always_on' ? 'always' : held ? 'pulled in' : '—'}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={granted}
      aria-label={label}
      className={cn(
        'inline-flex h-7 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-md border px-2 text-sm',
        'transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
        granted
          ? 'border-success-border bg-success-subtle text-success-text'
          : 'border-border bg-surface text-text-subtle hover:bg-surface-hover',
        dirty && 'ring-1 ring-warning-border',
      )}
    >
      {granted && <Icon name="Check" size="sm" />}
      {granted ? 'Granted' : 'Not sold'}
    </button>
  )
}
