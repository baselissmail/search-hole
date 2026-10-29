// SPDX-License-Identifier: Apache-2.0
/**
 * Queries for `jobs` (ADR-0006 point 7): lease rows with fencing. Every write is conditional
 * on `lease_epoch`, which increments on each acquire, so a stalled former owner cannot
 * clobber the new one. Call these inside BEGIN IMMEDIATE.
 */
import { z } from 'zod'
import type { Db } from '../driver.ts'
import type { JobOwner, JobPatch, JobRow, Lease } from '../types.ts'
import { compareSemver } from '../version.ts'

const jobRow = z.object({
  name: z.string(),
  owner_gateway_id: z.string().nullable(),
  owner_version: z.string().nullable(),
  lease_until: z.number(),
  heartbeat_at: z.number().nullable(),
  status: z.string(),
  progress_json: z.string().nullable(),
  last_error: z.string().nullable(),
  lease_epoch: z.number().int(),
})

const COLUMNS =
  'name, owner_gateway_id, owner_version, lease_until, heartbeat_at, status, progress_json, last_error, lease_epoch'

function parseProgress(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function toJob(raw: unknown): JobRow {
  const r = jobRow.parse(raw)
  return {
    name: r.name,
    ownerGatewayId: r.owner_gateway_id,
    ownerVersion: r.owner_version,
    leaseUntil: r.lease_until,
    heartbeatAt: r.heartbeat_at,
    status: r.status,
    progress: parseProgress(r.progress_json),
    lastError: r.last_error,
    leaseEpoch: r.lease_epoch,
  }
}

/** One job row, or undefined. */
export function getJob(db: Db, name: string): JobRow | undefined {
  const raw = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE name = ?`).get([name])
  return raw === undefined ? undefined : toJob(raw)
}

/** All job rows by name. */
export function listJobs(db: Db): JobRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM jobs ORDER BY name`).all().map(toJob)
}

function lastMigratedBy(db: Db): string {
  return db.prepare<{ v: string }>('SELECT last_migrated_by AS v FROM meta WHERE id = 1').get()?.v ?? '0.0.0'
}

export type AcquireRow =
  | { acquired: true; lease: Lease; tookOverFrom?: string }
  | { acquired: false; reason: 'held' | 'version_too_old'; heldBy?: string; until?: number }

/**
 * Takes the lease if it is free (never held, released or expired), held by an older version,
 * or already ours. Refused when the caller is older than the version that last migrated.
 */
export function acquireLease(
  db: Db,
  name: string,
  owner: JobOwner,
  leaseMs: number,
  now: number,
): AcquireRow {
  if (compareSemver(owner.version, lastMigratedBy(db)) < 0)
    return { acquired: false, reason: 'version_too_old' }
  const until = now + leaseMs
  const row = getJob(db, name)
  if (row === undefined) {
    db.prepare(
      `INSERT INTO jobs (name, owner_gateway_id, owner_version, lease_until, heartbeat_at, status, lease_epoch)
       VALUES ($name, $gw, $version, $until, $now, 'running', 1)`,
    ).run({ name, gw: owner.gatewayId, version: owner.version, until, now })
    return { acquired: true, lease: { name, epoch: 1, owner, until } }
  }
  const free = row.ownerGatewayId === null || row.leaseUntil <= now
  const olderOwner = row.ownerVersion !== null && compareSemver(row.ownerVersion, owner.version) < 0
  const ours = row.ownerGatewayId === owner.gatewayId
  if (!free && !olderOwner && !ours) {
    return {
      acquired: false,
      reason: 'held',
      ...(row.ownerGatewayId !== null ? { heldBy: row.ownerGatewayId } : {}),
      until: row.leaseUntil,
    }
  }
  const epoch = row.leaseEpoch + 1
  const taken = db
    .prepare(
      `UPDATE jobs SET owner_gateway_id = $gw, owner_version = $version, lease_until = $until,
                       heartbeat_at = $now, status = 'running', lease_epoch = $epoch
        WHERE name = $name AND lease_epoch = $old`,
    )
    .run({ gw: owner.gatewayId, version: owner.version, until, now, epoch, name, old: row.leaseEpoch })
  if (taken.changes !== 1) return { acquired: false, reason: 'held', until: row.leaseUntil }
  const lease: Lease = { name, epoch, owner, until }
  return row.ownerGatewayId !== null && row.ownerGatewayId !== owner.gatewayId
    ? { acquired: true, lease, tookOverFrom: row.ownerGatewayId }
    : { acquired: true, lease }
}

/** True when the lease row still carries this lease's epoch and owner. */
export function leaseHolds(db: Db, lease: Lease): boolean {
  return (
    db
      .prepare('SELECT 1 AS ok FROM jobs WHERE name = ? AND lease_epoch = ? AND owner_gateway_id = ?')
      .get([lease.name, lease.epoch, lease.owner.gatewayId]) !== undefined
  )
}

/** Heartbeat. Returns the extended lease, 'version_too_old', or 'lease_lost'. */
export function renewLease(
  db: Db,
  lease: Lease,
  leaseMs: number,
  now: number,
): { ok: true; lease: Lease } | { ok: false; reason: 'lease_lost' | 'version_too_old' } {
  if (compareSemver(lease.owner.version, lastMigratedBy(db)) < 0)
    return { ok: false, reason: 'version_too_old' }
  const until = now + leaseMs
  const r = db
    .prepare(
      `UPDATE jobs SET lease_until = $until, heartbeat_at = $now
        WHERE name = $name AND lease_epoch = $epoch AND owner_gateway_id = $gw`,
    )
    .run({ until, now, name: lease.name, epoch: lease.epoch, gw: lease.owner.gatewayId })
  return r.changes === 1 ? { ok: true, lease: { ...lease, until } } : { ok: false, reason: 'lease_lost' }
}

/** Fenced status / progress / last_error update. */
export function patchJob(db: Db, lease: Lease, patch: JobPatch, now: number): boolean {
  const r = db
    .prepare(
      `UPDATE jobs SET
         status = COALESCE($status, status),
         progress_json = CASE WHEN $setProgress = 1 THEN $progress ELSE progress_json END,
         last_error = CASE WHEN $setError = 1 THEN $error ELSE last_error END,
         heartbeat_at = $now
       WHERE name = $name AND lease_epoch = $epoch AND owner_gateway_id = $gw`,
    )
    .run({
      status: patch.status ?? null,
      setProgress: patch.progress === undefined ? 0 : 1,
      progress: patch.progress === undefined ? null : JSON.stringify(patch.progress),
      setError: patch.lastError === undefined ? 0 : 1,
      error: patch.lastError ?? null,
      now,
      name: lease.name,
      epoch: lease.epoch,
      gw: lease.owner.gatewayId,
    })
  return r.changes === 1
}

/** Fenced release: clears the owner, keeps the epoch so the next acquire increments it. */
export function releaseLease(db: Db, lease: Lease, final: JobPatch, now: number): boolean {
  const r = db
    .prepare(
      `UPDATE jobs SET
         owner_gateway_id = NULL, owner_version = NULL, lease_until = 0, heartbeat_at = $now,
         status = COALESCE($status, 'idle'),
         progress_json = CASE WHEN $setProgress = 1 THEN $progress ELSE progress_json END,
         last_error = CASE WHEN $setError = 1 THEN $error ELSE last_error END
       WHERE name = $name AND lease_epoch = $epoch AND owner_gateway_id = $gw`,
    )
    .run({
      status: final.status ?? null,
      setProgress: final.progress === undefined ? 0 : 1,
      progress: final.progress === undefined ? null : JSON.stringify(final.progress),
      setError: final.lastError === undefined ? 0 : 1,
      error: final.lastError ?? null,
      now,
      name: lease.name,
      epoch: lease.epoch,
      gw: lease.owner.gatewayId,
    })
  return r.changes === 1
}
