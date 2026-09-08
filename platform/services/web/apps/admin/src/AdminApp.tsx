import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AdminGate } from './session'
import { HandoffPage } from './HandoffPage'
import { AdminShell } from './layout/AdminShell'
import { DrawerProvider } from './Drawer'
import { TenantsPage } from './pages/TenantsPage'
import { TenantPage } from './pages/TenantPage'
import { OverviewTab } from './tenant/OverviewTab'
import { SalesTab } from './tenant/SalesTab'
import { EntitlementTab } from './tenant/EntitlementTab'
import { BillingTab } from './tenant/BillingTab'
import { ProvisioningTab } from './tenant/ProvisioningTab'
import { AuditTab } from './tenant/AuditTab'
import { ProvisioningPage } from './pages/ProvisioningPage'
import { TiersPage } from './pages/TiersPage'
import { BillingPage } from './pages/BillingPage'
import { AuditPage } from './pages/AuditPage'
import { SessionsPage } from './pages/SessionsPage'
import { TeamPage } from './pages/TeamPage'
import { SettingsPage } from './pages/SettingsPage'
import { NotFound } from './pages/NotFound'

/**
 * The admin console.
 *
 * Its own application, its own image, its own host. It shares the design
 * system, the money package and the module registry with the merchant
 * applications, and shares no session, no gateway and no origin with them.
 *
 * The tenant tabs are routes rather than local state so a specialist can send
 * somebody a link to the exact tab they are looking at. Half the reason this
 * console exists is two people trying to look at the same thing.
 */
export function AdminApp() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Outside the gate, and it has to be. This is the page that opens the
            session, so a gate in front of it would bounce the specialist back
            to sign in while they were holding the code that signs them in. */}
        <Route path="/session" element={<HandoffPage />} />
        <Route path="*" element={<Console />} />
      </Routes>
    </BrowserRouter>
  )
}

function Console() {
  return (
    <AdminGate>
      <DrawerProvider>
        <Routes>
          <Route element={<AdminShell />}>
            <Route index element={<TenantsPage />} />

            <Route path="tenants/:tenantId" element={<TenantPage />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<OverviewTab />} />
              <Route path="sales" element={<SalesTab />} />
              <Route path="entitlement" element={<EntitlementTab />} />
              <Route path="billing" element={<BillingTab />} />
              <Route path="provisioning" element={<ProvisioningTab />} />
              <Route path="audit" element={<AuditTab />} />
            </Route>

            <Route path="provisioning" element={<ProvisioningPage />} />
            <Route path="tiers" element={<TiersPage />} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="settings" element={<SettingsPage />} />

            <Route path="404" element={<NotFound />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
          </Route>
        </Routes>
      </DrawerProvider>
    </AdminGate>
  )
}
