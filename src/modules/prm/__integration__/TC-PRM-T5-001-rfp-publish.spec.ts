/**
 * TC-PRM-T5-001 — RFP draft → publish happy path.
 *
 * Spec #5 §3.1 (US5.1, US5.2) — Backend admin creates an RFP draft,
 * publishes it with `eligibility_filter='all_active'`, and the publish
 * response carries the broadcast set covering every active onboarded
 * Agency in the tenant.
 *
 * Coverage:
 * - Real `POST /api/prm/agency` (×2) to seed eligible recipients.
 * - Real `PATCH /api/prm/agency/{id}` to flip them to active+onboarded.
 * - Real `POST /api/prm/rfp` to create the draft.
 * - Real `POST /api/prm/rfp/{id}/publish` to fan out broadcasts.
 * - Assert `broadcastAgencyIds` covers both seeded agencies, and the RFP
 *   transitions to `status='published'`.
 *
 * Out of scope:
 * - Portal-side RFP submit (TC-PRM-T5-002, gated on AgencyMember link → v2).
 * - Eligibility-filter variants (`by_min_tier`, `explicit`) — covered by
 *   `__tests__/rfpService.test.ts` unit suites.
 */

import { test, expect } from './fixtures/tenantFixture'
import {
  createAgencyFixture,
  setAgencyOnboardedFixture,
  createRfpDraftFixture,
  publishRfpFixture,
} from '../testing/integration'

test('TC-PRM-T5-001 — staff publishes an RFP, broadcasts fan out to all active onboarded agencies', async ({ tenant }) => {
  const stamp = Date.now().toString(36)

  // Seed two eligible agencies (active + onboarded).
  const agencyIdA = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `T5 Recipient A w${tenant.workerIndex}`,
    slug: `t5-a-${tenant.workerIndex}-${stamp}`,
    tier: 'om_agency',
    headquartersCountry: 'US',
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyIdA, {
    onboarded: true,
    status: 'active',
  })
  const agencyIdB = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `T5 Recipient B w${tenant.workerIndex}`,
    slug: `t5-b-${tenant.workerIndex}-${stamp}`,
    tier: 'ai_native_expert',
    headquartersCountry: 'US',
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyIdB, {
    tier: 'ai_native_expert',
    onboarded: true,
    status: 'active',
  })

  // Create the RFP draft. eligibility_filter='all_active' captures both
  // seeded agencies (the `evaluateRfpEligibility` helper filters
  // `status='active' AND onboarded=true` per Spec #5 §2).
  const rfpId = await createRfpDraftFixture(tenant.request, tenant.staffToken, {
    title: `T5 Smoke RFP w${tenant.workerIndex} ${stamp}`,
    eligibility_filter: 'all_active',
  })

  // Publish — fan out broadcasts to every eligible agency in this tenant.
  const result = await publishRfpFixture(tenant.request, tenant.staffToken, rfpId)
  expect(
    result.status,
    `POST /api/prm/rfp/${rfpId}/publish should return 200; got ${result.status} body=${JSON.stringify(result.body)}`,
  ).toBe(200)
  expect(result.body?.status).toBe('published')

  const broadcastIds = (result.body?.broadcastAgencyIds ?? []).slice().sort()
  // Both seeded agencies must appear; tenant-isolation defence-in-depth means
  // we tolerate other PRM-internal agencies if any (e.g. seeded by setup
  // hooks), but ours MUST be present.
  expect(broadcastIds).toEqual(expect.arrayContaining([agencyIdA, agencyIdB].sort()))
})
