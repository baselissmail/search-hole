// SPDX-License-Identifier: Apache-2.0
/** Server state (TanStack Query): one key per resource, shared by every screen. */
import { QueryClient, useQuery } from '@tanstack/react-query'
import { ApiFailure, api } from './api.ts'

export const OVERVIEW_DAYS = 7

export const keys = {
  overview: ['overview', OVERVIEW_DAYS] as const,
  search: (id: number) => ['search', id] as const,
  rules: ['rules'] as const,
  suggestions: ['suggestions'] as const,
  engines: ['engines'] as const,
  doctor: ['doctor'] as const,
  settings: ['settings'] as const,
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
    // A logged search never changes.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useRules() {
  return useQuery({ queryKey: keys.rules, queryFn: ({ signal }) => api.rules(signal) })
}

export function useSuggestions() {
  return useQuery({ queryKey: keys.suggestions, queryFn: ({ signal }) => api.suggestions(signal) })
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
