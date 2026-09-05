import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { bootstrap, queryKeys, roles as rolesApi, type Bootstrap } from '@twentyfour/api'
import {
  EntitlementProvider,
  industryProfile,
  resolveEntitlement,
  type LaunchTargets,
} from '@twentyfour/entitlement'
import { TermsProvider } from '@twentyfour/terms'
import { SessionRoleProvider } from '@twentyfour/rbac'
import { ErrorState, FormatProvider, Spinner } from '@twentyfour/ui'

/**
 * One call, three providers.
 *
 * Entitlements, term set and profile arrive together because nothing can be
 * drawn without all three: the navigation needs the modules, every label needs
 * the vocabulary, and every amount needs the locale. Three round trips to
 * render a sidebar is three chances to render it half-built.
 *
 * Shared by all three applications, so the till and the calendar resolve their
 * vocabulary the same way the dashboard does.
 */
const BootstrapContext = createContext<Bootstrap | null>(null)

export function useBootstrap(): Bootstrap {
  const value = useContext(BootstrapContext)
  if (!value) throw new Error('useBootstrap must be used inside a BootstrapProvider')
  return value
}

export function BootstrapProvider({
  launchTargets,
  children,
}: {
  launchTargets?: LaunchTargets
  children: ReactNode
}) {
  const query = useQuery({ queryKey: queryKeys.bootstrap(), queryFn: bootstrap })
  // Fetched here so every screen reads one role list. A screen that fetched
  // its own would eventually disagree with the one next to it.
  const rolesQuery = useQuery({
    queryKey: queryKeys.roles.list(),
    queryFn: rolesApi.list,
    enabled: query.isSuccess,
  })

  if (query.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Loading" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <ErrorState
          title="We could not load your account"
          description="Your details did not come back. Nothing has changed on your side."
          onRetry={() => void query.refetch()}
        />
      </div>
    )
  }

  const { profile, entitlement, termOverrides } = query.data

  // Rebuilt locally from the same inputs the gateway used, so the navigation
  // and the enforcement cannot disagree about what this tenant holds.
  const record = resolveEntitlement({
    tenantId: profile.tenantId,
    tier: entitlement.tier,
    industry: profile.industry,
    seatsUsed: entitlement.seats.used,
    seatLimitOverride: entitlement.seats.limit,
    pending: entitlement.pending,
  })

  return (
    <BootstrapContext.Provider value={query.data}>
      <FormatProvider
        locale={profile.locale}
        currency={profile.currency}
        timezone={profile.timezone}
      >
        {/* Both layers. The family is the broad vocabulary a group of trades
            shares; the business type corrects it, because a cafe is not a
            restaurant and a bakery is neither. */}
        <TermsProvider
          family={industryProfile(profile.industry)?.family}
          profile={profile.industry}
          overrides={termOverrides}
          locale={profile.locale}
        >
          <EntitlementProvider record={record} launchTargets={launchTargets}>
            {/* What this person may do, alongside what the tenant bought. The
                gateway evaluates both; these providers only keep the screens
                from offering an action that would be refused. */}
            <SessionRoleProvider
              role={query.data.session.role}
              userId={query.data.session.userId}
              catalog={rolesQuery.data}
            >
              {children}
            </SessionRoleProvider>
          </EntitlementProvider>
        </TermsProvider>
      </FormatProvider>
    </BootstrapContext.Provider>
  )
}
