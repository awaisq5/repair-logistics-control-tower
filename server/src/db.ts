import pg from 'pg'

// NUMERIC comes back as string by default; values here fit safely in a double.
pg.types.setTypeParser(1700, (v) => Number(v))

export type Db = pg.Pool | pg.PoolClient

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 })
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const SCHEMA = `
-- One row per repair loop of one serialized unit. The seven dates are the
-- movement milestones; the current stage is the first one without an end date.
CREATE TABLE IF NOT EXISTS repair_orders (
  id                SERIAL PRIMARY KEY,
  serial_no         TEXT NOT NULL,
  tech_id           TEXT NOT NULL,
  material          TEXT NOT NULL,
  value_eur         NUMERIC(12, 2) NOT NULL CHECK (value_eur >= 0),
  sending_country   TEXT NOT NULL,
  sending_location  TEXT NOT NULL,
  hub_country       TEXT NOT NULL,
  hub_location      TEXT NOT NULL,
  return_country    TEXT NOT NULL,
  ready_at          TIMESTAMPTZ NOT NULL,
  dispatched_at     TIMESTAMPTZ,
  hub_received_at   TIMESTAMPTZ,
  work_order_at     TIMESTAMPTZ,
  repaired_at       TIMESTAMPTZ,
  hub_dispatched_at TIMESTAMPTZ,
  returned_at       TIMESTAMPTZ,
  -- Dates must follow the loop: no step dated before the one it follows.
  CHECK (dispatched_at     IS NULL OR dispatched_at     >= ready_at),
  CHECK (hub_received_at   IS NULL OR (dispatched_at IS NOT NULL AND hub_received_at >= dispatched_at)),
  CHECK (work_order_at     IS NULL OR (hub_received_at IS NOT NULL AND work_order_at >= hub_received_at)),
  CHECK (repaired_at       IS NULL OR (work_order_at IS NOT NULL AND repaired_at >= work_order_at)),
  CHECK (hub_dispatched_at IS NULL OR (repaired_at IS NOT NULL AND hub_dispatched_at >= repaired_at)),
  CHECK (returned_at       IS NULL OR (hub_dispatched_at IS NOT NULL AND returned_at >= hub_dispatched_at))
);
CREATE INDEX IF NOT EXISTS repair_orders_open_idx ON repair_orders (returned_at) WHERE returned_at IS NULL;
-- A serial number can only be in one open loop at a time.
CREATE UNIQUE INDEX IF NOT EXISTS repair_orders_one_open_loop ON repair_orders (serial_no) WHERE returned_at IS NULL;

-- Who to call when a unit is stuck at a location: the regional logistics owner.
CREATE TABLE IF NOT EXISTS region_contacts (
  country TEXT PRIMARY KEY,
  owner   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id                   SERIAL PRIMARY KEY,
  repair_order_id      INT NOT NULL REFERENCES repair_orders (id) ON DELETE CASCADE,
  stage                TEXT NOT NULL,
  group_key            TEXT NOT NULL,
  days_at_open         NUMERIC NOT NULL,
  limit_days           NUMERIC NOT NULL,
  value_eur            NUMERIC(12, 2) NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  owner                TEXT,
  note                 TEXT,
  opened_at            TIMESTAMPTZ NOT NULL,
  acknowledged_at      TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolved_by_movement BOOLEAN NOT NULL DEFAULT FALSE
);
-- A unit can have at most one escalation that is not yet resolved.
CREATE UNIQUE INDEX IF NOT EXISTS escalations_one_active
  ON escalations (repair_order_id) WHERE status <> 'resolved';
`

export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA)
}

export const ALL_TABLES = 'escalations, region_contacts, repair_orders'
