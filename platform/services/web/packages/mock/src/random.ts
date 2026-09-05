/**
 * Deterministic randomness.
 *
 * Seeded from the tenant id so a reload shows the same business. Analytics
 * screens are impossible to judge against data that reshuffles every time you
 * look at them: you cannot tell a bug from a different sample.
 */
export function createRandom(seed: string) {
  let state = 0
  for (let index = 0; index < seed.length; index++) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0
  }
  state = (state || 1) >>> 0

  const next = (): number => {
    // mulberry32: small, fast, and good enough for fixtures.
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    /** Integer in [min, max]. */
    int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
    /** True with the given probability. */
    chance: (probability: number): boolean => next() < probability,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    /**
     * A long tail.
     *
     * Customer spend is not normally distributed: a handful of people are
     * worth more than the bottom half put together, and a fixture with a
     * uniform spread makes every segmentation screen look broken because
     * nothing separates.
     */
    pareto: (shape = 1.3): number => Math.pow(1 - next(), -1 / shape) - 1,
    /** Weighted pick, where weights need not sum to one. */
    weighted: <T>(items: ReadonlyArray<readonly [T, number]>): T => {
      const total = items.reduce((sum, [, weight]) => sum + weight, 0)
      let roll = next() * total
      for (const [item, weight] of items) {
        roll -= weight
        if (roll <= 0) return item
      }
      return items[items.length - 1]?.[0] as T
    },
  }
}

export type Random = ReturnType<typeof createRandom>
