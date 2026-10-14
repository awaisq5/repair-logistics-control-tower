import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { migrate } from '../src/db.js'
import { savePolicy } from '../src/repo.js'
import { DEFAULT_POLICY, seedDemo } from '../src/seed.js'

/**
 * Integration tests against a real PostgreSQL database.
 * Set TEST_DATABASE_URL to run them; CI provides one as a service container.
 */
const url = process.env.TEST_DATABASE_URL
const DAY = 86_400_000

describe.skipIf(!url)('API', () => {
  let pool: pg.Pool
  let clock = new Date('2026-10-01T08:00:00Z')
  const app = () => createApp({ pool, now: () => clock })
  const daysAgo = (d: number) => new Date(clock.getTime() - d * DAY)

  async function addShipment(stage: string, enteredDaysAgo: number, value = 20_000) {
    const res = await pool.query(
      `INSERT INTO shipments (reference, material, description, serial_no, value_eur, origin, repair_center, carrier,
                              stage, stage_entered_at, created_at)
       VALUES ($1, 'TL-1', 'Test unit', 'SN1', $2, 'Aberdeen', 'Celle', 'Atlas Forwarding', $3, $4, $4) RETURNING id`,
      [`RL-${Math.random().toString(36).slice(2, 9)}`, value, stage, daysAgo(enteredDaysAgo)],
    )
    const id = res.rows[0].id as number
    await pool.query(`INSERT INTO stage_events (shipment_id, stage, entered_at) VALUES ($1, $2, $3)`, [
      id,
      stage,
      daysAgo(enteredDaysAgo),
    ])
    return id
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query('DROP TABLE IF EXISTS escalations, stage_events, sla_rules, settings, shipments CASCADE')
    await migrate(pool)
  })

  beforeEach(async () => {
    clock = new Date('2026-10-01T08:00:00Z')
    await pool.query('TRUNCATE escalations, stage_events, shipments RESTART IDENTITY CASCADE')
    await savePolicy(pool, DEFAULT_POLICY)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('reports a healthy database', async () => {
    await request(app()).get('/api/health').expect(200, { ok: true, db: 'connected' })
  })

  it('classifies shipments by SLA level', async () => {
    await addShipment('customs', 1)
    await addShipment('customs', 20)
    const res = await request(app()).get('/api/shipments').expect(200)
    expect(res.body.map((s: { level: string }) => s.level).sort()).toEqual(['critical', 'on_track'])
  })

  it('opens one escalation per breaching shipment, however often the scan runs', async () => {
    await addShipment('customs', 10)
    await addShipment('customs', 2)
    await request(app()).post('/api/escalations/scan').expect(200, { opened: 1, raised: 0 })
    await request(app()).post('/api/escalations/scan').expect(200, { opened: 0, raised: 0 })
    const active = await request(app()).get('/api/escalations').expect(200)
    expect(active.body).toHaveLength(1)
    expect(active.body[0]).toMatchObject({ level: 'escalated', status: 'open', stage: 'customs' })
  })

  it('re-opens an acknowledged escalation when the shipment gets worse', async () => {
    await addShipment('customs', 10)
    await request(app()).post('/api/escalations/scan')
    const [esc] = (await request(app()).get('/api/escalations')).body
    await request(app())
      .post(`/api/escalations/${esc.id}/acknowledge`)
      .send({ owner: 'A. Qurashi', note: 'Broker chased' })
      .expect(200)

    clock = new Date(clock.getTime() + 7 * DAY) // now 17 days in customs: critical
    await request(app()).post('/api/escalations/scan').expect(200, { opened: 0, raised: 1 })
    const [after] = (await request(app()).get('/api/escalations')).body
    expect(after).toMatchObject({ level: 'critical', status: 'open', owner: 'A. Qurashi' })
  })

  it('moving the shipment resolves its escalation and counts the capital released', async () => {
    const id = await addShipment('customs', 12, 48_000)
    await request(app()).post('/api/escalations/scan')
    const res = await request(app())
      .post(`/api/shipments/${id}/advance`)
      .send({ to: 'awaiting_repair', note: 'Cleared after duty payment' })
      .expect(200)
    expect(res.body.releasedEur).toBe(48_000)

    expect((await request(app()).get('/api/escalations')).body).toHaveLength(0)
    const kpis = (await request(app()).get('/api/kpis')).body
    expect(kpis.releasedLast30DaysEur).toBe(48_000)

    const detail = (await request(app()).get(`/api/shipments/${id}`)).body
    expect(detail.shipment.stage).toBe('awaiting_repair')
    expect(detail.events.map((e: { stage: string }) => e.stage)).toEqual(['customs', 'awaiting_repair'])
    expect(detail.events[0].leftAt).not.toBeNull()
  })

  it('rejects a move that skips the process', async () => {
    const id = await addShipment('awaiting_pickup', 1)
    const res = await request(app()).post(`/api/shipments/${id}/advance`).send({ to: 'in_repair' }).expect(409)
    expect(res.body.message).toMatch(/cannot move/)
  })

  it('validates input and explains what is wrong', async () => {
    await request(app()).post('/api/shipments/abc/advance').send({ to: 'customs' }).expect(400)
    await request(app()).post('/api/shipments/999/advance').send({ to: 'customs' }).expect(404)
    const ack = await request(app()).post('/api/escalations/1/acknowledge').send({ owner: '' }).expect(400)
    expect(ack.body.message).toMatch(/owns the follow-up/)
  })

  it('refuses SLA rules whose thresholds do not increase', async () => {
    const res = await request(app())
      .put('/api/sla')
      .send({
        highValueEur: 100_000,
        rules: [{ stage: 'customs', warnAfterDays: 9, escalateAfterDays: 5, criticalAfterDays: 15 }],
      })
      .expect(400)
    expect(res.body.message).toMatch(/In customs: Thresholds must increase/)
  })

  it('seeds a realistic demo with breaches, history and released capital', async () => {
    await pool.query('TRUNCATE shipments RESTART IDENTITY CASCADE')
    await seedDemo(pool, clock, 120)
    const kpis = (await request(app()).get('/api/kpis')).body
    expect(kpis.open.count).toBeGreaterThan(40)
    expect(kpis.byLevel.critical.count + kpis.byLevel.escalated.count).toBeGreaterThan(0)
    expect(kpis.slaAdherenceLast90Days).toBeGreaterThan(0.5)
    expect(kpis.slaAdherenceLast90Days).toBeLessThan(1)
    const active = (await request(app()).get('/api/escalations')).body
    expect(active.length).toBe(kpis.byLevel.critical.count + kpis.byLevel.escalated.count)
  })
})
