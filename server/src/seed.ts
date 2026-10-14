import type pg from 'pg'
import { withTransaction } from './db.js'
import type { SlaPolicy, SlaRule } from './domain/sla.js'
import type { Stage } from './domain/stages.js'
import { runEscalationScan, savePolicy } from './repo.js'

export const DEFAULT_RULES: SlaRule[] = [
  { stage: 'awaiting_pickup', warnAfterDays: 3, escalateAfterDays: 6, criticalAfterDays: 12 },
  { stage: 'in_transit_to_repair', warnAfterDays: 10, escalateAfterDays: 16, criticalAfterDays: 25 },
  { stage: 'customs', warnAfterDays: 5, escalateAfterDays: 9, criticalAfterDays: 15 },
  { stage: 'awaiting_repair', warnAfterDays: 7, escalateAfterDays: 14, criticalAfterDays: 28 },
  { stage: 'in_repair', warnAfterDays: 21, escalateAfterDays: 35, criticalAfterDays: 50 },
  { stage: 'return_transit', warnAfterDays: 10, escalateAfterDays: 16, criticalAfterDays: 25 },
]

export const DEFAULT_POLICY: SlaPolicy = { rules: DEFAULT_RULES, highValueEur: 100_000 }

/** Small deterministic PRNG so the demo looks the same on every machine. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Synthetic master data. Company and carrier names are invented.
const UNITS = [
  { material: 'TL-4410', description: 'MWD pulser assembly', value: 48_000 },
  { material: 'TL-4425', description: 'Directional sensor module', value: 62_000 },
  { material: 'TL-5102', description: 'Mud motor power section', value: 35_000 },
  { material: 'TL-3307', description: 'Telemetry battery pack', value: 4_200 },
  { material: 'TL-6001', description: 'Rotary steerable control unit', value: 184_000 },
  { material: 'TL-4471', description: 'Gamma ray sub', value: 27_500 },
  { material: 'TL-4490', description: 'Resistivity tool collar', value: 96_000 },
  { material: 'TL-3315', description: 'Downhole memory module', value: 8_500 },
]
const ORIGINS = ['Aberdeen', 'Stavanger', 'Port Harcourt', 'Ahmadi', 'Perth', 'Macaé', 'Midland', 'Calgary']
const REPAIR_CENTERS = ['Celle', 'Houston', 'Singapore', 'Dubai']
const CARRIERS = ['Northline Freight', 'Meridian Logistics', 'Atlas Forwarding', 'Kestrel Air Cargo', 'Harbourline']

const DAY = 86_400_000

export async function seedDemo(pool: pg.Pool, now: Date, count = 260): Promise<void> {
  const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM shipments`)
  if (existing.rows[0].n > 0) return

  await savePolicy(pool, DEFAULT_POLICY)
  const rand = mulberry32(20_251_014)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
  const rule = new Map(DEFAULT_RULES.map((r) => [r.stage, r]))
  // Carriers differ in reliability, so the breakdown by carrier tells a story.
  const carrierStuckRate: Record<string, number> = {
    'Northline Freight': 0.06,
    'Meridian Logistics': 0.1,
    'Atlas Forwarding': 0.22,
    'Kestrel Air Cargo': 0.05,
    Harbourline: 0.14,
  }

  await withTransaction(pool, async (client) => {
    for (let i = 0; i < count; i++) {
      const unit = pick(UNITS)
      const carrier = pick(CARRIERS)
      const origin = pick(ORIGINS)
      const repairCenter = pick(REPAIR_CENTERS)
      const needsCustoms = !['Celle', 'Houston'].includes(repairCenter) || rand() < 0.4
      const delivered = rand() < 0.38
      const targetStages: Stage[] = [
        'awaiting_pickup',
        'in_transit_to_repair',
        ...(needsCustoms ? (['customs'] as Stage[]) : []),
        'awaiting_repair',
        'in_repair',
        'return_transit',
        'delivered',
      ]
      const finalIndex = delivered ? targetStages.length - 1 : Math.floor(rand() * (targetStages.length - 1))

      // Duration of each completed stage; occasionally a stage got stuck.
      const durations: number[] = []
      for (let s = 0; s < finalIndex; s++) {
        const r = rule.get(targetStages[s])!
        const stuck = rand() < carrierStuckRate[carrier] * 0.6
        durations.push(stuck ? r.escalateAfterDays * (1 + rand() * 0.6) : r.warnAfterDays * (0.25 + rand() * 0.7))
      }
      // Time already spent in the current stage.
      const current = targetStages[finalIndex]
      let currentDays: number
      if (current === 'delivered') {
        currentDays = rand() * 85
      } else {
        const r = rule.get(current)!
        const stuck = rand() < carrierStuckRate[carrier] * 1.3
        // Skewed so most breaches are recent warnings and only a few are long overdue.
        currentDays = stuck ? r.warnAfterDays * (1 + Math.pow(rand(), 1.7) * 3) : r.warnAfterDays * rand() * 0.95
      }

      const total = durations.reduce((a, d) => a + d, 0) + currentDays
      const createdAt = new Date(now.getTime() - total * DAY)
      let cursor = createdAt.getTime()
      const value = Math.round(unit.value * (0.9 + rand() * 0.2))

      const stageEnteredAt = new Date(now.getTime() - currentDays * DAY)
      const ins = await client.query<{ id: number }>(
        `INSERT INTO shipments (reference, material, description, serial_no, value_eur, origin, repair_center, carrier,
                                stage, stage_entered_at, created_at, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          `RL-${String(240_000 + i * 37).padStart(7, '0')}`,
          unit.material,
          unit.description,
          `SN${Math.floor(100_000 + rand() * 899_999)}`,
          value,
          origin,
          repairCenter,
          carrier,
          current,
          stageEnteredAt,
          createdAt,
          current === 'delivered' ? stageEnteredAt : null,
        ],
      )
      const id = ins.rows[0].id

      for (let s = 0; s < finalIndex; s++) {
        const enteredAt = new Date(cursor)
        cursor += durations[s] * DAY
        const leftAt = new Date(cursor)
        await client.query(
          `INSERT INTO stage_events (shipment_id, stage, entered_at, left_at) VALUES ($1, $2, $3, $4)`,
          [id, targetStages[s], enteredAt, leftAt],
        )
        // Past breaches leave a resolved escalation behind: the history behind "capital released".
        const r = rule.get(targetStages[s])!
        if (durations[s] >= r.escalateAfterDays) {
          await client.query(
            `INSERT INTO escalations (shipment_id, level, status, stage, value_eur, owner, opened_at, acknowledged_at,
                                      resolved_at, resolved_by_movement, note)
             VALUES ($1, 'escalated', 'resolved', $2, $3, $4, $5, $6, $7, TRUE, $8)`,
            [
              id,
              targetStages[s],
              value,
              pick(['J. Becker', 'A. Okafor', 'M. Lindqvist', 'S. Rahman']),
              new Date(enteredAt.getTime() + r.escalateAfterDays * DAY),
              new Date(enteredAt.getTime() + (r.escalateAfterDays + 0.5) * DAY),
              leftAt,
              `Chased ${carrier}; moved on to ${targetStages[s + 1].replaceAll('_', ' ')}.`,
            ],
          )
        }
      }
      await client.query(`INSERT INTO stage_events (shipment_id, stage, entered_at) VALUES ($1, $2, $3)`, [
        id,
        current,
        stageEnteredAt,
      ])
    }
  })

  await runEscalationScan(pool, now)

  // The scan stamps escalations with "now"; date them to when each shipment actually breached,
  // and show a few already picked up by someone.
  await pool.query(
    `UPDATE escalations e
     SET opened_at = s.stage_entered_at + make_interval(
           secs => 86400 * CASE WHEN s.value_eur >= $1 THEN r.warn_after_days ELSE r.escalate_after_days END)
     FROM shipments s JOIN sla_rules r ON r.stage = s.stage
     WHERE e.shipment_id = s.id AND e.status = 'open'`,
    [DEFAULT_POLICY.highValueEur],
  )
  await pool.query(
    `UPDATE escalations SET status = 'acknowledged', owner = 'M. Lindqvist',
            acknowledged_at = opened_at + INTERVAL '6 hours', note = 'Chasing carrier for a new ETA.'
     WHERE status = 'open' AND id % 3 = 0`,
  )
}
