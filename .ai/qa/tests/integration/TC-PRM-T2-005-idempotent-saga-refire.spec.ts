import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
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
 * TC-PRM-T2-005 — Spec #3 §9 IT-9.5 Idempotent saga re-fire.
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.5 + §5.3 + §5.4,
 *   POST-MVP-FOLLOW-UPS.md "Playwright integration tests (deferred) →
 *   T2 Attribution Loop → IT-9.5".
 *
 * Scenario:
 *   "Idempotent saga re-fire — Duplicate `prm.license_deal.attributed` deduped
 *    via correlationKey."
 *
 * Idempotency contract (Spec #3):
 *   - `correlationKey = license_deal_id + ':' + attribution_source` per
 *     `licenseDealCorrelationKey(...)` in `data/validators.ts` (FROZEN
 *     cross-spec contract).
 *   - The platform's `WorkflowInstance.correlation_key` index + `maxConcurrentInstances=1`
 *     dedupes duplicate `prm.license_deal.attributed` events. NO PRM-owned
 *     `processed_events` table per OQ-017.
 *   - Each activity handler is read-before-write idempotent
 *     (`executeAttributionSaga` checks `attributedAgencyId` before snapshot,
 *     checks `prospect.status !== 'won'` before transition). Re-running is safe.
 *
 * Asserted end-to-end:
 *   1. Boot Agency, register + qualify Prospect, create LicenseDeal.
 *   2. POST `/attribute` → 202 with `sagaCorrelationKey = "<dealId>:prospect"`.
 *   3. Verify the correlationKey shape matches the FROZEN contract.
 *   4. Capture initial state: prospect = `won`, deal = `signed` + attributed.
 *   5. Attempt to re-attribute the SAME deal → 409 `status_change_not_allowed`.
 *      This proves the deal-aggregate dedup gate (only `pending` may be
 *      attributed); a duplicate `prm.license_deal.attributed` event reaching
 *      the saga would trigger the SAME read-before-write activity handlers,
 *      which the unit test `attributionSaga.test.ts` covers exhaustively.
 *   6. Confirm idempotency observable manifestation: prospect remains `won`
 *      (no double-walk), deal still attributed to the SAME agency, MIN
 *      ownCount remains 1 (no duplicate counting from saga re-firing).
 *
 * The saga is idempotent BY CONSTRUCTION — this integration test verifies the
 * observable invariant (state stable, no double-counting) rather than re-emitting
 * the event directly (no test seam exists for that, by design — the platform
 * dedupe is opaque to callers).
 */
test.describe('TC-PRM-T2-005: Spec #3 §9 IT-9.5 — Idempotent saga re-fire (correlationKey dedup)', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('attribute correlationKey matches FROZEN shape; re-attribute is rejected; state stays consistent', async ({
    request,
  }) => {
    // Forward saga poll + post-conditions. Allow 60s.
    test.setTimeout(60_000)
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-005-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    const clientCompanyName = `T2-005 LicenseClient ${suffix}`
    const contactEmail = `t2-005-buyer-${suffix}@example.test`
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

    const licenseIdentifier = `OM-T2-${suffix.toUpperCase()}`
    const licenseDealId = await createLicenseDealFixture(request, staffToken, {
      licenseIdentifier,
      clientCompanyName,
      type: 'enterprise',
      annualValueUsd: 84_000,
      monthlyLicenseAmount: 7_000,
    })

    const candidates = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
    })
    expect(candidates.find((c) => c.isDefaultPick)?.prospectId).toBe(prospectId)

    // ---- Step 2: First attribute → 202.
    const firstAttempt = await attributeLicenseDealFixture(
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
      firstAttempt.status,
      `first attribute should 202; body=${JSON.stringify(firstAttempt.body)}`,
    ).toBe(202)

    // ---- Step 3: correlationKey contract — `<dealId>:prospect` for Path A.
    const expectedCorrelationKey = `${licenseDealId}:prospect`
    expect(
      firstAttempt.body?.sagaCorrelationKey,
      `correlationKey FROZEN shape: <licenseDealId>:<attribution_source>; got ${firstAttempt.body?.sagaCorrelationKey}`,
    ).toBe(expectedCorrelationKey)

    // Saga walks prospect to `won` (≤30s).
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

    // ---- Step 4: capture post-saga state for stability comparison.
    const postFirstAttribute = await getProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
    )
    expect(postFirstAttribute.status).toBe('won')
    const firstStatusChangedAt = postFirstAttribute.statusChangedAt

    // Capture deal state.
    const dealAfterFirst = await apiRequest(
      request,
      'GET',
      `/api/prm/license-deal/${licenseDealId}`,
      { token: staffToken },
    )
    const dealBodyFirst = await readJsonSafe<{
      licenseDeal?: { status?: string; attributedAgencyId?: string | null; version?: number }
    }>(dealAfterFirst)
    expect(dealBodyFirst?.licenseDeal?.status).toBe('signed')
    expect(dealBodyFirst?.licenseDeal?.attributedAgencyId).toBe(agency.agencyId)
    const versionAfterFirst = dealBodyFirst?.licenseDeal?.version

    // Capture MIN ownCount baseline.
    const minResp1 = await customerApiRequest(request, 'GET', '/api/prm/portal/min', {
      customerToken: agency.admin.token,
    })
    const minBody1 = await readJsonSafe<{
      ok?: boolean
      ownCount?: number
      ownDeals?: Array<{ licenseIdentifier?: string }>
    }>(minResp1)
    expect(minResp1.status()).toBe(200)
    expect(minBody1?.ownCount).toBe(1)

    // ---- Step 5: Re-attribute the SAME deal → must reject (only pending deals
    // are attributable). This is the application-level dedup gate.
    const secondAttempt = await attributeLicenseDealFixture(
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
      secondAttempt.status,
      `re-attribute on signed deal should 409 status_change_not_allowed; body=${JSON.stringify(secondAttempt.body)}`,
    ).toBe(409)
    const errPayload = secondAttempt.body?.error
    if (typeof errPayload === 'object' && errPayload !== null && 'code' in errPayload) {
      expect((errPayload as { code: string }).code).toBe('status_change_not_allowed')
    }

    // ---- Step 6: idempotency observables — state must NOT have drifted.
    // Prospect must still be `won` with the SAME `statusChangedAt` (no double-walk).
    const prospectFinal = await getProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
    )
    expect(prospectFinal.status).toBe('won')
    expect(
      prospectFinal.statusChangedAt,
      'idempotency invariant: re-attribution attempt must NOT re-emit prospect.status_changed',
    ).toBe(firstStatusChangedAt)

    // Deal still attributed to the SAME agency; version unchanged by the rejected attempt.
    const dealAfterSecond = await apiRequest(
      request,
      'GET',
      `/api/prm/license-deal/${licenseDealId}`,
      { token: staffToken },
    )
    const dealBodySecond = await readJsonSafe<{
      licenseDeal?: { status?: string; attributedAgencyId?: string | null; version?: number }
    }>(dealAfterSecond)
    expect(dealBodySecond?.licenseDeal?.status).toBe('signed')
    expect(dealBodySecond?.licenseDeal?.attributedAgencyId).toBe(agency.agencyId)
    expect(
      dealBodySecond?.licenseDeal?.version,
      'rejected re-attribute must NOT bump aggregate version',
    ).toBe(versionAfterFirst)

    // MIN ownCount must remain 1 — no double-counting from saga dedup.
    const minResp2 = await customerApiRequest(request, 'GET', '/api/prm/portal/min', {
      customerToken: agency.admin.token,
    })
    const minBody2 = await readJsonSafe<{ ok?: boolean; ownCount?: number }>(minResp2)
    expect(minResp2.status()).toBe(200)
    expect(
      minBody2?.ownCount,
      'MIN aggregate must remain stable — saga dedup must not produce duplicate attribution counting',
    ).toBe(1)
  })
})
