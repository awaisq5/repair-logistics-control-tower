import type pg from 'pg'
import { withTransaction, type Db } from './db.js'
import { pastLoops, techHistory } from './domain/history.js'
import type { ImportedUnit } from './domain/importer.js'
import { controlLimits, limitsFor, type ControlLimits, type LimitsSet } from './domain/spc.js'
import {
  DATE_FIELDS,
  STAGE_BY_ID,
  STAGE_INFO,
  currentStage,
  daysBetween,
  groupKey,
  stageDays,
  type DateField,
  type Stage,
} from './domain/stages.js'

export interface RepairOrder {
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
  dates: Record<DateField, Date | null>
}

/** An open unit as the dashboard sees it: where it is, for how long, and against which limit. */
export interface LiveUnit extends RepairOrder {
  stage: Stage
  group: string
  daysInStage: number
  limit: ControlLimits | null
  limitScope: 'group' | 'stage' | null
  beyondLimit: boolean
  daysOverLimit: number
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
  openedAt: Date
  acknowledgedAt: Date | null
  resolvedAt: Date | null
  resolvedByMovement: boolean
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

const DATE_SQL: Record<DateField, string> = {
  readyAt: 'ready_at',
  dispatchedAt: 'dispatched_at',
  hubReceivedAt: 'hub_received_at',
  workOrderAt: 'work_order_at',
  repairedAt: 'repaired_at',
  hubDispatchedAt: 'hub_dispatched_at',
  returnedAt: 'returned_at',
}

const ORDER_COLUMNS = `
  id, serial_no, tech_id, material, value_eur, sending_country, sending_location,
  hub_country, hub_location, return_country, ${Object.values(DATE_SQL).join(', ')}`

type OrderRow = Record<string, unknown>

function toOrder(r: OrderRow): RepairOrder {
  const dates = {} as Record<DateField, Date | null>
  for (const f of DATE_FIELDS) dates[f] = (r[DATE_SQL[f]] as Date | null) ?? null
  return {
    id: r.id as number,
    serialNo: r.serial_no as string,
    techId: r.tech_id as string,
    material: r.material as string,
    valueEur: r.value_eur as number,
    sendingCountry: r.sending_country as string,
    sendingLocation: r.sending_location as string,
    hubCountry: r.hub_country as string,
    hubLocation: r.hub_location as string,
    returnCountry: r.return_country as string,
    dates,
  }
}

export async function listOrders(db: Db, opts: { open?: boolean } = {}): Promise<RepairOrder[]> {
  const where = opts.open === undefined ? '' : opts.open ? 'WHERE returned_at IS NULL' : 'WHERE returned_at IS NOT NULL'
  const res = await db.query(`SELECT ${ORDER_COLUMNS} FROM repair_orders ${where} ORDER BY ready_at`)
  return res.rows.map(toOrder)
}

/**
 * Control limits for every stage and group, from completed stages that ended
 * within the history window. Values are ordered by end date, as on an I-chart.
 */
export async function computeLimits(db: Db, now: Date, historyDays = 365): Promise<LimitsSet> {
  const since = new Date(now.getTime() - historyDays * 86_400_000)
  const orders = await listOrders(db)
  const byGroup: Record<string, Record<string, { end: number; days: number }[]>> = {}
  const byStage: Record<string, { end: number; days: number }[]> = {}
  for (const o of orders) {
    const days = stageDays(o.dates)
    for (const s of STAGE_INFO) {
      const d = days[s.id]
      const end = o.dates[s.end]
      if (d === undefined || !end || end < since || end > now) continue
      const key = groupKey(s.id, o)
      ;((byGroup[s.id] ??= {})[key] ??= []).push({ end: end.getTime(), days: d })
      ;(byStage[s.id] ??= []).push({ end: end.getTime(), days: d })
    }
  }
  const limits = (points: { end: number; days: number }[]) =>
    controlLimits(points.sort((a, b) => a.end - b.end).map((p) => p.days))
  const set: LimitsSet = { byGroup: {}, byStage: {} }
  for (const [stage, groups] of Object.entries(byGroup)) {
    set.byGroup[stage] = {}
    for (const [key, pts] of Object.entries(groups)) {
      const l = limits(pts)
      if (l) set.byGroup[stage][key] = l
    }
  }
  for (const [stage, pts] of Object.entries(byStage)) {
    const l = limits(pts)
    if (l) set.byStage[stage] = l
  }
  return set
}

export function toLive(order: RepairOrder, limits: LimitsSet, now: Date): LiveUnit | null {
  const stage = currentStage(order.dates)
  if (!stage) return null
  const start = order.dates[STAGE_BY_ID[stage].start]
  if (!start) return null
  const group = groupKey(stage, order)
  const found = limitsFor(limits, stage, group)
  const daysInStage = Math.max(0, daysBetween(start, now))
  const ucl = found?.limits.ucl ?? Infinity
  return {
    ...order,
    stage,
    group,
    daysInStage,
    limit: found?.limits ?? null,
    limitScope: found?.scope ?? null,
    beyondLimit: daysInStage > ucl,
    daysOverLimit: Math.max(0, daysInStage - ucl),
  }
}

export async function liveUnits(db: Db, now: Date, limits?: LimitsSet): Promise<LiveUnit[]> {
  const set = limits ?? (await computeLimits(db, now))
  return (await listOrders(db, { open: true }))
    .map((o) => toLive(o, set, now))
    .filter((u): u is LiveUnit => u !== null)
}

export async function getOrder(db: Db, id: number, now: Date) {
  const res = await db.query(`SELECT ${ORDER_COLUMNS} FROM repair_orders WHERE id = $1`, [id])
  if (!res.rowCount) throw new NotFoundError(`Repair order ${id} does not exist.`)
  const order = toOrder(res.rows[0])
  const limits = await computeLimits(db, now)
  const days = stageDays(order.dates, now)
  const stages = STAGE_INFO.map((s) => {
    const group = groupKey(s.id, order)
    const found = limitsFor(limits, s.id, group)
    return {
      stage: s.id,
      group,
      days: days[s.id] ?? null,
      done: Boolean(order.dates[s.end]),
      ucl: found?.limits.ucl ?? null,
      mean: found?.limits.mean ?? null,
    }
  })
  const escalations = await db.query(
    `SELECT ${ESC_COLUMNS} FROM escalations e JOIN repair_orders r ON r.id = e.repair_order_id
     ${REGION_JOIN}
     WHERE e.repair_order_id = $1 ORDER BY e.opened_at DESC`,
    [id],
  )
  const done = await listOrders(db, { open: false })
  const history = { serial: pastLoops(order.serialNo, order.id, done), tech: techHistory(order.techId, done) }
  return { order, live: toLive(order, limits, now), stages, escalations: escalations.rows, history }
}

/**
 * Records the next movement date. Closing a stage resolves the unit's active
 * escalation and counts its value as working capital moving again.
 */
export async function advanceOrder(pool: pg.Pool, id: number, at: Date, note: string | undefined) {
  return withTransaction(pool, async (client) => {
    const res = await client.query(`SELECT ${ORDER_COLUMNS} FROM repair_orders WHERE id = $1 FOR UPDATE`, [id])
    if (!res.rowCount) throw new NotFoundError(`Repair order ${id} does not exist.`)
    const order = toOrder(res.rows[0])
    const stage = currentStage(order.dates)
    if (!stage) throw new ConflictError(`Unit ${order.serialNo} is already back at its destination.`)
    const info = STAGE_BY_ID[stage]
    const start = order.dates[info.start]
    if (start && at < start) throw new ConflictError(`The date cannot be before the stage started.`)
    await client.query(`UPDATE repair_orders SET ${DATE_SQL[info.end]} = $2 WHERE id = $1`, [id, at])
    const resolved = await client.query(
      `UPDATE escalations SET status = 'resolved', resolved_at = $2, resolved_by_movement = TRUE,
              note = COALESCE(note || E'\\n', '') || $3
       WHERE repair_order_id = $1 AND status <> 'resolved' RETURNING value_eur`,
      [id, at, note ? `Moved on: ${note}` : `Moved on to the next stage.`],
    )
    return { completedStage: stage, releasedEur: (resolved.rows[0]?.value_eur as number) ?? 0 }
  })
}

/** The regional logistics owner responsible for where the unit is stuck. */
const REGION_JOIN = `LEFT JOIN region_contacts c ON c.country = CASE
       WHEN e.stage IN ('pending_at_sender', 'transit_to_hub') THEN r.sending_country
       WHEN e.stage = 'transit_from_hub' THEN r.return_country
       ELSE r.hub_country END`

const ESC_COLUMNS = `
  e.id, e.repair_order_id AS "repairOrderId", r.serial_no AS "serialNo", r.tech_id AS "techId",
  r.material, e.stage, e.group_key AS "groupKey", e.days_at_open AS "daysAtOpen", e.limit_days AS "limitDays",
  e.value_eur AS "valueEur", e.status, e.owner, c.owner AS "regionOwner", e.note, e.opened_at AS "openedAt",
  e.acknowledged_at AS "acknowledgedAt", e.resolved_at AS "resolvedAt", e.resolved_by_movement AS "resolvedByMovement"`

export async function listEscalations(db: Db, status: 'active' | 'resolved'): Promise<Escalation[]> {
  const where = status === 'active' ? `e.status <> 'resolved'` : `e.status = 'resolved'`
  const order = status === 'active' ? `e.value_eur DESC` : `e.resolved_at DESC LIMIT 50`
  const res = await db.query<Escalation>(
    `SELECT ${ESC_COLUMNS} FROM escalations e JOIN repair_orders r ON r.id = e.repair_order_id
     ${REGION_JOIN}
     WHERE ${where} ORDER BY ${order}`,
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
  if (!res.rowCount) await assertState(db, id, 'open')
}

export async function resolveEscalation(db: Db, id: number, note: string, now: Date) {
  const res = await db.query(
    `UPDATE escalations SET status = 'resolved', resolved_at = $2, note = COALESCE(note || E'\\n', '') || $3
     WHERE id = $1 AND status <> 'resolved' RETURNING id`,
    [id, now, note],
  )
  if (!res.rowCount) await assertState(db, id, 'active')
}

async function assertState(db: Db, id: number, expected: string): Promise<never> {
  const res = await db.query(`SELECT status FROM escalations WHERE id = $1`, [id])
  if (!res.rowCount) throw new NotFoundError(`Escalation ${id} does not exist.`)
  throw new ConflictError(`Escalation ${id} is ${res.rows[0].status}, not ${expected}.`)
}

/**
 * Opens one escalation for every open unit beyond its control limit.
 * Safe to run repeatedly: the partial unique index allows only one active
 * escalation per unit, and existing ones are left alone.
 */
export async function runEscalationScan(pool: pg.Pool, now: Date) {
  const units = (await liveUnits(pool, now)).filter((u) => u.beyondLimit && u.limit)
  let opened = 0
  await withTransaction(pool, async (client) => {
    for (const u of units) {
      const res = await client.query(
        `INSERT INTO escalations (repair_order_id, stage, group_key, days_at_open, limit_days, value_eur, opened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (repair_order_id) WHERE status <> 'resolved' DO NOTHING`,
        [u.id, u.stage, u.group, u.daysInStage, u.limit!.ucl, u.valueEur, now],
      )
      opened += res.rowCount ?? 0
    }
  })
  return { opened, beyondLimit: units.length }
}

export async function insertUnits(pool: pg.Pool, units: ImportedUnit[]) {
  return withTransaction(pool, async (client) => {
    let inserted = 0
    let skipped = 0
    for (const u of units) {
      const res = await client.query(
        `INSERT INTO repair_orders (serial_no, tech_id, material, value_eur, sending_country, sending_location,
           hub_country, hub_location, return_country, ${Object.values(DATE_SQL).join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (serial_no) WHERE returned_at IS NULL DO NOTHING`,
        [
          u.serialNo,
          u.techId,
          u.material,
          u.valueEur,
          u.sendingCountry,
          u.sendingLocation,
          u.hubCountry,
          u.hubLocation,
          u.returnCountry,
          ...DATE_FIELDS.map((f) => u.dates[f]),
        ],
      )
      if (res.rowCount) inserted++
      else skipped++
    }
    return { inserted, skipped }
  })
}

export async function setRegionContacts(db: Db, contacts: Record<string, string>) {
  for (const [country, owner] of Object.entries(contacts)) {
    await db.query(
      `INSERT INTO region_contacts (country, owner) VALUES ($1, $2) ON CONFLICT (country) DO UPDATE SET owner = $2`,
      [country, owner],
    )
  }
}
