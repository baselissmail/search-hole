// SPDX-License-Identifier: Apache-2.0
/** Server state (TanStack Query): one key per resource, shared by every screen. */
import { QueryClient, useQuery } from '@tanstack/react-query'
import { ApiFailure, api } from './api.ts'

export const OVERVIEW_DAYS = 7
const DETAIL_REFRESH_MS = 15_000

export const keys = {
  overview: ['overview', OVERVIEW_DAYS] as const,
  search: (id: number) => ['search', id] as const,
  rules: ['rules'] as const,
  suggestions: ['suggestions'] as const,
  review: ['review'] as const,
  engines: ['engines'] as const,
  doctor: ['doctor'] as const,
  settings: ['settings'] as const,
  lists: ['lists'] as const,
  listCatalog: ['lists', 'catalog'] as const,
}

/** Client errors and auth failures don't get better by retrying. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) return false
  return failureCount < 2
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 10_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  })
}

export function useOverview() {
  return useQuery({
    queryKey: keys.overview,
    queryFn: ({ signal }) => api.overview(OVERVIEW_DAYS, signal),
    refetchInterval: 30_000,
  })
}

export function useSearchDetail(id: number | undefined) {
  return useQuery({
    queryKey: keys.search(id ?? 0),
    queryFn: ({ signal }) => api.search(id ?? 0, signal),
    enabled: id !== undefined,
    // The results of a logged search never change, but which of them were opened does: pages
    // are opened after the search is logged. Refreshed while the row is expanded and the tab
    // is visible; an unchanged answer keeps the same object, so nothing re-renders.
    staleTime: DETAIL_REFRESH_MS,
    refetchInterval: DETAIL_REFRESH_MS,
  })
}

export function useRules() {
  return useQuery({ queryKey: keys.rules, queryFn: ({ signal }) => api.rules(signal) })
}

export function useSuggestions() {
  return useQuery({ queryKey: keys.suggestions, queryFn: ({ signal }) => api.suggestions(signal) })
}

/** Sites seen in several searches and never opened: the Review tab and its count badge. */
export function useReview() {
  return useQuery({ queryKey: keys.review, queryFn: ({ signal }) => api.review(signal), staleTime: 30_000 })
}

export function useEngines() {
  return useQuery({ queryKey: keys.engines, queryFn: ({ signal }) => api.engines(signal) })
}

export function useDoctor() {
  return useQuery({ queryKey: keys.doctor, queryFn: ({ signal }) => api.doctor(signal), staleTime: 30_000 })
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: ({ signal }) => api.settings(signal) })
}

/** Every list with its state and 7-day contribution. */
export function useLists() {
  return useQuery({ queryKey: keys.lists, queryFn: ({ signal }) => api.lists(signal) })
}

/** The list catalog, fetched when the catalog opens. */
export function useListCatalog(enabled = true) {
  return useQuery({
    queryKey: keys.listCatalog,
    queryFn: ({ signal }) => api.listCatalog(signal),
    enabled,
  })
}
