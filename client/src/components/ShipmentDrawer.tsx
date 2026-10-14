import { useEffect, useRef, useState } from 'react'
import { LEVEL_LABEL, api, days, eur, shortDate, type ShipmentDetail, type StageMeta } from '../api'

interface Props {
  id: number
  stages: StageMeta[]
  onClose: () => void
  onChanged: () => void
}

export function ShipmentDrawer({ id, stages, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<ShipmentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const label = (s: string) => stages.find((x) => x.id === s)?.label ?? s

  const load = () =>
    api
      .shipment(id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))

  useEffect(() => {
    setDetail(null)
    setMessage(null)
    load()
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id])

  async function advance(to: string) {
    setError(null)
    try {
      const { releasedEur } = await api.advance(id, to, note || undefined)
      setNote('')
      setMessage(
        releasedEur > 0
          ? `Moved to ${label(to).toLowerCase()}. The escalation is resolved and ${eur(releasedEur)} is moving again.`
          : `Moved to ${label(to).toLowerCase()}.`,
      )
      await load()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const s = detail?.shipment
  const next = s ? (stages.find((x) => x.id === s.stage)?.next ?? []) : []

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Shipment detail" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="drawer-close" onClick={onClose}>
          Close
        </button>
        {error && <p className="error">{error}</p>}
        {!s ? (
          !error && <p className="empty">Loading shipment…</p>
        ) : (
          <>
            <p className={`pill p-${s.level}`}>{LEVEL_LABEL[s.level]}</p>
            <h2>{s.description}</h2>
            <dl className="waybill">
              <div>
                <dt>Reference</dt>
                <dd>{s.reference}</dd>
              </div>
              <div>
                <dt>Serial</dt>
                <dd>{s.serialNo}</dd>
              </div>
              <div>
                <dt>Value</dt>
                <dd>{eur(s.valueEur)}</dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>{s.origin}</dd>
              </div>
              <div>
                <dt>Repair centre</dt>
                <dd>{s.repairCenter}</dd>
              </div>
              <div>
                <dt>Carrier</dt>
                <dd>{s.carrier}</dd>
              </div>
            </dl>

            <p className="drawer-status">
              {label(s.stage)} for {days(s.daysInStage)}
              {s.daysOverdue > 0 && `, ${days(s.daysOverdue)} past the warning threshold`}
              {s.raisedForValue && '. Raised one level because of its value'}.
            </p>

            {next.length > 0 && (
              <div className="advance">
                <label>
                  Note for the move
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, e.g. AWB 176-12345675" />
                </label>
                <div className="advance-buttons">
                  {next.map((to) => (
                    <button key={to} className="primary" onClick={() => advance(to)}>
                      Move to {label(to).toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {message && <p className="success" role="status">{message}</p>}

            <h3>Journey</h3>
            <ol className="timeline">
              {detail.events.map((e, i) => {
                const end = e.leftAt ? new Date(e.leftAt) : new Date()
                const d = (end.getTime() - new Date(e.enteredAt).getTime()) / 86_400_000
                return (
                  <li key={i} className={e.leftAt ? 'done' : 'current'}>
                    <span className="tl-stage">{label(e.stage)}</span>
                    <span className="tl-when">
                      {shortDate(e.enteredAt)}
                      {e.stage !== 'delivered' && `, ${days(d)}${e.leftAt ? '' : ' so far'}`}
                    </span>
                    {e.note && <span className="tl-note">{e.note}</span>}
                  </li>
                )
              })}
            </ol>

            {detail.escalations.length > 0 && (
              <>
                <h3>Escalations</h3>
                <ul className="esc-history">
                  {detail.escalations.map((e) => (
                    <li key={e.id}>
                      <strong>{e.level === 'critical' ? 'Critical' : 'Escalated'}</strong> in {label(e.stage).toLowerCase()},
                      opened {shortDate(e.openedAt)}
                      {e.resolvedAt ? `, resolved ${shortDate(e.resolvedAt)}` : e.owner ? `, owned by ${e.owner}` : ', unowned'}
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
