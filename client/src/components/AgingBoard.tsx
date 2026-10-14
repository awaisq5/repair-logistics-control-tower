import type { Shipment, SlaRule, StageMeta } from '../api'
import { LEVEL_LABEL, days, eur } from '../api'

const MAX_DAYS = 60
const ROW_H = 46
const LABEL_W = 168
const W = 1000

interface Props {
  stages: StageMeta[]
  rules: SlaRule[]
  shipments: Shipment[]
  highValueEur: number
  onOpen: (id: number) => void
}

/**
 * One row per stage. Each tick is a shipment, placed by how long it has sat in
 * that stage, over the stage's own SLA zones. Ticks past 60 days pile up at the edge.
 */
export function AgingBoard({ stages, rules, shipments, highValueEur, onOpen }: Props) {
  const open = stages.filter((s) => s.id !== 'delivered')
  const plotW = W - LABEL_W - 16
  const x = (d: number) => LABEL_W + (Math.min(d, MAX_DAYS) / MAX_DAYS) * plotW
  const H = open.length * ROW_H + 30
  const maxValue = Math.max(...shipments.map((s) => s.valueEur), 1)

  return (
    <figure className="board">
      <div className="board-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Shipments by days in their current stage">
          {open.map((stage, row) => {
            const rule = rules.find((r) => r.stage === stage.id)
            const y = row * ROW_H
            const inStage = shipments.filter((s) => s.stage === stage.id)
            return (
              <g key={stage.id}>
                {rule && (
                  <g aria-hidden="true">
                    <rect x={x(0)} y={y + 6} width={x(rule.warnAfterDays) - x(0)} height={ROW_H - 12} className="zone z-ok" />
                    <rect x={x(rule.warnAfterDays)} y={y + 6} width={x(rule.escalateAfterDays) - x(rule.warnAfterDays)} height={ROW_H - 12} className="zone z-warn" />
                    <rect x={x(rule.escalateAfterDays)} y={y + 6} width={x(rule.criticalAfterDays) - x(rule.escalateAfterDays)} height={ROW_H - 12} className="zone z-esc" />
                    <rect x={x(rule.criticalAfterDays)} y={y + 6} width={x(MAX_DAYS) - x(rule.criticalAfterDays)} height={ROW_H - 12} className="zone z-crit" />
                  </g>
                )}
                <text x={0} y={y + ROW_H / 2 + 1} className="row-label">
                  {stage.label}
                </text>
                <text x={LABEL_W - 14} y={y + ROW_H / 2 + 1} className="row-count" textAnchor="end">
                  {inStage.length}
                </text>
                {inStage.map((s) => {
                  const h = 10 + 18 * Math.sqrt(s.valueEur / maxValue)
                  return (
                    <g
                      key={s.id}
                      className={`tick t-${s.level}`}
                      tabIndex={0}
                      role="button"
                      aria-label={`${s.reference}, ${s.description}, ${days(s.daysInStage)} in ${stage.label}, ${LEVEL_LABEL[s.level]}`}
                      onClick={() => onOpen(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(s.id)
                        }
                      }}
                    >
                      <title>{`${s.reference}: ${s.description}\n${days(s.daysInStage)} in stage, ${eur(s.valueEur)}${s.valueEur >= highValueEur ? ' (high value)' : ''}`}</title>
                      <rect x={x(s.daysInStage) - 6} y={y + 2} width={12} height={ROW_H - 4} className="tick-hit" />
                      <rect
                        x={x(s.daysInStage) - (s.level === 'on_track' ? 1.5 : 2.5)}
                        y={y + ROW_H / 2 - h / 2}
                        width={s.level === 'on_track' ? 3 : 5}
                        height={h}
                        rx={1.5}
                        className="tick-mark"
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}
          <g className="axis" aria-hidden="true">
            {[0, 7, 14, 21, 28, 35, 42, 49, 60].map((d) => (
              <text key={d} x={x(d)} y={H - 8} textAnchor={d === 60 ? 'end' : 'middle'}>
                {d === 60 ? '60+ days' : d}
              </text>
            ))}
          </g>
        </svg>
      </div>
      <figcaption>
        Each tick is a shipment, taller ticks carry more value. Shaded zones are the SLA for that stage:
        <span className="legend z-ok-k">on track</span>
        <span className="legend z-warn-k">warning</span>
        <span className="legend z-esc-k">escalated</span>
        <span className="legend z-crit-k">critical</span>
      </figcaption>
    </figure>
  )
}
