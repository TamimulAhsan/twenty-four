/**
 * Where to send someone after they sign in.
 *
 * SessionGate puts the path it interrupted in ?return. Only same-origin
 * absolute paths are honoured: accepting anything else would turn sign-in into
 * an open redirect, which is a phishing tool with our domain on it.
 */
export function returnTo(fallback = '/'): string {
  const raw = new URLSearchParams(window.location.search).get('return')
  if (!raw) return fallback
  // Must be a path on this origin. Reject scheme-relative "//evil.com" and any
  // absolute URL, however it is spelled.
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
  return raw
}
