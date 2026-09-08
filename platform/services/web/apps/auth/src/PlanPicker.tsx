import {
  MODULES, TIER_IDS, TIERS, tierAutoEnabled, tierModules, type TierId,
} from '@twentyfour/entitlement'
import { money } from '@twentyfour/money'
import { Badge, Card, Icon, MoneyText, cn, isIconName } from '@twentyfour/ui'

/**
 * Choosing a plan.
 *
 * Tiers, never modules. A merchant buys a tier and the module set follows from
 * it; the module count never enters a price, which is why these cards show
 * what is included rather than pricing it line by line.
 *
 * The set is read from the same registry the gateway enforces against, so a
 * card cannot promise something entitlement will then refuse.
 */
export function PlanPicker({
  value,
  onChange,
}: {
  value: TierId
  onChange: (tier: TierId) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Plan"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {TIER_IDS.map((tier) => (
        <PlanCard key={tier} tier={tier} chosen={value === tier} onChoose={onChange} />
      ))}
    </div>
  )
}

function PlanCard({
  tier,
  chosen,
  onChoose,
}: {
  tier: TierId
  chosen: boolean
  onChoose: (tier: TierId) => void
}) {
  const definition = TIERS[tier]
  const granted = definition.grants

  return (
    <Card
      className={cn(
        'flex flex-col transition-colors',
        chosen ? 'border-accent ring-1 ring-accent/25' : 'hover:border-border-strong',
      )}
      padded={false}
    >
      <button
        type="button"
        role="radio"
        aria-checked={chosen}
        onClick={() => onChoose(tier)}
        className={cn(
          'flex h-full flex-col rounded-[inherit] p-4 text-left',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-md font-semibold text-text">{definition.name}</span>
          {definition.recommended && !chosen && <Badge>Popular</Badge>}
          {chosen && (
            <span className="ml-auto text-accent">
              <Icon name="CheckCircle2" size="lg" />
            </span>
          )}
        </div>

        <p className="mt-1 min-h-10 text-sm text-text-muted">{definition.tagline}</p>

        <p className="mt-3 text-2xl font-semibold text-text">
          {definition.monthlyMinor === null ? (
            <span className="text-lg">On request</span>
          ) : (
            <MoneyText
              value={money(definition.monthlyMinor, definition.currency)}
              deemphasiseSymbol
            />
          )}
        </p>
        <p className="text-sm text-text-subtle">
          {definition.monthlyMinor === null ? 'Quoted per business' : 'per month, ex VAT'}
          {' · '}
          {definition.seats === null ? 'seats agreed' : `${definition.seats} staff seats`}
        </p>

        <ul className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
          {granted.map((moduleId) => (
            <li key={moduleId} className="flex items-center gap-2 text-base text-text-muted">
              <Icon
                name={isIconName(MODULES[moduleId].icon) ? MODULES[moduleId].icon : 'CircleDot'}
                size="md"
                className="shrink-0 text-text-subtle"
              />
              <span className="truncate">{MODULES[moduleId].name}</span>
            </li>
          ))}
        </ul>

        {/* Said out loud, because it is the difference between the price
            looking high and looking obvious. Catalog, Inventory and Staff are
            not add-ons: a till cannot register a sale without them. */}
        <p className="mt-3 text-sm text-text-subtle">
          {autoLine(tier)}
        </p>
      </button>
    </Card>
  )
}

function autoLine(tier: TierId): string {
  const auto = tierAutoEnabled(tier).filter((moduleId) => MODULES[moduleId].kind !== 'always_on')
  if (auto.length === 0) {
    return `${tierModules(tier).length} modules switched on in total.`
  }
  const names = auto.map((moduleId) => MODULES[moduleId].name)
  const last = names[names.length - 1]
  return names.length === 1
    ? `${last} comes with it, at no extra cost.`
    : `${names.slice(0, -1).join(', ')} and ${last} come with it, at no extra cost.`
}
