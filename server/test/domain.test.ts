import { toCsv } from '../src/domain/csv.js'
import { describe, expect, it } from 'vitest'
import { importCsv } from '../src/domain/importer.js'
import { controlLimits, evaluateChart, limitsFor, MIN_GROUP_SIZE } from '../src/domain/spc.js'
import { currentStage, groupKey, stageDays, type MovementDates } from '../src/domain/stages.js'

const d = (s: string) => new Date(`${s}T00:00:00Z`)
const route = { sendingCountry: 'Egypt', hubCountry: 'UAE', returnCountry: 'Egypt' }

describe('stages', () => {
  const dates: MovementDates = {
    readyAt: d('2026-01-01'),
    dispatchedAt: d('2026-01-11'),
    hubReceivedAt: d('2026-01-25'),
    workOrderAt: d('2026-01-30'),
  }

  it('finds the current stage as the first one without an end date', () => {
    expect(currentStage(dates)).toBe('in_repair')
    expect(currentStage({ readyAt: d('2026-01-01') })).toBe('pending_at_sender')
  })

  it('measures completed stages, and the open one only when a clock is given', () => {
    expect(stageDays(dates)).toEqual({ pending_at_sender: 10, transit_to_hub: 14, gr_to_work_order: 5 })
    expect(stageDays(dates, d('2026-02-09')).in_repair).toBe(10)
  })

  it('groups each stage by where its delay comes from', () => {
    expect(groupKey('pending_at_sender', route)).toBe('Egypt')
    expect(groupKey('transit_to_hub', route)).toBe('Egypt → UAE')
    expect(groupKey('in_repair', route)).toBe('UAE')
    expect(groupKey('transit_from_hub', route)).toBe('UAE → Egypt')
  })
})

describe('control limits', () => {
  it('matches a hand-calculated I-chart', () => {
    // mean 12, moving ranges 4, 4, 4, 4 -> MR-bar 4, UCL 12 + 2.66 * 4 = 22.64
    const limits = controlLimits([12, 16, 12, 8, 12])!
    expect(limits.mean).toBe(12)
    expect(limits.mrBar).toBe(4)
    expect(limits.ucl).toBeCloseTo(22.64)
    expect(limits.lcl).toBeCloseTo(1.36)
  })

  it('never puts the lower limit below zero days', () => {
    expect(controlLimits([1, 30, 2, 28])!.lcl).toBe(0)
  })

  it('flags points beyond the limits and sustained runs above the mean', () => {
    const values = [10, 11, 9, 10, 40, 10, 9, 11]
    const limits = controlLimits(values)!
    const flagged = evaluateChart(values, limits)
    expect(flagged[4].signals).toContain('above_ucl')

    const shift = evaluateChart([13, 14, 13, 15, 14, 13, 14, 15, 14], { n: 9, mean: 12, mrBar: 1, ucl: 20, lcl: 4 })
    expect(shift[6].signals).toEqual([])
    expect(shift[7].signals).toEqual(['run_above_mean'])
  })

  it('falls back to stage-wide limits when a group has too little history', () => {
    const set = {
      byGroup: { in_repair: { UAE: controlLimits(Array(MIN_GROUP_SIZE).fill(0).map((_, i) => 20 + (i % 3)))!, Brazil: controlLimits([5, 6])! } },
      byStage: { in_repair: controlLimits([10, 20, 30, 40])! },
    }
    expect(limitsFor(set, 'in_repair', 'UAE')!.scope).toBe('group')
    expect(limitsFor(set, 'in_repair', 'Brazil')!.scope).toBe('stage')
    expect(limitsFor(set, 'transit_to_hub', 'X')).toBeNull()
  })
})

describe('import', () => {
  const header =
    'serial_no,tech_id,material,value_eur,sending_country,sending_location,hub_country,hub_location,return_country,ready_at,dispatched_at,hub_received_at,work_order_at,repaired_at,hub_dispatched_at,returned_at'
  const row = (serial: string, dates: string) =>
    `${serial},TID-1,Valve,1000,Egypt,Base,UAE,Hub,Egypt,${dates}`
  const now = d('2026-06-01')

  it('loads clean rows and accepts German dates', () => {
    const r = importCsv([header, row('A1', '01.03.2026,05.03.2026,,,,,')].join('\n'), now)
    expect(r.issues).toEqual([])
    expect(r.units[0].dates.dispatchedAt).toEqual(d('2026-03-05'))
  })

  it('reports dates that go back in time, holes in the chain and future dates, by row', () => {
    const r = importCsv(
      [
        header,
        row('A1', '2026-03-10,2026-03-05,,,,,'),
        row('A2', '2026-03-01,,2026-03-10,,,,'),
        row('A3', '2026-03-01,2026-07-01,,,,,'),
        row('A4', '2026-03-01,,,,,,'),
      ].join('\n'),
      now,
    )
    expect(r.units.map((u) => u.serialNo)).toEqual(['A4'])
    expect(r.issues.map((i) => i.row)).toEqual([2, 3, 4])
    expect(r.issues[0].problem).toMatch(/dispatched_at is before ready_at/)
    expect(r.issues[1].problem).toMatch(/hub_received_at is filled but the earlier dispatched_at is empty/)
    expect(r.issues[2].problem).toMatch(/in the future/)
  })

  it('refuses the same serial number open twice', () => {
    const r = importCsv([header, row('A1', '2026-03-01,,,,,,'), row('A1', '2026-04-01,,,,,,')].join('\n'), now)
    expect(r.issues[0]).toMatchObject({ row: 3, problem: 'serial A1 is already open in row 2' })
  })

  it('names missing columns', () => {
    expect(importCsv('serial_no,tech_id\nA,B', now).issues[0].problem).toMatch(/Missing columns: material/)
  })
})

describe('toCsv', () => {
  it('quotes only cells that need it and keeps accents with a byte order mark', () => {
    const csv = toCsv(['a', 'b', 'c'], [['Société Générale', 'say "hi"', 3], [null, true, 'two\nlines']])
    expect(csv).toBe('﻿a,b,c\r\nSociété Générale,"say ""hi""",3\r\n,yes,"two\nlines"\r\n')
  })
})
