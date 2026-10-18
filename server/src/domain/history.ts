/**
 * History across lanes: does a tool type (tech ID) keep stalling in the same
 * stage wherever it travels, and how did earlier loops of this serial number go?
 *
 * Control limits are per lane or location, so a tool type that is always slow
 * in repair makes every lane it passes through look a little worse without
 * pointing at the common cause. Comparing the tech ID's completed loops with
 * those of all other tool types, stage by stage, does.
 */
import { STAGE_INFO, daysBetween, stageDays, type MovementDates, type Stage } from './stages.js'

export interface LoopRecord {
  id: number
  serialNo: string
  techId: string
  dates: MovementDates
}

/** A tech ID stage counts as stalling at this multiple of the other tool types' average... */
export const STALL_RATIO = 1.5
/** ...over at least this many completed loops of the tech ID. */
export const MIN_TECH_LOOPS = 5

export interface StageComparison {
  stage: Stage
  techAvgDays: number | null
  othersAvgDays: number | null
  ratio: number | null
  stalls: boolean
}

export interface TechHistory {
  techId: string
  loops: number
  techAvgTotalDays: number | null
  othersAvgTotalDays: number | null
  stages: StageComparison[]
}

export interface PastLoop {
  id: number
  startedAt: Date | null
  returnedAt: Date | null
  totalDays: number | null
  longestStage: Stage | null
  longestDays: number | null
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const completed = (l: LoopRecord) => Boolean(l.dates.readyAt && l.dates.returnedAt)
const total = (l: LoopRecord) => daysBetween(l.dates.readyAt as Date, l.dates.returnedAt as Date)

export function techHistory(techId: string, loops: LoopRecord[]): TechHistory {
  const done = loops.filter(completed)
  const mine = done.filter((l) => l.techId === techId)
  // Compare with the other tool types, so a slow tech ID does not raise its own yardstick.
  const others = done.filter((l) => l.techId !== techId)
  const stages = STAGE_INFO.map((s) => {
    const techAvgDays = avg(mine.map((l) => stageDays(l.dates)[s.id]).filter((d): d is number => d !== undefined))
    const othersAvgDays = avg(others.map((l) => stageDays(l.dates)[s.id]).filter((d): d is number => d !== undefined))
    const ratio = techAvgDays !== null && othersAvgDays ? techAvgDays / othersAvgDays : null
    return {
      stage: s.id,
      techAvgDays,
      othersAvgDays,
      ratio,
      stalls: ratio !== null && ratio >= STALL_RATIO && mine.length >= MIN_TECH_LOOPS,
    }
  })
  return {
    techId,
    loops: mine.length,
    techAvgTotalDays: avg(mine.map(total)),
    othersAvgTotalDays: avg(others.map(total)),
    stages,
  }
}

/** Earlier completed loops of the same serial number, newest first. */
export function pastLoops(serialNo: string, excludeId: number, loops: LoopRecord[]): PastLoop[] {
  return loops
    .filter((l) => l.serialNo === serialNo && l.id !== excludeId && completed(l))
    .map((l) => {
      const days = Object.entries(stageDays(l.dates)) as [Stage, number][]
      const longest = days.reduce<[Stage, number] | null>((best, d) => (!best || d[1] > best[1] ? d : best), null)
      return {
        id: l.id,
        startedAt: (l.dates.readyAt as Date) ?? null,
        returnedAt: (l.dates.returnedAt as Date) ?? null,
        totalDays: total(l),
        longestStage: longest?.[0] ?? null,
        longestDays: longest?.[1] ?? null,
      }
    })
    .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
}
