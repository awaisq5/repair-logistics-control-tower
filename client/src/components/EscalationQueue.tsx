import { useState } from 'react'
import { api, days, eur, shortDate, type Escalation, type StageMeta } from '../api'

interface Props {
  escalations: Escalation[]
  stages: StageMeta[]
  onOpen: (unitId: number) => void
  onChanged: () => void
}

export function EscalationQueue({ escalations, stages, onOpen, onChanged }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const label = (id: string) => stages.find((s) => s.id === id)?.short ?? id

  if (!escalations.length) {
    return <p className="empty">No open escalations. Every unit is inside its lane's control limit.</p>
  }

  return (
    <ol className="queue">
      {escalations.map((e) => {
        const isOpen = expanded === e.id
        return (
          <li key={e.id} className={`ticket ${e.status === 'open' ? 'ticket-open' : 'ticket-owned'}`}>
            <button className="ticket-head" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : e.id)}>
              <span className="ticket-level">{label(e.stage)}</span>
              <span className="ticket-main">
                <span className="ticket-ref">{e.serialNo}</span> {e.material}
                <span className="ticket-sub">
                  {e.groupKey}: {days(e.daysAtOpen)} against a limit of {days(e.limitDays)}, escalated {shortDate(e.openedAt)}
                </span>
              </span>
              <span className="ticket-value">{eur(e.valueEur)}</span>
              <span className={`ticket-status s-${e.status}`}>
                {e.status === 'acknowledged' ? `Owned by ${e.owner}` : 'Unowned'}
              </span>
            </button>
            {isOpen && <TicketActions escalation={e} onOpen={onOpen} onChanged={onChanged} />}
          </li>
        )
      })}
    </ol>
  )
}

function TicketActions({ escalation: e, onOpen, onChanged }: { escalation: Escalation; onOpen: (id: number) => void; onChanged: () => void }) {
  const [owner, setOwner] = useState(e.regionOwner ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ticket-body">
      {e.regionOwner && e.status === 'open' && (
        <p className="ticket-note">Regional logistics owner for this location: {e.regionOwner}.</p>
      )}
      {e.note && <p className="ticket-note">{e.note}</p>}
      {e.status === 'open' ? (
        <form
          className="inline-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            run(() => api.acknowledge(e.id, owner, note || undefined))
          }}
        >
          <label>
            Owner
            <input value={owner} onChange={(ev) => setOwner(ev.target.value)} required />
          </label>
          <label className="grow">
            First action
            <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. asked the regional team for the reason" />
          </label>
          <button className="primary" disabled={busy}>
            Take ownership
          </button>
        </form>
      ) : (
        <form
          className="inline-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            run(() => api.resolve(e.id, note))
          }}
        >
          <label className="grow">
            How was it resolved?
            <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. shipment expedited after export licence" required />
          </label>
          <button className="primary" disabled={busy}>
            Mark resolved
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={() => onOpen(e.repairOrderId)}>
        Open unit {e.serialNo}
      </button>
    </div>
  )
}
