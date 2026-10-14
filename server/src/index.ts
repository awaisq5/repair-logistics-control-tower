import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createPool, migrate } from './db.js'
import { runEscalationScan } from './repo.js'
import { seedDemo } from './seed.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tower:tower@localhost:5432/tower'
const PORT = Number(process.env.PORT ?? 4000)
const SCAN_MINUTES = Number(process.env.SCAN_INTERVAL_MINUTES ?? 15)
const here = path.dirname(fileURLToPath(import.meta.url))

const pool = createPool(DATABASE_URL)
await migrate(pool)
if (process.env.SEED_DEMO !== 'false') await seedDemo(pool, new Date())

const clientDir = process.env.CLIENT_DIR ?? path.resolve(here, '../../client/dist')
createApp({ pool, clientDir }).listen(PORT, () => {
  console.log(`Control tower API on http://localhost:${PORT}`)
})

// Escalations should open even when nobody has the dashboard open.
setInterval(
  () => {
    runEscalationScan(pool, new Date())
      .then(({ opened, raised }) => {
        if (opened || raised) console.log(`Escalation scan: ${opened} opened, ${raised} raised`)
      })
      .catch((error) => console.error('Escalation scan failed', error))
  },
  SCAN_MINUTES * 60_000,
)
