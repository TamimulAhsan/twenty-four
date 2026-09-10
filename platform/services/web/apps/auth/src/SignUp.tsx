import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { auth, HttpError, PASSWORD_LENGTH_FALLBACK, type SignupInput } from '@twentyfour/api'
import {
  CAPABILITIES, TIERS, industryProfile, profileCapabilities, tierModules, MODULES,
  type TierId, TIER_IDS,
} from '@twentyfour/entitlement'
import { money } from '@twentyfour/money'
import { BusinessTypeSelector } from '@twentyfour/shell'
import { Button, Card, Icon, Input, MoneyText, cn } from '@twentyfour/ui'
import { AuthLayout } from './AuthLayout'
import { PasswordField } from './PasswordField'
import { PlanPicker } from './PlanPicker'

/**
 * Setting up an account.
 *
 * Four questions, asked one screen at a time, in the order they matter. The
 * first one is the business type, because it is the single most consequential
 * field in the product: it decides which capabilities switch on, what things
 * are called, which catalog template seeds and which tax categories exist. It
 * goes first so nothing after it has to be revisited.
 *
 * A wizard rather than one long form on purpose. The plan step is four cards
 * with what each one includes, and the trade step is forty-three options; put
 * them on one page with an email field and the two decisions that actually
 * cost money get scrolled past.
 *
 * Nothing here is a security control. Every rule the form checks is checked
 * again at the gateway, and the gateway's answer comes back per field so it
 * lands under the input that caused it rather than in a banner.
 */
const STEPS = ['trade', 'business', 'plan', 'review'] as const
type StepId = (typeof STEPS)[number]

const STEP_TITLES: Readonly<Record<StepId, { title: string; description: string }>> = {
  trade: {
    title: 'What kind of business is this?',
    description:
      'It decides what everything is called, which tools switch on, and what your catalog starts with. A specialist can change it later.',
  },
  business: {
    title: 'The business, and you',
    description: 'You are its first account, and its owner.',
  },
  plan: {
    title: 'Pick a plan',
    description:
      'Plans are what you are billed for. Nothing inside one is priced separately, and billing starts when you go live rather than today.',
  },
  review: {
    title: 'Check it over',
    description: 'This is what gets set up. Nothing is charged yet.',
  },
}

interface Draft {
  industry: string | null
  businessName: string
  displayName: string
  email: string
  password: string
  tier: TierId
}

type Errors = Partial<Record<keyof Draft, string>>

/** Which step owns a field, so a rejection from the gateway sends the merchant
 *  back to the screen the field is actually on. */
const FIELD_STEP: Readonly<Record<string, StepId>> = {
  industry: 'trade',
  businessName: 'business',
  displayName: 'business',
  email: 'business',
  password: 'business',
  tier: 'plan',
}

export function SignUp() {
  const [step, setStep] = useState<StepId>('trade')
  const [errors, setErrors] = useState<Errors>({})
  const [draft, setDraft] = useState<Draft>(() => ({
    industry: initialIndustry(),
    businessName: '',
    displayName: '',
    email: '',
    password: '',
    tier: initialTier(),
  }))

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    // Cleared as it is corrected. Leaving a message under a field somebody has
    // already fixed teaches them to ignore the messages.
    setErrors((current) => (key in current ? { ...current, [key]: undefined } : current))
  }

  /**
   * The password rule this deployment actually enforces.
   *
   * Asked for rather than assumed, because the length is Auth's setting and
   * differs between a development cluster and a real one. A form stating a
   * number nobody enforces is a form that rejects passwords that would work,
   * or promises ones that will not. If the call fails the fallback stands and
   * the gateway still has the last word, per field.
   */
  const policy = useQuery({
    queryKey: ['auth', 'policy'],
    queryFn: () => auth.policy(),
    staleTime: Infinity,
  })
  const minPassword = policy.data?.minPasswordLength ?? PASSWORD_LENGTH_FALLBACK

  const create = useMutation({
    mutationFn: (input: SignupInput) => auth.signup(input),
    onSuccess: () => {
      // The dashboard, at the checklist rather than the overview. Somebody who
      // signed up ninety seconds ago has no figures to look at; what they have
      // is a list of what happens over the next twenty-four hours.
      window.location.assign('/onboarding')
    },
    onError: (error) => {
      if (!(error instanceof HttpError)) return
      const next: Errors = {}
      for (const field of error.fieldErrors) {
        next[field.field as keyof Draft] = field.message
      }
      setErrors(next)
      const first = error.fieldErrors[0]
      const target = first ? FIELD_STEP[first.field] : undefined
      if (target) setStep(target)
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = validate(step, draft, minPassword)
    if (Object.keys(found).length > 0) {
      setErrors(found)
      return
    }
    if (step !== 'review') {
      setStep(STEPS[STEPS.indexOf(step) + 1] as StepId)
      return
    }
    create.mutate({
      email: draft.email.trim(),
      password: draft.password,
      displayName: draft.displayName.trim(),
      businessName: draft.businessName.trim(),
      industry: draft.industry ?? '',
      tier: draft.tier,
    })
  }

  const index = STEPS.indexOf(step)
  const failure =
    create.error instanceof HttpError && create.error.fieldErrors.length === 0
      ? create.error.message
      : undefined

  return (
    <AuthLayout wide aside={<Progress current={step} />}>
      <p className="text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
        Step {index + 1} of {STEPS.length}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-text">
        {STEP_TITLES[step].title}
      </h1>
      <p className="mt-1.5 text-base text-text-muted">{STEP_TITLES[step].description}</p>

      {/* A bar on small screens, where the panel carrying the step list is
          dropped and there would otherwise be nothing showing how far in this
          is. */}
      <div className="mt-5 flex gap-1.5 lg:hidden" aria-hidden="true">
        {STEPS.map((entry, position) => (
          <span
            key={entry}
            className={cn(
              'h-1 flex-1 rounded-full',
              position <= index ? 'bg-accent' : 'bg-border',
            )}
          />
        ))}
      </div>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-5" noValidate>
        {step === 'trade' && (
          <div className="flex flex-col gap-2">
            <BusinessTypeSelector
              value={draft.industry}
              onChange={(id) => set('industry', id)}
              autoFocus
            />
            {errors.industry && (
              <p className="text-base text-danger-text" role="alert">
                {errors.industry}
              </p>
            )}
          </div>
        )}

        {step === 'business' && (
          <>
            <Input
              label="Business name"
              name="organization"
              autoComplete="organization"
              required
              autoFocus
              value={draft.businessName}
              onChange={(event) => set('businessName', event.target.value)}
              hint="As your customers know it. It goes on receipts and invoices."
              error={errors.businessName}
            />
            <Input
              label="Your name"
              name="name"
              autoComplete="name"
              required
              value={draft.displayName}
              onChange={(event) => set('displayName', event.target.value)}
              error={errors.displayName}
            />
            <Input
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              value={draft.email}
              onChange={(event) => set('email', event.target.value)}
              iconStart="User"
              hint="You sign in with this, and it is where your specialist will reach you."
              error={errors.email}
            />
            <PasswordField
              autoComplete="new-password"
              value={draft.password}
              onChange={(value) => set('password', value)}
              hint={`At least ${minPassword} characters.`}
              error={errors.password}
            />
          </>
        )}

        {step === 'plan' && (
          <>
            <PlanPicker value={draft.tier} onChange={(tier) => set('tier', tier)} />
            {errors.tier && (
              <p className="text-base text-danger-text" role="alert">
                {errors.tier}
              </p>
            )}
          </>
        )}

        {step === 'review' && <Review draft={draft} onEdit={setStep} />}

        {failure && (
          <p className="text-base text-danger-text" role="alert">
            {failure}
          </p>
        )}

        <div className="flex items-center gap-3">
          {index > 0 && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              iconStart="ArrowLeft"
              onClick={() => setStep(STEPS[index - 1] as StepId)}
            >
              Back
            </Button>
          )}
          <Button type="submit" size="lg" className="flex-1" loading={create.isPending}>
            {step === 'review' ? 'Create the account' : 'Continue'}
          </Button>
        </div>
      </form>

      <p className="mt-6 text-base text-text-muted">
        Already set up?{' '}
        <Link to="/" className="font-medium text-accent-text underline-offset-2 hover:underline">
          Sign in
        </Link>
        .
      </p>
    </AuthLayout>
  )
}

/* ------------------------------------------------------------------ review */

function Review({ draft, onEdit }: { draft: Draft; onEdit: (step: StepId) => void }) {
  const profile = industryProfile(draft.industry ?? undefined)
  const tier = TIERS[draft.tier]
  const capabilities = profileCapabilities(draft.industry ?? undefined)
  // Everything the tier resolves to, dependencies included, minus what every
  // tenant has anyway. Listing Identity and Tenancy as a feature is noise.
  const modules = tierModules(draft.tier).filter(
    (moduleId) => MODULES[moduleId].kind !== 'always_on',
  )

  return (
    <div className="flex flex-col gap-3">
      <Card padded={false}>
        <Row label="Business" onEdit={() => onEdit('business')}>
          <p className="font-medium text-text">{draft.businessName}</p>
          <p className="text-base text-text-muted">
            {draft.displayName} · {draft.email}
          </p>
        </Row>
        <Row label="Trade" onEdit={() => onEdit('trade')}>
          <p className="font-medium text-text">{profile?.name ?? 'Not chosen'}</p>
          {capabilities.length > 0 && (
            <p className="text-base text-text-muted">
              {capabilities.map((id) => CAPABILITIES[id].name).join(' and ')} switched on for your
              trade, at no extra cost.
            </p>
          )}
        </Row>
        <Row label="Plan" onEdit={() => onEdit('plan')} last>
          <p className="font-medium text-text">
            {tier.name}
            {tier.monthlyMinor !== null && (
              <>
                {' · '}
                <MoneyText value={money(tier.monthlyMinor, tier.currency)} /> per month, ex VAT
              </>
            )}
          </p>
          <p className="text-base text-text-muted">
            {tier.seats === null ? 'Seats agreed with your account team' : `${tier.seats} staff seats`}
          </p>
        </Row>
      </Card>

      <Card>
        <p className="text-base font-medium text-text">What switches on</p>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {modules.map((moduleId) => (
            <li key={moduleId} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-success-text">
                <Icon name="Check" size="md" />
              </span>
              <span className="min-w-0">
                <span className="block text-base text-text">{MODULES[moduleId].name}</span>
                <span className="block text-sm text-text-subtle">
                  {MODULES[moduleId].summary}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="border-accent-border bg-accent-subtle">
        <p className="text-base font-medium text-accent-text">Live within 24 hours</p>
        <p className="mt-1 text-base text-text-muted">
          A specialist configures this for your trade and stays with it until you have taken a real
          sale. If that has not happened within twenty-four hours, your first month is free.
        </p>
      </Card>
    </div>
  )
}

function Row({
  label,
  onEdit,
  last,
  children,
}: {
  label: string
  onEdit: () => void
  last?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', !last && 'border-b border-border')}>
      <p className="w-20 shrink-0 pt-0.5 text-sm text-text-subtle">{label}</p>
      <div className="min-w-0 flex-1">{children}</div>
      <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
        Change
      </Button>
    </div>
  )
}

/* ---------------------------------------------------------------- progress */

function Progress({ current }: { current: StepId }) {
  const index = STEPS.indexOf(current)
  return (
    <div>
      <p className="text-3xl font-semibold leading-[1.15] tracking-[-0.03em] text-white">
        Four questions, then a specialist takes it from here.
      </p>
      <ol className="mt-8 flex flex-col gap-4">
        {STEPS.map((step, position) => {
          const done = position < index
          const active = position === index
          return (
            <li key={step} className="flex items-center gap-3">
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-full text-sm font-medium',
                  done
                    ? 'bg-accent text-white'
                    : active
                      ? 'bg-white text-neutral-950'
                      : 'border border-neutral-700 text-neutral-500',
                )}
              >
                {done ? <Icon name="Check" size="sm" /> : position + 1}
              </span>
              <span
                className={cn(
                  'text-md',
                  active ? 'font-medium text-white' : done ? 'text-neutral-300' : 'text-neutral-500',
                )}
              >
                {STEP_TITLES[step].title}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/* -------------------------------------------------------------- validation */

function validate(step: StepId, draft: Draft, minPassword: number): Errors {
  const errors: Errors = {}
  if (step === 'trade' && !industryProfile(draft.industry ?? undefined)) {
    errors.industry = 'Pick the nearest one. A specialist can adjust it later.'
  }
  if (step === 'business') {
    if (!draft.businessName.trim()) errors.businessName = 'What is the business called?'
    if (!draft.displayName.trim()) errors.displayName = 'Tell us your name.'
    // Deliberately loose. Anything stricter rejects addresses that work, and
    // the only real proof an address exists is sending something to it.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
      errors.email = 'Enter an email address we can reach you on.'
    }
    if (draft.password.length < minPassword) {
      errors.password = `Use at least ${minPassword} characters.`
    }
  }
  return errors
}

/* ------------------------------------------------------- arriving with a plan */

/**
 * The pricing page links here with the plan already chosen. Both are validated
 * rather than trusted: a query string is whatever the person holding the
 * address bar typed, and an unknown value falls back rather than throwing.
 */
function initialTier(): TierId {
  const raw = new URLSearchParams(window.location.search).get('tier')
  return TIER_IDS.includes(raw as TierId) ? (raw as TierId) : 'growth'
}

function initialIndustry(): string | null {
  const raw = new URLSearchParams(window.location.search).get('industry')
  return industryProfile(raw ?? undefined) ? raw : null
}
