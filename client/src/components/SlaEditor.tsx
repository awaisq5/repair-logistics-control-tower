import { useEffect, useState } from 'react'
import { api, type Policy, type StageMeta } from '../api'

interface Props {
  policy: Policy
  stages: StageMeta[]
  onSaved: () => void
}

type Field = 'warnAfterDays' | 'escalateAfterDays' | 'criticalAfterDays'

export function SlaEditor({ policy, stages, onSaved }: Props) {
  const [draft, setDraft] = useState(policy)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => setDraft(policy), [policy])

  const label = (id: string) => stages.find((s) => s.id === id)?.label ?? id
  const ordered = stages.map((s) => draft.rules.find((r) => r.stage === s.id)).filter((r) => r !== undefined)

  function update(stage: string, field: Field, value: number) {
    setSaved(false)
    setDraft((d) => ({ ...d, rules: d.rules.map((r) => (r.stage === stage ? { ...r, [field]: value } : r)) }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await api.savePolicy(draft)
      await api.scan()
      setSaved(true)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={save} className="sla-form">
      <table>
        <thead>
          <tr>
            <th>Stage</th>
            <th className="n">Warning after</th>
            <th className="n">Escalate after</th>
            <th className="n">Critical after</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.stage}>
              <td>{label(r.stage)}</td>
              {(['warnAfterDays', 'escalateAfterDays', 'criticalAfterDays'] as Field[]).map((f) => (
                <td key={f} className="n">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label={`${label(r.stage)}, ${f.replace('AfterDays', '')} after days`}
                    value={r[f]}
                    onChange={(e) => update(r.stage, f, Number(e.target.value))}
                  />{' '}
                  d
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <label className="high-value">
        Shipments worth at least
        <input
          type="number"
          min={1000}
          step={1000}
          value={draft.highValueEur}
          onChange={(e) => {
            setSaved(false)
            setDraft({ ...draft, highValueEur: Number(e.target.value) })
          }}
        />
        € move up one level as soon as they breach.
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary">Save rules and re-check shipments</button>
      {saved && <span className="success-inline">Saved. Escalations are up to date.</span>}
    </form>
  )
}
