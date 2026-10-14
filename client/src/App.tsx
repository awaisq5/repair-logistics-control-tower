import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LEVEL_LABEL,
  api,
  days,
  eur,
  eurShort,
  type Escalation,
  type Kpis,
  type Level,
  type Policy,
  type Shipment,
  type StageMeta,
} from './api'
import { AgingBoard } from './components/AgingBoard'
import { EscalationQueue } from './components/EscalationQueue'
import { ShipmentDrawer } from './components/ShipmentDrawer'
import { SlaEditor } from './components/SlaEditor'

interface State {
  stages: StageMeta[]
  kpis: Kpis
  shipments: Shipment[]
  escalations: Escalation[]
  policy: Policy
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<{ q: string; level: Level | 'past_sla' | 'all' }>({ q: '', level: 'past_sla' })

  const refresh = useCallback(async () => {
    try {
      const [meta, kpis, shipments, escalations, policy] = await Promise.all([
        api.meta(),
        api.kpis(),
        api.shipments(),
        api.escalations(),
        api.policy(),
      ])
      setState({ stages: meta.stages, kpis, shipments, escalations, policy })
      setError(null)
    } catch (e) {
      setError(`Could not reach the control tower API. ${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const rows = useMemo(() => {
    if (!state) return []
    const q = filter.q.trim().toLowerCase()
    return state.shipments
      .filter((s) =>
        filter.level === 'all' ? true : filter.level === 'past_sla' ? s.level !== 'on_track' : s.level === filter.level,
      )
      .filter(
        (s) =>
          !q ||
          [s.reference, s.serialNo, s.description, s.carrier, s.origin, s.repairCenter].some((f) =>
            f.toLowerCase().includes(q),
          ),
      )
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
  }, [state, filter])

  if (error) {
    return (
      <main className="page">
        <h1>Repair logistics control tower</h1>
        <p className="error">{error}</p>
        <button className="primary" onClick={refresh}>
          Try again
        </button>
      </main>
    )
  }
  if (!state) return <main className="page"><p className="empty">Loading shipments…</p></main>

  const { kpis, stages, policy } = state
  const breached = kpis.byLevel.escalated.count + kpis.byLevel.critical.count
  const breachedValue = kpis.byLevel.escalated.valueEur + kpis.byLevel.critical.valueEur
  const now = new Date(kpis.asOf)
  const label = (id: string) => stages.find((s) => s.id === id)?.label ?? id

  async function scan() {
    const { opened, raised } = await api.scan()
    setScanNote(
      opened || raised
        ? `${opened} escalation${opened === 1 ? '' : 's'} opened, ${raised} raised.`
        : 'Checked every open shipment. Nothing new to escalate.',
    )
    refresh()
  }

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <h1>Repair logistics control tower</h1>
          <p className="lede">Tools on their way to repair and back, measured against the SLA for every stage.</p>
        </div>
        <div className="masthead-actions">
          <span className="as-of">
            Updated {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <button className="secondary" onClick={scan}>
            Check for new escalations
          </button>
          {scanNote && (
            <span className="scan-note" role="status">
              {scanNote}
            </span>
          )}
        </div>
      </header>

      <section className="verdict">
        <p className="verdict-main">
          {breached > 0 ? (
            <>
              <strong>{breached} repair shipments</strong> worth <strong>{eurShort(breachedValue)}</strong> are past
              their escalation threshold.{' '}
              {kpis.byLevel.critical.count > 0 && (
                <>
                  <strong className="crit">{kpis.byLevel.critical.count}</strong> of them are critical.
                </>
              )}
            </>
          ) : (
            <>Every repair shipment is inside its escalation threshold.</>
          )}
        </p>
        <dl className="facts">
          <div>
            <dt>In the repair loop</dt>
            <dd>{eurShort(kpis.open.valueEur)}</dd>
            <dd className="sub">{kpis.open.count} units</dd>
          </div>
          <div>
            <dt>Moving again after escalation, last 30 days</dt>
            <dd>{eurShort(kpis.releasedLast30DaysEur)}</dd>
          </div>
          <div>
            <dt>Stage moves inside SLA, last 90 days</dt>
            <dd>{kpis.slaAdherenceLast90Days === null ? 'No data' : `${Math.round(kpis.slaAdherenceLast90Days * 100)}%`}</dd>
          </div>
          <div>
            <dt>Average turnaround, failure to return</dt>
            <dd>{kpis.avgTurnaroundDays === null ? 'No data' : `${Math.round(kpis.avgTurnaroundDays)} days`}</dd>
          </div>
        </dl>
      </section>

      <AgingBoard
        stages={stages}
        rules={policy.rules}
        shipments={state.shipments}
        highValueEur={policy.highValueEur}
        onOpen={setOpenId}
      />

      <div className="split">
        <section>
          <h2>Escalation queue</h2>
          <p className="hint">Critical first, then by value. Moving a shipment resolves its escalation automatically.</p>
          <EscalationQueue
            escalations={state.escalations}
            stages={stages}
            now={now}
            onOpen={setOpenId}
            onChanged={refresh}
          />
        </section>
        <section>
          {(
            [
              ['Carriers', kpis.byCarrier],
              ['Repair centres', kpis.byRepairCenter],
            ] as const
          ).map(([title, rows]) => (
            <div key={title} className="breakdown">
              <h2>{title}</h2>
              <p className="hint">Open shipments past their warning threshold.</p>
              <table className="carriers">
                <thead>
                  <tr>
                    <th>{title === 'Carriers' ? 'Carrier' : 'Repair centre'}</th>
                    <th className="n">Past SLA</th>
                    <th className="n">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td className="n">
                        {c.pastSla} of {c.open}
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${(c.pastSla / Math.max(1, c.open)) * 100}%` }} />
                        </span>
                      </td>
                      <td className="n">{eurShort(c.valuePastSla)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      </div>

      <section className="shipments">
        <h2>Shipments</h2>
        <div className="filters">
          <label className="search">
            Search
            <input
              type="search"
              value={filter.q}
              onChange={(e) => setFilter({ ...filter, q: e.target.value })}
              placeholder="Reference, serial, tool, carrier or location"
            />
          </label>
          <div className="segmented" role="group" aria-label="Filter by SLA level">
            {(['past_sla', 'critical', 'escalated', 'warning', 'all'] as const).map((l) => (
              <button
                key={l}
                aria-pressed={filter.level === l}
                onClick={() => setFilter({ ...filter, level: l })}
              >
                {l === 'past_sla' ? 'Past SLA' : l === 'all' ? 'All open' : LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Shipment</th>
                <th>Stage</th>
                <th className="n">In stage</th>
                <th>Route</th>
                <th>Carrier</th>
                <th className="n">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 60).map((s) => (
                <tr key={s.id} className="clickable" onClick={() => setOpenId(s.id)}>
                  <td>
                    <button className="row-link" onClick={() => setOpenId(s.id)}>
                      {s.reference}
                    </button>
                    <span className="desc">{s.description}</span>
                  </td>
                  <td>
                    <span className={`dot d-${s.level}`} aria-hidden="true" />
                    {label(s.stage)}
                    <span className="desc">{LEVEL_LABEL[s.level]}</span>
                  </td>
                  <td className="n">{days(s.daysInStage)}</td>
                  <td>
                    {s.origin} to {s.repairCenter}
                  </td>
                  <td>{s.carrier}</td>
                  <td className="n">{eur(s.valueEur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">No shipments match. Clear the search or pick another level.</p>}
          {rows.length > 60 && <p className="hint">Showing the 60 most overdue of {rows.length}. Search to narrow down.</p>}
        </div>
      </section>

      <details className="sla">
        <summary>SLA rules per stage</summary>
        <SlaEditor policy={policy} stages={stages} onSaved={refresh} />
      </details>

      <footer className="footer">
        Demo data is synthetic. API: Node.js, Express and PostgreSQL.{' '}
        <a href="https://github.com/awaisq5/repair-logistics-control-tower">Source on GitHub</a>
      </footer>

      {openId !== null && (
        <ShipmentDrawer id={openId} stages={stages} onClose={() => setOpenId(null)} onChanged={refresh} />
      )}
    </div>
  )
}
