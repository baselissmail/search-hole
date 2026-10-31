// SPDX-License-Identifier: Apache-2.0
/**
 * Engines (§8.3 v1): one card per engine with health, why it is inactive, where its key comes
 * from (never the key, ADR-0007), the last error and any suspension; then the doctor's checks.
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  CircleAlert,
  KeyRound,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Server,
  Stethoscope,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { CheckChip, HealthChip } from '../../components/status.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Card, PageHeader } from '../../components/ui/Card.tsx'
import { Chip } from '../../components/ui/Chip.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { messageOf } from '../../lib/api.ts'
import type { DoctorCheck, EngineStatus } from '../../lib/contract.ts'
import { formatDateTime } from '../../lib/format.ts'
import { engineName, errorLabel, inactiveLabel } from '../../lib/labels.ts'
import { useDoctor, useEngines } from '../../lib/queries.ts'
import { probeEngines } from '../../lib/ruleActions.ts'
import { usePageTitle } from '../../lib/usePageTitle.ts'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-end text-xs text-fg">{children}</dd>
    </div>
  )
}

function EngineCard({ engine }: { engine: EngineStatus }) {
  const name = engineName(engine.engine)
  const state = !engine.configured ? (
    <Chip tone="neutral" icon={PowerOff}>
      Not set up
    </Chip>
  ) : engine.active ? (
    <Chip tone="ok" icon={Power}>
      Active
    </Chip>
  ) : (
    <Chip tone="warn" icon={PowerOff}>
      Inactive
    </Chip>
  )
  return (
    <li className="flex flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{name}</h2>
          <p className="font-mono text-xs text-fg-muted">{engine.engine}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {state}
          {engine.configured ? <HealthChip health={engine.health} /> : null}
        </div>
      </div>
      <dl className="divide-y divide-border px-4 py-1">
        {engine.inactiveReason ? (
          <Fact label="Why inactive">{inactiveLabel(engine.inactiveReason)}</Fact>
        ) : null}
        <Fact label="Key">
          {engine.keySource ? (
            <span className="inline-flex items-center gap-1.5" title={engine.keySource}>
              <KeyRound aria-hidden="true" className="size-3 text-fg-muted" />
              {engine.keySource}
            </span>
          ) : (
            <span className="text-fg-muted">None</span>
          )}
        </Fact>
        {engine.lastError ? (
          <Fact label="Last error">
            <span className="text-danger">{errorLabel(engine.lastError)}</span>
          </Fact>
        ) : null}
        {engine.suspendedUntil ? (
          <Fact label="Suspended until">
            <time dateTime={engine.suspendedUntil}>{formatDateTime(engine.suspendedUntil)}</time>
          </Fact>
        ) : null}
        {engine.reachable === false ? (
          <Fact label="Endpoint">
            <span className="text-danger">Not answering</span>
          </Fact>
        ) : null}
        {engine.attribution ? (
          <Fact label="Attribution">
            <span title={engine.attribution}>{engine.attribution}</span>
          </Fact>
        ) : null}
      </dl>
    </li>
  )
}

function DoctorItem({ check }: { check: DoctorCheck }) {
  return (
    <li className="grid gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[6.5rem_1fr]">
      <div>
        <CheckChip status={check.status} />
      </div>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-fg">{check.title}</p>
        {check.detail ? <p className="mt-0.5 text-[13px] break-words text-fg-muted">{check.detail}</p> : null}
        {check.fix ? (
          <p className="mt-1.5 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs break-words text-fg">
            <span className="font-sans text-fg-muted">Fix: </span>
            {check.fix}
          </p>
        ) : null}
      </div>
    </li>
  )
}

function DoctorSection() {
  const doctor = useDoctor()
  const order: Record<DoctorCheck['status'], number> = { fail: 0, warn: 1, info: 2, ok: 3 }
  const checks = [...(doctor.data?.checks ?? [])].sort((a, b) => order[a.status] - order[b.status])
  return (
    <Card
      id="doctor"
      title="Checks"
      description="The same checks as searchhole doctor: Node, hooks, engines, keys and files."
    >
      {doctor.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true">
          <span className="sr-only">Running the checks…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-4 w-16 rounded-full" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : doctor.isError ? (
        <div role="alert" className="flex items-center justify-between gap-3 p-4 text-[13px] text-danger">
          <span className="flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4" />
            {messageOf(doctor.error)}
          </span>
          <Button size="sm" onClick={() => void doctor.refetch()}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : checks.length === 0 ? (
        <EmptyState icon={Stethoscope} title="No checks reported" />
      ) : (
        <>
          <ul aria-label="Checks" className="divide-y divide-border">
            {checks.map((check) => (
              <DoctorItem key={check.id} check={check} />
            ))}
          </ul>
          {doctor.data ? (
            <dl className="grid gap-x-6 gap-y-1 border-t border-border px-4 py-3 text-xs sm:grid-cols-2">
              {Object.entries(doctor.data.paths).map(([name, path]) => (
                <div key={name} className="flex min-w-0 gap-2">
                  <dt className="w-14 shrink-0 text-fg-muted capitalize">{name}</dt>
                  <dd className="min-w-0 truncate font-mono text-fg" title={path}>
                    {path}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
    </Card>
  )
}

export function EnginesPage() {
  usePageTitle('Engines')
  const queryClient = useQueryClient()
  const engines = useEngines()
  const [probing, setProbing] = useState(false)

  const checkNow = async () => {
    setProbing(true)
    await probeEngines(queryClient)
    setProbing(false)
  }

  const list = [...(engines.data ?? [])].sort(
    (a, b) => Number(b.configured) - Number(a.configured) || Number(b.active) - Number(a.active),
  )

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 md:px-6">
      <PageHeader
        title="Engines"
        description="Where searches go. Keys stay in your keychain or environment; only where they come from is shown."
        actions={
          <Button onClick={() => void checkNow()} disabled={probing} aria-busy={probing}>
            <RefreshCw aria-hidden="true" className={probing ? 'size-4 animate-spin' : 'size-4'} />
            {probing ? 'Checking…' : 'Check now'}
          </Button>
        }
      />
      <section aria-label="Engines">
        {engines.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            <span className="sr-only">Loading engines…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-3 rounded-lg border border-border bg-surface p-4">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : engines.isError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg border border-danger-line bg-danger-soft p-4 text-[13px] text-danger"
          >
            <span className="flex items-center gap-2">
              <CircleAlert aria-hidden="true" className="size-4" />
              Couldn't load the engines: {messageOf(engines.error)}
            </span>
            <Button size="sm" onClick={() => void engines.refetch()}>
              <RotateCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={Server} title="No engines">
            <p>
              Run <code className="font-mono text-fg">searchhole searxng up</code> for a private engine, or
              add a free Tavily key.
            </p>
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((engine) => (
              <EngineCard key={engine.engine} engine={engine} />
            ))}
          </ul>
        )}
      </section>
      <DoctorSection />
    </div>
  )
}
