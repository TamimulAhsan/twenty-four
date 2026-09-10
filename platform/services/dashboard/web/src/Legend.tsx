const NODES = [
  ['var(--ingress)', 'Route', 'A Traefik entry point: one hostname and path, pointing at one Service. Two hosts appear here, and they are two planes: app.twentyfour is the merchant applications, admin.twentyfour is the admin console. They never share a session.'],
  ['var(--svc)', 'Service', 'Stable cluster IP and DNS name in front of a set of pods.'],
  ['var(--app)', 'Service pod', 'A Go binary we wrote. Gateways, domain services, the outbox relay.'],
  ['var(--fe)', 'Frontend pod', 'nginx serving one built bundle. One per application, each its own image and deployment, plus the fallback page every route lands on when its application is down.'],
  ['var(--data)', 'Datastore pod', 'Postgres, Redis, Kafka, ClickHouse and MinIO. StatefulSets with attached volumes, so their data outlives the pod.'],
  ['var(--sys)', 'System pod', 'kube-system: CoreDNS, Traefik, metrics-server, local-path.'],
] as const

const EDGES = [
  ['routes', 'var(--ingress)', 'solid', 'Route → Service',
   'Read from Traefik’s IngressRoute objects, which is what every route here is written as. The label is the matched path.'],
  ['selects', '#4a5570', 'dashed', 'Service → Pod',
   'Read from EndpointSlices — the pods actually behind that Service right now.'],
  ['depends', 'var(--app)', 'solid', 'Pod → Service',
   'A synchronous call. Read from the flags a container was started with, and from its environment: any value shaped like host:port that resolves to a Service becomes an arrow. Every service here is told where its neighbours are with -auth=host:port, so this is the real wiring rather than a diagram of it.'],
  ['stores', 'var(--data)', 'solid', 'Pod → Datastore',
   'Where a workload keeps its own state. Many arrows into one Postgres box is not a shared database: each is a separate database inside one server, the label names it, and no service holds a credential for any but its own. A service that wants another\u2019s data calls it or consumes its events. Read from the secrets a pod mounts, because the DSN is a reference and its value is nowhere in the manifest.'],
  ['publishes', 'var(--bus)', 'dashed', 'Pod → Relay → Kafka',
   'An event on its way out. A service writes it to its own outbox in the same transaction as the change that caused it, and the relay drains that table later, which is why the arrow points at the relay and not at Kafka: nothing writes to Kafka except the relay. That is what makes a broker outage a backlog rather than an outage.'],
  ['consumes', 'var(--bus)', 'dashed', 'Kafka → Pod',
   'An event on its way in, labelled with what that consumer asked for. It is the one arrow here pointing at something that initiated nothing: the consumer pulls, and the service that announced the event does not know it exists. Read from the source, because nothing in the cluster declares it.'],
  ['replicates', 'var(--cdc)', 'dashed', 'Postgres → Connect → ClickHouse',
   'Change data capture: a database’s changes copied into the reporting store with no service involved at either end. This is the only wiring here that a Deployment does not declare — a Connect worker starts knowing nothing but its broker address, and what it captures is a connector definition in a ConfigMap. Drawn in the direction the rows move, not the direction the connection is opened, so ClickHouse reads as the end of a pipeline rather than a dependency of it.'],
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
          <p className="lp">
            Most of this is read from the cluster. The two bus edges are not: nothing in a
            Deployment says which topics a service publishes or consumes, so those are scanned out
            of the source at startup. A service whose topics are computed rather than written down
            shows none, which is wrong in the direction of saying less rather than of inventing an
            arrow.
          </p>
          <p className="lp">
            Reading the shape: a <b>command</b> goes down the call edges to the one service that
            owns that record, which writes its own database in a transaction. A <b>fact</b> comes
            back out along the bus edges, and whoever wants to react to it does. Writes never
            travel over the bus, which is why Kafka being down is a backlog rather than an outage:
            sales still commit, and the events wait in an outbox.
          </p>

          <div className="lsect">Nodes</div>
          {NODES.map(([c, name, desc]) => (
            <div className="litem" key={name}>
              <i className="sw" style={{ background: c }} />
              <div><b>{name}</b><span>{desc}</span></div>
            </div>
          ))}

          <div className="lsect">Edges — derived, never drawn by hand</div>
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
