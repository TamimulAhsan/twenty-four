export type Kind = 'ingress' | 'service' | 'pod'
export type Role = 'edge' | 'service' | 'app' | 'frontend' | 'datastore' | 'system'

export interface Container {
  name: string; ready: boolean; restarts: number; image: string; state: string
}
export interface GNode {
  id: string; name: string; kind: Kind; namespace: string
  phase: string; ready: boolean; readyStr: string; restarts: number
  image: string; nodeName: string; podIP: string; age: string
  cpu: string; mem: string; role: Role
  containers: Container[] | null; ports: number[] | null
  /** Scaled to zero: a Deployment with no pod. Still drawn, so it can be started. */
  stopped: boolean
  desired: number
  /** The Deployment this node is. */
  deployment: string
  /**
   * The surface an action acts on, which is not always one Deployment: web-pos
   * and pos are both the "pos" surface, and an action on either moves both.
   */
  workload: string
  /** Every Deployment an action on this surface will move. */
  moves: string[] | null
  /** What it is for, in a sentence. Backend purposes come from inventory.tsv. */
  purpose: string
  domain: string
  /** What may be done to it. Empty means nothing here can act on it. */
  actions: string[] | null
}

export type ActionName = 'stop' | 'start' | 'restart' | 'rebuild'

export interface Job {
  id: string; workload: string; action: string
  state: 'running' | 'done' | 'failed'
  output: string; started: string
}
export interface GEdge {
  from: string; to: string; kind: 'routes' | 'selects' | 'depends'; label: string
}
export interface Stats {
  Pods: number; PodsReady: number; Services: number
  Ingresses: number; Restarts: number; Completed: number
  Stopped: number; Namespaces: number
}
export interface Graph {
  at: string; nodes: GNode[]; edges: GEdge[]; stats: Stats; problems: string[]
}
