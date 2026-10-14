/**
 * Lifecycle of a repairable unit: it fails in the field, travels to a repair
 * centre, gets repaired, and travels back. Each stage has its own SLA.
 */
export const STAGES = [
  'awaiting_pickup',
  'in_transit_to_repair',
  'customs',
  'awaiting_repair',
  'in_repair',
  'return_transit',
  'delivered',
] as const

export type Stage = (typeof STAGES)[number]

export const OPEN_STAGES = STAGES.filter((s) => s !== 'delivered')

export const STAGE_LABELS: Record<Stage, string> = {
  awaiting_pickup: 'Awaiting pickup',
  in_transit_to_repair: 'In transit to repair',
  customs: 'In customs',
  awaiting_repair: 'Awaiting repair',
  in_repair: 'In repair',
  return_transit: 'Return transit',
  delivered: 'Delivered',
}

/** The stage a shipment normally moves to next. Customs is optional. */
export function nextStages(stage: Stage): Stage[] {
  switch (stage) {
    case 'awaiting_pickup':
      return ['in_transit_to_repair']
    case 'in_transit_to_repair':
      return ['customs', 'awaiting_repair']
    case 'customs':
      return ['awaiting_repair']
    case 'awaiting_repair':
      return ['in_repair']
    case 'in_repair':
      return ['return_transit']
    case 'return_transit':
      return ['delivered']
    case 'delivered':
      return []
  }
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}
