export type Kind = 'ingress' | 'service' | 'pod'
export type Role = 'edge' | 'service' | 'app' | 'datastore' | 'system'

export interface Container {
  name: string; ready: boolean; restarts: number; image: string; state: string
}
export interface GNode {
  id: string; name: string; kind: Kind; namespace: string
  phase: string; ready: boolean; readyStr: string; restarts: number
  image: string; nodeName: string; podIP: string; age: string
  cpu: string; mem: string; role: Role
  containers: Container[] | null; ports: number[] | null
}
export interface GEdge {
  from: string; to: string; kind: 'routes' | 'selects' | 'depends'; label: string
}
export interface Stats {
  Pods: number; PodsReady: number; Services: number
  Ingresses: number; Restarts: number; Namespaces: number
}
export interface Graph {
  at: string; nodes: GNode[]; edges: GEdge[]; stats: Stats; problems: string[]
}
