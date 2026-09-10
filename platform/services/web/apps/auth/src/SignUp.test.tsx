// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { auth, HttpError } from '@twentyfour/api'
import { FormatProvider } from '@twentyfour/ui'
import { SignUp } from './SignUp'

/**
 * Walking the signup form.
 *
 * The four answers this collects each change something downstream that is
 * expensive to get wrong: the trade decides the vocabulary and which
 * capabilities switch on, the tier decides what the gateway will let through.
 * A form that quietly sends the wrong one of those is not visibly broken, which
 * is why what it sends is asserted rather than eyeballed.
 */
function renderForm() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <FormatProvider locale="en-GB" currency="EUR" timezone="UTC">
        <MemoryRouter>
          <SignUp />
        </MemoryRouter>
      </FormatProvider>
    </QueryClientProvider>,
  )
}

const heading = () => screen.getByRole('heading', { level: 1 }).textContent
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }))
const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
/** The plan cards are radios, not buttons: one of four, and only one. */
const plan = (name: RegExp) => screen.getByRole('radio', { name })

/** Steps one and two, filled in correctly, leaving the form on the plan step. */
function fillAccount(email = 'marta@kenyeresk.hu') {
  press('Bakery')
  press('Continue')
  fill(/business name/i, 'Kenyér és Kávé')
  fill(/your name/i, 'Márta Nagy')
  fill(/^email/i, email)
  fill(/^password/i, 'a-long-enough-one')
  press('Continue')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the signup form', () => {
  it('asks for the business type first, because everything else follows from it', () => {
    renderForm()
    expect(heading()).toContain('What kind of business is this?')
  })

  it('will not move on until a trade is picked', async () => {
    renderForm()
    press('Continue')
    expect((await screen.findByRole('alert')).textContent).toMatch(/pick the nearest one/i)
    expect(heading()).toContain('What kind of business is this?')
  })

  it('refuses a malformed email and a short password, under the right fields', async () => {
    renderForm()
    press('Bakery')
    press('Continue')
    fill(/business name/i, 'Kenyér és Kávé')
    fill(/your name/i, 'Márta Nagy')
    fill(/^email/i, 'not-an-address')
    fill(/^password/i, 'short')
    press('Continue')

    expect(await screen.findByText(/an email address we can reach you on/i)).toBeTruthy()
    expect(screen.getByText(/at least 10 characters/i)).toBeTruthy()
    // Still on the same step. A form that advances past its own errors has none.
    expect(heading()).toContain('The business, and you')
  })

  it('preselects Growth, and lets a different plan be chosen', () => {
    renderForm()
    fillAccount()
    expect(heading()).toContain('Pick a plan')
    expect(plan(/^Growth/).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(plan(/^Starter/))
    expect(plan(/^Starter/).getAttribute('aria-checked')).toBe('true')
    expect(plan(/^Growth/).getAttribute('aria-checked')).toBe('false')
  })

  it('shows what was chosen before anything is created', () => {
    renderForm()
    fillAccount()
    press('Continue')
    expect(heading()).toContain('Check it over')
    expect(screen.getByText('Kenyér és Kávé')).toBeTruthy()
    // The trade's own name, not its id, and the tier's name.
    expect(screen.getByText('Bakery')).toBeTruthy()
    expect(screen.getByText(/Growth/)).toBeTruthy()
  })

  it('sends exactly what was typed, and the plan that was chosen', async () => {
    const signup = vi.spyOn(auth, 'signup').mockResolvedValue({
      userId: 'u1',
      email: 'marta@kenyeresk.hu',
      name: 'Márta Nagy',
      role: 'owner',
      tenantId: 't1',
    })

    renderForm()
    fillAccount()
    fireEvent.click(plan(/^Starter/))
    press('Continue')
    press('Create the account')

    await waitFor(() =>
      expect(signup).toHaveBeenCalledWith({
        email: 'marta@kenyeresk.hu',
        password: 'a-long-enough-one',
        displayName: 'Márta Nagy',
        businessName: 'Kenyér és Kávé',
        industry: 'bakery',
        tier: 'starter',
      }),
    )
  })

  /**
   * The length is Auth's setting, not the form's. A development cluster and a
   * real one enforce different numbers, and a form carrying its own copy is
   * wrong on one of them without anybody finding out until a merchant is
   * refused a password the hint said was long enough.
   */
  describe('the password rule', () => {
    it('states the length this deployment enforces', async () => {
      vi.spyOn(auth, 'policy').mockResolvedValue({ minPasswordLength: 14 })
      renderForm()
      press('Bakery')
      press('Continue')
      expect(await screen.findByText('At least 14 characters.')).toBeTruthy()
    })

    it('refuses against that length rather than its own', async () => {
      vi.spyOn(auth, 'policy').mockResolvedValue({ minPasswordLength: 14 })
      renderForm()
      press('Bakery')
      press('Continue')
      await screen.findByText('At least 14 characters.')
      fill(/business name/i, 'Kenyér és Kávé')
      fill(/your name/i, 'Márta Nagy')
      fill(/^email/i, 'marta@kenyeresk.hu')
      // Twelve characters: long enough for the fallback, short here.
      fill(/^password/i, 'twelve-chars')
      press('Continue')
      expect(screen.getByText('Use at least 14 characters.')).toBeTruthy()
      expect(heading()).toContain('The business, and you')
    })

    it('falls back to the shorter rule when the policy cannot be read', async () => {
      vi.spyOn(auth, 'policy').mockRejectedValue(new Error('offline'))
      renderForm()
      press('Bakery')
      press('Continue')
      expect(await screen.findByText('At least 10 characters.')).toBeTruthy()
    })
  })

  it('goes back to the step that owns a field the gateway refused', async () => {
    vi.spyOn(auth, 'signup').mockRejectedValue(
      new HttpError({
        status: 409,
        code: 'email_taken',
        message: 'That email already has an account.',
        fieldErrors: [{ field: 'email', message: 'This address already has an account.' }],
      }),
    )

    renderForm()
    fillAccount('anna@nyolcaskavezo.hu')
    press('Continue')
    press('Create the account')

    expect(await screen.findByText(/already has an account/i)).toBeTruthy()
    expect(heading()).toContain('The business, and you')
  })
})
