/**
 * Where the one sign-in form lives.
 *
 * On the merchant origin, because that is where everybody arrives and because
 * two forms would be two places for the password rules to drift. The console
 * has no form of its own and sends people there instead.
 *
 * Read from the build environment with the production host as the fallback,
 * the same way the merchant applications find each other: separate
 * applications means separate origins in development, so the address cannot be
 * a constant in the code.
 */
export function signInUrl(): string {
  const configured = import.meta.env['VITE_SIGN_IN_URL']
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'http://app.twentyfour.localhost/auth'
}
