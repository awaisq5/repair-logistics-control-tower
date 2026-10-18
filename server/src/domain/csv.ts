/** Minimal CSV writer (RFC 4180 quoting), for exports opened in Excel. */

export type Cell = string | number | boolean | null | undefined

function cell(value: Cell): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Header plus rows, CRLF line endings, and a byte order mark so Excel reads
 * the file as UTF-8 and keeps names like "Société Générale" intact.
 */
export function toCsv(header: readonly string[], rows: Cell[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
