import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  attributeLicenseDealFixture,
  bootPartnerAgencyWithMembers,
  createLicenseDealFixture,
  createProspectFixture,
  getProspectViaPortalFixture,
  listGoldenRuleCandidatesFixture,
  resetPrmState,
  transitionProspectViaPortalFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T2-002 — Spec #3 §9 IT-9.2 Golden Rule override with reasoning.
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.2, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T2 Attribution Loop → IT-9.2".
 *
 * Scenario:
 *   "Golden Rule override with reasoning — Non-default pick captures reasoning;
 *    `attribution_overridden` event fired."
 *
 * Asserts the override branch end-to-end:
 *   1. Two PartnerAgencies (A, B) each register a Prospect for the SAME client
 *      company name. Agency A registers FIRST → Golden Rule default pick is
 *      Prospect-A (oldest non-lost per invariant #14).
 *   2. Both Prospects transition to `qualified` so they're eligible.
 *   3. OMPartnerOps creates a LicenseDeal matching the client company.
 *   4. Golden Rule picker returns BOTH candidates — exactly one isDefaultPick
 *      and that one is Prospect-A.
 *   5. Sanity gate: Path A attempt overriding (picked B, default A) WITHOUT
 *      `attribution_reasoning` → 422 ATTRIBUTION_REASONING_REQUIRED. Proves
 *      the server-side override detector enforces the gate per spec §3.1.1.
 *   6. Successful override: same body + `attribution_reasoning` text → 202.
 *      Response `emittedEvents` MUST include
 *      `prm.license_deal.attribution_overridden` alongside `prm.license_deal.attributed`.
 *      `attributedAgencyId` must be Agency-B (the picked one).
 *   7. Saga walks Prospect-B (the picked one) → `won`. Prospect-A stays
 *      `qualified` per OQ-004 (attribution-time resolution; competing prospects
 *      are NOT auto-touched).
 *   8. Reasoning is persisted on the deal aggregate (GET `/api/prm/license-deal/{id}`
 *      returns the captured `attributionReasoning`).
 *
 * Real saga, no stubs. Polls portal `/prospects/{id}` (≤30s) for `won`.
 */
test.describe('TC-PRM-T2-002: Spec #3 §9 IT-9.2 — Golden Rule override + reasoning + overridden event', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Non-default Golden Rule pick captures reasoning, fires attribution_overridden, walks picked prospect to won', async ({
    request,
  }) => {
    // Two saga polls (forward + post-override sanity GETs). Match the T2-001 budget: 90s.
    test.setTimeout(90_000)
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-002-${Date.now().toString(36)}`

    // Two distinct partner agencies — A first (default pick), B second (override target).
    const agencyA = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix: `${suffix}-a`,
      tier: 'om_agency',
    })
    const agencyB = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix: `${suffix}-b`,
      tier: 'om_agency',
    })

    // ---- Step 1+2: Both agencies register a Prospect for the SAME client company.
    // Agency A registers FIRST → Golden Rule default per invariant #14 (oldest).
    const clientCompanyName = `T2-002 Override Client ${suffix}`
    const contactEmailA = `t2-002-buyer-a-${suffix}@example.test`
    const contactEmailB = `t2-002-buyer-b-${suffix}@example.test`

    const prospectAId = await createProspectFixture(request, agencyA.admin.token, {
      companyName: clientCompanyName,
      contactName: 'Pat Buyer A',
      contactEmail: contactEmailA,
      source: 'agency_owned',
    })
    await transitionProspectViaPortalFixture(
      request,
      agencyA.admin.token,
      prospectAId,
      'qualified',
    )

    // Tiny gap so registered_at strictly differs (Golden Rule ordering).
    await new Promise((r) => setTimeout(r, 50))

    const prospectBId = await createProspectFixture(request, agencyB.admin.token, {
      companyName: clientCompanyName,
      contactName: 'Pat Buyer B',
      contactEmail: contactEmailB,
      source: 'agency_owned',
    })
    await transitionProspectViaPortalFixture(
      request,
      agencyB.admin.token,
      prospectBId,
      'qualified',
    )

    // ---- Step 3: License deal whose client matches the shared company name.
    const licenseIdentifier = `OM-T2-${suffix.toUpperCase()}`
    const licenseDealId = await createLicenseDealFixture(request, staffToken, {
      licenseIdentifier,
      clientCompanyName,
      type: 'enterprise',
      annualValueUsd: 96_000,
      monthlyLicenseAmount: 8_000,
    })

    // ---- Step 4: Golden Rule picker returns BOTH candidates; default = Prospect-A.
    const candidates = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
    })
    expect(
      candidates.length,
      `picker should return both candidates; got ${JSON.stringify(candidates)}`,
    ).toBeGreaterThanOrEqual(2)
    const defaults = candidates.filter((c) => c.isDefaultPick)
    expect(defaults.length, 'exactly one default pick').toBe(1)
    expect(defaults[0]!.prospectId).toBe(prospectAId)

    // ---- Step 5 (sanity): override without reasoning → 422.
    // Body sends prospect_id = B but golden_rule_default_prospect_id = A
    // (the canonical override shape). Server detects mismatch + missing
    // reasoning per Spec §3.1.1.
    const noReasonAttempt = await attributeLicenseDealFixture(
      request,
      staffToken,
      licenseDealId,
      {
        attribution_path: 'A',
        prospect_id: prospectBId,
        golden_rule_default_prospect_id: prospectAId,
        competing_prospect_ids_to_retire: [],
        // attribution_reasoning intentionally omitted
      },
    )
    expect(
      noReasonAttempt.status,
      `override w/o reasoning should 422 ATTRIBUTION_REASONING_REQUIRED; body=${JSON.stringify(noReasonAttempt.body)}`,
    ).toBe(422)
    const errPayload = noReasonAttempt.body?.error
    if (typeof errPayload === 'object' && errPayload !== null && 'code' in errPayload) {
      expect((errPayload as { code: string }).code).toBe('attribution_reasoning_required')
    }

    // ---- Step 6: Successful override path with reasoning → 202.
    const reasoning =
      'Agency B holds the active relationship with this buyer; Agency A registered first ' +
      'but never made contact (verified with stakeholder before override).'
    const overrideAttempt = await attributeLicenseDealFixture(
      request,
      staffToken,
      licenseDealId,
      {
        attribution_path: 'A',
        prospect_id: prospectBId,
        golden_rule_default_prospect_id: prospectAId,
        competing_prospect_ids_to_retire: [],
        attribution_reasoning: reasoning,
      },
    )
    expect(
      overrideAttempt.status,
      `override w/ reasoning should 202; body=${JSON.stringify(overrideAttempt.body)}`,
    ).toBe(202)
    expect(overrideAttempt.body?.sagaCorrelationKey).toBeTruthy()
    expect(overrideAttempt.body?.licenseDeal?.attributedAgencyId).toBe(agencyB.agencyId)
    expect(
      overrideAttempt.body?.emittedEvents,
      `emittedEvents should include attribution_overridden + attributed; got ${JSON.stringify(overrideAttempt.body?.emittedEvents)}`,
    ).toEqual(
      expect.arrayContaining([
        'prm.license_deal.attributed',
        'prm.license_deal.attribution_overridden',
      ]),
    )

    // ---- Step 7: Saga walks the PICKED prospect (B) to `won` (≤30s).
    await expect
      .poll(
        async () => {
          const p = await getProspectViaPortalFixture(
            request,
            agencyB.admin.token,
            prospectBId,
          )
          return p.status
        },
        {
          timeout: 30_000,
          intervals: [200, 500, 1000, 2000],
          message:
            'Override saga did not walk Prospect-B to "won" within 30s. ' +
            'Real saga timeout = real bug; do NOT stub.',
        },
      )
      .toBe('won')

    // Prospect-A (the default that was overridden) MUST stay `qualified` per OQ-004.
    const prospectAAfter = await getProspectViaPortalFixture(
      request,
      agencyA.admin.token,
      prospectAId,
    )
    expect(
      prospectAAfter.status,
      'overridden default prospect must NOT be auto-lost — OQ-004 attribution-time resolution only',
    ).toBe('qualified')

    // ---- Step 8: Reasoning persisted on the aggregate.
    const dealResp = await apiRequest(
      request,
      'GET',
      `/api/prm/license-deal/${licenseDealId}`,
      { token: staffToken },
    )
    const dealBody = await readJsonSafe<{
      ok?: boolean
      licenseDeal?: {
        status?: string
        attributionPath?: string
        attributedAgencyId?: string | null
        attributionReasoning?: string | null
        prospectId?: string | null
      }
    }>(dealResp)
    expect(dealResp.status(), `GET deal detail; body=${JSON.stringify(dealBody)}`).toBe(200)
    expect(dealBody?.licenseDeal?.status).toBe('signed')
    expect(dealBody?.licenseDeal?.attributionPath).toBe('A')
    expect(dealBody?.licenseDeal?.prospectId).toBe(prospectBId)
    expect(dealBody?.licenseDeal?.attributedAgencyId).toBe(agencyB.agencyId)
    expect(
      dealBody?.licenseDeal?.attributionReasoning,
      'reasoning must be persisted verbatim on the LicenseDeal aggregate',
    ).toBe(reasoning)
  })
})
