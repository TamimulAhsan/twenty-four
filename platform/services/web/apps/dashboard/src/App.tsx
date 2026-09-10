import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { SessionGate } from '@twentyfour/shell'
import { AppShell } from './layout/AppShell'
import { Overview } from './pages/Overview'
import { InventoryPage } from './pages/InventoryPage'
import { OrdersPage } from './pages/OrdersPage'
import { StaffPage } from './pages/StaffPage'
import { PaymentsPage } from './pages/PaymentsPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { BooksPage } from './pages/BooksPage'
import { ActivityPage } from './pages/ActivityPage'
import { SubscriptionPage } from './pages/SubscriptionPage'
import { FinancialsPage } from './pages/FinancialsPage'
import { ProductsPage } from './pages/ProductsPage'
import { CustomersPage } from './pages/CustomersPage'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { DiscountsPage } from './pages/DiscountsPage'
import { LoyaltyPage } from './pages/LoyaltyPage'
import { SettingsPage } from './pages/SettingsPage'
import { Placeholder } from './pages/Placeholder'
import { NotFound } from './pages/NotFound'
import { CatalogMoved } from './pages/CatalogMoved'
import { OnboardingPage } from './onboarding/OnboardingPage'

export function App() {
  return (
    <BrowserRouter>
      {/* Sign-in is its own application now. SessionGate sends signed-out
          visitors to /auth and it returns them here. */}
      <SessionGate>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Overview />} />
            {/* Not derived from entitlement, because it is not a module. Every
                tenant passes through it once and no tenant buys it. */}
            <Route path="onboarding" element={<OnboardingPage />} />
            <Route path="financials" element={<FinancialsPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/:id" element={<CustomerDetailPage />} />
            <Route path="discounts" element={<DiscountsPage />} />
            <Route path="loyalty" element={<LoyaltyPage />} />
            {/* Superseded by Financials, Products and Customers, which answer
                the same questions with more depth. Redirected so an old link
                still lands somewhere useful. */}
            <Route path="analytics" element={<Navigate to="/financials" replace />} />
            <Route path="catalog" element={<CatalogMoved />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="staff" element={<StaffPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="books" element={<BooksPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="subscription" element={<SubscriptionPage />} />

            {/* Routed now so no navigation entry is ever a dead link, and each
                says which phase it belongs to rather than pretending. */}
            <Route path="payouts" element={<Placeholder title="Payouts" phase="F5" />} />
            <Route path="marketing" element={<Placeholder title="Marketing and ads" phase="F6" />} />
            <Route path="creative" element={<Placeholder title="Creative" phase="F6" />} />
            <Route path="site" element={<Placeholder title="Website" phase="F6" />} />
            <Route path="settings" element={<SettingsPage />} />

            <Route path="404" element={<NotFound />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
          </Route>
        </Routes>
      </SessionGate>
    </BrowserRouter>
  )
}
