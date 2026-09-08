import type { Graph, GNode } from './types'

export const NODE_W = 244
export const NODE_H = 88
const GAP_X = 40
const ROW_H = 186
const TOP = 92

export interface Placed extends GNode { x: number; y: number; tier: number }
export interface Tier { index: number; y: number; label: string; count: number }
export interface Layout {
  nodes: Placed[]; tiers: Tier[]; width: number; height: number
}

/**
 * Longest-path layering. Every edge points from caller to callee
 * (ingress → service → pod → service → pod), so a node sits one row below the
 * deepest thing that points at it. The canvas is then sized to the widest tier
 * rather than a fixed width — that is what stops nodes overlapping.
 */
export function layout(g: Graph, minWidth: number): Layout {
  const ids = new Set(g.nodes.map((n) => n.id))
  const incoming = new Map<string, string[]>()
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from])
  }

  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const resolve = (id: string): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // cycle guard
    visiting.add(id)
    const parents = incoming.get(id) ?? []
    const d = parents.length === 0 ? 0 : Math.max(...parents.map(resolve)) + 1
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  g.nodes.forEach((n) => resolve(n.id))

  const byTier = new Map<number, GNode[]>()
  for (const n of g.nodes) {
    const d = depth.get(n.id) ?? 0
    byTier.set(d, [...(byTier.get(d) ?? []), n])
  }

  const widest = Math.max(1, ...[...byTier.values()].map((v) => v.length))
  const width = Math.max(minWidth, widest * (NODE_W + GAP_X) + GAP_X)

  const order = { ingress: 0, service: 1, pod: 2 } as const
  const placed: Placed[] = []
  const tiers: Tier[] = []

  for (const [tier, nodes] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
    // Group a tier by namespace then kind so related things sit together.
    nodes.sort((a, b) =>
      a.namespace.localeCompare(b.namespace) ||
      order[a.kind] - order[b.kind] ||
      a.name.localeCompare(b.name))

    const span = nodes.length * (NODE_W + GAP_X) - GAP_X
    const startX = (width - span) / 2 + NODE_W / 2
    const y = TOP + tier * ROW_H
    nodes.forEach((n, i) => placed.push({ ...n, tier, x: startX + i * (NODE_W + GAP_X), y }))
    tiers.push({ index: tier, y, label: tierLabel(nodes), count: nodes.length })
  }

  const height = TOP + tiers.length * ROW_H + 40
  return { nodes: placed, tiers, width, height }
}

/** Names a tier from what it actually contains, rather than a fixed scheme. */
function tierLabel(nodes: GNode[]): string {
  const kinds = new Set(nodes.map((n) => n.kind))
  if (kinds.size === 1) {
    const k = [...kinds][0]
    if (k === 'ingress') return 'entry points'
    if (k === 'service') return 'services'
    const roles = new Set(nodes.map((n) => n.role))
    if (roles.size === 1 && roles.has('datastore')) return 'datastore pods'
    if (roles.size === 1 && roles.has('frontend')) return 'frontend pods'
    if (roles.size === 1 && roles.has('app')) return 'service pods'
    return 'pods'
  }
  return 'mixed'
}
