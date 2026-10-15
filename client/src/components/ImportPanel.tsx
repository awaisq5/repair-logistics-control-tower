import { useState } from 'react'
import { api, type ImportReport } from '../api'

export function ImportPanel({ columns, onLoaded }: { columns: string[]; onLoaded: () => void }) {
  const [csv, setCsv] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function check(text: string) {
    setError(null)
    try {
      setReport(await api.importCsv(text, true))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function load() {
    if (!csv) return
    try {
      setReport(await api.importCsv(csv, false))
      onLoaded()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function template() {
    const blob = new Blob([`${columns.join(',')}\n`], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'rr-movements-template.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <section className="import">
      <h2>Load movement data</h2>
      <p className="lede">
        One row per unit and repair loop, with the seven movement dates. Dates may be ISO{' '}
        <span className="nowrap">(2026-03-05)</span> or German <span className="nowrap">(05.03.2026)</span>. The file is
        checked first; rows with problems are listed and never loaded.
      </p>
      <div className="import-actions">
        <label className="upload">
          Choose CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const text = await f.text()
              setFileName(f.name)
              setCsv(text)
              check(text)
              e.target.value = ''
            }}
          />
        </label>
        <button className="link" onClick={template}>
          Download an empty template
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <div className="import-report">
          <p>
            <strong>{fileName}</strong>: {report.rowsRead} rows read, {report.valid} clean,{' '}
            {report.issues.length} with problems.
            {!report.dryRun && ` Loaded ${report.inserted}; ${report.skipped} skipped because the serial is already open.`}
          </p>
          {report.dryRun && report.valid > 0 && (
            <button className="primary" onClick={load}>
              Load {report.valid} clean {report.valid === 1 ? 'row' : 'rows'}
            </button>
          )}
          {report.issues.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="n">Row</th>
                  <th>Serial</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {report.issues.slice(0, 50).map((i) => (
                  <tr key={i.row}>
                    <td className="n">{i.row}</td>
                    <td>{i.serialNo}</td>
                    <td>{i.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <details className="columns">
        <summary>Expected columns</summary>
        <code>{columns.join(', ')}</code>
      </details>
    </section>
  )
}
