import { describe, expect, it } from 'vitest'
import { agingBucket, evaluate, validateRule, type SlaPolicy } from '../src/domain/sla.js'
import { nextStages } from '../src/domain/stages.js'

const policy: SlaPolicy = {
  highValueEur: 100_000,
  rules: [{ stage: 'customs', warnAfterDays: 5, escalateAfterDays: 9, criticalAfterDays: 15 }],
}
const now = new Date('2026-10-01T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)

describe('evaluate', () => {
  it.each([
    [2, 'on_track'],
    [5, 'warning'],
    [9, 'escalated'],
    [15, 'critical'],
    [40, 'critical'],
  ])('a normal-value shipment %s days in customs is %s', (days, level) => {
    expect(evaluate({ stage: 'customs', stageEnteredAt: daysAgo(days), valueEur: 20_000 }, policy, now).level).toBe(level)
  })

  it('moves high-value shipments up one level once they breach', () => {
    const result = evaluate({ stage: 'customs', stageEnteredAt: daysAgo(6), valueEur: 150_000 }, policy, now)
    expect(result.level).toBe('escalated')
    expect(result.raisedForValue).toBe(true)
  })

  it('does not raise high-value shipments that are on track', () => {
    expect(evaluate({ stage: 'customs', stageEnteredAt: daysAgo(1), valueEur: 150_000 }, policy, now).level).toBe(
      'on_track',
    )
  })

  it('reports days overdue against the warning threshold', () => {
    const result = evaluate({ stage: 'customs', stageEnteredAt: daysAgo(8), valueEur: 1 }, policy, now)
    expect(result.daysOverdue).toBeCloseTo(3)
  })

  it('treats stages without a rule, and delivered units, as on track', () => {
    expect(evaluate({ stage: 'in_repair', stageEnteredAt: daysAgo(400), valueEur: 1 }, policy, now).level).toBe('on_track')
    expect(evaluate({ stage: 'delivered', stageEnteredAt: daysAgo(400), valueEur: 1 }, policy, now).level).toBe('on_track')
  })
})

describe('validateRule', () => {
  it('requires increasing thresholds', () => {
    expect(validateRule({ stage: 'customs', warnAfterDays: 5, escalateAfterDays: 4, criticalAfterDays: 9 })).toMatch(
      /increase/,
    )
    expect(validateRule({ stage: 'customs', warnAfterDays: 1, escalateAfterDays: 2, criticalAfterDays: 3 })).toBeNull()
  })
})

describe('stages', () => {
  it('lets transit go through customs or skip it', () => {
    expect(nextStages('in_transit_to_repair')).toEqual(['customs', 'awaiting_repair'])
    expect(nextStages('delivered')).toEqual([])
  })

  it('buckets aging by whole days', () => {
    expect(agingBucket(7.9)).toBe('0–7 days')
    expect(agingBucket(8)).toBe('8–14 days')
    expect(agingBucket(45)).toBe('Over 30 days')
  })
})
