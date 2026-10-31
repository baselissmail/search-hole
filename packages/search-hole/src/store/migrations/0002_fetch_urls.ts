// SPDX-License-Identifier: Apache-2.0
/**
 * 0002: keep the URL of each opened page (pages the model fetched are the user's own session
 * data), so receipts rebuilt in another process show the page, not just its host. Additive:
 * older writers ignore the new columns (ADR-0006 point 2).
 */
export const sql = `
ALTER TABLE fetches ADD COLUMN url TEXT;
ALTER TABLE fetches ADD COLUMN final_url TEXT;
`
