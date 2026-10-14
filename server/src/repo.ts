import type pg from 'pg'
import { withTransaction, type Db } from './db.js'
import { evaluate, levelRank, type Evaluation, type Level, type SlaPolicy, type SlaRule } from './domain/sla.js'
import { nextStages, type Stage } from './domain/stages.js'

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
  stage: Stage
  stageEnteredAt: Date
  createdAt: Date
  deliveredAt: Date | null
}

export interface Escalation {
  id: number
  shipmentId: number
  reference: string
  description: string
  carrier: string
  level: 'escalated' | 'critical'
  status: 'open' | 'acknowledged' | 'resolved'
  stage: Stage
  valueEur: number
  owner: string | null
  note: string | null
  openedAt: Date
  acknowledgedAt: Date | null
  resolvedAt: Date | null
  resolvedByMovement: boolean
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

const SHIPMENT_COLUMNS = `
  id, reference, material, description, serial_no AS "serialNo", value_eur AS "valueEur",
  origin, repair_center AS "repairCenter", carrier, stage, stage_entered_at AS "stageEnteredAt",
  created_at AS "createdAt", delivered_at AS "deliveredAt"`

const ESCALATION_COLUMNS = `
  e.id, e.shipment_id AS "shipmentId", s.reference, s.description, s.carrier, e.level, e.status, e.stage,
  e.value_eur AS "valueEur", e.owner, e.note, e.opened_at AS "openedAt",
  e.acknowledged_at AS "acknowledgedAt", e.resolved_at AS "resolvedAt",
  e.resolved_by_movement AS "resolvedByMovement"`

export async function getPolicy(db: Db): Promise<SlaPolicy> {
  const rules = await db.query<SlaRule>(`
    SELECT stage, warn_after_days AS "warnAfterDays", escalate_after_days AS "escalateAfterDays",
           critical_after_days AS "criticalAfterDays"
    FROM sla_rules ORDER BY stage`)
  const setting = await db.query<{ value: number }>(`SELECT value FROM settings WHERE key = 'high_value_eur'`)
  return { rules: rules.rows, highValueEur: setting.rows[0]?.value ?? 100_000 }
}

export async function savePolicy(pool: pg.Pool, policy: SlaPolicy): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const r of policy.rules) {
      await client.query(
        `INSERT INTO sla_rules (stage, warn_after_days, escalate_after_days, critical_after_days)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (stage) DO UPDATE SET warn_after_days = $2, escalate_after_days = $3, critical_after_days = $4`,
        [r.stage, r.warnAfterDays, r.escalateAfterDays, r.criticalAfterDays],
      )
    }
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('high_value_eur', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(policy.highValueEur)],
    )
  })
}

export async function listShipments(db: Db, opts: { openOnly?: boolean } = {}): Promise<Shipment[]> {
  const where = opts.openOnly ? `WHERE stage <> 'delivered'` : ''
  const res = await db.query<Shipment>(`SELECT ${SHIPMENT_COLUMNS} FROM shipments ${where} ORDER BY stage_entered_at`)
  return res.rows
}

export async function getShipment(db: Db, id: number) {
  const res = await db.query<Shipment>(`SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1`, [id])
  const shipment = res.rows[0]
  if (!shipment) throw new NotFoundError(`Shipment ${id} does not exist.`)
  const events = await db.query(
    `SELECT stage, entered_at AS "enteredAt", left_at AS "leftAt", note
     FROM stage_events WHERE shipment_id = $1 ORDER BY entered_at`,
    [id],
  )
  const escalations = await db.query<Escalation>(
    `SELECT ${ESCALATION_COLUMNS} FROM escalations e JOIN shipments s ON s.id = e.shipment_id
     WHERE e.shipment_id = $1 ORDER BY e.opened_at DESC`,
    [id],
  )
  return { shipment, events: events.rows, escalations: escalations.rows }
}

/**
 * Moves a shipment to its next stage. Closing the old stage also resolves any
 * active escalation, and records the shipment value as working capital released.
 */
export async function advanceShipment(pool: pg.Pool, id: number, to: Stage, note: string | undefined, now: Date) {
  return withTransaction(pool, async (client) => {
    const res = await client.query<Shipment>(`SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1 FOR UPDATE`, [id])
    const shipment = res.rows[0]
    if (!shipment) throw new NotFoundError(`Shipment ${id} does not exist.`)
    if (!nextStages(shipment.stage).includes(to)) {
      throw new ConflictError(`A shipment in "${shipment.stage}" cannot move to "${to}".`)
    }
    await client.query(`UPDATE stage_events SET left_at = $2 WHERE shipment_id = $1 AND left_at IS NULL`, [id, now])
    await client.query(`INSERT INTO stage_events (shipment_id, stage, entered_at, note) VALUES ($1, $2, $3, $4)`, [
      id,
      to,
      now,
      note ?? null,
    ])
    await client.query(
      `UPDATE shipments SET stage = $2, stage_entered_at = $3, delivered_at = CASE WHEN $2 = 'delivered' THEN $3 ELSE delivered_at END
       WHERE id = $1`,
      [id, to, now],
    )
    const resolved = await client.query(
      `UPDATE escalations SET status = 'resolved', resolved_at = $2, resolved_by_movement = TRUE,
              note = COALESCE(note || E'\\n', '') || $3
       WHERE shipment_id = $1 AND status <> 'resolved' RETURNING value_eur`,
      [id, now, `Resolved automatically: moved to ${to}.`],
    )
    return { releasedEur: resolved.rows[0]?.value_eur ?? 0 }
  })
}

export async function listEscalations(db: Db, status: 'active' | 'resolved'): Promise<Escalation[]> {
  const where = status === 'active' ? `e.status <> 'resolved'` : `e.status = 'resolved'`
  const order =
    status === 'active'
      ? `CASE e.level WHEN 'critical' THEN 0 ELSE 1 END, e.value_eur DESC`
      : `e.resolved_at DESC LIMIT 50`
  const res = await db.query<Escalation>(
    `SELECT ${ESCALATION_COLUMNS} FROM escalations e JOIN shipments s ON s.id = e.shipment_id WHERE ${where} ORDER BY ${order}`,
  )
  return res.rows
}

export async function acknowledgeEscalation(db: Db, id: number, owner: string, note: string | undefined, now: Date) {
  const res = await db.query(
    `UPDATE escalations SET status = 'acknowledged', owner = $2, acknowledged_at = $3,
            note = CASE WHEN $4::text IS NULL THEN note ELSE COALESCE(note || E'\\n', '') || $4 END
     WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, owner, now, note ?? null],
  )
  if (!res.rowCount) await assertExists(db, id, 'open')
}

export async function resolveEscalation(db: Db, id: number, note: string, now: Date) {
  const res = await db.query(
    `UPDATE escalations SET status = 'resolved', resolved_at = $2, note = COALESCE(note || E'\\n', '') || $3
     WHERE id = $1 AND status <> 'resolved' RETURNING id`,
    [id, now, note],
  )
  if (!res.rowCount) await assertExists(db, id, 'active')
}

async function assertExists(db: Db, id: number, expected: string): Promise<never> {
  const res = await db.query(`SELECT status FROM escalations WHERE id = $1`, [id])
  if (!res.rowCount) throw new NotFoundError(`Escalation ${id} does not exist.`)
  throw new ConflictError(`Escalation ${id} is ${res.rows[0].status}, not ${expected}.`)
}

/**
 * Opens an escalation for every shipment at "escalated" or "critical",
 * and raises the level of active escalations whose shipment got worse.
 * Safe to run repeatedly: it never creates a second active escalation.
 */
export async function runEscalationScan(pool: pg.Pool, now: Date) {
  const policy = await getPolicy(pool)
  const shipments = await listShipments(pool, { openOnly: true })
  let opened = 0
  let raised = 0
  await withTransaction(pool, async (client) => {
    const active = await client.query<{ shipment_id: number; level: Level; id: number }>(
      `SELECT id, shipment_id, level FROM escalations WHERE status <> 'resolved'`,
    )
    const byShipment = new Map(active.rows.map((r) => [r.shipment_id, r]))
    for (const s of shipments) {
      const { level } = evaluate(s, policy, now)
      if (levelRank(level) < levelRank('escalated')) continue
      const existing = byShipment.get(s.id)
      if (!existing) {
        await client.query(
          `INSERT INTO escalations (shipment_id, level, stage, value_eur, opened_at) VALUES ($1, $2, $3, $4, $5)`,
          [s.id, level, s.stage, s.valueEur, now],
        )
        opened++
      } else if (levelRank(level) > levelRank(existing.level)) {
        // Getting worse re-opens an acknowledged escalation so someone looks again.
        await client.query(`UPDATE escalations SET level = $2, status = 'open' WHERE id = $1`, [existing.id, level])
        raised++
      }
    }
  })
  return { opened, raised }
}

export function withEvaluation(shipments: Shipment[], policy: SlaPolicy, now: Date): (Shipment & Evaluation)[] {
  return shipments.map((s) => ({ ...s, ...evaluate(s, policy, now) }))
}
