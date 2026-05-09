/**
 * SPEC-2026-05-09b acceptance criterion:
 *   "Smoke spec confirms: two specs running on different workers see
 *   disjoint tenant data."
 *
 * Strategy: create an Agency in this worker's tenant, then GET the agency
 * list and assert ONLY this worker's agency shows up — none from other
 * workers' tenants. The list endpoint scopes to `organization_id` server-side,
 * so a per-tenant tenant id alone is enough proof of isolation.
 *
 * This spec is duplicated as `TC-PRM-T0-SMOKE-isolation-b.spec.ts` so that
 * `--workers=2` actually exercises the parallel claim. Both files perform
 * the same assertion against their own tenant — the fact that the listing
 * never sees the other file's agency is the isolation proof.
 *
 * NOTE: this is a tier-0 SMOKE only. Functional T0 onboarding coverage
 * lives in TC-PRM-T0-001 (Phase 4).
 */

import { test, expect } from './fixtures/tenantFixture'
import { createAgencyFixture } from '../testing/integration'

test('TC-PRM-T0-SMOKE-isolation [a] — created agency is visible only inside its own tenant', async ({ tenant }) => {
  const slug = `iso-a-${tenant.workerIndex}-${Date.now().toString(36)}`
  const agencyName = `Isolation Smoke A w${tenant.workerIndex}`

  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: agencyName,
    slug,
  })
  expect(agencyId, 'createAgencyFixture should return the new agency id').toBeTruthy()

  const listResponse = await tenant.request.get('/api/prm/agency?pageSize=200')
  expect(
    listResponse.ok(),
    `GET /api/prm/agency should be 200; got ${listResponse.status()}`,
  ).toBeTruthy()
  const body = (await listResponse.json()) as { items?: Array<{ id?: string; slug?: string }> }
  const items = Array.isArray(body.items) ? body.items : []

  // The freshly-created agency must be present.
  expect(items.some((item) => item?.id === agencyId)).toBe(true)

  // No agency from any *other* worker's tenant should leak in. Detect leakage
  // by checking for the canonical iso-b slug shape from the sibling spec —
  // if the other worker's tenant data leaks across, we'd see it here.
  const leakage = items.find((item) => typeof item?.slug === 'string' && /^iso-b-\d+/.test(item.slug))
  expect(
    leakage,
    `Found cross-tenant leak from sibling worker: slug=${String(leakage?.slug)}`,
  ).toBeUndefined()
})
