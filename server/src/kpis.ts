import type { Db } from './db.js'
import { AGING_BUCKETS, agingBucket, levelRank, type Level, type SlaPolicy } from './domain/sla.js'
import { OPEN_STAGES, type Stage } from './domain/stages.js'
import { listShipments, withEvaluation } from './repo.js'

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
  aging: { stage: Stage; buckets: Record<string, number> }[]
  byCarrier: Breakdown[]
  byRepairCenter: Breakdown[]
}

export async function computeKpis(db: Db, policy: SlaPolicy, now: Date): Promise<Kpis> {
  const open = withEvaluation(await listShipments(db, { openOnly: true }), policy, now)

  const byLevel = {
    on_track: { count: 0, valueEur: 0 },
    warning: { count: 0, valueEur: 0 },
    escalated: { count: 0, valueEur: 0 },
    critical: { count: 0, valueEur: 0 },
  }
  for (const s of open) {
    byLevel[s.level].count++
    byLevel[s.level].valueEur += s.valueEur
  }

  const aging = OPEN_STAGES.map((stage) => {
    const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b.label, 0]))
    for (const s of open) if (s.stage === stage) buckets[agingBucket(s.daysInStage)]++
    return { stage, buckets }
  })

  const breakdown = (key: 'carrier' | 'repairCenter'): Breakdown[] => {
    const map = new Map<string, Breakdown>()
    for (const s of open) {
      const name = s[key]
      const row = map.get(name) ?? { name, open: 0, pastSla: 0, valuePastSla: 0 }
      row.open++
      if (levelRank(s.level) > 0) {
        row.pastSla++
        row.valuePastSla += s.valueEur
      }
      map.set(name, row)
    }
    return [...map.values()].sort((a, b) => b.valuePastSla - a.valuePastSla)
  }

  const released = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(value_eur), 0)::float AS total FROM escalations
     WHERE resolved_by_movement AND resolved_at >= $1::timestamptz - INTERVAL '30 days' AND resolved_at <= $1`,
    [now],
  )

  // Share of stage moves in the last 90 days that finished before the warning threshold.
  const moves = await db.query<{ stage: Stage; days: number }>(
    `SELECT stage, EXTRACT(EPOCH FROM (left_at - entered_at)) / 86400 AS days FROM stage_events
     WHERE left_at IS NOT NULL AND left_at >= $1::timestamptz - INTERVAL '90 days' AND left_at <= $1`,
    [now],
  )
  const warn = new Map(policy.rules.map((r) => [r.stage, r.warnAfterDays]))
  const scored = moves.rows.filter((m) => warn.has(m.stage))
  const within = scored.filter((m) => Number(m.days) < warn.get(m.stage)!).length

  const turnaround = await db.query<{ avg: number | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400)::float AS avg FROM shipments
     WHERE delivered_at >= $1::timestamptz - INTERVAL '90 days' AND delivered_at <= $1`,
    [now],
  )

  return {
    asOf: now.toISOString(),
    open: { count: open.length, valueEur: open.reduce((a, s) => a + s.valueEur, 0) },
    byLevel,
    releasedLast30DaysEur: released.rows[0].total,
    slaAdherenceLast90Days: scored.length ? within / scored.length : null,
    avgTurnaroundDays: turnaround.rows[0].avg,
    aging,
    byCarrier: breakdown('carrier'),
    byRepairCenter: breakdown('repairCenter'),
  }
}
