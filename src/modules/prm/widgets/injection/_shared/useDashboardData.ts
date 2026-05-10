'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

export type TierRequirement = {
  tier: string
  minWip: number
  minMonthlyWic: number
  rank: number
}

export type PartnershipYearEnvelope = {
  start: string
  end: string
  number: number
  priorYearMinCount: number | null
}

export type DashboardData = {
  agency: {
    id: string
    name: string
    slug: string
    status: string
    tier: string
  }
  period: {
    year: number
    month: number
    /** SPEC-2026-05-10. Null when `Agency.partnershipStartDate` is unset; falls back to calendar year. */
    partnershipYear: PartnershipYearEnvelope | null
    warnings?: string[]
  }
  wip: {
    monthly: number
    yearly: number
    byStatus: Record<string, number>
  }
  wic: {
    awaiting: boolean
    monthlyTotal: number
    yearlyTotal: number
    perMember: Array<{
      agencyMemberId: string
      firstName: string
      lastName: string
      monthly: number
      yearly: number
    }>
  }
  tier: {
    current: TierRequirement
    next: TierRequirement | null
    pctToNext: number
  } | null
}

type DashboardResponse = { ok: true; dashboard: DashboardData | null }

const TTL_MS = 30_000

type Store = {
  promise: Promise<DashboardData | null> | null
  data: DashboardData | null
  error: string | null
  loadedAt: number
}

const store: Store = { promise: null, data: null, error: null, loadedAt: 0 }
const subscribers = new Set<() => void>()

function notify() {
  subscribers.forEach((cb) => cb())
}

async function fetchOnce(): Promise<DashboardData | null> {
  if (store.promise) return store.promise
  if (store.data && Date.now() - store.loadedAt < TTL_MS) return store.data
  store.promise = (async () => {
    try {
      const { ok, result } = await apiCall<DashboardResponse>('/api/prm/portal/dashboard')
      if (!ok || !result?.ok) {
        throw new Error('Failed to load dashboard')
      }
      store.data = result.dashboard
      store.error = null
      store.loadedAt = Date.now()
      return store.data
    } catch (err) {
      store.error = err instanceof Error ? err.message : String(err)
      store.data = null
      throw err
    } finally {
      store.promise = null
      notify()
    }
  })()
  return store.promise
}

export function invalidateDashboardData() {
  store.data = null
  store.error = null
  store.loadedAt = 0
}

export function useDashboardData() {
  const [, setTick] = React.useState(0)

  React.useEffect(() => {
    const rerender = () => setTick((t) => t + 1)
    subscribers.add(rerender)
    if (!store.data && !store.promise && !store.error) {
      void fetchOnce().catch(() => {
        // notify() inside fetchOnce already triggers re-render with error state.
      })
    }
    return () => {
      subscribers.delete(rerender)
    }
  }, [])

  const reload = React.useCallback(() => {
    invalidateDashboardData()
    return fetchOnce().catch(() => {
      /* error captured in store */
    })
  }, [])

  return {
    data: store.data,
    loading: !!store.promise && !store.data,
    error: store.error,
    reload,
  }
}
