// SPDX-License-Identifier: Apache-2.0
/**
 * The Lists page's URL state (MASTER_PLAN §8.4 point 4): `?catalog=1` opens the catalog. Kept
 * apart from the list helpers so the router does not pull them into the initial bundle.
 */

export interface ListsSearch {
  catalog?: true | undefined
}

export function parseListsSearch(raw: Record<string, unknown>): ListsSearch {
  const v = raw.catalog
  return v === true || v === 1 || v === '1' || v === 'true' ? { catalog: true } : {}
}
