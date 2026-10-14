import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type pg from 'pg'
import { z } from 'zod'
import { computeKpis } from './kpis.js'
import {
  ConflictError,
  NotFoundError,
  acknowledgeEscalation,
  advanceShipment,
  getPolicy,
  getShipment,
  listEscalations,
  listShipments,
  resolveEscalation,
  runEscalationScan,
  savePolicy,
  withEvaluation,
} from './repo.js'
import { LEVELS, validateRule } from './domain/sla.js'
import { OPEN_STAGES, STAGES, STAGE_LABELS, nextStages } from './domain/stages.js'

export interface AppOptions {
  pool: pg.Pool
  /** Injectable clock so tests can travel in time. */
  now?: () => Date
  clientDir?: string
}

class BadRequestError extends Error {}

const stageSchema = z.enum(STAGES)
const idSchema = z.coerce.number().int().positive()

const advanceBody = z.object({ to: stageSchema, note: z.string().trim().max(500).optional() })
const acknowledgeBody = z.object({
  owner: z.string().trim().min(1, 'Name who owns the follow-up.').max(80),
  note: z.string().trim().max(500).optional(),
})
const resolveBody = z.object({ note: z.string().trim().min(1, 'Say how it was resolved.').max(500) })
const policyBody = z.object({
  highValueEur: z.number().positive(),
  rules: z
    .array(
      z.object({
        stage: z.enum(OPEN_STAGES as [string, ...string[]]),
        warnAfterDays: z.number(),
        escalateAfterDays: z.number(),
        criticalAfterDays: z.number(),
      }),
    )
    .min(1),
})

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new BadRequestError(result.error.issues.map((i) => i.message).join(' '))
  }
  return result.data
}

export function createApp({ pool, now = () => new Date(), clientDir }: AppOptions) {
  const app = express()
  app.use(express.json({ limit: '100kb' }))

  const api = express.Router()

  api.get('/health', async (_req, res) => {
    await pool.query('SELECT 1')
    res.json({ ok: true, db: 'connected' })
  })

  api.get('/meta', (_req, res) => {
    res.json({
      stages: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s], next: nextStages(s) })),
      levels: LEVELS,
    })
  })

  api.get('/shipments', async (req, res) => {
    const policy = await getPolicy(pool)
    const openOnly = req.query.open !== 'false'
    let rows = withEvaluation(await listShipments(pool, { openOnly }), policy, now())
    const { level, stage, carrier, q } = req.query
    if (typeof level === 'string') rows = rows.filter((s) => s.level === level)
    if (typeof stage === 'string') rows = rows.filter((s) => s.stage === stage)
    if (typeof carrier === 'string') rows = rows.filter((s) => s.carrier === carrier)
    if (typeof q === 'string' && q.trim()) {
      const needle = q.trim().toLowerCase()
      rows = rows.filter((s) =>
        [s.reference, s.serialNo, s.description, s.origin, s.repairCenter].some((f) => f.toLowerCase().includes(needle)),
      )
    }
    res.json(rows)
  })

  api.get('/shipments/:id', async (req, res) => {
    const id = parse(idSchema, req.params.id)
    const policy = await getPolicy(pool)
    const detail = await getShipment(pool, id)
    const [shipment] = withEvaluation([detail.shipment], policy, now())
    res.json({ ...detail, shipment })
  })

  api.post('/shipments/:id/advance', async (req, res) => {
    const id = parse(idSchema, req.params.id)
    const body = parse(advanceBody, req.body)
    const result = await advanceShipment(pool, id, body.to, body.note, now())
    res.json(result)
  })

  api.get('/kpis', async (_req, res) => {
    res.json(await computeKpis(pool, await getPolicy(pool), now()))
  })

  api.get('/sla', async (_req, res) => {
    res.json(await getPolicy(pool))
  })

  api.put('/sla', async (req, res) => {
    const body = parse(policyBody, req.body)
    const rules = body.rules.map((r) => ({ ...r, stage: parse(stageSchema, r.stage) }))
    for (const rule of rules) {
      const problem = validateRule(rule)
      if (problem) throw new BadRequestError(`${STAGE_LABELS[rule.stage]}: ${problem}`)
    }
    await savePolicy(pool, { rules, highValueEur: body.highValueEur })
    res.json(await getPolicy(pool))
  })

  api.get('/escalations', async (req, res) => {
    const status = req.query.status === 'resolved' ? 'resolved' : 'active'
    res.json(await listEscalations(pool, status))
  })

  api.post('/escalations/scan', async (_req, res) => {
    res.json(await runEscalationScan(pool, now()))
  })

  api.post('/escalations/:id/acknowledge', async (req, res) => {
    const id = parse(idSchema, req.params.id)
    const body = parse(acknowledgeBody, req.body)
    await acknowledgeEscalation(pool, id, body.owner, body.note, now())
    res.json({ ok: true })
  })

  api.post('/escalations/:id/resolve', async (req, res) => {
    const id = parse(idSchema, req.params.id)
    const body = parse(resolveBody, req.body)
    await resolveEscalation(pool, id, body.note, now())
    res.json({ ok: true })
  })

  api.use((_req, res) => {
    res.status(404).json({ message: 'No such endpoint.' })
  })

  app.use('/api', api)

  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir))
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')))
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequestError) return res.status(400).json({ message: err.message })
    if (err instanceof NotFoundError) return res.status(404).json({ message: err.message })
    if (err instanceof ConflictError) return res.status(409).json({ message: err.message })
    if (err instanceof SyntaxError) return res.status(400).json({ message: 'Request body is not valid JSON.' })
    console.error(err)
    return res.status(500).json({ message: 'Something went wrong on the server.' })
  })

  return app
}
