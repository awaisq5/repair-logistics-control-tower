import type { Stage } from './stages.js'

export type Level = 'on_track' | 'warning' | 'escalated' | 'critical'

export const LEVELS: Level[] = ['on_track', 'warning', 'escalated', 'critical']

/** Days a shipment may sit in one stage before each level applies. */
export interface SlaRule {
  stage: Stage
  warnAfterDays: number
  escalateAfterDays: number
  criticalAfterDays: number
}

export interface SlaPolicy {
  rules: SlaRule[]
  /** Shipments at or above this value move up one level once they breach. */
  highValueEur: number
}

export interface ShipmentLike {
  stage: Stage
  stageEnteredAt: Date
  valueEur: number
}

export interface Evaluation {
  daysInStage: number
  level: Level
  /** Days past the warning threshold; 0 when on track. */
  daysOverdue: number
  /** True when the high-value rule raised the level. */
  raisedForValue: boolean
}

const DAY_MS = 86_400_000

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / DAY_MS)
}

export function validateRule(rule: SlaRule): string | null {
  const { warnAfterDays: w, escalateAfterDays: e, criticalAfterDays: c } = rule
  if ([w, e, c].some((n) => !Number.isFinite(n) || n <= 0)) return 'Thresholds must be positive numbers of days.'
  if (!(w < e && e < c)) return 'Thresholds must increase: warning, then escalation, then critical.'
  return null
}

/**
 * Classifies one shipment against the SLA for the stage it is in.
 * Delivered shipments and stages without a rule are always on track.
 */
export function evaluate(shipment: ShipmentLike, policy: SlaPolicy, now: Date): Evaluation {
  const daysInStage = daysBetween(shipment.stageEnteredAt, now)
  const rule = policy.rules.find((r) => r.stage === shipment.stage)
  if (!rule || shipment.stage === 'delivered') {
    return { daysInStage, level: 'on_track', daysOverdue: 0, raisedForValue: false }
  }

  let index = 0
  if (daysInStage >= rule.criticalAfterDays) index = 3
  else if (daysInStage >= rule.escalateAfterDays) index = 2
  else if (daysInStage >= rule.warnAfterDays) index = 1

  let raisedForValue = false
  if (index > 0 && index < 3 && shipment.valueEur >= policy.highValueEur) {
    index += 1
    raisedForValue = true
  }

  return {
    daysInStage,
    level: LEVELS[index],
    daysOverdue: Math.max(0, daysInStage - rule.warnAfterDays),
    raisedForValue,
  }
}

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level)
}

export const AGING_BUCKETS = [
  { label: '0–7 days', max: 7 },
  { label: '8–14 days', max: 14 },
  { label: '15–30 days', max: 30 },
  { label: 'Over 30 days', max: Infinity },
] as const

export function agingBucket(daysInStage: number): string {
  return AGING_BUCKETS.find((b) => daysInStage < b.max + 1)!.label
}
