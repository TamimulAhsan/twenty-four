import { useEffect, useState, useCallback, useMemo } from 'react'
import type { Graph, GNode } from './types'
import { Topology } from './Topology'
import { Legend } from './Legend'
import { Actions } from './Actions'

export default function App() {
  const [g, setG] = useState<Graph | null>(null)
  const [live, setLive] = useState(false)
  const [sel, setSel] = useState<GNode | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [showSystem, setShowSystem] = useState(false)
  const [legendOpen, setLegendOpen] = useState(true)

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (ev) => { setG(JSON.parse(ev.data)); setLive(true) }
    es.onerror = () => setLive(false)
    return () => es.close()
  }, [])

  const view = useMemo<Graph | null>(() => {
    if (!g) return null
    if (showSystem) return g
    const keep = new Set(g.nodes.filter((n) => n.namespace !== 'kube-system').map((n) => n.id))
    return {
      ...g,
      nodes: g.nodes.filter((n) => keep.has(n.id)),
      edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    }
  }, [g, showSystem])

  // Keep the open detail panel in sync, and drop the selection if that node is
  // no longer visible (deleted from the cluster, or filtered out).
  useEffect(() => {
    if (!sel) return
    const fresh = view?.nodes.find((n) => n.id === sel.id)
    if (!fresh) { setSel(null); setLogs(null); return }
    if (JSON.stringify(fresh) !== JSON.stringify(sel)) setSel(fresh)
  }, [view])

  const select = useCallback((n: GNode) => {
    setSel((cur) => (cur?.id === n.id ? null : n))
    setLogs(null)
  }, [])

  const fetchLogs = async () => {
    if (!sel) return
    setLogs('loading…')
    try {
      const r = await fetch(`/api/logs/${sel.namespace}/${sel.name}`)
      setLogs(await r.text())
    } catch (e) {
      setLogs(String(e))
    }
  }

  const s = g?.stats
  const allReady = s ? s.PodsReady === s.Pods : false
  const connected = view ? view.edges.filter((e) => e.kind === 'depends').length : 0

  return (
    <div className="app">
      <header className="hdr">
        <div className="brand">TwentyFour <span>/ cluster</span></div>
        <label className="toggle">
          <input type="checkbox" checked={showSystem}
                 onChange={(e) => setShowSystem(e.target.checked)} />
          show kube-system
        </label>
        <div className="live">
          <span className={`dot${live ? '' : ' off'}`} />
          {live ? 'LIVE' : 'RECONNECTING'}
          {g && <span className="ts">· updated {new Date(g.at).toLocaleTimeString()}</span>}
        </div>
      </header>

      <div className="tiles">
        <Tile k="Pods ready" v={s ? `${s.PodsReady}/${s.Pods}` : '—'}
              tone={allReady ? 'ok' : 'warn'}
              sub={
                !s ? 'connecting'
                  : allReady
                    ? s.Completed
                      ? `all passing probes · ${s.Completed} finished job${s.Completed === 1 ? '' : 's'} not counted`
                      : 'all containers passing probes'
                    : 'some not ready'
              } />
        <Tile k="Stopped" v={s?.Stopped ?? '—'}
              tone={(s?.Stopped ?? 0) > 0 ? 'warn' : 'ok'}
              sub={(s?.Stopped ?? 0) > 0
                ? 'scaled to zero on purpose'
                : 'nothing scaled to zero'} />
        <Tile k="Services" v={s?.Services ?? '—'} sub="stable cluster IPs" />
        <Tile k="Routes" v={s?.Ingresses ?? '—'} sub="Traefik host and path rules" />
        <Tile k="Dependencies" v={connected} sub="pod → service, from flags and env" />
        <Tile k="Restarts" v={s?.Restarts ?? '—'}
              tone={(s?.Restarts ?? 0) > 0 ? 'warn' : 'ok'} sub="since pod creation" />
        <Tile k="Problems" v={g?.problems.length ?? '—'}
              tone={(g?.problems.length ?? 0) > 0 ? 'bad' : 'ok'}
              sub={(g?.problems.length ?? 0) > 0 ? 'see panel' : 'nothing needs attention'} />
      </div>

      <div className="body">
        <div className="canvas">
          {view
            ? <Topology g={view} sel={sel?.id ?? null} onSelect={select}
                        onBackground={() => { setSel(null); setLogs(null) }} />
            : <div className="empty">connecting to cluster…</div>}
        </div>

        <aside className="side">
          {sel ? (
            <>
              <button className="back" onClick={() => setSel(null)}>← overview</button>
              <h3>{sel.name}</h3>
              <div className="ns">
                <span className="badge">{sel.kind}</span>
                <span className="badge dim">{sel.namespace}</span>
                <span className="badge dim">{sel.role}</span>
                {sel.domain && <span className="badge dim">{sel.domain}</span>}
                {sel.stopped && <span className="badge stop">stopped</span>}
              </div>
              {/* A pod whose surface has another half should say so here, not
                  only in the confirmation. Half of "pos" reading as all of it
                  is what made stopping the till leave its frontend serving. */}
              {sel.kind === 'pod' && (sel.moves?.length ?? 0) > 1 && (
                <p className="dimline surfaceline">
                  part of the <b>{sel.workload}</b> surface:
                  {' '}{sel.moves!.join(' + ')}
                </p>
              )}

              {/* What it is for comes first. Everything below it is detail
                  about a thing you have to already know the shape of. */}
              {sel.purpose && <p className="purpose">{sel.purpose}</p>}
              <p className="desc">{describe(sel)}</p>

              {sel.kind === 'pod' && sel.actions?.length
                ? <Actions node={sel} />
                : null}

              <dl className="kv">
                {/* A stopped workload has no pod, so it has no node, no IP and
                    no metrics. Those rows are omitted rather than printed as a
                    column of dashes that reads like a broken collector. */}
                {sel.kind === 'pod' && sel.stopped && <>
                  <dt>state</dt><dd>scaled to zero</dd>
                  <dt>deployment</dt><dd>{sel.deployment}</dd>
                  <dt>replicas</dt><dd>{sel.desired} wanted, 0 running</dd>
                  <dt>image</dt><dd>{sel.image || '—'}</dd>
                  <dt>declared since</dt><dd>{sel.age}</dd>
                  {sel.ports?.length ? <><dt>ports</dt><dd>{sel.ports.join(', ')}</dd></> : null}
                </>}
                {sel.kind === 'pod' && !sel.stopped && <>
                  <dt>phase</dt><dd>{sel.phase}</dd>
                  <dt>ready</dt><dd>{sel.readyStr}</dd>
                  <dt>restarts</dt><dd>{sel.restarts}</dd>
                  <dt>deployment</dt><dd>{sel.deployment}</dd>
                  <dt>image</dt><dd>{sel.image || '—'}</dd>
                  <dt>node</dt><dd>{sel.nodeName}</dd>
                  <dt>pod ip</dt><dd>{sel.podIP || '—'}</dd>
                  <dt>cpu</dt><dd>{sel.cpu || 'no metrics'}</dd>
                  <dt>memory</dt><dd>{sel.mem || 'no metrics'}</dd>
                  <dt>age</dt><dd>{sel.age}</dd>
                  {sel.ports?.length ? <><dt>ports</dt><dd>{sel.ports.join(', ')}</dd></> : null}
                </>}
                {sel.kind === 'service' && <>
                  <dt>cluster ip</dt><dd>{sel.podIP}</dd>
                  <dt>ports</dt><dd>{sel.ports?.join(', ') || '—'}</dd>
                  <dt>dns</dt><dd>{sel.name}.{sel.namespace}.svc.cluster.local</dd>
                </>}
                {sel.kind === 'ingress' && <>
                  <dt>host</dt><dd>{sel.image || '—'}</dd>
                  <dt>controller</dt><dd>traefik</dd>
                </>}
              </dl>

              {view && <Connections g={view} id={sel.id} onSelect={select} />}

              {sel.containers?.length ? <>
                <div className="sect">Containers</div>
                {sel.containers.map((c) => (
                  <div className="ctr" key={c.name}>
                    <div className="row">
                      <b>{c.name}</b>
                      <span className={`pill ${c.ready ? 'ok' : 'bad'}`}>
                        {c.ready ? 'ready' : c.state}
                      </span>
                    </div>
                    <div className="dimline">{c.image}</div>
                    {c.restarts > 0 &&
                      <div style={{ color: 'var(--warn)', marginTop: 3 }}>↻ {c.restarts} restarts</div>}
                  </div>
                ))}
              </> : null}

              {sel.kind === 'pod' && !sel.stopped && <>
                <button className="btn" onClick={fetchLogs}>fetch last 200 log lines</button>
                {logs && <pre className="logs">{logs}</pre>}
              </>}
            </>
          ) : (
            <>
              <div className="sect">Problems</div>
              {g?.problems.length
                ? <ul className="probs">{g.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                : <div className="allgood">
                    <div className="tick">✓</div>
                    Everything is healthy.
                    <span>No pod is failing a probe or stuck.</span>
                  </div>}
              <Legend open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} />
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/** Lists what a node talks to and what talks to it, both clickable. */
function Connections({ g, id, onSelect }: {
  g: Graph; id: string; onSelect: (n: GNode) => void
}) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const out = g.edges.filter((e) => e.from === id)
  const inc = g.edges.filter((e) => e.to === id)
  if (!out.length && !inc.length) return null
  const Row = ({ nid, kind, label, dir }: {
    nid: string; kind: string; label: string; dir: '→' | '←'
  }) => {
    const n = byId.get(nid)
    if (!n) return null
    return (
      <button className="conn" onClick={() => onSelect(n)}>
        <span className="arrow">{dir}</span>
        <span className="cname">{n.name}</span>
        <span className={`ckind k-${kind}`}>{label || kind}</span>
      </button>
    )
  }
  return (
    <>
      <div className="sect">Connections</div>
      {inc.map((e, i) => <Row key={'i' + i} nid={e.from} kind={e.kind} label={e.label} dir="←" />)}
      {out.map((e, i) => <Row key={'o' + i} nid={e.to} kind={e.kind} label={e.label} dir="→" />)}
    </>
  )
}

/** How this kind of thing works, as opposed to what this one is for. */
function describe(n: GNode): string {
  if (n.stopped)
    return `Deployed but scaled to zero, so it has no pod right now. Nothing was deleted: its manifest, its image and any volume are all still here, and start brings it back without a rebuild.`
  if (n.kind === 'ingress')
    return `A Traefik route. It matches a host and a path and hands the request to a Service.`
  if (n.kind === 'service')
    return `A stable cluster IP and DNS name. Traffic sent here is load-balanced across whichever pods currently match its selector.`
  if (n.role === 'datastore')
    return `A stateful workload with an attached volume, which outlives the pod. In production this is replaced by an operator-managed cluster.`
  if (n.role === 'system')
    return `Part of k3s itself, running in kube-system. Not something we deploy, and not something to act on from here.`
  if (n.role === 'frontend')
    return `An nginx pod serving one built bundle. Its own image and its own deployment, so it moves without touching the others.`
  return `A Go service we wrote. The dependencies below were read from the flags it was started with.`
}

function Tile({ k, v, sub, tone }: {
  k: string; v: string | number; sub?: string; tone?: 'ok' | 'warn' | 'bad'
}) {
  return (
    <div className="tile">
      <div className="k">{k}</div>
      <div className={`v${tone ? ' ' + tone : ''}`}>{v}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  )
}
