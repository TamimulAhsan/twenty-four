import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import type { Graph, GNode } from './types'
import { layout, NODE_W as W, NODE_H as H } from './layout'

const ROLE: Record<string, string> = {
  edge: 'var(--ingress)', service: 'var(--svc)', app: 'var(--app)',
  frontend: 'var(--fe)', datastore: 'var(--data)', system: 'var(--sys)',
}
const EDGE: Record<string, string> = {
  routes: 'var(--ingress)', selects: '#4a5570', depends: 'var(--app)',
  stores: 'var(--data)', publishes: 'var(--bus)', consumes: 'var(--bus)',
  replicates: 'var(--cdc)',
}
// The bus is drawn dashed in both directions, so an event flow is
// distinguishable from a call at a glance rather than by reading the colour.
const DASHED: Record<string, string> = {
  selects: '5 5', publishes: '2 4', consumes: '2 4', replicates: '8 3',
}
const MIN_K = 0.25, MAX_K = 2.5
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))

interface View { k: number; x: number; y: number }

export function Topology({ g, sel, onSelect, onBackground }: {
  g: Graph
  sel: string | null
  onSelect: (n: GNode) => void
  onBackground: () => void
}) {
  const { nodes, tiers, width, height } = useMemo(() => layout(g, 900), [g])
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const vp = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // Distinguishes a drag from a click, so panning never selects a node.
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const moved = useRef(false)

  const fit = useCallback(() => {
    const el = vp.current
    if (!el) return
    const k = clampK(Math.min(el.clientWidth / width, el.clientHeight / height) * 0.9)
    setView({ k, x: (el.clientWidth - width * k) / 2, y: (el.clientHeight - height * k) / 2 })
  }, [width, height])

  // Fit on mount and whenever the visible node set changes size (e.g. filtering).
  useEffect(() => { fit() }, [nodes.length, fit])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = vp.current
    if (!el) return
    const px = cx ?? el.clientWidth / 2
    const py = cy ?? el.clientHeight / 2
    setView((v) => {
      const k = clampK(v.k * factor)
      const r = k / v.k
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
    })
  }, [])

  // Deliberately no setPointerCapture: capturing retargets the subsequent click
  // to the capturing element, which would swallow every node and button click.
  // Window listeners give the same "keep tracking outside the box" behaviour
  // without stealing the click.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as Element).closest?.('.zoomctl')) return // let controls be clicked
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
    moved.current = false
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      if (!moved.current && Math.hypot(dx, dy) > 4) moved.current = true
      if (moved.current) setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
    }
    const up = () => { drag.current = null; setDragging(false) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging])

  const onWheel = (e: React.WheelEvent) => {
    const r = vp.current?.getBoundingClientRect()
    if (!r) return
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top)
  }

  const clickNode = (n: GNode) => { if (!moved.current) onSelect(n) }
  const clickBackground = () => { if (!moved.current) onBackground() }

  const touches = (e: { from: string; to: string }) =>
    sel !== null && (e.from === sel || e.to === sel)

  return (
    <div className={`viewport${dragging ? ' dragging' : ''}`} ref={vp}
         onPointerDown={onPointerDown} onWheel={onWheel}>
      <svg width="100%" height="100%">
        <defs>
          {Object.entries(EDGE).map(([k, c]) => (
            <marker key={k} id={`ar-${k}`} viewBox="0 0 10 10" refX="9" refY="5"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
            </marker>
          ))}
        </defs>

        {/* background catcher: a click here (not a drag) clears the selection */}
        <rect width="100%" height="100%" fill="transparent" onClick={clickBackground} />

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {tiers.map((t) => (
            <g key={t.index}>
              <line x1={0} y1={t.y - H / 2 - 30} x2={width} y2={t.y - H / 2 - 30}
                    stroke="var(--line)" strokeDasharray="2 6" opacity={0.5} />
              <text className="tierLabel" x={14} y={t.y - H / 2 - 36}>
                TIER {t.index} · {t.label} · {t.count}
              </text>
            </g>
          ))}

          {g.edges.map((e, i) => {
            const a = pos.get(e.from), b = pos.get(e.to)
            if (!a || !b) return null
            const x1 = a.x, y1 = a.y + H / 2, x2 = b.x, y2 = b.y - H / 2
            const my = (y1 + y2) / 2
            const d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
            const on = touches(e)
            return (
              <g key={i} opacity={sel !== null && !on ? 0.1 : 1}>
                <path d={d} fill="none" stroke={EDGE[e.kind]} strokeWidth={on ? 2.2 : 1.3}
                      strokeDasharray={DASHED[e.kind]}
                      markerEnd={`url(#ar-${e.kind})`} />
                {on && <circle r="3.5" fill={EDGE[e.kind]}>
                  <animateMotion dur="1.5s" repeatCount="indefinite" path={d} />
                </circle>}
                {e.label && on && (
                  <text className="elabel" x={(x1 + x2) / 2 + 8} y={my + 3} fill={EDGE[e.kind]}>
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}

          {nodes.map((n) => {
            const c = ROLE[n.role] ?? 'var(--sys)'
            const done = n.phase === 'Succeeded'
            // Stopped is a choice somebody made, not a fault. Drawing it in
            // the red of a failing probe would send people looking for a break
            // that is not there, so it gets its own muted treatment: dashed
            // outline, grey dot, and the word "stopped" where the ready
            // fraction goes.
            const bad = !n.ready && !done && !n.stopped
            const isSel = n.id === sel
            return (
              <g key={n.id} className="nodeBox"
                 transform={`translate(${n.x - W / 2},${n.y - H / 2})`}
                 onClick={() => clickNode(n)} opacity={sel && !isSel ? 0.5 : 1}>
                <rect width={W} height={H} rx="9"
                      fill={n.stopped ? 'var(--panel)' : 'var(--panel2)'}
                      stroke={isSel ? c : bad ? 'var(--bad)' : 'var(--line)'}
                      strokeDasharray={n.stopped && !isSel ? '5 4' : undefined}
                      strokeWidth={isSel ? 2.2 : 1} />
                <rect width="4" height={H} rx="2"
                      fill={bad ? 'var(--bad)' : done || n.stopped ? 'var(--sys)' : c}
                      opacity={n.stopped ? 0.6 : 1} />
                <text className="nkind" x="15" y="19" fill={c}>{n.kind.toUpperCase()}</text>
                <text className="nns" x={W - 26} y="19" textAnchor="end">{n.namespace}</text>
                <circle cx={W - 14} cy="15" r="4"
                        fill={bad ? 'var(--bad)' : done || n.stopped ? 'var(--sys)' : 'var(--ok)'} />
                <text className="nlabel" x="15" y="41"
                      opacity={n.stopped ? 0.65 : 1}>{trunc(n.name, 26)}</text>
                <text className="nimg" x="15" y="57">{trunc(subtitle(n), 30)}</text>
                <line x1="15" y1="66" x2={W - 15} y2="66" stroke="var(--line)" />
                <text className="nstat" x="15" y="80">{statLine(n)}</text>
                {n.restarts > 0 && (
                  <text className="nstat" x={W - 15} y="80" textAnchor="end" fill="var(--warn)">
                    ↻ {n.restarts}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      <div className="zoomctl">
        <button title="Zoom in" onClick={() => zoomAt(1.25)}>+</button>
        <button title="Zoom out" onClick={() => zoomAt(1 / 1.25)}>−</button>
        <button title="Fit to view" className="wide" onClick={fit}>fit</button>
        <button title="Reset to 100%" className="wide"
                onClick={() => setView({ k: 1, x: 24, y: 24 })}>1:1</button>
        <div className="zoomval">{Math.round(view.k * 100)}%</div>
      </div>
      <div className="panhint">drag to pan · scroll to zoom</div>
    </div>
  )
}

function subtitle(n: GNode): string {
  // A paired surface says so on the node itself, so it is visible without
  // opening the panel that "pos" is two deployments rather than one.
  if (n.kind === 'pod' && (n.moves?.length ?? 0) > 1) return `${n.workload} surface · ${n.image}`
  if (n.kind === 'pod') return n.image || '—'
  if (n.kind === 'service') return n.podIP || 'headless'
  return n.image || 'ingress'
}

function statLine(n: GNode): string {
  if (n.kind === 'pod') {
    if (n.stopped) return `stopped  ·  0 of ${n.desired || 1}`
    const parts = [n.phase === 'Succeeded' ? 'completed' : n.readyStr]
    if (n.cpu) parts.push(n.cpu)
    if (n.mem) parts.push(n.mem)
    if (n.age) parts.push(n.age)
    return parts.join('  ·  ')
  }
  if (n.kind === 'service') return n.ports?.length ? `port ${n.ports.join(', ')}` : 'no ports'
  return 'routes traffic in'
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
