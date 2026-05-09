/**
 * TC-PRM-T0-001 — T0 Agency onboarding happy path (no invite).
 *
 * Spec #1 §3.1 — Backend admin creates an Agency, patches it through the
 * onboarding fields (`tier`, `status='active'`, `onboarded=true`), and the
 * resource shows up in `GET /api/prm/agency` with the correct shape.
 *
 * Coverage scope (intentionally narrow):
 * - Real `POST /api/prm/agency` succeeds with minimum-viable payload.
 * - Real `PATCH /api/prm/agency/{id}` flips the agency to onboarded.
 * - Real `GET /api/prm/agency?...` lists the agency with the patched values.
 *
 * Out of scope (covered by Phase 4 sibling specs / v2):
 * - Member invite + acceptance flow (gated on SPEC-2026-05-09c).
 * - WIC ingestion (TC-PRM-T3-001).
 * - RFP broadcast (TC-PRM-T5-001).
 */

import { test, expect } from './fixtures/tenantFixture'
import {
  createAgencyFixture,
  setAgencyOnboardedFixture,
} from '../testing/integration'

test('TC-PRM-T0-001 — backend admin onboards an Agency end-to-end (no invite)', async ({ tenant }) => {
  const slug = `t0-onboard-${tenant.workerIndex}-${Date.now().toString(36)}`

  // Step 1: create the Agency via the production backend route.
  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `T0 Onboarded Agency w${tenant.workerIndex}`,
    slug,
    tier: 'ai_native_expert',
    headquartersCountry: 'US',
  })
  expect(agencyId).toBeTruthy()

  // Step 2: patch through onboarding fields. PATCH is the real production
  // surface for staff to flip an agency to "active + onboarded" — this is
  // the gating step before the agency is eligible for RFP broadcasts.
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyId, {
    tier: 'ai_native_expert',
    onboarded: true,
    status: 'active',
  })

  // Step 3: list and assert. The freshly-onboarded agency must show in the
  // backend list with `onboarded=true` + `status='active'`.
  const listResponse = await tenant.request.get('/api/prm/agency?pageSize=100')
  expect(
    listResponse.ok(),
    `GET /api/prm/agency should be 200; got ${listResponse.status()}`,
  ).toBeTruthy()
  const body = (await listResponse.json()) as {
    ok?: true
    items?: Array<{
      id: string
      slug: string
      tier: string
      status: string
      onboarded: boolean
      tenantId?: string
    }>
  }
  const found = (body.items ?? []).find((item) => item.id === agencyId)
  expect(found, `Newly created Agency ${agencyId} should appear in GET /api/prm/agency`).toBeTruthy()
  expect(found?.slug).toBe(slug)
  expect(found?.tier).toBe('ai_native_expert')
  expect(found?.status).toBe('active')
  expect(found?.onboarded).toBe(true)

  // Cross-tenant safety check: the agency's tenantId must match THIS worker's tenant.
  // (Defends against a regression where the create handler ignores `auth.tenantId`.)
  if (found?.tenantId !== undefined) {
    expect(found.tenantId).toBe(tenant.tenantId)
  }
})
