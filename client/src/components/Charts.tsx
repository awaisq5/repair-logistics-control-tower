import { useMemo, useState } from 'react'
import { STAGE_COLOURS, days, eurShort, shortDate, type ChartGroup, type CountryBar, type Lane, type Overview, type StageMeta } from '../api'

/** The R&R loop as six steps, each with the units and value sitting in it right now. */
export function LoopStrip({ stages, byStage, onPick }: { stages: StageMeta[]; byStage: Overview['byStage']; onPick: (s: StageMeta) => void }) {
  return (
    <ol className="loop" aria-label="Units in each stage of the repair loop">
      {stages.map((s, i) => {
        const row = byStage.find((b) => b.stage === s.id)
        return (
          <li key={s.id}>
            <button className="loop-step" onClick={() => onPick(s)} style={{ borderTopColor: STAGE_COLOURS[s.id] }}>
              <span className="loop-n">{i + 1}</span>
              <span className="loop-name">{s.short}</span>
              <span className="loop-units">{row?.units ?? 0}</span>
              <span className="loop-value">{eurShort(row?.valueEur ?? 0)}</span>
              {row && row.beyondLimit > 0 && <span className="loop-flag">{row.beyondLimit} beyond limit</span>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/** Average days per country as a bar, with the unit count beside it; the live view of the dashboard. */
export function CountryBars({ rows, unit, selected, onSelect }: { rows: CountryBar[]; unit: string; selected: string | null; onSelect: (c: string | null) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.avgDays))
  if (!rows.length) return <p className="empty">Nothing in this stage right now.</p>
  return (
    <ul className="cbars">
      {rows.map((r) => (
        <li key={r.country}>
          <button
            className={selected === r.country ? 'cbar active' : 'cbar'}
            aria-pressed={selected === r.country}
            onClick={() => onSelect(selected === r.country ? null : r.country)}
          >
            <span className="cbar-name">{r.country}</span>
            <span className="cbar-track">
              <span className="cbar-fill" style={{ width: `${(r.avgDays / max) * 100}%` }} />
            </span>
            <span className="cbar-days">{days(r.avgDays)}</span>
            <span className="cbar-units">
              {r.units} {r.units === 1 ? unit.replace(/s$/, '') : unit}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Where on each lane the time goes: average days per stage, stacked. */
export function LaneChart({ lanes, stages }: { lanes: Lane[]; stages: StageMeta[] }) {
  const max = Math.max(1, ...lanes.map((l) => l.totalDays))
  return (
    <figure className="lanes">
      <ul className="lane-legend">
        {stages.map((s) => (
          <li key={s.id}>
            <i style={{ background: STAGE_COLOURS[s.id] }} />
            {s.short}
          </li>
        ))}
      </ul>
      <div className="lane-rows">
        {lanes.map((l) => (
          <div className="lane-row" key={l.lane}>
            <span className="lane-name">{l.lane}</span>
            <span className="lane-bar" role="img" aria-label={`${l.lane}: ${Math.round(l.totalDays)} days door to door`}>
              {stages.map((s) => {
                const d = l.avgDays[s.id] ?? 0
                if (d <= 0) return null
                return (
                  <span
                    key={s.id}
                    className="lane-seg"
                    title={`${s.short}: ${days(d)}`}
                    style={{ width: `${(d / max) * 100}%`, background: STAGE_COLOURS[s.id] }}
                  >
                    {(d / max) * 100 > 6 ? Math.round(d) : ''}
                  </span>
                )
              })}
            </span>
            <span className="lane-total">{Math.round(l.totalDays)} d</span>
            <span className="lane-n">{l.units} units</span>
          </div>
        ))}
      </div>
    </figure>
  )
}

/**
 * Individuals chart by group, the way Minitab draws "I-chart by stages":
 * groups side by side, each with its own centre line and limits, special
 * causes in red.
 */
export function ControlChart({ groups, onOpen }: { groups: ChartGroup[]; onOpen: (id: number) => void }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const layout = useMemo(() => {
    const W = 1120
    const H = 340
    const pad = { l: 46, r: 12, t: 30, b: 28 }
    const total = groups.reduce((a, g) => a + g.points.length, 0)
    const yMax = Math.max(10, ...groups.flatMap((g) => [g.limits?.ucl ?? 0, ...g.points.map((p) => p.days)])) * 1.08
    const step = (W - pad.l - pad.r) / Math.max(1, total)
    let offset = 0
    const placed = groups.map((g) => {
      const x0 = pad.l + offset * step
      offset += g.points.length
      return { g, x0, x1: pad.l + offset * step }
    })
    const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b)
    return { W, H, pad, step, yMax, placed, y }
  }, [groups])

  if (!groups.length) return <p className="empty">Not enough completed history for this stage yet.</p>
  const { W, H, pad, step, yMax, placed, y } = layout
  const ticks = niceTicks(yMax)

  return (
    <figure className="spc">
      <div className="spc-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Individuals control chart by group">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="spc-grid" />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="spc-axis">
                {t}
              </text>
            </g>
          ))}
          {placed.map(({ g, x0, x1 }, gi) => (
            <g key={g.group}>
              {gi > 0 && <line x1={x0} x2={x0} y1={pad.t - 18} y2={H - pad.b} className="spc-divider" />}
              <text x={x0 + 4} y={pad.t - 8} className="spc-group">
                {g.group}
              </text>
              {g.limits && (
                <>
                  <line x1={x0} x2={x1} y1={y(g.limits.ucl)} y2={y(g.limits.ucl)} className="spc-ucl" />
                  <line x1={x0} x2={x1} y1={y(g.limits.mean)} y2={y(g.limits.mean)} className="spc-mean" />
                  {g.limits.lcl > 0 && <line x1={x0} x2={x1} y1={y(g.limits.lcl)} y2={y(g.limits.lcl)} className="spc-ucl" />}
                </>
              )}
              <polyline
                className="spc-line"
                points={g.points.map((p, i) => `${x0 + (i + 0.5) * step},${y(p.days)}`).join(' ')}
              />
              {g.points.map((p, i) => {
                const flagged = p.signals.length > 0
                const cx = x0 + (i + 0.5) * step
                return (
                  <circle
                    key={p.id}
                    cx={cx}
                    cy={y(p.days)}
                    r={flagged ? 4 : 2.2}
                    className={flagged ? 'spc-pt flagged' : 'spc-pt'}
                    tabIndex={flagged ? 0 : -1}
                    onMouseEnter={() =>
                      setHover({
                        x: cx,
                        y: y(p.days),
                        text: `${p.serialNo}: ${days(p.days)}, done ${shortDate(p.end)}${flagged ? ' (special cause)' : ''}`,
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onOpen(p.id)}
                  >
                    <title>{`${g.group} · ${p.serialNo}: ${days(p.days)}`}</title>
                  </circle>
                )
              })}
            </g>
          ))}
          {hover && (
            <text x={Math.min(hover.x + 8, W - 260)} y={Math.max(hover.y - 8, 14)} className="spc-tip">
              {hover.text}
            </text>
          )}
        </svg>
      </div>
      <figcaption>
        <span className="key key-line" /> Centre line (average)
        <span className="key key-ucl" /> Control limits (average ± 2.66 × average moving range)
        <span className="key key-flag" /> Special cause: beyond the limit, or 8 in a row above average
      </figcaption>
    </figure>
  )
}

/** Units beyond their limit at each week's end. */
export function TrendChart({ trend }: { trend: Overview['stagnantTrend'] }) {
  const W = 520
  const H = 150
  const pad = { l: 30, r: 10, t: 12, b: 22 }
  const max = Math.max(5, ...trend.map((t) => t.stagnant))
  const x = (i: number) => pad.l + (i / Math.max(1, trend.length - 1)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const pts = trend.map((t, i) => `${x(i)},${y(t.stagnant)}`).join(' ')
  const first = trend[0]
  const last = trend.at(-1)
  return (
    <figure className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stagnant units per week">
        {niceTicks(max).map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="spc-grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="spc-axis">
              {t}
            </text>
          </g>
        ))}
        <polyline points={pts} className="trend-line" />
        {first && (
          <text x={pad.l} y={H - 4} className="spc-axis">
            {shortDate(first.weekEnding)}
          </text>
        )}
        {last && (
          <>
            <circle cx={x(trend.length - 1)} cy={y(last.stagnant)} r={4} className="trend-end" />
            <text x={W - pad.r} y={H - 4} textAnchor="end" className="spc-axis">
              {shortDate(last.weekEnding)}
            </text>
          </>
        )}
      </svg>
    </figure>
  )
}

function niceTicks(max: number): number[] {
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = 0; v <= max; v += step) out.push(Math.round(v))
  return out
}
