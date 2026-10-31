// SPDX-License-Identifier: Apache-2.0
/**
 * 0003: list refresh state (ADR-0022) and the audit list behind a "would hide".
 *
 * - `lists`: display name and source (bundled, vendored, subscribed, local), skipped-line count,
 *   consecutive refresh failures, when the next refresh is due, when the list last answered
 *   (200 or 304), and a human-readable detail next to the `last_error` code.
 * - `results.audit_list_id`: the audit-mode list that would have hidden a kept result, so each
 *   list's "would hide" contribution can be counted (the deciding `list_id` is a different rule).
 *
 * Additive: older writers ignore the new columns (ADR-0006 point 2).
 */
export const sql = `
ALTER TABLE lists ADD COLUMN name TEXT;
ALTER TABLE lists ADD COLUMN source TEXT;
ALTER TABLE lists ADD COLUMN skipped_count INTEGER;
ALTER TABLE lists ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lists ADD COLUMN next_check_at INTEGER;
ALTER TABLE lists ADD COLUMN verified_at INTEGER;
ALTER TABLE lists ADD COLUMN last_error_detail TEXT;
ALTER TABLE results ADD COLUMN audit_list_id TEXT;
`
