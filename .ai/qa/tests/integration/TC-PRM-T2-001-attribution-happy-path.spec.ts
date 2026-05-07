import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  attributeLicenseDealFixture,
  bootPartnerAgencyWithMembers,
  createLicenseDealFixture,
  createProspectFixture,
  customerApiRequest,
  getProspectViaPortalFixture,
  listGoldenRuleCandidatesFixture,
  resetPrmState,
  transitionProspectViaPortalFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T2-001 — Spec #3 §9 IT-9.1 happy-path Path A attribution + saga + MIN.
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.1, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T2 Attribution Loop → IT-9.1".
 *
 * Scenario:
 *   "Path A happy path → MIN update — Saga completes within 10min;
 *    Prospect → won; portal MIN reflects deal."
 *
 * Asserts the full Path A loop end-to-end:
 *   1. PartnerAdmin registers a Prospect (own-Agency, qualified).
 *   2. OMPartnerOps creates a LicenseDeal with `clientCompanyName == prospect.companyName`.
 *   3. Golden Rule candidate picker returns exactly one default-pick row matching
 *      our prospect (invariant #14 — oldest non-lost).
 *   4. POST `/api/prm/license-deal/{id}/attribute` with Path A → 202 Accepted +
 *      `sagaCorrelationKey` + `licenseDeal.attributedAgencyId === agencyId`.
 *   5. **Saga poll (≤30s)** — `expect.poll(...)` walks the prospect status until
 *      `won`. The attribute route runs `runInlineSaga` synchronously so this
 *      typically takes <1s; the 30s budget is defence-in-depth for workers-
 *      not-running regressions.
 *   6. Portal MIN aggregate reflects the deal — `ownCount >= 1` and the
 *      license identifier appears in `ownDeals`.
 *
 * Per the run-plan brief: if the saga poll times out, that's a real bug the
 * test is designed to catch — do NOT stub the saga.
 */
test.describe('TC-PRM-T2-001: Spec #3 §9 IT-9.1 — Path A attribution + saga + MIN happy path', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('OMPartnerOps attributes deal Path A; saga walks prospect to won; portal MIN reflects', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-001-${Date.now().toString(36)}`

    // Boot Agency + partner_admin (post-accept state via the test seam).
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Step 1: PartnerAdmin registers a Prospect; transition to qualified.
    // Path A picker requires a non-`new` candidate ordered by registered_at;
    // qualified is the canonical "ready for attribution" status.
    const clientCompanyName = `T2-001 LicenseClient ${suffix}`
    const contactEmail = `t2-001-buyer-${suffix}@example.test`
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

    // ---- Step 2: OMPartnerOps creates a LicenseDeal matching the prospect's company.
    const licenseIdentifier = `OM-T2-${suffix.toUpperCase()}`
    const licenseDealId = await createLicenseDealFixture(request, staffToken, {
      licenseIdentifier,
      clientCompanyName,
      type: 'enterprise',
      annualValueUsd: 120_000,
      monthlyLicenseAmount: 10_000,
    })

    // ---- Step 3: Golden Rule picker returns exactly one default-pick candidate.
    const candidates = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
      contactEmail,
    })
    expect(candidates.length, JSON.stringify(candidates)).toBeGreaterThanOrEqual(1)
    const defaultPick = candidates.find((c) => c.isDefaultPick)
    expect(defaultPick, 'Golden Rule must elect exactly one default candidate').toBeTruthy()
    expect(defaultPick?.prospectId).toBe(prospectId)

    // ---- Step 4: POST attribute (Path A, default pick — no override reasoning needed).
    const attributeResult = await attributeLicenseDealFixture(
      request,
      staffToken,
      licenseDealId,
      {
        attribution_path: 'A',
        prospect_id: prospectId,
        golden_rule_default_prospect_id: prospectId, // default pick == picked
        competing_prospect_ids_to_retire: [],
      },
    )
    expect(
      attributeResult.status,
      `POST attribute should return 202; body=${JSON.stringify(attributeResult.body)}`,
    ).toBe(202)
    expect(attributeResult.body?.sagaCorrelationKey).toBeTruthy()
    expect(attributeResult.body?.licenseDeal?.attributedAgencyId).toBe(agency.agencyId)
    expect(attributeResult.body?.emittedEvents).toContain('prm.license_deal.attributed')

    // ---- Step 5: Saga poll — wait for prospect.status = 'won' (≤30s).
    // Per the run-plan brief: saga timeout = real bug, surface; do NOT stub.
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
            'Attribution saga did not walk Prospect to "won" within 30s. ' +
            'This is the bug the smoke is designed to catch (workers not running, ' +
            'or markProspectWon activity broken). Do NOT stub.',
        },
      )
      .toBe('won')

    // ---- Step 6: Portal MIN aggregate reflects the deal (US4.5).
    // NB: portal MIN scopes by `auth.orgId` (staff org, since the test seam
    // currently leaves the customer in the staff org — see notes in
    // `agency-member-link/route.ts` and TC-PRM-T0-001 commit). The MIN deal
    // is in the staff org, so the lookup matches; this test exercises the
    // same code path partner agencies hit in production AFTER the org-vs-
    // route mismatch follow-up lands.
    const minResponse = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/min',
      { customerToken: agency.admin.token },
    )
    const minBody = await readJsonSafe<{
      ok?: boolean
      year?: number
      ownCount?: number
      ownAnnualValueUsd?: number
      ownDeals?: Array<{
        licenseIdentifier?: string
        status?: string
        annualValueUsd?: { low: number; high: number } | null
      }>
    }>(minResponse)
    expect(
      minResponse.status(),
      `GET /api/prm/portal/min body=${JSON.stringify(minBody)}`,
    ).toBe(200)
    expect(minBody?.ownCount, JSON.stringify(minBody)).toBeGreaterThanOrEqual(1)
    const matchedDeal = minBody?.ownDeals?.find(
      (d) => d.licenseIdentifier === licenseIdentifier,
    )
    expect(
      matchedDeal,
      `MIN ownDeals must include licenseIdentifier=${licenseIdentifier}; got ${JSON.stringify(minBody?.ownDeals)}`,
    ).toBeTruthy()
    // Annual value is bucketed into $50k bands per the route's privacy DTO.
    expect(matchedDeal?.annualValueUsd).toEqual({ low: 100_000, high: 150_000 })
  })
})
