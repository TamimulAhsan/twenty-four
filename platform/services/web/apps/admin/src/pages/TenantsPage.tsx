import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  adminKeys,
  adminTenants,
  type TenantHealth,
  type TenantStatus,
  type TenantSummary,
} from '@twentyfour/api'
import {
  MODULES,
  TIERS,
  TIER_IDS,
  industryProfile,
  tierModules,
  type ModuleId,
  type TierId,
} from '@twentyfour/entitlement'
import { addMoney, zero, type Money } from '@twentyfour/money'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  MoneyText,
  PageHeader,
  Select,
  Skeleton,
  StatTile,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  cn,
  useFormat,
} from '@twentyfour/ui'
import { HealthNote, StatusBadge, TierBadge, errorMessage } from '../common'
import { useDrawer } from '../Drawer'
import { useEnvironment } from '../session'
import { StartSessionButton } from '../StartSessionButton'

/**
 * Every merchant in this environment.
 *
 * One environment, so this is the whole list rather than a page of it, and
 * every total below is a total of exactly these rows. There is no market
 * filter because there is no second market here to filter out: the other one
 * is a different deployment with its own console and its own books.
 *
 * The filters are the ones a specialist reaches for at the start of a day:
 * who is in trouble, who is still being set up, who is on which tier, and who
 * holds a module a release is about to touch.
 */
type StatusFilter = TenantStatus | 'all'
type HealthFilter = TenantHealth | 'all'
type Sort = 'mrr' | 'gmv' | 'orders' | 'name' | 'newest'

/** Sorts a figure that may be absent to the bottom, whichever way we are going. */
const byNumber = (left: number | null, right: number | null): number =>
  (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY)

const SORTS: Record<Sort, (left: TenantSummary, right: TenantSummary) => number> = {
  mrr: (left, right) => byNumber(left.mrr?.minor ?? null, right.mrr?.minor ?? null),
  gmv: (left, right) => byNumber(left.gmv30d?.minor ?? null, right.gmv30d?.minor ?? null),
  orders: (left, right) => byNumber(left.orders30d, right.orders30d),
  name: (left, right) => left.name.localeCompare(right.name),
  newest: (left, right) => right.onboardedAt.localeCompare(left.onboardedAt),
}

/**
 * A figure whose source does not exist yet.
 *
 * Distinct from zero, and the distinction matters: a tenant that pays nothing
 * and a tenant nobody has priced look identical if both render as an amount.
 */
function NotRecorded() {
  return <span className="text-sm text-text-subtle">not recorded</span>
}

/**
 * Seats in use against the quota.
 *
 * The used figure can be absent: the directory asks Staff per tenant on a time
 * budget, and one that did not answer shows its limit alone rather than
 * pretending nobody is using a seat.
 */
function Seats({ used, limit }: { used: number | null; limit: number | null }) {
  const full = used !== null && limit !== null && used >= limit
  return (
    <span className={cn('tnum text-sm', full ? 'text-danger-text' : 'text-text-muted')}>
      {used ?? '—'} / {limit ?? 'negotiated'}
    </span>
  )
}

/** Modules worth filtering on: the ones a tenant can be said to hold or not. */
const FILTERABLE: ModuleId[] = (Object.keys(MODULES) as ModuleId[]).filter(
  (id) => MODULES[id].kind !== 'always_on',
)

export function TenantsPage() {
  const environment = useEnvironment()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: adminKeys.tenants.list(),
    queryFn: () => adminTenants.list(),
  })

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [health, setHealth] = useState<HealthFilter>('all')
  const [tier, setTier] = useState<TierId | 'all'>('all')
  const [module, setModule] = useState<ModuleId | 'all'>('all')
  const [sort, setSort] = useState<Sort>('name')

  const tenants = useMemo(() => data?.tenants ?? [], [data])
  /**
   * Whether trading figures came back at all.
   *
   * They do not today: reading them means asking POS once per tenant, which is
   * the shape that stops working past a hundred tenants, so the directory
   * leaves them out and a tenant's own page answers them. Rendered
   * conditionally rather than deleted, so the columns come back on their own
   * when the analytics pipeline can answer a whole page at once.
   */
  const trading = useMemo(() => tenants.some((tenant) => tenant.gmv30d !== null), [tenants])
  const priced = useMemo(() => tenants.some((tenant) => tenant.mrr !== null), [tenants])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tenants
      .filter((tenant) => {
        if (status !== 'all' && tenant.status !== status) return false
        if (health !== 'all' && tenant.health !== health) return false
        if (tier !== 'all' && tenant.tier !== tier) return false
        // Approximate: the tier's resolved set, not the tenant's record, which
        // would need a call per row. Overrides are rare and the tenant page is
        // the place that answers precisely.
        if (module !== 'all' && !tierModules(tenant.tier).includes(module)) return false
        if (!needle) return true
        return [tenant.name, tenant.merchantCode, tenant.tenantId, tenant.city, tenant.industry]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      })
      .slice()
      .sort(SORTS[sort])
  }, [tenants, query, status, health, tier, module, sort])

  const totals = useMemo(() => {
    const currency = environment.currency
    const sum = (pick: (tenant: TenantSummary) => Money | null): Money =>
      tenants.reduce<Money>(
        (running, tenant) => (pick(tenant) ? addMoney(running, pick(tenant) as Money) : running),
        zero(currency),
      )
    return {
      mrr: sum((tenant) => (tenant.status === 'trial' ? null : tenant.mrr)),
      gmv: sum((tenant) => tenant.gmv30d),
      live: tenants.filter((tenant) => tenant.status === 'live').length,
      provisioning: tenants.filter((tenant) => tenant.status === 'provisioning').length,
      failing: tenants.filter((tenant) => tenant.health === 'failing').length,
      attention: tenants.filter((tenant) => tenant.health === 'attention').length,
    }
  }, [tenants, environment.currency])

  const filtered = rows.length !== tenants.length

  if (isError) {
    return (
      <ErrorState
        title="The tenant list did not come back"
        description={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tenants"
        description={`Every merchant in ${environment.market}. This console sees one environment and never across two.`}
      />

      {isPending ? (
        <Skeleton className="h-28" />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Tenants" value={data?.total ?? tenants.length} icon="Building2" />
          <StatTile label="Live" value={totals.live} icon="CheckCircle2" />
          <StatTile label="Getting live" value={totals.provisioning} icon="Clock" />
          <StatTile label="Needs a look" value={totals.attention + totals.failing} icon="AlertTriangle" />
          {/* Both of these are absent until their source exists: the tier
              registry carries no prices, and merchant sales need one call per
              tenant. Shown when they arrive rather than shown as zero. */}
          {priced && <StatTile label="Platform MRR" money={totals.mrr} icon="Wallet" />}
          {trading && (
            <StatTile label="Merchant sales, 30 days" money={totals.gmv} icon="Receipt" />
          )}
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[16rem] flex-1">
            <Input
              label="Search"
              iconStart="Search"
              placeholder="Business name, merchant code, city"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Select
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            className="w-40"
          >
            <option value="all">Any status</option>
            <option value="live">Live</option>
            <option value="provisioning">Setting up</option>
            <option value="trial">Trial</option>
            <option value="suspended">Suspended</option>
          </Select>
          <Select
            label="Health"
            value={health}
            onChange={(event) => setHealth(event.target.value as HealthFilter)}
            className="w-40"
          >
            <option value="all">Any health</option>
            <option value="ok">Nothing outstanding</option>
            <option value="attention">Needs a look</option>
            <option value="failing">Failing</option>
          </Select>
          <Select
            label="Tier"
            value={tier}
            onChange={(event) => setTier(event.target.value as TierId | 'all')}
            className="w-36"
          >
            <option value="all">Any tier</option>
            {TIER_IDS.map((id) => (
              <option key={id} value={id}>
                {TIERS[id].name}
              </option>
            ))}
          </Select>
          <Select
            label="Holds module"
            value={module}
            onChange={(event) => setModule(event.target.value as ModuleId | 'all')}
            className="w-48"
          >
            <option value="all">Any module</option>
            {FILTERABLE.map((id) => (
              <option key={id} value={id}>
                {MODULES[id].name}
              </option>
            ))}
          </Select>
          <Select
            label="Sort by"
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="w-44"
          >
            <option value="name">Name</option>
            <option value="newest">Newest</option>
            {/* Offered only when there is something to sort on. A sort that
                cannot reorder anything is worse than one that is missing. */}
            {priced && <option value="mrr">What they pay us</option>}
            {trading && <option value="gmv">What they sold</option>}
            {trading && <option value="orders">Orders</option>}
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5">
          <p className="text-sm text-text-muted">
            {filtered ? `${rows.length} of ${tenants.length} tenants` : `${tenants.length} tenants`}
          </p>
          {totals.failing > 0 && (
            <button
              type="button"
              onClick={() => {
                setHealth('failing')
                setStatus('all')
              }}
              className="flex items-center gap-1.5 text-sm font-medium text-danger-text hover:underline"
            >
              <Icon name="AlertCircle" size="sm" />
              {totals.failing} failing
            </button>
          )}
          {filtered && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setQuery('')
                setStatus('all')
                setHealth('all')
                setTier('all')
                setModule('all')
              }}
            >
              Clear filters
            </Button>
          )}
        </div>

        {isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="Search"
            title="No tenant matches that"
            description="Try a wider filter, or search by merchant code."
            className="m-4"
          />
        ) : (
          <TenantTable rows={rows} trading={trading} priced={priced} />
        )}
      </Card>
    </div>
  )
}

function TenantTable({
  rows,
  trading,
  priced,
}: {
  rows: readonly TenantSummary[]
  trading: boolean
  priced: boolean
}) {
  const navigate = useNavigate()
  const drawer = useDrawer()
  const { locale } = useFormat()

  return (
    <TableScroll className="border-t border-border">
      <Table>
        <thead>
          <tr>
            <Th>Merchant</Th>
            <Th>Trade</Th>
            <Th>Tier</Th>
            <Th>Status</Th>
            {priced && <Th numeric>Pays us</Th>}
            {trading && <Th numeric>Their sales, 30 days</Th>}
            {trading && <Th numeric>Orders</Th>}
            <Th>Seats</Th>
            <Th>Health</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((tenant) => (
            <Tr
              key={tenant.tenantId}
              interactive
              onClick={() => navigate(`/tenants/${tenant.tenantId}/overview`)}
            >
              <Td>
                <p className="font-medium text-text">{tenant.name}</p>
                {/* The merchant code, not the tenant id. It is what is printed
                    on their invoices and what they read out on the phone. */}
                <p className="font-mono text-xs text-text-subtle">
                  {tenant.merchantCode} · {tenant.city}
                </p>
              </Td>
              <Td className="text-text-muted">
                {industryProfile(tenant.industry)?.name ?? tenant.industry}
              </Td>
              <Td>
                <TierBadge tier={tenant.tier} />
              </Td>
              <Td>
                <StatusBadge status={tenant.status} />
              </Td>
              {priced && (
                <Td numeric>
                  {tenant.mrr ? <MoneyText value={tenant.mrr} compact /> : <NotRecorded />}
                </Td>
              )}
              {trading && (
                <Td numeric>
                  {tenant.gmv30d === null ? (
                    <NotRecorded />
                  ) : tenant.gmv30d.minor === 0 ? (
                    <span className="text-text-subtle">not trading</span>
                  ) : (
                    <MoneyText value={tenant.gmv30d} compact />
                  )}
                </Td>
              )}
              {trading && (
                <Td numeric>
                  {tenant.orders30d === null ? (
                    <NotRecorded />
                  ) : (
                    tenant.orders30d.toLocaleString(locale)
                  )}
                </Td>
              )}
              <Td>
                <Seats used={tenant.seatsUsed} limit={tenant.seatLimit} />
              </Td>
              <Td className="max-w-[18rem]">
                <HealthNote health={tenant.health} note={tenant.healthNote} />
              </Td>
              <Td onClick={(event) => event.stopPropagation()}>
                <div className="flex justify-end gap-2">
                  <StartSessionButton tenant={tenant} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      drawer.open({
                        title: tenant.name,
                        subtitle: `${tenant.merchantCode} · ${industryProfile(tenant.industry)?.name ?? tenant.industry}`,
                        rows: [
                          { key: 'Tenant id', value: <span className="font-mono text-sm">{tenant.tenantId}</span> },
                          { key: 'Tier', value: TIERS[tenant.tier].name },
                          { key: 'Status', value: <StatusBadge status={tenant.status} /> },
                          {
                            key: 'Pays us',
                            value: tenant.mrr ? <MoneyText value={tenant.mrr} /> : <NotRecorded />,
                          },
                          {
                            key: 'Seats',
                            value: <Seats used={tenant.seatsUsed} limit={tenant.seatLimit} />,
                          },
                          { key: 'Onboarded', value: tenant.onboardedAt.slice(0, 10) },
                          {
                            key: 'Health',
                            value: <HealthNote health={tenant.health} note={tenant.healthNote} />,
                          },
                        ],
                        footer: (
                          <Button
                            className="w-full"
                            iconEnd="ArrowRight"
                            onClick={() => {
                              drawer.close()
                              navigate(`/tenants/${tenant.tenantId}/overview`)
                            }}
                          >
                            Open this tenant
                          </Button>
                        ),
                      })
                    }
                  >
                    Peek
                  </Button>
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  )
}
