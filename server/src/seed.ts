import type pg from 'pg'
import { withTransaction } from './db.js'
import type { ImportedUnit } from './domain/importer.js'
import { DATE_FIELDS, STAGE_INFO, type DateField, type Stage } from './domain/stages.js'
import { insertUnits, runEscalationScan, setRegionContacts } from './repo.js'

/**
 * Synthetic repair & return network for the demo. Countries are real so the
 * lanes read naturally; every location name, serial number, value and
 * duration is generated. Nothing here comes from company data.
 */

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

// Sending country: typical days waiting to ship, chance a unit gets stuck there, preferred hubs.
const SENDERS: Record<string, { pending: number; stuck: number; hubs: string[] }> = {
  Algeria: { pending: 22, stuck: 0.14, hubs: ['UAE', 'Romania'] },
  Angola: { pending: 18, stuck: 0.12, hubs: ['UAE', 'Romania'] },
  Egypt: { pending: 12, stuck: 0.08, hubs: ['UAE', 'Germany'] },
  Congo: { pending: 16, stuck: 0.1, hubs: ['UAE', 'Romania'] },
  Nigeria: { pending: 20, stuck: 0.16, hubs: ['UAE', 'Romania'] },
  Kazakhstan: { pending: 14, stuck: 0.08, hubs: ['Romania'] },
  Colombia: { pending: 10, stuck: 0.07, hubs: ['US', 'Brazil'] },
  Argentina: { pending: 11, stuck: 0.07, hubs: ['US', 'Brazil'] },
  Mozambique: { pending: 13, stuck: 0.09, hubs: ['UAE'] },
  Norway: { pending: 4, stuck: 0.03, hubs: ['Germany'] },
  'United Kingdom': { pending: 5, stuck: 0.03, hubs: ['Germany'] },
  Kuwait: { pending: 6, stuck: 0.04, hubs: ['UAE'] },
  'Saudi Arabia': { pending: 7, stuck: 0.05, hubs: ['UAE'] },
  Qatar: { pending: 6, stuck: 0.04, hubs: ['UAE'] },
  'Trinidad and Tobago': { pending: 15, stuck: 0.1, hubs: ['US'] },
  Guyana: { pending: 14, stuck: 0.09, hubs: ['US'] },
  India: { pending: 9, stuck: 0.06, hubs: ['UAE'] },
  Indonesia: { pending: 9, stuck: 0.06, hubs: ['UAE'] },
}

// Repair hub: days from goods receipt to work order, in repair, waiting to ship out.
const HUBS: Record<string, { grToWo: number; repair: number; outbound: number }> = {
  UAE: { grToWo: 5, repair: 21, outbound: 6 },
  Romania: { grToWo: 8, repair: 26, outbound: 7 },
  Germany: { grToWo: 4, repair: 18, outbound: 4 },
  US: { grToWo: 4, repair: 20, outbound: 5 },
  Brazil: { grToWo: 7, repair: 24, outbound: 6 },
}

// Rough transit days between regions; customs-heavy lanes take longer.
const TRANSIT: Record<string, number> = {
  UAE: 12,
  Romania: 15,
  Germany: 9,
  US: 11,
  Brazil: 10,
}

// repairFactor: some tool types take longer in repair wherever they are sent,
// e.g. because a test bench or a long-lead part is scarce.
const MATERIALS: { material: string; value: number; repairFactor?: number }[] = [
  { material: 'Unit, hydraulic', value: 42_000 },
  { material: 'Valve, control', value: 18_000 },
  { material: 'Transformer, insert', value: 26_000 },
  { material: 'Pulser assembly', value: 55_000 },
  { material: 'Sensor module, directional', value: 68_000 },
  { material: 'Electronics insert', value: 34_000 },
  { material: 'Battery pack', value: 6_500 },
  { material: 'Motor, power section', value: 39_000 },
  { material: 'Steering unit', value: 145_000, repairFactor: 1.7 },
]

const OWNERS = ['L. Haddad', 'M. Okonkwo', 'S. Ionescu', 'J. Becker', 'A. Mensah', 'R. Silva', 'K. Nurlan', 'D. Ortiz']

const DAY = 86_400_000
/** The escalation process went live this many days before "now": breaches after it get chased. */
export const PROCESS_START_DAYS = 200

export function generateUnits(now: Date, count = 1400, seed = 20240815) {
  const rand = mulberry32(seed)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
  const normal = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())
  const lognormal = (median: number, sigma = 0.45) => median * Math.exp(sigma * normal())
  const processStart = now.getTime() - PROCESS_START_DAYS * DAY

  const units: ImportedUnit[] = []
  const chased: { serialNo: string; stage: Stage; openedAt: Date; resolvedAt: Date; days: number; limit: number; value: number }[] = []
  const senders = Object.keys(SENDERS)

  for (let i = 0; i < count; i++) {
    const sendingCountry = pick(senders)
    const sender = SENDERS[sendingCountry]
    const hubCountry = pick(sender.hubs)
    const hub = HUBS[hubCountry]
    const transit = TRANSIT[hubCountry] * (['Nigeria', 'Angola', 'Algeria', 'Congo'].includes(sendingCountry) ? 1.4 : 1)
    const m = pick(MATERIALS)
    const serialNo = String(10_000_000 + Math.floor(rand() * 89_999_999))

    const medians: Record<Stage, number> = {
      pending_at_sender: sender.pending,
      transit_to_hub: transit,
      gr_to_work_order: hub.grToWo,
      in_repair: hub.repair * (m.repairFactor ?? 1),
      awaiting_outbound: hub.outbound,
      transit_from_hub: transit,
    }

    // Loops started over the last 18 months.
    const readyAt = new Date(now.getTime() - rand() * 540 * DAY)
    const dates = Object.fromEntries(DATE_FIELDS.map((f) => [f, null])) as Record<DateField, Date | null>
    dates.readyAt = readyAt
    let cursor = readyAt.getTime()

    for (const s of STAGE_INFO) {
      let days = lognormal(medians[s.id])
      const stuckChance = s.id === 'pending_at_sender' || s.id === 'transit_to_hub' ? sender.stuck : 0.05
      if (rand() < stuckChance) days *= 3 + rand() * 5
      // After the escalation process started, most units that breach get chased and move on,
      // some days after the breach. Not all: some stay stuck, which is what the live view shows.
      const breachAt = medians[s.id] * 3
      const breachTime = cursor + breachAt * DAY
      if (days > breachAt && breachTime > processStart && rand() < 0.8) {
        const resolvedDays = breachAt + 3 + rand() * 22
        if (resolvedDays < days) {
          days = resolvedDays
          const resolvedAt = cursor + days * DAY
          if (resolvedAt < now.getTime()) {
            chased.push({
              serialNo,
              stage: s.id,
              openedAt: new Date(breachTime),
              resolvedAt: new Date(resolvedAt),
              days: breachAt,
              limit: breachAt,
              value: Math.round(m.value * (0.85 + rand() * 0.3)),
            })
          }
        }
      }
      const end = cursor + days * DAY
      if (end > now.getTime()) break
      dates[s.end] = new Date(end)
      cursor = end
    }

    units.push({
      serialNo,
      techId: `TID-${String(4400 + MATERIALS.indexOf(m) * 37).padStart(4, '0')}`,
      material: m.material,
      valueEur: Math.round(m.value * (0.85 + rand() * 0.3)),
      sendingCountry,
      sendingLocation: `${sendingCountry} operations base`,
      hubCountry,
      hubLocation: `${hubCountry} repair hub`,
      returnCountry: sendingCountry,
      dates,
    })
  }

  // A serial can only be open once; drop later duplicates.
  const seen = new Set<string>()
  const unique = units.filter((u) => {
    const key = u.serialNo + (u.dates.returnedAt ? u.dates.readyAt!.toISOString() : '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { units: unique, chased }
}

export async function seedDemo(pool: pg.Pool, now: Date, count = 1400): Promise<void> {
  const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM repair_orders`)
  if (existing.rows[0].n > 0) return

  const { units, chased } = generateUnits(now, count)
  await insertUnits(pool, units)

  const contacts = Object.fromEntries(
    [...Object.keys(SENDERS), ...Object.keys(HUBS)].map((c, i) => [c, OWNERS[i % OWNERS.length]]),
  )
  await setRegionContacts(pool, contacts)

  // History of chased breaches: the escalation trail behind "capital moving again".
  await withTransaction(pool, async (client) => {
    for (const c of chased) {
      await client.query(
        `INSERT INTO escalations (repair_order_id, stage, group_key, days_at_open, limit_days, value_eur, status,
                                  owner, opened_at, acknowledged_at, resolved_at, resolved_by_movement, note)
         SELECT id, $2, '', $3, $4, value_eur, 'resolved', $5, $6, $6::timestamptz + INTERVAL '4 hours', $7, TRUE,
                'Chased with the regional logistics owner; unit moved on.'
         FROM repair_orders WHERE serial_no = $1 ORDER BY ready_at DESC LIMIT 1`,
        [c.serialNo, c.stage, c.days, c.limit, OWNERS[c.serialNo.charCodeAt(3) % OWNERS.length], c.openedAt, c.resolvedAt],
      )
    }
  })

  await runEscalationScan(pool, now)
  // Some current escalations already have someone on them.
  await pool.query(
    `UPDATE escalations e SET status = 'acknowledged', owner = c.owner,
            acknowledged_at = e.opened_at, note = 'Asked the regional team for the reason and a new ship date.'
     FROM repair_orders r JOIN region_contacts c ON c.country = r.sending_country
     WHERE e.repair_order_id = r.id AND e.status = 'open' AND e.id % 3 = 0`,
  )
}
