// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { onboarding as onboardingApi, type Bootstrap, type OnboardingState } from '@twentyfour/api'
import { buildOnboarding } from '@twentyfour/mock'
import { FormatProvider, ToastProvider } from '@twentyfour/ui'
import { TermsProvider } from '@twentyfour/terms'
import { formatRemaining } from './useOnboarding'
import { OnboardingPage } from './OnboardingPage'

/**
 * The checklist, as a merchant reads it.
 *
 * What matters here is not that twelve rows render. It is that the two steps
 * which cannot complete unattended stay visibly with a specialist, and that the
 * ones waiting on the merchant say so and offer somewhere to go. A checklist
 * that presents all twelve identically is a progress bar with extra words.
 */
let state: OnboardingState = buildOnboarding()

vi.mock('@twentyfour/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@twentyfour/runtime')>()),
  useBootstrap: (): Bootstrap => ({ onboarding: state }) as Bootstrap,
}))

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <FormatProvider locale="en-GB" currency="HUF" timezone="Europe/Budapest">
        <TermsProvider family="retail" profile="clothing" locale="en-GB">
          <ToastProvider>
            <MemoryRouter>
              <OnboardingPage />
            </MemoryRouter>
          </ToastProvider>
        </TermsProvider>
      </FormatProvider>
    </QueryClientProvider>,
  )
}

/** The row a step's title sits in, so an action can be found next to it. */
const rowFor = (title: RegExp): HTMLElement => {
  const row = screen.getByText(title).closest('li')
  if (!row) throw new Error(`no step row for ${String(title)}`)
  return row
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  state = buildOnboarding()
})

describe('the 24-hour checklist screen', () => {
  it('groups the steps into the four stages the guarantee is measured in', () => {
    renderPage()
    for (const stage of ['At the intake call', 'First four hours', 'By hour twelve', 'Before you go live']) {
      expect(screen.getByText(stage)).toBeTruthy()
    }
  })

  it('says how much of the day is left and how many steps are done', () => {
    renderPage()
    // The fixture starts five hours in, so nineteen remain.
    expect(screen.getByText(/19 h left/)).toBeTruthy()
    const total = state.steps.length
    const done = state.steps.filter((step) => step.status === 'done').length
    expect(screen.getByText(`/${total}`)).toBeTruthy()
    expect(screen.getByText(String(done))).toBeTruthy()
  })

  it('marks the steps that are waiting on the merchant, and only those', () => {
    renderPage()
    const expected = state.steps.filter(
      (step) => step.owner === 'merchant' && step.status !== 'done',
    ).length
    expect(screen.getAllByText('Needs you')).toHaveLength(expected)
  })

  it('leaves the steps that need a person sitting with a specialist', () => {
    renderPage()
    const expected = state.steps.filter(
      (step) => step.owner === 'specialist' && step.status !== 'done',
    ).length
    expect(screen.getAllByText('Your specialist')).toHaveLength(expected)
    expect(
      within(rowFor(/Card processing account/)).getByRole('button', { name: /ask for an update/i }),
    ).toBeTruthy()
  })

  it('offers a merchant step somewhere to go', () => {
    renderPage()
    expect(within(rowFor(/Staff accounts created/)).getByRole('button', { name: /add your team/i })).toBeTruthy()
  })

  it('offers nothing on a step that is already finished', () => {
    renderPage()
    expect(within(rowFor(/Tax rules configured/)).queryByRole('button')).toBeNull()
  })

  it('asks the server to pick a specialist step back up', async () => {
    const retry = vi
      .spyOn(onboardingApi, 'retryStep')
      .mockResolvedValue({ ...state, steps: state.steps })
    renderPage()
    fireEvent.click(
      within(rowFor(/Terminals and printers paired/)).getByRole('button', { name: /ask for an update/i }),
    )
    await waitFor(() => expect(retry).toHaveBeenCalledWith('hardware'))
  })

  it('says so plainly once nothing is left', () => {
    state = {
      ...state,
      completedAt: new Date().toISOString(),
      steps: state.steps.map((step) => ({ ...step, status: 'done' as const })),
    }
    renderPage()
    expect(screen.getByText('You are live')).toBeTruthy()
  })
})

describe('how long is left, in words', () => {
  const minutes = (count: number) => count * 60_000

  it('counts in minutes inside the last hour', () => {
    expect(formatRemaining(minutes(42))).toBe('42 min left')
  })

  it('drops the minutes once there are hours enough not to care', () => {
    expect(formatRemaining(minutes(60 * 7 + 20))).toBe('7 h left')
  })

  it('keeps the minutes when the hours are running out', () => {
    expect(formatRemaining(minutes(60 * 2 + 15))).toBe('2 h 15 min left')
  })

  it('does not count backwards past the deadline', () => {
    expect(formatRemaining(0)).toBe('past due')
    expect(formatRemaining(-minutes(90))).toBe('past due')
  })
})
