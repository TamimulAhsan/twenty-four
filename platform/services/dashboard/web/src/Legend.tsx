const NODES = [
  ['var(--ingress)', 'Ingress', 'Traefik entry point. Maps a hostname and path to a Service.'],
  ['var(--svc)', 'Service', 'Stable cluster IP and DNS name in front of a set of pods.'],
  ['var(--app)', 'App pod', 'A service we wrote. Runs the Go binaries.'],
  ['var(--data)', 'Datastore pod', 'Postgres, Redis, Kafka. StatefulSets with attached volumes.'],
  ['var(--sys)', 'System pod', 'kube-system: CoreDNS, Traefik, metrics-server, local-path.'],
] as const

const EDGES = [
  ['routes', 'var(--ingress)', 'solid', 'Ingress → Service',
   'Read from the Ingress rules. The label is the matched path.'],
  ['selects', '#4a5570', 'dashed', 'Service → Pod',
   'Read from EndpointSlices — the pods actually behind that Service right now.'],
  ['depends', 'var(--app)', 'solid', 'Pod → Service',
   'Parsed from the container’s own env vars: any value shaped like host:port that resolves to a Service becomes an arrow.'],
] as const

export function Legend({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className={`legendPanel${open ? ' open' : ''}`}>
      <button className="legendHead" onClick={onToggle}>
        <span>How to read this</span><span className="chev">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="legendBody">
          <p className="lp">
            Rows are <b>tiers</b>, computed as the longest path from an entry point — a node sits
            one row below the deepest thing that points at it. Everything flows downward, so the
            request path reads top to bottom.
          </p>

          <div className="lsect">Nodes</div>
          {NODES.map(([c, name, desc]) => (
            <div className="litem" key={name}>
              <i className="sw" style={{ background: c }} />
              <div><b>{name}</b><span>{desc}</span></div>
            </div>
          ))}

          <div className="lsect">Edges — all derived from the live cluster</div>
          {EDGES.map(([kind, c, style, what, how]) => (
            <div className="litem" key={kind}>
              <svg width="26" height="12" className="swline">
                <line x1="1" y1="6" x2="25" y2="6" stroke={c} strokeWidth="1.8"
                      strokeDasharray={style === 'dashed' ? '4 3' : undefined} />
              </svg>
              <div>
                <b style={{ color: c }}>{kind}</b>
                <span><i>{what}</i> — {how}</span>
              </div>
            </div>
          ))}

          <div className="lsect">Indicators</div>
          <div className="litem"><i className="sw round" style={{ background: 'var(--ok)' }} />
            <div><b>Green dot</b><span>All containers ready.</span></div></div>
          <div className="litem"><i className="sw round" style={{ background: 'var(--bad)' }} />
            <div><b>Red dot / border</b><span>Not ready — needs attention.</span></div></div>
          <div className="litem"><i className="sw round" style={{ background: 'var(--sys)' }} />
            <div><b>Grey dot</b><span>Completed Job. 0/1 ready is normal here.</span></div></div>
          <div className="litem"><span className="swtxt" style={{ color: 'var(--warn)' }}>↻</span>
            <div><b>Restart badge</b><span>Container restarts since creation. A reboot shows here.</span></div></div>

          <p className="lp dim">
            Click any node to isolate its connections and see detail. Data refreshes every 2s over
            SSE; the collector is read-only and only ever runs <code>kubectl get</code>.
          </p>
        </div>
      )}
    </div>
  )
}
