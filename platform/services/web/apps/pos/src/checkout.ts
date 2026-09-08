import {
  isAwaitingPayment,
  payments,
  type CheckoutResult,
  type Order,
  type PaymentPending,
} from '@twentyfour/api'

/**
 * Waiting for the customer.
 *
 * A payment that needs a person cannot complete inside the software: somebody
 * has to tap a terminal, approve a page, confirm in an app. The till's job is
 * to send them there, wait, and then ask for the sale again.
 *
 * Asking again is the part that has to be got right. Every attempt at one
 * checkout carries the same idempotency key, so the payment already made is
 * found rather than made a second time. A key generated per attempt would be a
 * charge per attempt.
 */

/** How often the till asks whether they have finished. A payment that takes a
 *  minute is asked about sixty times, which is nothing. */
const POLL_MS = 1000

/** Long enough for someone to find their phone, hunt for their card, and read
 *  a confirmation screen twice. Past this the till stops watching and says so,
 *  rather than spinning at a cashier with a queue. */
const GIVE_UP_MS = 10 * 60 * 1000

/** Thrown when nobody completed the payment in time. */
export class PaymentNotCompleted extends Error {
  constructor() {
    super('Nobody completed that payment. It is still waiting, and can be finished or given back.')
    this.name = 'PaymentNotCompleted'
  }
}

/**
 * Opens the page the customer has to complete the payment on.
 *
 * Returns null when the browser refused, which is not an error: a blocked
 * popup is why the waiting dialog carries the link as well. The till must not
 * depend on a tab it is not allowed to open.
 */
export function openPaymentPage(url: string): Window | null {
  try {
    return window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    return null
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Polls until the payment stops being pending.
 *
 * It does not decide whether the payment succeeded. That verdict belongs to the
 * next attempt at the sale, which asks the services that own it: a till reading
 * a status and concluding "sold" is a till that will one day conclude it from a
 * refund.
 */
async function waitForPayment(paymentId: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + GIVE_UP_MS
  for (;;) {
    await sleep(POLL_MS, signal)
    let status: string
    try {
      status = (await payments.detail(paymentId)).status
    } catch {
      // A poll that fails is a poll, not a failure. The payment is still out
      // there and the next tick asks again.
      if (Date.now() > deadline) throw new PaymentNotCompleted()
      continue
    }
    if (status !== 'pending') return
    if (Date.now() > deadline) throw new PaymentNotCompleted()
  }
}

/**
 * Runs a checkout to its end: the sale, or the reason there is not one.
 *
 * `attempt` is called once for a sale that needs nothing, and again after each
 * payment the customer completes. It must send the same idempotency key every
 * time, which is why the caller owns the key rather than this function.
 */
export async function runCheckout(
  attempt: () => Promise<CheckoutResult>,
  hooks: {
    /** Called when the customer has somewhere to go, with the tab if one
     *  opened. Null means the browser blocked it and the dialog's own link is
     *  the way through. */
    onAwaiting: (pending: PaymentPending, tab: Window | null) => void
    signal: AbortSignal
  },
): Promise<Order> {
  let result = await attempt()
  while (isAwaitingPayment(result)) {
    const tab = openPaymentPage(result.url)
    hooks.onAwaiting(result, tab)
    await waitForPayment(result.paymentId, hooks.signal)
    // Ours to close, because ours to open. A real hosted page would send the
    // customer back itself.
    try {
      tab?.close()
    } catch {
      // A tab that will not close is not worth failing a sale over.
    }
    result = await attempt()
  }
  return result
}
