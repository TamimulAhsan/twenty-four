// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { adminPlatform, type TierRegistryEntry } from '@twentyfour/api'
import { MODULES, TIERS, TIER_IDS, resolveDependencies, requiresSpecialist } from '@twentyfour/entitlement'
import { money } from '@twentyfour/money'
import { FormatProvider, ToastProvider } from '@twentyfour/ui'
import { DrawerProvider } from '../Drawer'
import { TiersPage } from './TiersPage'

/**
 * The tier registry, tested for what it must not do.
 *
 * This is the one screen in the console whose blast radius is every tenant on
 * a tier. The claim it makes is that a click stages a change and nothing
 * reaches the registry until somebody confirms a dialog that names how many
 * businesses are affected. That claim is invisible when it is broken: a page
 * that wrote through on click would look and feel identical right up to the
 * moment somebody explored the table.
 */
const REGISTRY: TierRegistryEntry[] = TIER_IDS.map((tier) => {
  const grants = [...TIERS[tier].grants]
  const modules = resolveDependencies(grants)
  const needsSpecialist = requiresSpecialist(modules)
  return {
    tier,
    grants,
    modules,
    seats: TIERS[tier].seats,
    monthly: TIERS[tier].monthlyMinor === null ? null : money(TIERS[tier].monthlyMinor * 4, 'HUF'),
    tenants: tier === 'starter' ? 4 : tier === 'growth' ? 5 : tier === 'max' ? 2 : 1,
    autoProvision: needsSpecialist.length === 0,
    needsSpecialist,
  }
})

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <FormatProvider locale="hu-HU" currency="HUF" timezone="Europe/Budapest">
        <ToastProvider>
          <DrawerProvider>
            <TiersPage />
          </DrawerProvider>
        </ToastProvider>
      </FormatProvider>
    </QueryClientProvider>,
  )
}

/** One cell of the matrix, addressed the way a reader would describe it. */
const cell = (module: string, tier: string) =>
  screen.getByRole('button', { name: `${module} on ${tier}` })

/**
 * Waits for the matrix itself, not for the heading above it.
 *
 * The section title renders before the query resolves, so awaiting the words
 * "What each tier grants" would let a test click into a skeleton and fail with
 * a missing element rather than a wrong one.
 */
const matrixReady = () =>
  screen.findByRole('button', { name: `${MODULES.crm.name} on Starter` })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the tier registry', () => {
  it('stages a change and writes nothing until it is confirmed', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    const write = vi.spyOn(adminPlatform, 'setTierGrants').mockResolvedValue(REGISTRY)
    renderPage()

    await matrixReady()
    fireEvent.click(cell(MODULES.crm.name, 'Starter'))

    // The change is visible, the count of who it would hit is named, and the
    // registry has not been touched.
    const apply = await screen.findByRole('button', { name: 'Apply to every tenant' })
    // Read off the bar the button sits in. "4 tenants" also appears on the
    // Starter card, and a loose text query would pass on the wrong one.
    const bar = apply.closest('div')?.parentElement
    expect(bar?.textContent).toContain('4 tenants')
    expect(write).not.toHaveBeenCalled()
  })

  it('names what would be added before anything is applied', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    vi.spyOn(adminPlatform, 'setTierGrants').mockResolvedValue(REGISTRY)
    renderPage()

    await matrixReady()
    fireEvent.click(cell(MODULES.crm.name, 'Starter'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply to every tenant' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(new RegExp(`Adds ${MODULES.crm.name}`))).toBeTruthy()
  })

  it('discards without touching the registry', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    const write = vi.spyOn(adminPlatform, 'setTierGrants').mockResolvedValue(REGISTRY)
    renderPage()

    await matrixReady()
    fireEvent.click(cell(MODULES.crm.name, 'Starter'))
    await screen.findByRole('button', { name: 'Apply to every tenant' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply to every tenant' })).toBeNull(),
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('applies in ladder order, so a higher tier is never briefly poorer', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    const write = vi.spyOn(adminPlatform, 'setTierGrants').mockResolvedValue(REGISTRY)
    renderPage()

    await matrixReady()
    // Staged out of order on purpose: Max first, then Growth.
    fireEvent.click(cell(MODULES.advanced_analytics.name, 'Max'))
    fireEvent.click(cell(MODULES.advanced_analytics.name, 'Growth'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply to every tenant' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Apply to \d+ tenants?/ }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[0]?.[0]).toBe('growth')
    expect(write.mock.calls[1]?.[0]).toBe('max')
  })

  it('will not let a module that ships with every tenant be sold per tier', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    renderPage()

    await matrixReady()
    // notifications is always_on, so it has no control at all, on any tier.
    expect(
      screen.queryByRole('button', { name: `${MODULES.notifications.name} on Starter` }),
    ).toBeNull()
    expect(screen.getAllByText('always').length).toBeGreaterThan(0)
  })

  it('says which module stops a tier going live on its own', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    renderPage()

    // Growth grants marketing, whose ad-account consent only the owner can
    // give. The card has to say which module, not just that it needs someone.
    await screen.findAllByText('Needs a specialist')
    expect(screen.getAllByText(new RegExp(MODULES.marketing_ads.name)).length).toBeGreaterThan(0)
  })

  it('shows the quoted tier as quoted rather than as free', async () => {
    vi.spyOn(adminPlatform, 'tiers').mockResolvedValue(REGISTRY)
    renderPage()
    expect(await screen.findByText('Quoted per customer')).toBeTruthy()
  })
})
