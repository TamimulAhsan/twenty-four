import { useEffect, useRef, useState } from 'react'
import type { ActionName, GNode, Job } from './types'

/**
 * Starting, stopping and rebuilding the workload a pod belongs to.
 *
 * The heading says "workload" and names the Deployment on purpose. Stopping a
 * pod does nothing you would want: the ReplicaSet makes another one, and the
 * button looks broken. What these do is scale the Deployment, which is what
 * anyone reaching for "stop" actually meant.
 *
 * Rebuild is the slow one: it builds an image from source before rolling it
 * out, so every action runs as a job with a log rather than a request that
 * spins. The log is the same output the terminal would have shown, because it
 * is the same script.
 */
const EXPLAIN: Record<ActionName, string> = {
  stop: 'Scales the deployment to zero. Its routes then serve the unavailable page. Nothing is deleted and no data is lost.',
  start: 'Scales it back to one and waits for the rollout. Reuses the image already in the registry.',
  restart: 'Stop, then start. Picks up a config change without rebuilding.',
  rebuild: 'Stop, build the image from source, then start. This is the slow one: a Go service takes a minute or two, a frontend rather longer.',
}

const DESTRUCTIVE: ActionName[] = ['stop', 'rebuild']

export function Actions({ node }: { node: GNode }) {
  const [job, setJob] = useState<Job | null>(null)
  const [asking, setAsking] = useState<ActionName | null>(null)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  // Polled rather than streamed: a job is one at a time and lasts minutes, so
  // a second of latency costs nothing and this needs no second SSE channel.
  useEffect(() => {
    if (!job || job.state !== 'running') return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/actions/${job.id}`)
        if (r.ok) setJob(await r.json())
      } catch {
        // The monitor is on localhost. A failed poll is a blip; the next one
        // will pick the job back up, and the state is held server-side.
      }
    }, 1000)
    return () => clearInterval(t)
  }, [job])

  // Escape cancels. A confirm you can only dismiss by finding a small button is
  // a confirm people learn to click through, which is the opposite of the point.
  useEffect(() => {
    if (!asking) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAsking(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asking])

  // Changing pod closes anything half-open, so a confirm can never be answered
  // for a workload other than the one it was raised for.
  useEffect(() => {
    setAsking(null)
    setError(null)
  }, [node.workload])

  // Follow the tail while it is running, so the interesting line is on screen.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [job?.output])

  const run = async (action: ActionName) => {
    setAsking(null)
    setError(null)
    try {
      const r = await fetch(`/api/actions/${node.workload}/${action}`, { method: 'POST' })
      if (!r.ok) {
        setError((await r.text()).trim())
        return
      }
      setJob(await r.json())
    } catch (e) {
      setError(String(e))
    }
  }

  const busy = job?.state === 'running'
  const moves = node.moves?.length ? node.moves : [node.workload]

  return (
    <>
      <div className="sect">
        Actions · <span className="wl">{node.workload}</span>
      </div>
      <p className="dimline actnote">
        {moves.length > 1
          ? `A surface, not a pod: ${node.workload} is a frontend and the API behind it, and these move both. Half a ${node.workload} is not a useful thing to run.`
          : 'These act on the deployment, not on this one pod. Stopping a pod alone would just make another one.'}
      </p>

      <div className="acts">
        {(node.actions ?? []).map((a) => {
          const action = a as ActionName
          return (
            <button
              key={a}
              className={`act${DESTRUCTIVE.includes(action) ? ' danger' : ''}`}
              disabled={busy}
              title={EXPLAIN[action]}
              onClick={() => setAsking(action)}
            >
              {a}
            </button>
          )
        })}
      </div>

      {asking && (
        <div className="confirm">
          <b>{asking} {node.workload}?</b>
          <p>{EXPLAIN[asking]}</p>
          {/* Named, not summarised. "stop pos" moving two deployments is the
              thing a person needs to know before pressing it, not after. */}
          <p className="moves">
            {moves.length > 1 ? 'moves both halves: ' : 'moves: '}
            {moves.map((m) => <code key={m}>{m}</code>)}
          </p>
          <div className="confirmRow">
            <button className={`act${DESTRUCTIVE.includes(asking) ? ' danger' : ''}`}
                    onClick={() => run(asking)}>
              yes, {asking}
            </button>
            <button className="act ghost" onClick={() => setAsking(null)}>cancel</button>
            <span className="dimline esc">or press Escape</span>
          </div>
        </div>
      )}

      {error && <p className="actErr">{error}</p>}

      {job && (
        <>
          <div className="jobline">
            <span className={`pill ${job.state === 'done' ? 'ok' : job.state === 'failed' ? 'bad' : ''}`}>
              {job.state}
            </span>
            <span className="dimline">{job.action} {job.workload}</span>
          </div>
          <pre className="logs" ref={logRef}>{job.output || 'starting…'}</pre>
        </>
      )}
    </>
  )
}
