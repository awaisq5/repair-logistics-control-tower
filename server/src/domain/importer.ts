import { parse } from 'csv-parse/sync'
import { DATE_FIELDS, type DateField } from './stages.js'

/**
 * Reads an R&R movement export (one row per unit per repair loop) and checks it
 * before it touches the database. Real exports are messy: dates missing in the
 * middle of the chain, receipts dated before dispatch, the same serial number
 * open twice. Every problem is reported with its row, and only clean rows load.
 */

export const DATE_COLUMNS: Record<DateField, string> = {
  readyAt: 'ready_at',
  dispatchedAt: 'dispatched_at',
  hubReceivedAt: 'hub_received_at',
  workOrderAt: 'work_order_at',
  repairedAt: 'repaired_at',
  hubDispatchedAt: 'hub_dispatched_at',
  returnedAt: 'returned_at',
}

export const REQUIRED_COLUMNS = [
  'serial_no',
  'tech_id',
  'material',
  'value_eur',
  'sending_country',
  'sending_location',
  'hub_country',
  'hub_location',
  'return_country',
  'ready_at',
] as const

export interface ImportedUnit {
  serialNo: string
  techId: string
  material: string
  valueEur: number
  sendingCountry: string
  sendingLocation: string
  hubCountry: string
  hubLocation: string
  returnCountry: string
  dates: Record<DateField, Date | null>
}

export interface ImportIssue {
  row: number
  serialNo: string
  problem: string
}

export interface ImportResult {
  units: ImportedUnit[]
  issues: ImportIssue[]
  rowsRead: number
}

function parseDate(raw: string | undefined): Date | null | 'invalid' {
  const value = (raw ?? '').trim()
  if (!value) return null
  // Accept ISO dates and the German DD.MM.YYYY that SAP exports often use.
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value)
  const iso = german ? `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}` : value
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return Number.isNaN(date.getTime()) ? 'invalid' : date
}

export function importCsv(text: string, now: Date = new Date()): ImportResult {
  let records: Record<string, string>[]
  try {
    records = parse(text, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true })
  } catch (error) {
    return { units: [], issues: [{ row: 0, serialNo: '', problem: `The file is not valid CSV: ${(error as Error).message}` }], rowsRead: 0 }
  }
  const header = Object.keys(records[0] ?? {})
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length) {
    return {
      units: [],
      issues: [{ row: 1, serialNo: '', problem: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` }],
      rowsRead: records.length,
    }
  }

  const units: ImportedUnit[] = []
  const issues: ImportIssue[] = []
  const openSerials = new Map<string, number>()

  records.forEach((r, i) => {
    const row = i + 2 // header is row 1
    const serialNo = r.serial_no ?? ''
    const problems: string[] = []

    for (const col of REQUIRED_COLUMNS) if (!r[col]) problems.push(`${col} is empty`)
    const value = Number(r.value_eur)
    if (r.value_eur && !(value >= 0)) problems.push(`value_eur "${r.value_eur}" is not a number`)

    const dates = {} as Record<DateField, Date | null>
    for (const field of DATE_FIELDS) {
      const parsed = parseDate(r[DATE_COLUMNS[field]])
      if (parsed === 'invalid') {
        problems.push(`${DATE_COLUMNS[field]} "${r[DATE_COLUMNS[field]]}" is not a date`)
        dates[field] = null
      } else {
        dates[field] = parsed
      }
    }

    // The chain must have no holes and must not go back in time.
    let previous: { field: DateField; date: Date } | null = null
    let firstMissing: DateField | null = null
    for (const field of DATE_FIELDS) {
      const d = dates[field]
      if (!d) {
        firstMissing ??= field
        continue
      }
      if (firstMissing) {
        problems.push(`${DATE_COLUMNS[field]} is filled but the earlier ${DATE_COLUMNS[firstMissing]} is empty`)
        break
      }
      if (previous && d < previous.date) {
        problems.push(`${DATE_COLUMNS[field]} is before ${DATE_COLUMNS[previous.field]}`)
      }
      if (d > now) problems.push(`${DATE_COLUMNS[field]} is in the future`)
      previous = { field, date: d }
    }

    const open = !dates.returnedAt
    if (open && serialNo) {
      const earlier = openSerials.get(serialNo)
      if (earlier) problems.push(`serial ${serialNo} is already open in row ${earlier}`)
      else openSerials.set(serialNo, row)
    }

    if (problems.length) {
      issues.push({ row, serialNo, problem: problems.join('; ') })
      return
    }
    units.push({
      serialNo,
      techId: r.tech_id,
      material: r.material,
      valueEur: value,
      sendingCountry: r.sending_country,
      sendingLocation: r.sending_location,
      hubCountry: r.hub_country,
      hubLocation: r.hub_location,
      returnCountry: r.return_country,
      dates,
    })
  })

  return { units, issues, rowsRead: records.length }
}
