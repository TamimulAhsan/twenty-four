import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminKeys,
  adminPlatform,
  adminTenants,
  type TenantDetail,
  type TierRegistryEntry,
} from '@twentyfour/api'
import {
  MODULES,
  MODULE_IDS,
  TIERS,
  TIER_IDS,
  autoEnabledBy,
  dependentsOf,
  tierModules,
  type ModuleId,
  type TierId,
} from '@twentyfour/entitlement'
import {
  Badge,
  Button,
  Card,
  Icon,
  MoneyText,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  cn,
  useToast,
} from '@twentyfour/ui'
import { ModuleKind, Preamble, ReasonDialog, Section, errorMessage, moduleNames } from '../common'
import { useTenant } from './useTenant'

/**
 * What this tenant holds, and how to change it.
 *
 * Two levers, and they are not the same lever. Moving the tier changes what
 * they pay and what they get; an override changes what they get and
 * deliberately not what they pay. Both are audited, and the second is the one
 * that needs the reason, because a tier change explains itself and a free
 * module does not.
 *
 * Every row is read from the module registry rather than restated here. The
 * design this came from carried its own list of twenty-one modules with
 * invented dependencies, which would have been a console describing a platform
 * that does not exist the first time the real registry changed.
 */
export function EntitlementTab() {
  const { data, isPending } = useTenant()
  if (isPending || !data) return <Skeleton className="h-96" />
  return (
    <div className="flex flex-col gap-6">
      <TierPicker tenant={data} />
      <ModuleTable tenant={data} />
    </div>
  )
}

function TierPicker({ tenant }: { tenant: TenantDetail }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [staged, setStaged] = useState<TierId | null>(null)

  const change = useMutation({
    mutationFn: (reason: string) => adminTenants.setTier(tenant.tenantId, staged as TierId, reason),
    onSuccess: (next) => {
      queryClient.setQueryData(adminKeys.tenants.detail(tenant.tenantId), next)
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.list() })
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.audit(tenant.tenantId) })
      void queryClient.invalidateQueries({ queryKey: adminKeys.billing() })
      setStaged(null)
      toast.show({
        tone: 'success',
        title: 'Tier changed',
        description: 'The entitlement record is rewritten and the gateway cache is invalidated.',
      })
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'Nothing changed', description: errorMessage(error) }),
  })

  // Prices come from the registry rather than being computed here. The
  // registry already answers in this environment's currency, and a component
  // that multiplies a list price is a component that will disagree with the
  // invoice.
  const registry = useQuery({ queryKey: adminKeys.tiers(), queryFn: adminPlatform.tiers })
  const priced = new Map((registry.data ?? []).map((row) => [row.tier, row]))

  const current = tierModules(tenant.tier)
  const target = staged ? tierModules(staged) : current
  const gaining = staged ? target.filter((id) => !current.includes(id)) : []
  const losing = staged ? current.filter((id) => !target.includes(id)) : []

  return (
    <Section
      title="Tier"
      description="The unit of sale. The module set follows from it, and nothing here is priced per module."
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TIER_IDS.map((id) => {
          const tier = TIERS[id]
          const isCurrent = tenant.tier === id
          const isStaged = staged === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setStaged(isCurrent || isStaged ? null : id)}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                isStaged
                  ? 'border-accent bg-accent-subtle'
                  : isCurrent
                    ? 'border-border-strong bg-surface'
                    : 'border-border bg-surface hover:bg-surface-hover',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-md font-semibold text-text">{tier.name}</p>
                {isCurrent && <Badge tone="success">On this tier</Badge>}
                {isStaged && <Badge tone="accent">Staged</Badge>}
              </div>
              <p className="mt-2 text-xl font-semibold tracking-[-0.02em] text-text">
                <TierPrice entry={priced.get(id)} />
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {tier.seats === null ? 'Seats negotiated' : `${tier.seats} staff seats`} ·{' '}
                {tierModules(id).length} modules
              </p>
              <p className="mt-2 text-sm text-text-muted">{tier.tagline}</p>
            </button>
          )
        })}
      </div>

      {staged && (
        <Card className="mt-3 border-accent-border bg-accent-subtle">
          <p className="text-base font-medium text-accent-text">
            {TIERS[tenant.tier].name} to {TIERS[staged].name}
          </p>
          <div className="mt-2 flex flex-col gap-1.5 text-sm text-accent-text">
            {gaining.length > 0 && <p>Gains {moduleNames(gaining)}.</p>}
            {losing.length > 0 && (
              <p className="font-medium text-danger-text">
                Loses {moduleNames(losing)}. Their data stays; the screens go.
              </p>
            )}
            {gaining.length === 0 && losing.length === 0 && (
              <p>The module set is identical. Only the price and the seat quota change.</p>
            )}
            <p>
              Applying rewrites the entitlement record and invalidates the gateway cache
              immediately, not on a timer.
            </p>
          </div>
          <div className="mt-4 flex gap-2">
            <StagedTierConfirm
              tenantName={tenant.name}
              from={tenant.tier}
              to={staged}
              pending={change.isPending}
              onConfirm={(reason) => change.mutate(reason)}
            />
            <Button variant="ghost" onClick={() => setStaged(null)}>
              Discard
            </Button>
          </div>
        </Card>
      )}
    </Section>
  )
}

function StagedTierConfirm({
  tenantName,
  from,
  to,
  pending,
  onConfirm,
}: {
  tenantName: string
  from: TierId
  to: TierId
  pending: boolean
  onConfirm: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Apply and re-provision</Button>
      <ReasonDialog
        open={open}
        title={`Move ${tenantName} to ${TIERS[to].name}`}
        description={
          <>
            Their bill changes from the next cycle and their dashboard changes on their next
            request. Coming from {TIERS[from].name}.
          </>
        }
        confirmLabel="Apply"
        pending={pending}
        onConfirm={(reason) => {
          onConfirm(reason)
          setOpen(false)
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/* ---------------------------------------------------------------- modules */

function ModuleTable({ tenant }: { tenant: TenantDetail }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [asking, setAsking] = useState<{ id: ModuleId; entitled: boolean } | null>(null)

  const override = useMutation({
    mutationFn: ({ id, entitled, reason }: { id: ModuleId; entitled: boolean; reason: string }) =>
      adminTenants.overrideModule(tenant.tenantId, { moduleId: id, entitled, reason }),
    onSuccess: (next) => {
      queryClient.setQueryData(adminKeys.tenants.detail(tenant.tenantId), next)
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.audit(tenant.tenantId) })
      setAsking(null)
      toast.show({
        tone: 'success',
        title: 'Entitlement changed',
        description: 'Recorded against the tenant. The price did not move.',
      })
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'Nothing changed', description: errorMessage(error) }),
  })

  const held = new Set(tenant.modules.map((grant) => grant.moduleId))
  const grantedBy = new Map(tenant.modules.map((grant) => [grant.moduleId, grant.source]))
  const fromTier = new Set(tierModules(tenant.tier))
  const pulled = new Set(autoEnabledBy(TIERS[tenant.tier].grants))

  const sourceOf = (id: ModuleId): { label: string; tone: 'neutral' | 'accent' | 'warning' } => {
    if (MODULES[id].kind === 'always_on') return { label: 'Ships with every tenant', tone: 'neutral' }
    if (grantedBy.get(id) === 'override') return { label: 'Override by a specialist', tone: 'warning' }
    if (pulled.has(id) && held.has(id)) return { label: 'Pulled in by another module', tone: 'accent' }
    if (fromTier.has(id)) return { label: `${TIERS[tenant.tier].name} tier`, tone: 'neutral' }
    return { label: `Not in ${TIERS[tenant.tier].name}`, tone: 'neutral' }
  }

  return (
    <Section
      title="Modules"
      description="What the gateway will let this tenant through to. Every change here is on the audit record."
    >
      <div className="flex flex-col gap-3">
        <Preamble>
          Granting a module against the tier is free and stays free. That is the point of recording
          it against the tenant rather than moving them up a tier: the specialist can say yes to one
          thing without changing what the business pays.
        </Preamble>

        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Module</Th>
                  <Th>Kind</Th>
                  <Th>Needs</Th>
                  <Th>Why they have it</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {MODULE_IDS.map((id) => {
                  const definition = MODULES[id]
                  const on = held.has(id)
                  const source = sourceOf(id)
                  const locked = definition.kind === 'always_on'
                  const blockers = dependentsOf(id).filter((other) => held.has(other))
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
                        {definition.requires.length === 0
                          ? 'nothing'
                          : moduleNames(definition.requires)}
                      </Td>
                      <Td>
                        <Badge tone={source.tone}>{source.label}</Badge>
                      </Td>
                      <Td>
                        <div className="flex justify-end">
                          {locked ? (
                            <span className="flex items-center gap-1.5 text-sm text-text-subtle">
                              <Icon name="ShieldCheck" size="sm" />
                              Always on
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant={on ? 'outline' : 'ghost'}
                              // Refused server-side too. Disabling here just
                              // saves a round trip to be told the obvious.
                              disabled={on && blockers.length > 0}
                              title={
                                on && blockers.length > 0
                                  ? `${moduleNames(blockers)} needs this`
                                  : undefined
                              }
                              onClick={() => setAsking({ id, entitled: !on })}
                            >
                              {on ? 'Entitled' : 'Grant'}
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      </div>

      {asking && (
        <ReasonDialog
          open
          title={`${asking.entitled ? 'Grant' : 'Withdraw'} ${MODULES[asking.id].name}`}
          description={
            asking.entitled ? (
              <>
                {MODULES[asking.id].requires.length > 0 && (
                  <>
                    This pulls in {moduleNames(MODULES[asking.id].requires)}, which the gateway
                    resolves for you.{' '}
                  </>
                )}
                The tenant keeps their tier and their price does not change.
              </>
            ) : (
              <>
                Their screens for this disappear on their next request. Nothing is deleted, and
                granting it again brings everything back.
              </>
            )
          }
          confirmLabel={asking.entitled ? 'Grant' : 'Withdraw'}
          destructive={!asking.entitled}
          pending={override.isPending}
          onConfirm={(reason) => override.mutate({ ...asking, reason })}
          onClose={() => setAsking(null)}
        />
      )}
    </Section>
  )
}

/**
 * A tier's list price, or the honest absence of one.
 *
 * Enterprise is quoted per customer, so the registry carries no figure and the
 * card says so. A zero here would read as free.
 */
function TierPrice({ entry }: { entry: TierRegistryEntry | undefined }) {
  if (!entry) return <span className="text-md font-medium text-text-subtle">loading</span>
  if (entry.monthly === null) {
    return <span className="text-md font-medium text-text-muted">Quoted per customer</span>
  }
  return <MoneyText value={entry.monthly} deemphasiseSymbol />
}
