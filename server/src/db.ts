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
CREATE TABLE IF NOT EXISTS shipments (
  id               SERIAL PRIMARY KEY,
  reference        TEXT UNIQUE NOT NULL,
  material         TEXT NOT NULL,
  description      TEXT NOT NULL,
  serial_no        TEXT NOT NULL,
  value_eur        NUMERIC(12, 2) NOT NULL CHECK (value_eur >= 0),
  origin           TEXT NOT NULL,
  repair_center    TEXT NOT NULL,
  carrier          TEXT NOT NULL,
  stage            TEXT NOT NULL,
  stage_entered_at TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL,
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shipments_stage_idx ON shipments (stage);

CREATE TABLE IF NOT EXISTS stage_events (
  id          SERIAL PRIMARY KEY,
  shipment_id INT NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  entered_at  TIMESTAMPTZ NOT NULL,
  left_at     TIMESTAMPTZ,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS stage_events_shipment_idx ON stage_events (shipment_id);
CREATE INDEX IF NOT EXISTS stage_events_left_idx ON stage_events (left_at);

CREATE TABLE IF NOT EXISTS sla_rules (
  stage               TEXT PRIMARY KEY,
  warn_after_days     NUMERIC NOT NULL,
  escalate_after_days NUMERIC NOT NULL,
  critical_after_days NUMERIC NOT NULL,
  CHECK (0 < warn_after_days AND warn_after_days < escalate_after_days AND escalate_after_days < critical_after_days)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id                   SERIAL PRIMARY KEY,
  shipment_id          INT NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,
  level                TEXT NOT NULL CHECK (level IN ('escalated', 'critical')),
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  stage                TEXT NOT NULL,
  value_eur            NUMERIC(12, 2) NOT NULL,
  owner                TEXT,
  note                 TEXT,
  opened_at            TIMESTAMPTZ NOT NULL,
  acknowledged_at      TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolved_by_movement BOOLEAN NOT NULL DEFAULT FALSE
);
-- A shipment can have at most one escalation that is not yet resolved.
CREATE UNIQUE INDEX IF NOT EXISTS escalations_one_active
  ON escalations (shipment_id) WHERE status <> 'resolved';
`

export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA)
}
