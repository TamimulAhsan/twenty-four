import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { FormatProvider } from '@twentyfour/ui'
import { SignIn } from './SignIn'
import { SignUp } from './SignUp'
import { Pending } from './Pending'

/**
 * The auth application. One sign-in form for the whole product, and the form
 * that creates an account in the first place.
 *
 * It deliberately does not use SessionGate: this is where people arrive when
 * they have no session, so gating it would loop. It runs on the same origin as
 * every other application, so the cookie issued here is already present when
 * the browser is sent back.
 *
 * Password reset and invite acceptance are routed so no link is ever dead.
 * Each says what it is waiting on rather than pretending to work: authd
 * implements ResetPassword and ChangePassword, but delivering either mail
 * needs the Notification service.
 */
export function AuthApp() {
  return (
    <FormatProvider
      locale={read('VITE_LOCALE', 'en-GB')}
      currency={read('VITE_CURRENCY', 'EUR')}
      timezone={read('VITE_TIMEZONE', 'UTC')}
    >
      <BrowserRouter basename="/auth">
        <Routes>
          <Route index element={<SignIn />} />
          <Route path="signup" element={<SignUp />} />
          <Route
            path="reset"
            element={
              <Pending
                title="Reset your password"
                waitingOn="the Notification service, so the reset link can actually be delivered"
              />
            }
          />
          <Route
            path="invite"
            element={
              <Pending
                title="Accept your invitation"
                waitingOn="the Notification service, so invitations can be sent"
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </FormatProvider>
  )
}

/**
 * Formatting, before there is a tenant to take it from.
 *
 * Everywhere else the locale comes off the business profile, because a
 * Hungarian merchant serving a German tourist still reads their own till in
 * Hungarian. Nobody signing up has a profile yet, so this one comes from the
 * environment. That is deployment configuration, not a country check in the
 * code: an environment is one market, and it knows which.
 */
function read(key: string, fallback: string): string {
  const value = (import.meta.env as Record<string, string | boolean | undefined>)[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
