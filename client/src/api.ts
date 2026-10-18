export type Stage =
  | 'pending_at_sender'
  | 'transit_to_hub'
  | 'gr_to_work_order'
  | 'in_repair'
  | 'awaiting_outbound'
  | 'transit_from_hub'

export interface StageMeta {
  id: Stage
  label: string
  short: string
  groupBy: 'sendingCountry' | 'inboundLane' | 'hub' | 'outboundLane'
}

export interface Limits {
  n: number
  mean: number
  mrBar: number
  ucl: number
  lcl: number
}

export interface LiveUnit {
  id: number
  serialNo: string
  techId: string
  material: string
  valueEur: number
  sendingCountry: string
  sendingLocation: string
  hubCountry: string
  hubLocation: string
  returnCountry: string
  dates: Record<string, string | null>
  stage: Stage
  group: string
  daysInStage: number
  limit: Limits | null
  limitScope: 'group' | 'stage' | null
  beyondLimit: boolean
  daysOverLimit: number
}

interface Sum {
  units: number
  valueEur: number
}

export interface CountryBar {
  country: string
  units: number
  avgDays: number
  valueEur: number
}

export interface Overview {
  asOf: string
  totals: {
    open: Sum
    pending: Sum
    inTransit: Sum
    atHub: Sum
    beyondLimit: Sum
    releasedLast90DaysEur: number
  }
  byStage: (Sum & { stage: Stage; beyondLimit: number })[]
  pendingByCountry: CountryBar[]
  inTransitByCountry: CountryBar[]
  stagnantTrend: { weekEnding: string; open: number; stagnant: number; stagnantValueEur: number }[]
}

export interface Lane {
  lane: string
  units: number
  techIds: number
  avgDays: Record<Stage, number | null>
  totalDays: number
}

export interface ChartGroup {
  group: string
  limits: Limits | null
  scope: 'group' | 'stage' | null
  points: { id: number; serialNo: string; end: string; days: number; signals: string[] }[]
}

export interface Escalation {
  id: number
  repairOrderId: number
  serialNo: string
  techId: string
  material: string
  stage: Stage
  groupKey: string
  daysAtOpen: number
  limitDays: number
  valueEur: number
  status: 'open' | 'acknowledged' | 'resolved'
  owner: string | null
  regionOwner: string | null
  note: string | null
  openedAt: string
}

export interface UnitDetail {
  order: Omit<LiveUnit, 'stage' | 'group' | 'daysInStage' | 'limit' | 'limitScope' | 'beyondLimit' | 'daysOverLimit'>
  live: LiveUnit | null
  stages: { stage: Stage; group: string; days: number | null; done: boolean; ucl: number | null; mean: number | null }[]
  escalations: Escalation[]
  history: {
    serial: { id: number; startedAt: string | null; returnedAt: string | null; totalDays: number | null; longestStage: Stage | null; longestDays: number | null }[]
    tech: {
      techId: string
      loops: number
      techAvgTotalDays: number | null
      othersAvgTotalDays: number | null
      stages: { stage: Stage; techAvgDays: number | null; othersAvgDays: number | null; ratio: number | null; stalls: boolean }[]
    }
  }
}

export interface ImportReport {
  rowsRead: number
  valid: number
  inserted: number
  skipped: number
  dryRun: boolean
  issues: { row: number; serialNo: string; problem: string }[]
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
  meta: () => call<{ stages: StageMeta[]; importColumns: string[] }>('/meta'),
  overview: () => call<Overview>('/overview'),
  units: () => call<LiveUnit[]>('/units'),
  unit: (id: number) => call<UnitDetail>(`/units/${id}`),
  advance: (id: number, at?: string, note?: string) =>
    post<{ completedStage: Stage; releasedEur: number }>(`/units/${id}/advance`, { at, note }),
  lanes: () => call<Lane[]>('/lanes'),
  chart: (stage: Stage) => call<ChartGroup[]>(`/control-chart/${stage}`),
  escalations: () => call<Escalation[]>('/escalations'),
  scan: () => post<{ opened: number; beyondLimit: number }>('/escalations/scan'),
  acknowledge: (id: number, owner: string, note?: string) => post(`/escalations/${id}/acknowledge`, { owner, note }),
  resolve: (id: number, note: string) => post(`/escalations/${id}/resolve`, { note }),
  importCsv: (csv: string, dryRun: boolean) =>
    call<ImportReport>(`/import?dryRun=${dryRun}`, { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } }),
}

export const eur = (n: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)

export const eurShort = (n: number) =>
  n >= 1_000_000
    ? `€${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `€${Math.round(n / 1000)}k`
      : eur(n)

export const days = (n: number) => (n < 1 ? '<1 d' : `${Math.round(n)} d`)

export function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** One colour per stage, in loop order: cool on the way in, warm at the hub, cool on the way back. */
export const STAGE_COLOURS: Record<Stage, string> = {
  pending_at_sender: '#2B5C8A',
  transit_to_hub: '#5B8DB8',
  gr_to_work_order: '#C7922B',
  in_repair: '#8C5A2B',
  awaiting_outbound: '#D3B35A',
  transit_from_hub: '#7FA9A0',
}
