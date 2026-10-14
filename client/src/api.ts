export type Level = 'on_track' | 'warning' | 'escalated' | 'critical'

export interface StageMeta {
  id: string
  label: string
  next: string[]
}

export interface Shipment {
  id: number
  reference: string
  material: string
  description: string
  serialNo: string
  valueEur: number
  origin: string
  repairCenter: string
  carrier: string
  stage: string
  stageEnteredAt: string
  createdAt: string
  deliveredAt: string | null
  daysInStage: number
  level: Level
  daysOverdue: number
  raisedForValue: boolean
}

export interface Escalation {
  id: number
  shipmentId: number
  reference: string
  description: string
  carrier: string
  level: 'escalated' | 'critical'
  status: 'open' | 'acknowledged' | 'resolved'
  stage: string
  valueEur: number
  owner: string | null
  note: string | null
  openedAt: string
  acknowledgedAt: string | null
  resolvedAt: string | null
  resolvedByMovement: boolean
}

export interface SlaRule {
  stage: string
  warnAfterDays: number
  escalateAfterDays: number
  criticalAfterDays: number
}

export interface Policy {
  rules: SlaRule[]
  highValueEur: number
}

interface Breakdown {
  name: string
  open: number
  pastSla: number
  valuePastSla: number
}

export interface Kpis {
  asOf: string
  open: { count: number; valueEur: number }
  byLevel: Record<Level, { count: number; valueEur: number }>
  releasedLast30DaysEur: number
  slaAdherenceLast90Days: number | null
  avgTurnaroundDays: number | null
  byCarrier: Breakdown[]
  byRepairCenter: Breakdown[]
}

export interface ShipmentDetail {
  shipment: Shipment
  events: { stage: string; enteredAt: string; leftAt: string | null; note: string | null }[]
  escalations: Escalation[]
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status}).`)
  return body as T
}

const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  meta: () => call<{ stages: StageMeta[] }>('/meta'),
  kpis: () => call<Kpis>('/kpis'),
  shipments: () => call<Shipment[]>('/shipments'),
  shipment: (id: number) => call<ShipmentDetail>(`/shipments/${id}`),
  advance: (id: number, to: string, note?: string) => post<{ releasedEur: number }>(`/shipments/${id}/advance`, { to, note }),
  escalations: () => call<Escalation[]>('/escalations'),
  scan: () => post<{ opened: number; raised: number }>('/escalations/scan'),
  acknowledge: (id: number, owner: string, note?: string) => post(`/escalations/${id}/acknowledge`, { owner, note }),
  resolve: (id: number, note: string) => post(`/escalations/${id}/resolve`, { note }),
  policy: () => call<Policy>('/sla'),
  savePolicy: (policy: Policy) => call<Policy>('/sla', { method: 'PUT', body: JSON.stringify(policy) }),
}

export const eur = (n: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)

/** €1.15M style, for sentences. */
export const eurShort = (n: number) =>
  n >= 1_000_000
    ? `€${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
    : n >= 10_000
      ? `€${Math.round(n / 1000)}k`
      : eur(n)

export const days = (n: number) => (n < 1 ? "<1 d" : `${Math.floor(n)} d`)

export const LEVEL_LABEL: Record<Level, string> = {
  on_track: 'On track',
  warning: 'Warning',
  escalated: 'Escalated',
  critical: 'Critical',
}

export function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
