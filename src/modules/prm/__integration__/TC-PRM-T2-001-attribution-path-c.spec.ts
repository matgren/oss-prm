/**
 * TC-PRM-T2-001 — License-deal attribution via Path C (admin override).
 *
 * Spec #3 §3.1 — Path C is the admin-only attribution path: a staff
 * `prm.license_deal.attribute` user attributes a LicenseDeal to a chosen
 * Agency without going through Prospect (Path A) or RFP (Path B).
 *
 * Why Path C and not A?
 *   Path A requires a `prospect_id` from `golden-rule-candidates`. Prospect
 *   WRITES are portal-only (`POST /api/prm/portal/prospects`), and portal
 *   write routes need a CustomerUser linked to an `AgencyMember.customerUserId`
 *   row — which today only happens through the invite-acceptance flow
 *   (gated on SPEC-2026-05-09c upstream PR). Path C is the staff-only path
 *   that needs no portal context — the canonical happy-path coverage for
 *   T2 attribution under the v1 constraint set.
 *
 * Coverage:
 * - Real `POST /api/prm/agency` to seed an Agency.
 * - Real `POST /api/prm/license-deal` to seed a LicenseDeal.
 * - Real `POST /api/prm/license-deal/{id}/attribute` with Path C.
 * - Assert the response carries the chosen `attributedAgencyId`.
 */

import { test, expect } from './fixtures/tenantFixture'
import {
  createAgencyFixture,
  setAgencyOnboardedFixture,
  createLicenseDealFixture,
  attributeLicenseDealFixture,
} from '../testing/integration'

test('TC-PRM-T2-001 — staff attributes a LicenseDeal via Path C (admin override)', async ({ tenant }) => {
  const slug = `t2-${tenant.workerIndex}-${Date.now().toString(36)}`

  // Seed an active onboarded agency to receive the attribution.
  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `T2 Attribution Target w${tenant.workerIndex}`,
    slug,
    tier: 'ai_native_expert',
    headquartersCountry: 'US',
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyId, {
    tier: 'ai_native_expert',
    onboarded: true,
    status: 'active',
  })

  // Seed a LicenseDeal — `agencyId` is intentionally NOT in the create
  // payload (per the helper JSDoc); attribution is the separate step.
  const licenseDealId = await createLicenseDealFixture(tenant.request, tenant.staffToken, {
    clientCompanyName: `Acme Corp w${tenant.workerIndex}`,
    type: 'enterprise',
    isRenewal: false,
    annualValueUsd: 25_000,
  })

  // Attribute via Path C — staff override, no Prospect or RFP context needed.
  const result = await attributeLicenseDealFixture(
    tenant.request,
    tenant.staffToken,
    licenseDealId,
    {
      attribution_path: 'C',
      attributed_agency_id: agencyId,
      attribution_reasoning: 'TC-PRM-T2-001 happy-path smoke',
    },
  )

  expect(
    result.status,
    `POST /api/prm/license-deal/${licenseDealId}/attribute (Path C) should return 200/202; got ${result.status} body=${JSON.stringify(result.body)}`,
  ).toBeGreaterThanOrEqual(200)
  expect(result.status).toBeLessThan(300)
  expect(result.body?.licenseDeal?.attributedAgencyId).toBe(agencyId)
  expect(result.body?.licenseDeal?.attributionPath).toBe('C')
})
