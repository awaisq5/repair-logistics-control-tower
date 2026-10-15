/**
 * The repair & return (R&R) loop of a serialized tool, as six measured stages.
 *
 * Each stage starts at one movement date and ends at the next, so a unit's
 * history is fully described by seven dates. This mirrors how the data comes
 * out of an ERP: a removal/ready date, shipment dispatch, goods receipt at the
 * hub, work order opening, repair completion, outbound dispatch, and receipt
 * back at the customer location.
 */
export const DATE_FIELDS = [
  'readyAt', // unit is ready to ship at the sending location
  'dispatchedAt', // shipped towards the repair hub
  'hubReceivedAt', // goods receipt (GR) at the repair hub
  'workOrderAt', // work order (WO) opened
  'repairedAt', // repair finished
  'hubDispatchedAt', // shipped out of the repair hub
  'returnedAt', // received back at the destination
] as const

export type DateField = (typeof DATE_FIELDS)[number]

export const STAGES = [
  'pending_at_sender',
  'transit_to_hub',
  'gr_to_work_order',
  'in_repair',
  'awaiting_outbound',
  'transit_from_hub',
] as const

export type Stage = (typeof STAGES)[number]

export interface StageInfo {
  id: Stage
  label: string
  short: string
  start: DateField
  end: DateField
  /** What the control limits are grouped by: where the delay usually comes from. */
  groupBy: 'sendingCountry' | 'inboundLane' | 'hub' | 'outboundLane'
}

export const STAGE_INFO: readonly StageInfo[] = [
  {
    id: 'pending_at_sender',
    label: 'Waiting to ship at sending location',
    short: 'Pending at sender',
    start: 'readyAt',
    end: 'dispatchedAt',
    groupBy: 'sendingCountry',
  },
  {
    id: 'transit_to_hub',
    label: 'In transit to repair hub',
    short: 'Transit to hub',
    start: 'dispatchedAt',
    end: 'hubReceivedAt',
    groupBy: 'inboundLane',
  },
  {
    id: 'gr_to_work_order',
    label: 'Goods receipt to work order opening',
    short: 'GR to WO',
    start: 'hubReceivedAt',
    end: 'workOrderAt',
    groupBy: 'hub',
  },
  {
    id: 'in_repair',
    label: 'In repair',
    short: 'In repair',
    start: 'workOrderAt',
    end: 'repairedAt',
    groupBy: 'hub',
  },
  {
    id: 'awaiting_outbound',
    label: 'Waiting to ship out of repair hub',
    short: 'Awaiting outbound',
    start: 'repairedAt',
    end: 'hubDispatchedAt',
    groupBy: 'hub',
  },
  {
    id: 'transit_from_hub',
    label: 'In transit back from repair hub',
    short: 'Transit back',
    start: 'hubDispatchedAt',
    end: 'returnedAt',
    groupBy: 'outboundLane',
  },
]

export const STAGE_BY_ID = Object.fromEntries(STAGE_INFO.map((s) => [s.id, s])) as Record<Stage, StageInfo>

export type MovementDates = Partial<Record<DateField, Date | null>>

export interface UnitRoute {
  sendingCountry: string
  hubCountry: string
  returnCountry: string
}

/** The stage a unit is in now: the first stage whose end date is missing. Null when returned. */
export function currentStage(dates: MovementDates): Stage | null {
  for (const s of STAGE_INFO) {
    if (!dates[s.end]) return s.id
  }
  return null
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}

/** Key used to group a stage's durations for control limits, e.g. "Egypt → UAE" for transit to hub. */
export function groupKey(stage: Stage, route: UnitRoute): string {
  switch (STAGE_BY_ID[stage].groupBy) {
    case 'sendingCountry':
      return route.sendingCountry
    case 'inboundLane':
      return `${route.sendingCountry} → ${route.hubCountry}`
    case 'hub':
      return route.hubCountry
    case 'outboundLane':
      return `${route.hubCountry} → ${route.returnCountry}`
  }
}

const DAY_MS = 86_400_000

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS
}

/** Days spent in each stage. Completed stages only, unless `now` is given for the open one. */
export function stageDays(dates: MovementDates, now?: Date): Partial<Record<Stage, number>> {
  const out: Partial<Record<Stage, number>> = {}
  for (const s of STAGE_INFO) {
    const start = dates[s.start]
    if (!start) break
    const end = dates[s.end] ?? now
    if (!end) break
    out[s.id] = Math.max(0, daysBetween(start, end))
    if (!dates[s.end]) break
  }
  return out
}
