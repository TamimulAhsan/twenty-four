import { useMemo, useState } from 'react'
import { FAMILY_LABELS, profilesByFamily, searchProfiles } from '@twentyfour/entitlement'
import { Icon, Input, cn } from '@twentyfour/ui'

/**
 * Picking what kind of business this is.
 *
 * One input decides everything trade-specific: which capabilities switch on,
 * what things are called, which catalog template seeds, which tax categories
 * exist. It is the single most consequential field in the product and the one
 * a merchant answers in four seconds, so it is searchable and grouped rather
 * than a list of forty in a dropdown.
 */
export function BusinessTypeSelector({
  value,
  onChange,
  autoFocus,
}: {
  value: string | null
  onChange: (id: string) => void
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    if (!query.trim()) return profilesByFamily()
    const matches = searchProfiles(query)
    const families = [...new Set(matches.map((profile) => profile.family))]
    return families.map((family) => ({
      family,
      label: FAMILY_LABELS[family],
      profiles: matches.filter((profile) => profile.family === family),
    }))
  }, [query])

  const total = groups.reduce((sum, group) => sum + group.profiles.length, 0)

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        iconStart="Search"
        placeholder="Search, or pick from the list"
        aria-label="Search business types"
        autoFocus={autoFocus}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-base text-text-muted">
          Nothing matches that. Pick the nearest one; a specialist can adjust it later.
        </p>
      ) : (
        <div className="flex max-h-80 flex-col gap-4 overflow-y-auto pr-1">
          {groups.map((group) => (
            <fieldset key={group.family}>
              <legend className="text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
                {group.label}
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {group.profiles.map((profile) => {
                  const chosen = value === profile.id
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => onChange(profile.id)}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left',
                        'text-base transition-colors',
                        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                        chosen
                          ? 'border-accent bg-accent-subtle font-medium text-accent-text'
                          : 'border-border hover:bg-surface-hover',
                      )}
                    >
                      <span className="min-w-0 truncate">{profile.name}</span>
                      {chosen && <Icon name="Check" size="sm" className="shrink-0" />}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </div>
  )
}
