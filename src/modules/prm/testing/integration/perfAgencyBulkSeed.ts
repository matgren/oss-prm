/**
 * Bulk-seed helper for the Spec #5 §9.6 perf-smoke (`TC-PRM-T5-PERF-001-*`).
 *
 * Mirrors the staff-token Playwright fixture pattern from `./fixtures.ts`.
 * Wraps `POST /api/prm/test-fixtures/bulk-seed-agencies` so the perf smoke
 * spec can seed a 500-agency roster in one HTTP call (~hundreds of ms)
 * instead of looping `createAgencyFixture` 500 times (~30-60s).
 *
 * Mandatory env at the running app: `OM_PRM_TEST_FIXTURES_ENABLED=1`.
 * Without it the seam returns 404 and this helper throws.
 */

import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest, readJsonSafe } from '@open-mercato/core/testing/integration'
import type { PerfAgencyRow } from '../fixtures/perfAgencyRoster'

export type BulkSeedAgenciesResult = {
  insertedAgencies: number
  insertedOrganizations: number
  /** Wall-clock for the seam HTTP round-trip (ms). Useful for the smoke's
   *  diagnostic logging — the perf assertion uses publish-side timing only. */
  seedDurationMs: number
}

/**
 * Bulk-insert 1-2000 paired Organization + Agency rows via the test-only
 * seam at `POST /api/prm/test-fixtures/bulk-seed-agencies`.
 *
 * The `agencies` array shape matches `PerfAgencyRow` exactly so the smoke
 * can pipe the roster generator's output straight in.
 */
export async function bulkSeedAgenciesFixture(
  request: APIRequestContext,
  token: string,
  agencies: ReadonlyArray<PerfAgencyRow>,
): Promise<BulkSeedAgenciesResult> {
  const startedAt = Date.now()
  const response = await apiRequest(request, 'POST', '/api/prm/test-fixtures/bulk-seed-agencies', {
    token,
    data: { agencies },
  })
  const seedDurationMs = Date.now() - startedAt
  const body = await readJsonSafe<{
    ok?: boolean
    insertedAgencies?: number
    insertedOrganizations?: number
    error?: string
    details?: Record<string, unknown>
  }>(response)
  if (response.status() === 404) {
    throw new Error(
      'POST /api/prm/test-fixtures/bulk-seed-agencies returned 404 — likely OM_PRM_TEST_FIXTURES_ENABLED is not set in the running app env. ' +
        `body=${JSON.stringify(body)}`,
    )
  }
  expect(
    response.status(),
    `bulk-seed-agencies should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  expect(body?.ok, `bulk-seed-agencies response should have ok:true; body=${JSON.stringify(body)}`).toBe(true)
  return {
    insertedAgencies: body?.insertedAgencies ?? 0,
    insertedOrganizations: body?.insertedOrganizations ?? 0,
    seedDurationMs,
  }
}
