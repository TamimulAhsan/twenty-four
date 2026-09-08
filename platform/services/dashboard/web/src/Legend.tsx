const NODES = [
  ['var(--ingress)', 'Route', 'A Traefik entry point: one hostname and path, pointing at one Service. Two hosts appear here, and they are two planes: app.twentyfour is the merchant applications, admin.twentyfour is the admin console. They never share a session.'],
  ['var(--svc)', 'Service', 'Stable cluster IP and DNS name in front of a set of pods.'],
  ['var(--app)', 'Service pod', 'A Go binary we wrote. Gateways, domain services, the outbox relay.'],
  ['var(--fe)', 'Frontend pod', 'nginx serving one built bundle. Five of them, one per application, each its own image and deployment.'],
  ['var(--data)', 'Datastore pod', 'Postgres, Redis, Kafka. StatefulSets with attached volumes.'],
  ['var(--sys)', 'System pod', 'kube-system: CoreDNS, Traefik, metrics-server, local-path.'],
] as const

const EDGES = [
  ['routes', 'var(--ingress)', 'solid', 'Route → Service',
   'Read from Traefik’s IngressRoute objects, which is what every route here is written as. The label is the matched path.'],
  ['selects', '#4a5570', 'dashed', 'Service → Pod',
   'Read from EndpointSlices — the pods actually behind that Service right now.'],
  ['depends', 'var(--app)', 'solid', 'Pod → Service',
   'Read from the flags a container was started with, and from its environment: any value shaped like host:port that resolves to a Service becomes an arrow. Every service here is told where its neighbours are with -auth=host:port, so this is the real wiring rather than a diagram of it.'],
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
