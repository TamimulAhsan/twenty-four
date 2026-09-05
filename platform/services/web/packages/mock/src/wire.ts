/**
 * Converts an internal value to the wire form.
 *
 * Money leaves as { minor: "1270", currency: "HUF" }, matching protobuf's JSON
 * mapping for int64. The client parses it back through parseMoney, so the
 * boundary is exercised on every request rather than only in production.
 */
function isMoney(value: unknown): value is { minor: number; currency: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['minor'] === 'number' &&
    typeof (value as Record<string, unknown>)['currency'] === 'string' &&
    Object.keys(value as object).length === 2
  )
}

export function wire<T>(value: T): unknown {
  if (Array.isArray(value)) return value.map(wire)
  if (isMoney(value)) return { minor: String(value.minor), currency: value.currency }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = wire(entry)
    return out
  }
  return value
}
