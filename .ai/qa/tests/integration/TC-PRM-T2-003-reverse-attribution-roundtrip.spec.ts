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
 * TC-PRM-T2-003 — Spec #3 §9 IT-9.3 Reverse attribution round trip (LIFO).
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.3, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T2 Attribution Loop → IT-9.3".
 *
 * Scenario:
 *   "Reverse attribution round trip — LIFO compensation; Prospect reverts to qualified."
 *
 * Asserts the full forward+compensation loop end-to-end:
 *   1. Boot Agency, register Prospect, transition `qualified`.
 *   2. Create LicenseDeal + Path A attribute → status `signed`, prospect → `won`.
 *   3. POST `/api/prm/license-deal/{id}/reverse` with `reason` → 202.
 *      Reverse-saga (LIFO compensation handlers) MUST:
 *        - Reset deal aggregate: status → `pending`, attributionPath → `none`,
 *          prospectId → null, attributedAgencyId → null, attributedAt → null.
 *        - Walk prospect: `won → qualified` via system actor (the
 *          `attributionSaga.compensateAttributionSaga` LIFO step #1).
 *      Response `emittedEvents` MUST include `prm.license_deal.reversal_started`
 *      and `prm.license_deal.reversed`.
 *   4. Poll portal `/prospects/{id}` (≤30s) for `qualified` — the compensation
 *      subscriber runs async via the platform event runtime. Saga timeout = real
 *      bug; do NOT stub.
 *   5. After full reversal the deal can be re-attributed (re-runs forward saga,
 *      sanity check that the compensation truly released the prospect).
 *
 * The compensation path runs through `subscribers/license-deal-reversal-compensation.ts`
 * — it does NOT execute inline in the route handler, so the polling step is
 * load-bearing for catching workers-not-running regressions.
 */
test.describe('TC-PRM-T2-003: Spec #3 §9 IT-9.3 — Reverse attribution round trip (LIFO compensation)', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Reverse walks prospect won → qualified via LIFO compensation; deal returns to pending+none', async ({
    request,
  }) => {
    // Three saga polls: forward → reverse compensation → re-forward. Allow 120s.
    test.setTimeout(120_000)
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-003-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Step 1: register + qualify a Prospect.
    const clientCompanyName = `T2-003 LicenseClient ${suffix}`
    const contactEmail = `t2-003-buyer-${suffix}@example.test`
    const prospectId = await createProspectFixture(request, agency.admin.token, {
      companyName: clientCompanyName,
      contactName: 'Pat Buyer',
      contactEmail,
      source: 'agency_owned',
    })
    await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
      'qualified',
    )

    // ---- Step 2: create + Path A attribute.
    const licenseIdentifier = `OM-T2-${suffix.toUpperCase()}`
    const licenseDealId = await createLicenseDealFixture(request, staffToken, {
      licenseIdentifier,
      clientCompanyName,
      type: 'enterprise',
      annualValueUsd: 60_000,
      monthlyLicenseAmount: 5_000,
    })

    const candidates = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
    })
    const defaultPick = candidates.find((c) => c.isDefaultPick)
    expect(defaultPick?.prospectId).toBe(prospectId)

    const attributeResult = await attributeLicenseDealFixture(
      request,
      staffToken,
      licenseDealId,
      {
        attribution_path: 'A',
        prospect_id: prospectId,
        golden_rule_default_prospect_id: prospectId,
        competing_prospect_ids_to_retire: [],
      },
    )
    expect(attributeResult.status).toBe(202)
    expect(attributeResult.body?.licenseDeal?.attributedAgencyId).toBe(agency.agencyId)

    // Saga forward run: prospect reaches `won`.
    await expect
      .poll(
        async () => {
          const p = await getProspectViaPortalFixture(
            request,
            agency.admin.token,
            prospectId,
          )
          return p.status
        },
        {
          timeout: 30_000,
          intervals: [200, 500, 1000, 2000],
          message: 'Forward saga did not walk Prospect to "won" within 30s.',
        },
      )
      .toBe('won')

    // ---- Step 3: reverse the attribution.
    const reverseResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/reverse`,
      {
        token: staffToken,
        data: {
          reason: 'Wrong agency attributed — buyer corrected after the close call.',
        },
      },
    )
    const reverseBody = await readJsonSafe<{
      ok?: boolean
      emittedEvents?: string[]
      licenseDeal?: {
        status?: string
        attributionPath?: string
        attributedAgencyId?: string | null
        prospectId?: string | null
        attributedAt?: string | null
      }
    }>(reverseResp)
    expect(
      reverseResp.status(),
      `POST /reverse should return 202; body=${JSON.stringify(reverseBody)}`,
    ).toBe(202)
    expect(reverseBody?.licenseDeal?.status).toBe('pending')
    expect(reverseBody?.licenseDeal?.attributionPath).toBe('none')
    expect(reverseBody?.licenseDeal?.attributedAgencyId).toBeNull()
    expect(reverseBody?.licenseDeal?.prospectId).toBeNull()
    expect(reverseBody?.licenseDeal?.attributedAt).toBeNull()
    expect(
      reverseBody?.emittedEvents,
      `reverse emittedEvents must include reversal_started + reversed; got ${JSON.stringify(reverseBody?.emittedEvents)}`,
    ).toEqual(
      expect.arrayContaining([
        'prm.license_deal.reversal_started',
        'prm.license_deal.reversed',
      ]),
    )

    // ---- Step 4: LIFO compensation walks prospect won → qualified (≤30s).
    // Compensation runs through the `prm:license-deal-reversal-compensation`
    // subscriber on `prm.license_deal.reversal_started` — async via the
    // platform event runtime. Polling protects against workers-not-running.
    await expect
      .poll(
        async () => {
          const p = await getProspectViaPortalFixture(
            request,
            agency.admin.token,
            prospectId,
          )
          return p.status
        },
        {
          timeout: 30_000,
          intervals: [200, 500, 1000, 2000],
          message:
            'Reverse-saga compensation did not walk Prospect won → qualified within 30s. ' +
            'Real bug surface: workers not running OR compensateAttributionSaga broken. Do NOT stub.',
        },
      )
      .toBe('qualified')

    // ---- Step 5: re-attribution after full reversal must succeed (round trip).
    // Proves the compensation released the deal back to its pending base state
    // and the prospect is eligible again.
    const candidatesAgain = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
    })
    const defaultAgain = candidatesAgain.find((c) => c.isDefaultPick)
    expect(defaultAgain?.prospectId, 'prospect must be eligible again post-reverse').toBe(
      prospectId,
    )

    const reAttribute = await attributeLicenseDealFixture(
      request,
      staffToken,
      licenseDealId,
      {
        attribution_path: 'A',
        prospect_id: prospectId,
        golden_rule_default_prospect_id: prospectId,
        competing_prospect_ids_to_retire: [],
      },
    )
    expect(
      reAttribute.status,
      `re-attribute after reverse should 202; body=${JSON.stringify(reAttribute.body)}`,
    ).toBe(202)
    expect(reAttribute.body?.licenseDeal?.attributedAgencyId).toBe(agency.agencyId)
  })
})
