import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { ALL_TABLES, migrate } from '../src/db.js'
import { setRegionContacts } from '../src/repo.js'
import { seedDemo } from '../src/seed.js'

/**
 * Integration tests against a real PostgreSQL database.
 * Set TEST_DATABASE_URL to run them; CI provides one as a service container.
 */
const url = process.env.TEST_DATABASE_URL
const DAY = 86_400_000
const HEADER =
  'serial_no,tech_id,material,value_eur,sending_country,sending_location,hub_country,hub_location,return_country,ready_at,dispatched_at,hub_received_at,work_order_at,repaired_at,hub_dispatched_at,returned_at'

describe.skipIf(!url)('API', () => {
  let pool: pg.Pool
  let clock = new Date('2026-06-01T12:00:00Z')
  const app = () => createApp({ pool, now: () => clock })
  const iso = (daysAgo: number) => new Date(clock.getTime() - daysAgo * DAY).toISOString().slice(0, 10)

  /** History of returned units on the Egypt → UAE lane, each waiting `pending` days at the sender. */
  function history(pendings: number[]) {
    return pendings.map((p, i) => {
      const start = 300 - i * 10
      return `H${i},TID-1,Valve,1000,Egypt,Base,UAE,Hub,Egypt,${iso(start)},${iso(start - p)},${iso(start - p - 5)},${iso(start - p - 6)},${iso(start - p - 20)},${iso(start - p - 22)},${iso(start - p - 30)}`
    })
  }

  async function load(rows: string[]) {
    return request(app())
      .post('/api/import')
      .set('Content-Type', 'text/csv')
      .send([HEADER, ...rows].join('\n'))
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query(`DROP TABLE IF EXISTS ${ALL_TABLES} CASCADE`)
    await migrate(pool)
  })

  beforeEach(async () => {
    clock = new Date('2026-06-01T12:00:00Z')
    await pool.query(`TRUNCATE ${ALL_TABLES} RESTART IDENTITY CASCADE`)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('reports a healthy database', async () => {
    await request(app()).get('/api/health').expect(200, { ok: true, db: 'connected' })
  })

  it('imports clean rows and reports the rest without loading them', async () => {
    const res = await load([...history([10, 12]), `BAD,TID-1,Valve,1000,Egypt,Base,UAE,Hub,Egypt,${iso(5)},${iso(9)},,,,,`])
    expect(res.body).toMatchObject({ rowsRead: 3, valid: 2, inserted: 2 })
    expect(res.body.issues[0]).toMatchObject({ row: 4, serialNo: 'BAD' })
    const dry = await request(app()).post('/api/import?dryRun=true').set('Content-Type', 'text/csv').send(`${HEADER}\n${history([9])[0].replace('H0', 'H9')}`)
    expect(dry.body).toMatchObject({ valid: 1, inserted: 0, dryRun: true })
  })

  it('flags a unit beyond its lane limit and escalates it once, to the regional owner', async () => {
    await setRegionContacts(pool, { Egypt: 'L. Haddad' })
    await load([...history([10, 12, 9, 11, 10, 13, 9, 12, 11, 10]), `LIVE1,TID-1,Valve,48000,Egypt,Base,UAE,Hub,Egypt,${iso(40)},,,,,,`])

    const units = (await request(app()).get('/api/units?beyond=true').expect(200)).body
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ serialNo: 'LIVE1', stage: 'pending_at_sender', group: 'Egypt', limitScope: 'group' })

    await request(app()).post('/api/escalations/scan').expect(200, { opened: 1, beyondLimit: 1 })
    await request(app()).post('/api/escalations/scan').expect(200, { opened: 0, beyondLimit: 1 })
    const [esc] = (await request(app()).get('/api/escalations').expect(200)).body
    expect(esc).toMatchObject({ serialNo: 'LIVE1', status: 'open', regionOwner: 'L. Haddad', valueEur: 48000 })
  })

  it('exports the active queue as CSV with days in stage as of today', async () => {
    await setRegionContacts(pool, { Egypt: 'L. Haddad' })
    await load([...history([10, 12, 9, 11, 10, 13, 9, 12, 11, 10]), `LIVE1,TID-1,"Valve, 6 3/4in",48000,Egypt,Base,UAE,Hub,Egypt,${iso(40)},,,,,,`])
    await request(app()).post('/api/escalations/scan')
    clock = new Date(clock.getTime() + 5 * DAY)

    const res = await request(app()).get('/api/escalations.csv').expect(200)
    expect(res.headers['content-type']).toMatch(/^text\/csv/)
    expect(res.headers['content-disposition']).toBe('attachment; filename=escalations-2026-06-06.csv')
    expect(res.text.charCodeAt(0)).toBe(0xfeff)
    const [header, row, end] = res.text.slice(1).split('\r\n')
    expect(header.split(',')).toContain('days_in_stage_today')
    expect(row).toMatch(/^LIVE1,TID-1,"Valve, 6 3\/4in",Waiting to ship at sending location,Egypt,41,46,\d+,48000,open,,L\. Haddad,2026-06-01,$/)
    expect(end).toBe('')
  })

  it('moving the unit on resolves its escalation and counts the value as released', async () => {
    await load([...history([10, 12, 9, 11, 10, 13, 9, 12, 11, 10]), `LIVE1,TID-1,Valve,48000,Egypt,Base,UAE,Hub,Egypt,${iso(40)},,,,,,`])
    await request(app()).post('/api/escalations/scan')
    const [unit] = (await request(app()).get('/api/units').expect(200)).body.filter((u: { serialNo: string }) => u.serialNo === 'LIVE1')

    const res = await request(app()).post(`/api/units/${unit.id}/advance`).send({ note: 'AWB 176-12345675' }).expect(200)
    expect(res.body).toEqual({ completedStage: 'pending_at_sender', releasedEur: 48000 })
    expect((await request(app()).get('/api/escalations')).body).toHaveLength(0)
    expect((await request(app()).get('/api/overview')).body.totals.releasedLast90DaysEur).toBe(48000)

    const detail = (await request(app()).get(`/api/units/${unit.id}`)).body
    expect(detail.live.stage).toBe('transit_to_hub')
    expect(detail.stages[0]).toMatchObject({ stage: 'pending_at_sender', done: true })
  })

  it('rejects impossible movements', async () => {
    await load(history([10]))
    const returned = (await pool.query(`SELECT id FROM repair_orders LIMIT 1`)).rows[0].id
    await request(app()).post(`/api/units/${returned}/advance`).send({}).expect(409)
    await request(app()).post('/api/units/999/advance').send({}).expect(404)
    await request(app()).post('/api/units/abc/advance').send({}).expect(400)
    const future = new Date(clock.getTime() + DAY).toISOString()
    await request(app()).post(`/api/units/${returned}/advance`).send({ at: future }).expect(400)
  })

  it('serves lane breakdowns and control charts', async () => {
    await load(history([10, 12, 9, 11, 10, 13, 9, 12, 11, 10]))
    const lanes = (await request(app()).get('/api/lanes').expect(200)).body
    expect(lanes[0]).toMatchObject({ lane: 'Egypt → UAE', units: 10 })
    expect(lanes[0].avgDays.gr_to_work_order).toBeCloseTo(1)

    const chart = (await request(app()).get('/api/control-chart/pending_at_sender').expect(200)).body
    expect(chart[0].group).toBe('Egypt')
    expect(chart[0].points).toHaveLength(10)
    await request(app()).get('/api/control-chart/nonsense').expect(400)
  })

  it('validates escalation input and explains what is wrong', async () => {
    const ack = await request(app()).post('/api/escalations/1/acknowledge').send({ owner: '' }).expect(400)
    expect(ack.body.message).toMatch(/owns the follow-up/)
    await request(app()).post('/api/escalations/99/resolve').send({ note: 'done' }).expect(404)
  })

  it('seeds a demo with live breaches, history and released capital', async () => {
    await seedDemo(pool, clock, 600)
    const o = (await request(app()).get('/api/overview')).body
    expect(o.totals.open.units).toBeGreaterThan(50)
    expect(o.totals.releasedLast90DaysEur).toBeGreaterThan(0)
    expect(o.pendingByCountry.length).toBeGreaterThan(5)
    const first = o.stagnantTrend[0].stagnant
    const last = o.stagnantTrend.at(-1).stagnant
    expect(last).toBeLessThan(first)
  })
})
