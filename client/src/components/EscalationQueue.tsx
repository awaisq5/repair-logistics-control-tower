import { useState } from 'react'
import { api, days, eur, shortDate, type Escalation, type StageMeta } from '../api'

interface Props {
  escalations: Escalation[]
  stages: StageMeta[]
  now: Date
  onOpen: (shipmentId: number) => void
  onChanged: () => void
}

export function EscalationQueue({ escalations, stages, now, onOpen, onChanged }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const label = (id: string) => stages.find((s) => s.id === id)?.label ?? id

  if (!escalations.length) {
    return <p className="empty">No open escalations. Every shipment is inside its escalation threshold.</p>
  }

  return (
    <ol className="queue">
      {escalations.map((e) => {
        const age = (now.getTime() - new Date(e.openedAt).getTime()) / 86_400_000
        const isOpen = expanded === e.id
        return (
          <li key={e.id} className={`ticket ticket-${e.level}`}>
            <button className="ticket-head" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : e.id)}>
              <span className="ticket-level">{e.level === 'critical' ? 'Critical' : 'Escalated'}</span>
              <span className="ticket-main">
                <span className="ticket-ref">{e.reference}</span> {e.description}
                <span className="ticket-sub">
                  {label(e.stage)} with {e.carrier}, escalated {shortDate(e.openedAt)} ({days(age)} ago)
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

function TicketActions({
  escalation: e,
  onOpen,
  onChanged,
}: {
  escalation: Escalation
  onOpen: (id: number) => void
  onChanged: () => void
}) {
  const [owner, setOwner] = useState('')
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
            <input value={owner} onChange={(ev) => setOwner(ev.target.value)} placeholder="Your name" required />
          </label>
          <label className="grow">
            First action
            <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Optional, e.g. called the broker" />
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
            <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. carrier confirmed new ETA" required />
          </label>
          <button className="primary" disabled={busy}>
            Mark resolved
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={() => onOpen(e.shipmentId)}>
        Open shipment {e.reference}
      </button>
    </div>
  )
}
