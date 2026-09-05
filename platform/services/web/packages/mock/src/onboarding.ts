/**
 * The 24-hour checklist.
 *
 * These are the steps from the provisioning saga in system-architecture.html
 * section 11, mapped to the hours the guarantee claims. Every step is
 * idempotent and independently retryable: a failure at hour 12 does not unwind
 * hour 4, and the specialist retries that step alone.
 *
 * Two of them cannot complete unattended. Processor KYC is an external
 * approval and terminal pairing needs someone holding the hardware, so both
 * sit at awaiting_specialist rather than pretending to be in progress. A
 * checklist that silently half-completes is how a 24-hour promise gets broken
 * the first time a processor is slow.
 */
import type { OnboardingState, OnboardingStep } from '@twentyfour/api'

interface StepSpec {
  id: string
  title: string
  description: string
  hour: 0 | 4 | 12 | 24
  status: OnboardingStep['status']
}

const STEPS: StepSpec[] = [
  {
    id: 'intake',
    title: 'Business type and hours recorded',
    description: 'What you sell, when you open, and which tax rates apply.',
    hour: 0,
    status: 'done',
  },
  {
    id: 'plan',
    title: 'Plan confirmed',
    description: 'Your tier and everything it switches on.',
    hour: 0,
    status: 'done',
  },
  {
    id: 'entitlement',
    title: 'Account opened',
    description: 'Your modules are enabled and your dashboard is built from them.',
    hour: 4,
    status: 'done',
  },
  {
    id: 'catalog_seed',
    title: 'Starter catalog loaded',
    description: 'Seeded from your trade’s template. Edit anything that is not yours.',
    hour: 4,
    status: 'done',
  },
  {
    id: 'tax_setup',
    title: 'Tax rules configured',
    description: 'Rates and categories for your trade, applied to your prices.',
    hour: 4,
    status: 'done',
  },
  {
    id: 'staff_accounts',
    title: 'Staff accounts created',
    description: 'Logins and roles for everyone on your team.',
    hour: 4,
    status: 'in_progress',
  },
  {
    id: 'processor_account',
    title: 'Card processing account',
    description:
      'Your processor is verifying the business. This one is on their clock, so a specialist is watching it for you.',
    hour: 12,
    status: 'awaiting_specialist',
  },
  {
    id: 'hardware',
    title: 'Terminals and printers paired',
    description: 'Booked with your specialist. Someone needs to be holding the hardware.',
    hour: 12,
    status: 'awaiting_specialist',
  },
  {
    id: 'data_import',
    title: 'Existing data imported',
    description: 'Products, customers and past bookings brought across and reconciled.',
    hour: 12,
    status: 'pending',
  },
  {
    id: 'subscription',
    title: 'Subscription opened',
    description: 'Billing starts when you go live, not before.',
    hour: 12,
    status: 'pending',
  },
  {
    id: 'training',
    title: 'Training session',
    description: 'Forty minutes with your specialist, on your own data.',
    hour: 24,
    status: 'pending',
  },
  {
    id: 'first_sale',
    title: 'First real sale',
    description: 'The timer stops here.',
    hour: 24,
    status: 'pending',
  },
]

export function buildOnboarding(startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000)): OnboardingState {
  const due = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000)
  return {
    startedAt: startedAt.toISOString(),
    dueAt: due.toISOString(),
    completedAt: null,
    steps: STEPS.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      hour: step.hour,
      status: step.status,
      completedAt:
        step.status === 'done'
          ? new Date(startedAt.getTime() + step.hour * 60 * 60 * 1000).toISOString()
          : null,
    })),
  }
}
