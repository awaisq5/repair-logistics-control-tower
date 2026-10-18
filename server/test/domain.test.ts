import { MIN_TECH_LOOPS, STALL_RATIO, pastLoops, techHistory, type LoopRecord } from '../src/domain/history.js'
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

describe('tool type history', () => {
  const DAY = 86_400_000
  const t0 = new Date('2026-01-01T00:00:00Z').getTime()
  /** A completed loop with the given days per stage, starting `start` days after t0. */
  function loop(id: number, techId: string, perStage: number[], start = 0, serialNo = `S${id}`): LoopRecord {
    const fields = ['readyAt', 'dispatchedAt', 'hubReceivedAt', 'workOrderAt', 'repairedAt', 'hubDispatchedAt', 'returnedAt'] as const
    let at = t0 + start * DAY
    const dates: Record<string, Date> = { readyAt: new Date(at) }
    perStage.forEach((d, i) => {
      at += d * DAY
      dates[fields[i + 1]] = new Date(at)
    })
    return { id, techId, serialNo, dates }
  }
  const normal = [10, 10, 5, 20, 5, 10]
  const slowRepair = [10, 10, 5, 40, 5, 10]

  it('flags a stage where a tool type takes far longer than the other tool types', () => {
    const loops = [
      ...Array.from({ length: 6 }, (_, i) => loop(i, 'TID-SLOW', slowRepair)),
      ...Array.from({ length: 20 }, (_, i) => loop(100 + i, `TID-${i % 4}`, normal)),
    ]
    const h = techHistory('TID-SLOW', loops)
    expect(h.loops).toBe(6)
    const repair = h.stages.find((s) => s.stage === 'in_repair')!
    expect(repair).toMatchObject({ techAvgDays: 40, othersAvgDays: 20, ratio: 2, stalls: true })
    expect(h.stages.filter((s) => s.stalls)).toHaveLength(1)
    expect(h.techAvgTotalDays).toBe(80)
    expect(h.othersAvgTotalDays).toBe(60)
  })

  it(`needs ${MIN_TECH_LOOPS} completed loops before calling it a pattern`, () => {
    const loops = [loop(1, 'TID-SLOW', slowRepair), ...Array.from({ length: 10 }, (_, i) => loop(10 + i, 'TID-A', normal))]
    expect(techHistory('TID-SLOW', loops).stages.some((s) => s.stalls)).toBe(false)
    expect(STALL_RATIO).toBe(1.5)
  })

  it('ignores open loops and handles a tool type with no history', () => {
    const open = { id: 9, techId: 'TID-NEW', serialNo: 'S9', dates: { readyAt: new Date(t0) } }
    const h = techHistory('TID-NEW', [open, loop(1, 'TID-A', normal)])
    expect(h.loops).toBe(0)
    expect(h.techAvgTotalDays).toBeNull()
  })

  it('lists earlier loops of the same serial number, newest first, without the current one', () => {
    const loops = [loop(1, 'T', normal, 0, 'S-1'), loop(2, 'T', slowRepair, 100, 'S-1'), loop(3, 'T', normal, 200, 'S-1'), loop(4, 'T', normal, 0, 'S-2')]
    const past = pastLoops('S-1', 3, loops)
    expect(past.map((p) => p.id)).toEqual([2, 1])
    expect(past[0]).toMatchObject({ totalDays: 80, longestStage: 'in_repair', longestDays: 40 })
  })
})
