import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  createAgencyFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-RESET-001 — Regression test for the cross-spec test-isolation bleed.
 *
 * This spec demonstrates that `resetPrmState()` (wired into `test.beforeEach`)
 * actually wipes PRM-owned rows between tests. Two-test minimum so the bleed
 * lane is exercised back-to-back inside a single spec file:
 *
 *   1. Test #1: seed an Agency with a unique name. Read the staff agency-list
 *      and assert the new Agency is present (sanity check the seam works).
 *   2. Test #2: AFTER the beforeEach reset, the Agency from test #1 must NOT
 *      appear when test #2 reads the staff agency-list — proving the reset
 *      ran. Test #2 then seeds its own Agency to confirm the table is writable
 *      (catches "TRUNCATE locks the table for the rest of the run" regressions).
 *
 * Orthogonal to the cross-spec bleed (which lives across .spec.ts files), but
 * cheap to maintain and catches regressions where `resetPrmState` becomes a
 * no-op (e.g. helper accidentally short-circuiting on a 404, env-var rename,
 * etc.). The cross-spec bleed itself is verified by running the full
 * `yarn test:integration:ephemeral` suite twice — beyond a Playwright spec's
 * reach.
 *
 * Why list-based assertions instead of a strict count: the staff
 * `/api/prm/agency` route may include rows the bootstrap step seeds (none today,
 * but defence-in-depth against future fixture seeds). Filtering by the unique
 * `slug` we just minted keeps the assertion stable.
 */

const RESET_SUFFIX = `reset-001-${Date.now().toString(36)}`
const TEST_1_SLUG = `${RESET_SUFFIX}-a`
const TEST_2_SLUG = `${RESET_SUFFIX}-b`

test.describe('TC-PRM-RESET-001: resetPrmState() clears Agency seeds between tests', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  // The point of this spec is to prove this beforeEach actually does its job.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Test #1 — seed an Agency, confirm it lands in the staff agency-list', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await createAgencyFixture(request, token, {
      name: `Reset-001 Test 1 ${RESET_SUFFIX}`,
      slug: TEST_1_SLUG,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })

    const listResponse = await apiRequest(request, 'GET', '/api/prm/agency?pageSize=100', { token })
    const listBody = await readJsonSafe<{
      ok?: true
      items?: Array<{ slug?: string }>
      agencies?: Array<{ slug?: string }>
      data?: Array<{ slug?: string }>
    }>(listResponse)
    expect(listResponse.status(), `GET /api/prm/agency status; body=${JSON.stringify(listBody)}`).toBe(200)
    const items = listBody?.items ?? listBody?.agencies ?? listBody?.data ?? []
    const slugs = items.map((it) => it.slug)
    expect(slugs).toContain(TEST_1_SLUG)
  })

  test('Test #2 — beforeEach reset cleared test #1; this test sees a clean slice', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    // ---- Step A: BEFORE seeding anything, assert test #1's Agency is gone.
    const beforeResponse = await apiRequest(request, 'GET', '/api/prm/agency?pageSize=100', { token })
    const beforeBody = await readJsonSafe<{
      ok?: true
      items?: Array<{ slug?: string }>
      agencies?: Array<{ slug?: string }>
      data?: Array<{ slug?: string }>
    }>(beforeResponse)
    expect(beforeResponse.status()).toBe(200)
    const beforeItems =
      beforeBody?.items ?? beforeBody?.agencies ?? beforeBody?.data ?? []
    const beforeSlugs = beforeItems.map((it) => it.slug)
    expect(
      beforeSlugs,
      `test #1's Agency (slug=${TEST_1_SLUG}) must NOT appear after beforeEach reset; saw slugs=${JSON.stringify(beforeSlugs)}`,
    ).not.toContain(TEST_1_SLUG)

    // ---- Step B: write is still allowed (TRUNCATE didn't lock the table).
    await createAgencyFixture(request, token, {
      name: `Reset-001 Test 2 ${RESET_SUFFIX}`,
      slug: TEST_2_SLUG,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })

    const afterResponse = await apiRequest(request, 'GET', '/api/prm/agency?pageSize=100', { token })
    const afterBody = await readJsonSafe<{
      ok?: true
      items?: Array<{ slug?: string }>
      agencies?: Array<{ slug?: string }>
      data?: Array<{ slug?: string }>
    }>(afterResponse)
    expect(afterResponse.status()).toBe(200)
    const afterItems = afterBody?.items ?? afterBody?.agencies ?? afterBody?.data ?? []
    const afterSlugs = afterItems.map((it) => it.slug)
    expect(afterSlugs).toContain(TEST_2_SLUG)
    // And test #1's Agency is STILL gone — beforeEach didn't accidentally re-seed it.
    expect(afterSlugs).not.toContain(TEST_1_SLUG)
  })
})
