import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type pg from 'pg'
import { z } from 'zod'
import { controlChart, laneBreakdown, overview } from './analytics.js'
import { DATE_COLUMNS, REQUIRED_COLUMNS, importCsv } from './domain/importer.js'
import { DATE_FIELDS, STAGES, STAGE_INFO } from './domain/stages.js'
import {
  ConflictError,
  NotFoundError,
  acknowledgeEscalation,
  advanceOrder,
  getOrder,
  insertUnits,
  listEscalations,
  liveUnits,
  resolveEscalation,
  runEscalationScan,
} from './repo.js'

export interface AppOptions {
  pool: pg.Pool
  /** Injectable clock so tests can travel in time. */
  now?: () => Date
  clientDir?: string
}

class BadRequestError extends Error {}

const idSchema = z.coerce.number().int().positive()
const stageSchema = z.enum(STAGES)
const advanceBody = z.object({ at: z.coerce.date().optional(), note: z.string().trim().max(500).optional() })
const acknowledgeBody = z.object({
  owner: z.string().trim().min(1, 'Name who owns the follow-up.').max(80),
  note: z.string().trim().max(500).optional(),
})
const resolveBody = z.object({ note: z.string().trim().min(1, 'Say how it was resolved.').max(500) })

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadRequestError(result.error.issues.map((i) => i.message).join(' '))
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
      stages: STAGE_INFO.map((s) => ({ id: s.id, label: s.label, short: s.short, groupBy: s.groupBy })),
      importColumns: [...REQUIRED_COLUMNS, ...DATE_FIELDS.map((f) => DATE_COLUMNS[f]).filter((c) => c !== 'ready_at')],
    })
  })

  api.get('/overview', async (_req, res) => {
    res.json(await overview(pool, now()))
  })

  api.get('/units', async (req, res) => {
    let units = await liveUnits(pool, now())
    const { stage, country, beyond, q } = req.query
    if (typeof stage === 'string') units = units.filter((u) => u.stage === stage)
    if (typeof country === 'string') units = units.filter((u) => u.sendingCountry === country)
    if (beyond === 'true') units = units.filter((u) => u.beyondLimit)
    if (typeof q === 'string' && q.trim()) {
      const needle = q.trim().toLowerCase()
      units = units.filter((u) =>
        [u.serialNo, u.techId, u.material, u.sendingCountry, u.hubCountry].some((f) => f.toLowerCase().includes(needle)),
      )
    }
    res.json(units.sort((a, b) => b.daysOverLimit - a.daysOverLimit || b.daysInStage - a.daysInStage))
  })

  api.get('/units/:id', async (req, res) => {
    res.json(await getOrder(pool, parse(idSchema, req.params.id), now()))
  })

  api.post('/units/:id/advance', async (req, res) => {
    const id = parse(idSchema, req.params.id)
    const body = parse(advanceBody, req.body ?? {})
    const at = body.at ?? now()
    if (at > now()) throw new BadRequestError('The movement date cannot be in the future.')
    res.json(await advanceOrder(pool, id, at, body.note))
  })

  api.get('/lanes', async (_req, res) => {
    res.json(await laneBreakdown(pool, now()))
  })

  api.get('/control-chart/:stage', async (req, res) => {
    res.json(await controlChart(pool, parse(stageSchema, req.params.stage), now()))
  })

  api.get('/escalations', async (req, res) => {
    res.json(await listEscalations(pool, req.query.status === 'resolved' ? 'resolved' : 'active'))
  })

  api.post('/escalations/scan', async (_req, res) => {
    res.json(await runEscalationScan(pool, now()))
  })

  api.post('/escalations/:id/acknowledge', async (req, res) => {
    const body = parse(acknowledgeBody, req.body)
    await acknowledgeEscalation(pool, parse(idSchema, req.params.id), body.owner, body.note, now())
    res.json({ ok: true })
  })

  api.post('/escalations/:id/resolve', async (req, res) => {
    const body = parse(resolveBody, req.body)
    await resolveEscalation(pool, parse(idSchema, req.params.id), body.note, now())
    res.json({ ok: true })
  })

  /** Load an R&R movement export. Rows with problems are reported, never loaded. */
  api.post('/import', express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }), async (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw new BadRequestError('Send the CSV file as the request body.')
    const result = importCsv(req.body, now())
    const dryRun = req.query.dryRun === 'true'
    const loaded = dryRun ? { inserted: 0, skipped: 0 } : await insertUnits(pool, result.units)
    res.json({ rowsRead: result.rowsRead, valid: result.units.length, issues: result.issues, ...loaded, dryRun })
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
