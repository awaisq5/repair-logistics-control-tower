import { useEffect, useRef, useState } from 'react'
import { STAGE_COLOURS, api, days, eur, shortDate, type StageMeta, type UnitDetail } from '../api'

interface Props {
  id: number
  stages: StageMeta[]
  onClose: () => void
  onChanged: () => void
}

export function UnitDrawer({ id, stages, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<UnitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [at, setAt] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const label = (s: string) => stages.find((x) => x.id === s)

  const load = () =>
    api
      .unit(id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))

  useEffect(() => {
    setDetail(null)
    setMessage(null)
    setError(null)
    load()
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id])

  async function advance() {
    setError(null)
    try {
      const res = await api.advance(id, at ? new Date(`${at}T12:00:00`).toISOString() : undefined, note || undefined)
      const done = label(res.completedStage)?.short.toLowerCase()
      setMessage(
        res.releasedEur > 0
          ? `Recorded: ${done} is complete. The escalation is closed and ${eur(res.releasedEur)} is moving again.`
          : `Recorded: ${done} is complete.`,
      )
      setNote('')
      setAt('')
      await load()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const o = detail?.order
  const live = detail?.live
  const maxDays = Math.max(1, ...(detail?.stages ?? []).map((s) => Math.max(s.days ?? 0, s.ucl ?? 0)))
  const next = live ? stages[stages.findIndex((s) => s.id === live.stage)] : null

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Unit detail" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="drawer-close" onClick={onClose}>
          Close
        </button>
        {error && <p className="error">{error}</p>}
        {!o ? (
          !error && <p className="empty">Loading unit…</p>
        ) : (
          <>
            <p className={live?.beyondLimit ? 'pill p-beyond' : live ? 'pill p-ok' : 'pill p-done'}>
              {live ? (live.beyondLimit ? 'Beyond its control limit' : 'Within limits') : 'Returned'}
            </p>
            <h2>{o.material}</h2>
            <dl className="waybill">
              <div>
                <dt>Serial no.</dt>
                <dd>{o.serialNo}</dd>
              </div>
              <div>
                <dt>Tech ID</dt>
                <dd>{o.techId}</dd>
              </div>
              <div>
                <dt>Value</dt>
                <dd>{eur(o.valueEur)}</dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>{o.sendingLocation}</dd>
              </div>
              <div>
                <dt>Repair hub</dt>
                <dd>{o.hubLocation}</dd>
              </div>
              <div>
                <dt>Returns to</dt>
                <dd>{o.returnCountry}</dd>
              </div>
            </dl>

            <h3>The loop so far</h3>
            <p className="hint">Each bar is time spent in a stage. The tick is that stage's upper control limit for this unit's lane or hub.</p>
            <ol className="loop-detail">
              {detail.stages.map((s) => {
                const meta = label(s.stage)!
                const over = s.days !== null && s.ucl !== null && s.days > s.ucl
                const current = live?.stage === s.stage
                return (
                  <li key={s.stage} className={current ? 'current' : s.done ? 'done' : 'todo'}>
                    <span className="ld-name">
                      {meta.short}
                      <span className="ld-group">{s.group}</span>
                    </span>
                    <span className="ld-track">
                      {s.days !== null && (
                        <span
                          className={over ? 'ld-fill over' : 'ld-fill'}
                          style={{ width: `${(s.days / maxDays) * 100}%`, background: over ? undefined : STAGE_COLOURS[s.stage] }}
                        />
                      )}
                      {s.ucl !== null && <span className="ld-ucl" style={{ left: `${(s.ucl / maxDays) * 100}%` }} title={`Limit ${days(s.ucl)}`} />}
                    </span>
                    <span className="ld-days">
                      {s.days === null ? '' : days(s.days)}
                      {current && ' so far'}
                    </span>
                  </li>
                )
              })}
            </ol>

            {live && next && (
              <div className="advance">
                <p className="advance-title">
                  Record the end of <strong>{next.short.toLowerCase()}</strong>
                </p>
                <div className="advance-fields">
                  <label>
                    Date
                    <input type="date" value={at} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setAt(e.target.value)} />
                  </label>
                  <label className="grow">
                    Note
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, e.g. AWB 176-12345675" />
                  </label>
                </div>
                <button className="primary" onClick={advance}>
                  {at ? 'Record movement' : 'Record movement today'}
                </button>
              </div>
            )}
            {message && (
              <p className="success" role="status">
                {message}
              </p>
            )}

            <TechHistory detail={detail} label={(id) => label(id)?.short ?? id} />

            {detail.escalations.length > 0 && (
              <>
                <h3>Escalations</h3>
                <ul className="esc-history">
                  {detail.escalations.map((e) => (
                    <li key={e.id}>
                      {label(e.stage)?.short}, opened {shortDate(e.openedAt)},{' '}
                      {e.status === 'resolved' ? 'resolved' : e.owner ? `owned by ${e.owner}` : 'unowned'}
                      {e.note && <span className="tl-note">{e.note}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  )
}

function TechHistory({ detail, label }: { detail: UnitDetail; label: (stage: string) => string }) {
  const { tech, serial } = detail.history
  const stalls = tech.stages.filter((s) => s.stalls)
  const ratio = (r: number | null) => (r === null ? '' : `${r.toFixed(1)}×`)
  return (
    <>
      <h3>History of {tech.techId}</h3>
      {tech.loops === 0 ? (
        <p className="hint">No completed loops of this tool type yet.</p>
      ) : (
        <>
          <p className="hint">
            {tech.loops} completed {tech.loops === 1 ? 'loop' : 'loops'} of this tool type, on every lane, against all other tool types.
            {tech.techAvgTotalDays !== null && tech.othersAvgTotalDays !== null && (
              <> A loop takes {days(tech.techAvgTotalDays)} on average, against {days(tech.othersAvgTotalDays)}.</>
            )}
          </p>
          {stalls.length > 0 && (
            <p className="stall-note">
              Keeps stalling at {stalls.map((s) => `“${label(s.stage)}”`).join(' and ')}, whatever the lane. That points at the tool type, not
              at one lane or region.
            </p>
          )}
          <table className="history-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="num">This tool type</th>
                <th className="num">Others</th>
                <th className="num">Ratio</th>
              </tr>
            </thead>
            <tbody>
              {tech.stages.map((s) => (
                <tr key={s.stage} className={s.stalls ? 'stalls' : undefined}>
                  <td>{label(s.stage)}</td>
                  <td className="num">{s.techAvgDays === null ? '' : days(s.techAvgDays)}</td>
                  <td className="num">{s.othersAvgDays === null ? '' : days(s.othersAvgDays)}</td>
                  <td className="num">{ratio(s.ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Earlier loops of this serial number</h3>
      {serial.length === 0 ? (
        <p className="hint">This is the first loop recorded for {detail.order.serialNo}.</p>
      ) : (
        <ul className="esc-history">
          {serial.map((l) => (
            <li key={l.id}>
              {l.startedAt ? shortDate(l.startedAt) : '?'} to {l.returnedAt ? shortDate(l.returnedAt) : '?'}: {l.totalDays === null ? '' : days(l.totalDays)}
              {l.longestStage && l.longestDays !== null && (
                <span className="tl-note">
                  Longest stage: {label(l.longestStage)}, {days(l.longestDays)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
