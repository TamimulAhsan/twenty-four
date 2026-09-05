import { useEffect, useState, useCallback, useMemo } from 'react'
import type { Graph, GNode } from './types'
import { Topology } from './Topology'
import { Legend } from './Legend'

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
              sub={allReady ? 'all containers passing probes' : 'some not ready'} />
        <Tile k="Services" v={s?.Services ?? '—'} sub="stable cluster IPs" />
        <Tile k="Ingresses" v={s?.Ingresses ?? '—'} sub="host routes via Traefik" />
        <Tile k="Dependencies" v={connected} sub="pod → service, from env" />
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
              </div>
              <p className="desc">{describe(sel)}</p>

              <dl className="kv">
                {sel.kind === 'pod' && <>
                  <dt>phase</dt><dd>{sel.phase}</dd>
                  <dt>ready</dt><dd>{sel.readyStr}</dd>
                  <dt>restarts</dt><dd>{sel.restarts}</dd>
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

              {sel.kind === 'pod' && <>
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

function describe(n: GNode): string {
  if (n.kind === 'ingress')
    return `Traefik routes requests for this host into the cluster and hands them to a Service.`
  if (n.kind === 'service')
    return `A stable cluster IP and DNS name. Traffic sent here is load-balanced across whichever pods currently match its selector.`
  if (n.role === 'datastore')
    return `A stateful workload with an attached volume. In production this is replaced by an operator-managed cluster — see graph.html §17.`
  if (n.role === 'system')
    return `Part of k3s itself, running in kube-system. Not something we deploy.`
  return `One of our Go services. Its dependencies below were read from its own environment variables.`
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
