import type { Db } from './db.js'
import { evaluateChart, limitsFor, type LimitsSet } from './domain/spc.js'
import { STAGE_BY_ID, STAGE_INFO, currentStage, daysBetween, groupKey, stageDays, type Stage } from './domain/stages.js'
import { computeLimits, listOrders, toLive, type LiveUnit, type RepairOrder } from './repo.js'

const IN_TRANSIT: Stage[] = ['transit_to_hub', 'transit_from_hub']
const AT_HUB: Stage[] = ['gr_to_work_order', 'in_repair', 'awaiting_outbound']

interface CountryBar {
  country: string
  units: number
  avgDays: number
  valueEur: number
}

function byCountry(units: LiveUnit[], key: (u: LiveUnit) => string): CountryBar[] {
  const map = new Map<string, { units: number; days: number; value: number }>()
  for (const u of units) {
    const k = key(u)
    const row = map.get(k) ?? { units: 0, days: 0, value: 0 }
    row.units++
    row.days += u.daysInStage
    row.value += u.valueEur
    map.set(k, row)
  }
  return [...map.entries()]
    .map(([country, r]) => ({ country, units: r.units, avgDays: r.days / r.units, valueEur: r.value }))
    .sort((a, b) => b.avgDays - a.avgDays)
}

export async function overview(db: Db, now: Date) {
  const limits = await computeLimits(db, now)
  const orders = await listOrders(db)
  const live = orders.map((o) => toLive(o, limits, now)).filter((u): u is LiveUnit => u !== null)
  const sum = (units: LiveUnit[]) => ({ units: units.length, valueEur: units.reduce((a, u) => a + u.valueEur, 0) })

  const pending = live.filter((u) => u.stage === 'pending_at_sender')
  const inTransit = live.filter((u) => IN_TRANSIT.includes(u.stage))
  const atHub = live.filter((u) => AT_HUB.includes(u.stage))
  const beyond = live.filter((u) => u.beyondLimit)

  const released = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(value_eur), 0)::float AS total FROM escalations
     WHERE resolved_by_movement AND resolved_at > $1::timestamptz - INTERVAL '90 days' AND resolved_at <= $1`,
    [now],
  )

  return {
    asOf: now.toISOString(),
    totals: {
      open: sum(live),
      pending: sum(pending),
      inTransit: sum(inTransit),
      atHub: sum(atHub),
      beyondLimit: sum(beyond),
      releasedLast90DaysEur: released.rows[0].total,
    },
    byStage: STAGE_INFO.map((s) => {
      const units = live.filter((u) => u.stage === s.id)
      return { stage: s.id, ...sum(units), beyondLimit: units.filter((u) => u.beyondLimit).length }
    }),
    pendingByCountry: byCountry(pending, (u) => u.sendingCountry),
    inTransitByCountry: byCountry(
      live.filter((u) => u.stage === 'transit_to_hub'),
      (u) => u.sendingCountry,
    ),
    stagnantTrend: stagnantTrend(orders, limits, now),
  }
}

/**
 * Average days per stage for each inbound lane (sending country → repair hub),
 * from completed stages in the history window. The stacked view shows where on
 * a lane the time goes: in the sending country, on the road, or at the hub.
 */
export async function laneBreakdown(db: Db, now: Date, historyDays = 365) {
  const since = new Date(now.getTime() - historyDays * 86_400_000)
  const lanes = new Map<string, { sums: Partial<Record<Stage, number>>; counts: Partial<Record<Stage, number>>; techIds: Set<string>; serials: Set<string> }>()
  for (const o of await listOrders(db)) {
    if (o.dates.readyAt! < since) continue
    const key = `${o.sendingCountry} → ${o.hubCountry}`
    const lane = lanes.get(key) ?? { sums: {}, counts: {}, techIds: new Set(), serials: new Set() }
    lane.techIds.add(o.techId)
    lane.serials.add(o.serialNo)
    for (const [stage, d] of Object.entries(stageDays(o.dates)) as [Stage, number][]) {
      lane.sums[stage] = (lane.sums[stage] ?? 0) + d
      lane.counts[stage] = (lane.counts[stage] ?? 0) + 1
    }
    lanes.set(key, lane)
  }
  return [...lanes.entries()]
    .map(([lane, l]) => {
      const avg = Object.fromEntries(
        STAGE_INFO.map((s) => [s.id, l.counts[s.id] ? l.sums[s.id]! / l.counts[s.id]! : null]),
      ) as Record<Stage, number | null>
      return {
        lane,
        units: l.serials.size,
        techIds: l.techIds.size,
        avgDays: avg,
        totalDays: STAGE_INFO.reduce((a, s) => a + (avg[s.id] ?? 0), 0),
      }
    })
    .filter((l) => l.units >= 3)
    .sort((a, b) => b.totalDays - a.totalDays)
}

/**
 * I-chart data for one stage: completed durations ordered by completion date,
 * split into the stage's groups (countries, lanes or hubs), each with its own
 * limits, like a Minitab I-chart "by stages".
 */
export async function controlChart(db: Db, stage: Stage, now: Date, historyDays = 365) {
  const since = new Date(now.getTime() - historyDays * 86_400_000)
  const limits = await computeLimits(db, now, historyDays)
  const info = STAGE_BY_ID[stage]
  const groups = new Map<string, { end: Date; days: number; serialNo: string; id: number }[]>()
  for (const o of await listOrders(db)) {
    const days = stageDays(o.dates)[stage]
    const end = o.dates[info.end]
    if (days === undefined || !end || end < since || end > now) continue
    const key = groupKey(stage, o)
    const list = groups.get(key) ?? []
    list.push({ end, days, serialNo: o.serialNo, id: o.id })
    groups.set(key, list)
  }
  return [...groups.entries()]
    .map(([group, points]) => {
      points.sort((a, b) => a.end.getTime() - b.end.getTime())
      const found = limitsFor(limits, stage, group)
      const evaluated = found ? evaluateChart(points.map((p) => p.days), found.limits) : []
      return {
        group,
        limits: found?.limits ?? null,
        scope: found?.scope ?? null,
        points: points.map((p, i) => ({
          id: p.id,
          serialNo: p.serialNo,
          end: p.end.toISOString(),
          days: p.days,
          signals: evaluated[i]?.signals ?? [],
        })),
      }
    })
    .filter((g) => g.points.length >= 2)
    .sort((a, b) => b.points.length - a.points.length)
}

/**
 * Units open and beyond their limit at the end of each of the last weeks,
 * measured against today's limits so the weeks are comparable.
 */
export function stagnantTrend(orders: RepairOrder[], limits: LimitsSet, now: Date, weeks = 26) {
  const out: { weekEnding: string; open: number; stagnant: number; stagnantValueEur: number }[] = []
  for (let w = weeks - 1; w >= 0; w--) {
    const t = new Date(now.getTime() - w * 7 * 86_400_000)
    let open = 0
    let stagnant = 0
    let value = 0
    for (const o of orders) {
      if (o.dates.readyAt! > t || (o.dates.returnedAt && o.dates.returnedAt <= t)) continue
      const asOf = Object.fromEntries(
        Object.entries(o.dates).map(([k, d]) => [k, d && d <= t ? d : null]),
      ) as RepairOrder['dates']
      const stage = currentStage(asOf)
      if (!stage) continue
      open++
      const start = asOf[STAGE_BY_ID[stage].start]
      const found = limitsFor(limits, stage, groupKey(stage, o))
      if (start && found && daysBetween(start, t) > found.limits.ucl) {
        stagnant++
        value += o.valueEur
      }
    }
    out.push({ weekEnding: t.toISOString().slice(0, 10), open, stagnant, stagnantValueEur: value })
  }
  return out
}
