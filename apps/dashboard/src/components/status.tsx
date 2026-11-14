// SPDX-License-Identifier: Apache-2.0
/** Status chips: every state is colour plus icon plus word. */
import {
  ArrowDown,
  ArrowUp,
  Ban,
  BookOpenCheck,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Equal,
  Eye,
  EyeOff,
  Info,
  type LucideIcon,
  Pin,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import type { DoctorCheck, HealthState, LogResult, RuleAction } from '../lib/contract.ts'
import { ruleActionLabel } from '../lib/labels.ts'
import { Chip, type Tone } from './ui/Chip.tsx'

const DECISIONS: Record<LogResult['decision'], { tone: Tone; icon: LucideIcon; label: string }> = {
  kept: { tone: 'ok', icon: CircleCheck, label: 'Kept' },
  hidden: { tone: 'danger', icon: EyeOff, label: 'Hidden' },
  pinned: { tone: 'info', icon: Pin, label: 'Pinned' },
}

export function DecisionChip({ decision }: { decision: LogResult['decision'] }) {
  const d = DECISIONS[decision] ?? { tone: 'neutral' as const, icon: CircleHelp, label: decision }
  return (
    <Chip tone={d.tone} icon={d.icon}>
      {d.label}
    </Chip>
  )
}

/**
 * For a result the assistant was shown: did it open the page, or only see it in its results?
 * (A hidden result was never shown, so its decision chip already says everything.)
 */
export function OpenedMark({ opened }: { opened: boolean }) {
  const Icon = opened ? BookOpenCheck : Eye
  return (
    <span
      title={
        opened
          ? 'The assistant opened this page in the same session'
          : 'In the results the assistant got; it did not open this page'
      }
      className={
        opened
          ? 'flex items-center gap-1 text-xs font-medium text-fg'
          : 'flex items-center gap-1 text-xs text-fg-muted'
      }
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {opened ? 'Opened' : 'Seen'}
    </span>
  )
}

const HEALTH: Record<HealthState, { tone: Tone; icon: LucideIcon; label: string }> = {
  healthy: { tone: 'ok', icon: CircleCheck, label: 'Healthy' },
  unknown: { tone: 'neutral', icon: CircleHelp, label: 'Unknown' },
  unhealthy: { tone: 'danger', icon: CircleAlert, label: 'Unhealthy' },
}

export function HealthChip({ health }: { health: HealthState }) {
  const h = HEALTH[health] ?? HEALTH.unknown
  return (
    <Chip tone={h.tone} icon={h.icon}>
      {h.label}
    </Chip>
  )
}

const CHECKS: Record<DoctorCheck['status'], { tone: Tone; icon: LucideIcon; label: string }> = {
  ok: { tone: 'ok', icon: CircleCheck, label: 'OK' },
  warn: { tone: 'warn', icon: TriangleAlert, label: 'Warning' },
  fail: { tone: 'danger', icon: CircleX, label: 'Failed' },
  info: { tone: 'info', icon: Info, label: 'Info' },
}

export function CheckChip({ status }: { status: DoctorCheck['status'] }) {
  const c = CHECKS[status] ?? CHECKS.info
  return (
    <Chip tone={c.tone} icon={c.icon}>
      {c.label}
    </Chip>
  )
}

const ACTIONS: Record<RuleAction, { tone: Tone; icon: LucideIcon }> = {
  block: { tone: 'danger', icon: Ban },
  allow: { tone: 'ok', icon: ShieldCheck },
  pin: { tone: 'info', icon: Pin },
  raise: { tone: 'neutral', icon: ArrowUp },
  lower: { tone: 'neutral', icon: ArrowDown },
  normal: { tone: 'neutral', icon: Equal },
}

export const ACTION_ICONS: Record<RuleAction, LucideIcon> = {
  block: Ban,
  allow: ShieldCheck,
  pin: Pin,
  raise: ArrowUp,
  lower: ArrowDown,
  normal: Equal,
}

export function ActionChip({ action, weight }: { action: string; weight?: number }) {
  const a = ACTIONS[action as RuleAction] ?? { tone: 'neutral' as const, icon: CircleHelp }
  const showWeight = (action === 'raise' || action === 'lower') && weight !== undefined
  return (
    <Chip tone={a.tone} icon={a.icon}>
      {ruleActionLabel(action)}
      {showWeight ? <span className="tabular ms-1 font-mono">{weight}</span> : null}
    </Chip>
  )
}
