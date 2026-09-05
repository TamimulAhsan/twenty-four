import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { SignIn } from './SignIn'
import { Pending } from './Pending'

/**
 * The auth application. One sign-in form for the whole product.
 *
 * It deliberately does not use SessionGate: this is where people arrive when
 * they have no session, so gating it would loop. It runs on the same origin as
 * every other application, so the cookie issued here is already present when
 * the browser is sent back.
 *
 * Sign-up, password reset and invite acceptance are routed now so no link is
 * ever dead. Each says what it is waiting on rather than pretending to work:
 * authd implements ResetPassword and ChangePassword, but Signup here needs the
 * Tenant service and invites need Notification to deliver the mail.
 */
export function AuthApp() {
  return (
    <BrowserRouter basename="/auth">
      <Routes>
        <Route index element={<SignIn />} />
        <Route
          path="signup"
          element={
            <Pending
              title="Create an account"
              waitingOn="the Tenant service, so a business profile exists to attach the account to"
            />
          }
        />
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
  )
}
