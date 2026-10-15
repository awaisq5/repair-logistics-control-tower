/**
 * Statistical process control for stage durations: individuals (I-MR) charts.
 *
 * Instead of one fixed service level for every lane, each lane and stage gets
 * control limits from its own history. A shipment beyond the upper limit is
 * not just "slow": it is slower than that lane's normal variation explains,
 * which is the signal worth escalating.
 *
 *   centre line  x̄  = mean of individual values
 *   moving range MR̄ = mean of |xᵢ − xᵢ₋₁|
 *   UCL = x̄ + 2.66 · MR̄      (2.66 = 3 / d₂, with d₂ = 1.128 for n = 2)
 *   LCL = max(0, x̄ − 2.66 · MR̄)
 */
export const I_CHART_FACTOR = 2.66

export interface ControlLimits {
  n: number
  mean: number
  mrBar: number
  ucl: number
  lcl: number
}

export function controlLimits(values: number[]): ControlLimits | null {
  if (values.length < 2) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  let mrSum = 0
  for (let i = 1; i < values.length; i++) mrSum += Math.abs(values[i] - values[i - 1])
  const mrBar = mrSum / (values.length - 1)
  return {
    n: values.length,
    mean,
    mrBar,
    ucl: mean + I_CHART_FACTOR * mrBar,
    lcl: Math.max(0, mean - I_CHART_FACTOR * mrBar),
  }
}

export type Signal = 'above_ucl' | 'below_lcl' | 'run_above_mean'

export interface ChartPoint {
  index: number
  value: number
  signals: Signal[]
}

/**
 * Flags special causes with two Western Electric / Nelson rules:
 *  1. a point beyond the control limits;
 *  2. eight points in a row above the centre line (a sustained shift, e.g. a
 *     customs backlog), flagged on the eighth point and every point after it.
 */
export function evaluateChart(values: number[], limits: ControlLimits, runLength = 8): ChartPoint[] {
  let run = 0
  return values.map((value, index) => {
    const signals: Signal[] = []
    if (value > limits.ucl) signals.push('above_ucl')
    else if (value < limits.lcl) signals.push('below_lcl')
    run = value > limits.mean ? run + 1 : 0
    if (run >= runLength) signals.push('run_above_mean')
    return { index, value, signals }
  })
}

export interface LimitsSet {
  /** Limits per stage and group, e.g. limits.in_repair["Romania"]. */
  byGroup: Record<string, Record<string, ControlLimits>>
  /** Fallback per stage when a group has too little history. */
  byStage: Record<string, ControlLimits>
}

/** Minimum completed durations before a group gets its own limits. */
export const MIN_GROUP_SIZE = 8

/** Limits for one stage and group, falling back to the stage-wide limits for thin groups. */
export function limitsFor(set: LimitsSet, stage: string, group: string): { limits: ControlLimits; scope: 'group' | 'stage' } | null {
  const own = set.byGroup[stage]?.[group]
  if (own && own.n >= MIN_GROUP_SIZE) return { limits: own, scope: 'group' }
  const fallback = set.byStage[stage]
  return fallback ? { limits: fallback, scope: 'stage' } : null
}
