import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  STAGE_COLOURS,
  api,
  days,
  eur,
  eurShort,
  type ChartGroup,
  type Escalation,
  type Lane,
  type LiveUnit,
  type Overview,
  type Stage,
  type StageMeta,
} from './api'
import { ControlChart, CountryBars, LaneChart, LoopStrip, TrendChart } from './components/Charts'
import { EscalationQueue } from './components/EscalationQueue'
import { ImportPanel } from './components/ImportPanel'
import { UnitDrawer } from './components/UnitDrawer'

type Tab = 'live' | 'lanes' | 'spc' | 'escalations' | 'import'

interface State {
  stages: StageMeta[]
  importColumns: string[]
  overview: Overview
  units: LiveUnit[]
  escalations: Escalation[]
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('live')
  const [openId, setOpenId] = useState<number | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<{ stage: Stage | null; country: string | null; beyond: boolean; q: string }>({
    stage: null,
    country: null,
    beyond: true,
    q: '',
  })
  const [lanes, setLanes] = useState<Lane[] | null>(null)
  const [chartStage, setChartStage] = useState<Stage>('pending_at_sender')
  const [chart, setChart] = useState<ChartGroup[] | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [meta, overview, units, escalations] = await Promise.all([api.meta(), api.overview(), api.units(), api.escalations()])
      setState({ stages: meta.stages, importColumns: meta.importColumns, overview, units, escalations })
      setError(null)
    } catch (e) {
      setError(`Could not reach the API. ${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (tab === 'lanes' && !lanes) api.lanes().then(setLanes).catch(() => setLanes([]))
  }, [tab, lanes])

  useEffect(() => {
    if (tab !== 'spc') return
    setChart(null)
    api.chart(chartStage).then(setChart).catch(() => setChart([]))
  }, [tab, chartStage])

  const rows = useMemo(() => {
    if (!state) return []
    const q = filter.q.trim().toLowerCase()
    return state.units.filter(
      (u) =>
        (!filter.stage || u.stage === filter.stage) &&
        (!filter.country || u.sendingCountry === filter.country) &&
        (!filter.beyond || u.beyondLimit) &&
        (!q || [u.serialNo, u.techId, u.material, u.sendingCountry, u.hubCountry].some((f) => f.toLowerCase().includes(q))),
    )
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
  if (!state)
    return (
      <main className="page">
        <p className="empty">Loading the repair loop…</p>
      </main>
    )

  const { overview: o, stages } = state
  const t = o.totals
  const stageLabel = (s: Stage) => stages.find((x) => x.id === s)?.short ?? s
  const trendStart = o.stagnantTrend[0]?.stagnant ?? 0
  const trendNow = o.stagnantTrend.at(-1)?.stagnant ?? 0

  async function scan() {
    const { opened, beyondLimit } = await api.scan()
    setScanNote(
      opened ? `${opened} new escalation${opened === 1 ? '' : 's'} opened.` : `Checked ${t.open.units} units. ${beyondLimit} beyond limit, all already escalated.`,
    )
    refresh()
  }

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <h1>Repair logistics control tower</h1>
          <p className="lede">Serialized tools in the repair &amp; return loop, from the field to the repair hub and back.</p>
        </div>
        <div className="masthead-actions">
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
          <strong>{eurShort(t.inTransit.valueEur)}</strong> of tools are in transit and{' '}
          <strong>{eurShort(t.pending.valueEur)}</strong> are waiting to ship at sending locations.{' '}
          {t.beyondLimit.units > 0 ? (
            <>
              <strong className="crit">{t.beyondLimit.units} units</strong> worth {eurShort(t.beyondLimit.valueEur)} have been in their
              stage longer than their lane's normal variation explains.
            </>
          ) : (
            <>Every unit is within its lane's control limits.</>
          )}
        </p>
        <dl className="facts">
          <div>
            <dt>In the loop</dt>
            <dd>{eurShort(t.open.valueEur)}</dd>
            <dd className="sub">{t.open.units} units</dd>
          </div>
          <div>
            <dt>At the repair hubs</dt>
            <dd>{eurShort(t.atHub.valueEur)}</dd>
            <dd className="sub">{t.atHub.units} units</dd>
          </div>
          <div>
            <dt>Moving again after escalation, last 90 days</dt>
            <dd>{eurShort(t.releasedLast90DaysEur)}</dd>
          </div>
          <div>
            <dt>Units beyond their limit, 26 weeks ago vs now</dt>
            <dd>
              {trendStart} → {trendNow}
            </dd>
          </div>
        </dl>
      </section>

      <LoopStrip
        stages={stages}
        byStage={o.byStage}
        onPick={(s) => {
          setTab('live')
          setFilter({ ...filter, stage: filter.stage === s.id ? null : s.id, beyond: false })
        }}
      />

      <nav className="tabs" role="tablist">
        {(
          [
            ['live', 'Live units'],
            ['lanes', 'Lanes'],
            ['spc', 'Control charts'],
            ['escalations', `Escalations (${state.escalations.length})`],
            ['import', 'Load data'],
          ] as [Tab, string][]
        ).map(([id, text]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            {text}
          </button>
        ))}
      </nav>

      {tab === 'live' && (
        <>
          <div className="split">
            <section>
              <h2>Pending at sending location</h2>
              <p className="hint">Average days waiting to ship, by country. Select a country to list its units.</p>
              <CountryBars
                rows={o.pendingByCountry}
                unit="units"
                selected={filter.stage === 'pending_at_sender' ? filter.country : null}
                onSelect={(c) => setFilter({ ...filter, stage: c ? 'pending_at_sender' : null, country: c, beyond: false })}
              />
            </section>
            <section>
              <h2>In transit to repair hub</h2>
              <p className="hint">Average days since dispatch, by sending country.</p>
              <CountryBars
                rows={o.inTransitByCountry}
                unit="units"
                selected={filter.stage === 'transit_to_hub' ? filter.country : null}
                onSelect={(c) => setFilter({ ...filter, stage: c ? 'transit_to_hub' : null, country: c, beyond: false })}
              />
            </section>
          </div>

          <section className="units">
            <div className="units-head">
              <h2>Units</h2>
              <div className="filters">
                <label className="search">
                  Search
                  <input
                    type="search"
                    value={filter.q}
                    onChange={(e) => setFilter({ ...filter, q: e.target.value })}
                    placeholder="Serial, tech ID, material or country"
                  />
                </label>
                <div className="segmented" role="group" aria-label="Which units">
                  <button aria-pressed={filter.beyond} onClick={() => setFilter({ ...filter, beyond: true })}>
                    Beyond limit
                  </button>
                  <button aria-pressed={!filter.beyond} onClick={() => setFilter({ ...filter, beyond: false })}>
                    All open
                  </button>
                </div>
              </div>
            </div>
            {(filter.stage || filter.country) && (
              <p className="filter-note">
                Showing {filter.stage ? stageLabel(filter.stage).toLowerCase() : 'all stages'}
                {filter.country ? ` from ${filter.country}` : ''}.{' '}
                <button className="link" onClick={() => setFilter({ ...filter, stage: null, country: null })}>
                  Clear
                </button>
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Stage</th>
                    <th className="n">In stage</th>
                    <th className="n">Limit</th>
                    <th>Route</th>
                    <th className="n">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 80).map((u) => (
                    <tr key={u.id} className="clickable" onClick={() => setOpenId(u.id)}>
                      <td>
                        <button className="row-link" onClick={() => setOpenId(u.id)}>
                          {u.serialNo}
                        </button>
                        <span className="desc">
                          {u.material} · {u.techId}
                        </span>
                      </td>
                      <td>
                        <span className="dot" style={{ background: STAGE_COLOURS[u.stage] }} aria-hidden="true" />
                        {stageLabel(u.stage)}
                        <span className="desc">{u.group}</span>
                      </td>
                      <td className={u.beyondLimit ? 'n over' : 'n'}>{days(u.daysInStage)}</td>
                      <td className="n">{u.limit ? days(u.limit.ucl) : '–'}</td>
                      <td>
                        {u.sendingCountry} → {u.hubCountry}
                      </td>
                      <td className="n">{eur(u.valueEur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <p className="empty">No units match. Switch to all open units or clear the filter.</p>}
              {rows.length > 80 && <p className="hint">Showing the 80 longest overdue of {rows.length}.</p>}
            </div>
          </section>
        </>
      )}

      {tab === 'lanes' && (
        <section>
          <h2>Where the time goes on each lane</h2>
          <p className="hint">
            Average days per stage over the last 12 months, sending country to repair hub, longest lanes first. Lanes with fewer
            than three units are left out.
          </p>
          {lanes ? <LaneChart lanes={lanes} stages={stages} /> : <p className="empty">Loading lanes…</p>}
        </section>
      )}

      {tab === 'spc' && (
        <section>
          <h2>Control charts</h2>
          <p className="hint">
            Days per completed unit, in completion order, grouped by{' '}
            {
              {
                sendingCountry: 'sending country',
                inboundLane: 'lane',
                hub: 'repair hub',
                outboundLane: 'return lane',
              }[stages.find((s) => s.id === chartStage)!.groupBy]
            }
            . Each group has its own limits, so a slow lane is judged against itself, not against the network average.
          </p>
          <div className="segmented stage-pick" role="group" aria-label="Stage">
            {stages.map((s) => (
              <button key={s.id} aria-pressed={chartStage === s.id} onClick={() => setChartStage(s.id)}>
                {s.short}
              </button>
            ))}
          </div>
          {chart ? <ControlChart groups={chart.slice(0, 8)} onOpen={setOpenId} /> : <p className="empty">Loading chart…</p>}
          <div className="split trend-split">
            <div>
              <h3>Units beyond their limit, week by week</h3>
              <TrendChart trend={o.stagnantTrend} />
            </div>
            <div className="method">
              <h3>How the limits work</h3>
              <p>
                For each stage and group, the limit is the average plus 2.66 times the average moving range of the last 12 months of
                completed units: the standard individuals (I-MR) chart. A unit above it has been in its stage longer than that
                lane's normal variation explains, which makes it worth a call.
              </p>
              <p>Groups with fewer than 8 completed units use the limits of the whole stage instead.</p>
            </div>
          </div>
        </section>
      )}

      {tab === 'escalations' && (
        <section>
          <div className="section-head">
            <h2>Escalation queue</h2>
            {state.escalations.length > 0 && (
              <a className="button secondary" href="/api/escalations.csv" download>
                Download CSV for the weekly call
              </a>
            )}
          </div>
          <p className="hint">
            One escalation per unit beyond its limit, largest value first, suggested to the regional logistics owner. Recording the next
            movement closes it. The download shows how long each unit has been in its stage as of today.
          </p>
          <EscalationQueue escalations={state.escalations} stages={stages} onOpen={setOpenId} onChanged={refresh} />
        </section>
      )}

      {tab === 'import' && <ImportPanel columns={state.importColumns} onLoaded={refresh} />}

      <footer className="footer">
        Demo data is synthetic: countries are real, every location, serial number, value and duration is generated. Independent personal project; it contains no information from any former employer.{' '}
        <a href="https://github.com/awaisq5/repair-logistics-control-tower">Source on GitHub</a>
      </footer>

      {openId !== null && <UnitDrawer id={openId} stages={stages} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  )
}
