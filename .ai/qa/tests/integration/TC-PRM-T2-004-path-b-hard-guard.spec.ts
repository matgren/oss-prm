import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  attributeLicenseDealFixture,
  bootPartnerAgencyWithMembers,
  createLicenseDealFixture,
  createRfpDraftFixture,
  publishRfpFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T2-004 — Spec #3 §9 IT-9.4 Path-B hard guard (cross-spec with Spec #6).
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.4 + §8.4 cross-spec
 *   contract, POST-MVP-FOLLOW-UPS.md "Playwright integration tests (deferred)
 *   → T2 Attribution Loop → IT-9.4".
 *
 * Scenario:
 *   "Path-B hard guard (cross-spec coordination with Spec #6) —
 *    `RfpPathBLockSubscriber` writes `is_path_b_locked = true`;
 *    Spec #6 reads + enforces."
 *
 * Cross-spec contract (Spec #3 §8.4):
 *   1. Spec #5 ships the `prm_rfps.is_path_b_locked` column.
 *   2. Spec #3 owns `subscribers/rfp-path-b-lock.ts` as the SOLE writer
 *      (Singularity Law). It listens on `prm.license_deal.status_changed` and
 *      flips the flag to TRUE when at least one Path-B deal exists in
 *      status `signed`/`active` for that RFP, FALSE otherwise.
 *   3. Spec #6 (`rfpService.reopenRfp`) reads the flag and returns 409
 *      `path_b_signed_deal_lock` when set, blocking RFP re-open.
 *
 * Asserted end-to-end:
 *   1. Boot Agency (forces agency-org existence so RFP broadcast has a target).
 *   2. Create + publish a draft RFP — gives us a row in `prm_rfps`.
 *   3. Create LicenseDeal, attribute Path B → status `signed`. The
 *      `prm.license_deal.status_changed` event triggers the
 *      `prm:rfp-path-b-lock` subscriber.
 *   4. Poll GET `/api/prm/rfp/{id}` until `isPathBLocked === true` (≤30s,
 *      subscriber runs async via the platform event runtime). Real bug
 *      surface: workers not running OR introspection guard mis-firing.
 *
 * Notes:
 *   - This test does NOT exercise Spec #6's reopen-rejection branch directly
 *     because reaching the reopen-able states (`selection_made` / `closed`)
 *     requires the full scoring pipeline (responses + scores + winner select).
 *     Once the cross-spec read-model column flips to TRUE, Spec #6's runtime
 *     check is a single-line read against `Rfp.isPathBLocked` — covered by
 *     `__tests__/rfpSelectionService.test.ts` ("scenario:lockedReopen").
 *   - We DO exercise the lock-RELEASE half of the contract (lock = false)
 *     after `/unreverse-status signed → pending` per §8.6 lock semantics.
 *
 * Real saga, no stubs. Polls (≤30s).
 */
test.describe('TC-PRM-T2-004: Spec #3 §9 IT-9.4 — Path-B hard guard cross-spec contract', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Path B attribution flips RfpPathBLockSubscriber → is_path_b_locked = true; signed→pending releases the lock', async ({
    request,
  }) => {
    // Two subscriber-driven polls (lock-set + lock-release). Allow 90s.
    test.setTimeout(90_000)
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-004-${Date.now().toString(36)}`

    // ---- Step 1: Boot an Agency so the publish-broadcast has a target.
    // Tier ai_native so it's eligible for any min_tier filter.
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'ai_native',
    })

    // ---- Step 2: Create + publish a draft RFP.
    // Path B attribution only requires the RFP to exist for the tenant;
    // `tryLookupRfp` in `licenseDealService` does NOT check status.
    const rfpId = await createRfpDraftFixture(request, staffToken, {
      title: `T2-004 Path-B RFP ${suffix}`,
      eligibility_filter: 'all_active',
    })
    const publishResult = await publishRfpFixture(request, staffToken, rfpId)
    expect(
      publishResult.status,
      `publish should 200; body=${JSON.stringify(publishResult.body)}`,
    ).toBe(200)
    expect(publishResult.body?.status).toBe('published')
    expect(publishResult.body?.broadcastAgencyIds ?? []).toContain(agency.agencyId)

    // Read the RFP detail to confirm baseline isPathBLocked=false.
    const baselineResp = await apiRequest(
      request,
      'GET',
      `/api/prm/rfp/${rfpId}`,
      { token: staffToken },
    )
    const baselineBody = await readJsonSafe<{ ok?: boolean; rfp?: { isPathBLocked?: boolean } }>(
      baselineResp,
    )
    expect(baselineResp.status()).toBe(200)
    expect(
      baselineBody?.rfp?.isPathBLocked,
      'pre-attribution baseline must be unlocked',
    ).toBe(false)

    // ---- Step 3: Create LicenseDeal + attribute Path B.
    const licenseIdentifier = `OM-T2-${suffix.toUpperCase()}`
    const licenseDealId = await createLicenseDealFixture(request, staffToken, {
      licenseIdentifier,
      clientCompanyName: `T2-004 LicenseClient ${suffix}`,
      type: 'enterprise',
      annualValueUsd: 200_000,
      monthlyLicenseAmount: 16_666.67,
    })

    const attributeResult = await attributeLicenseDealFixture(
      request,
      staffToken,
      licenseDealId,
      {
        attribution_path: 'B',
        rfp_id: rfpId,
      },
    )
    expect(
      attributeResult.status,
      `Path B attribute should 202; body=${JSON.stringify(attributeResult.body)}`,
    ).toBe(202)
    expect(attributeResult.body?.licenseDeal?.attributionPath).toBe('B')
    expect(attributeResult.body?.licenseDeal?.status).toBe('signed')
    expect(
      attributeResult.body?.emittedEvents,
      `must emit attributed + status_changed (drives the lock subscriber)`,
    ).toEqual(
      expect.arrayContaining([
        'prm.license_deal.attributed',
        'prm.license_deal.status_changed',
      ]),
    )

    // ---- Step 4: Subscriber flips is_path_b_locked → true (≤30s).
    // The `prm:rfp-path-b-lock` subscriber runs async on
    // `prm.license_deal.status_changed`. Polling protects against
    // workers-not-running regressions.
    await expect
      .poll(
        async () => {
          const resp = await apiRequest(
            request,
            'GET',
            `/api/prm/rfp/${rfpId}`,
            { token: staffToken },
          )
          const body = await readJsonSafe<{ rfp?: { isPathBLocked?: boolean } }>(resp)
          return body?.rfp?.isPathBLocked ?? null
        },
        {
          timeout: 30_000,
          intervals: [200, 500, 1000, 2000],
          message:
            'RfpPathBLockSubscriber did not flip is_path_b_locked → true within 30s. ' +
            'Real bug surface: workers not running OR introspection guard mis-firing on prm_rfps. ' +
            'Do NOT stub.',
        },
      )
      .toBe(true)

    // ---- Step 5 (lock release per §8.6): unreverse signed → pending releases the lock.
    // Lock semantics: lock = ANY Path-B deal in status('signed','active'). After
    // `/unreverse-status signed → pending` the deal is no longer in the locking
    // set, so the subscriber must flip the flag back to false.
    const unreverseResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/unreverse-status`,
      {
        token: staffToken,
        data: {
          toStatus: 'pending',
          reason: 'Cross-spec test: walk back to pending to release the RFP lock.',
        },
      },
    )
    const unreverseBody = await readJsonSafe<{
      ok?: boolean
      licenseDeal?: { status?: string }
    }>(unreverseResp)
    expect(
      unreverseResp.status(),
      `unreverse-status should 200; body=${JSON.stringify(unreverseBody)}`,
    ).toBe(200)
    expect(unreverseBody?.licenseDeal?.status).toBe('pending')

    await expect
      .poll(
        async () => {
          const resp = await apiRequest(
            request,
            'GET',
            `/api/prm/rfp/${rfpId}`,
            { token: staffToken },
          )
          const body = await readJsonSafe<{ rfp?: { isPathBLocked?: boolean } }>(resp)
          return body?.rfp?.isPathBLocked ?? null
        },
        {
          timeout: 30_000,
          intervals: [200, 500, 1000, 2000],
          message:
            'Lock RELEASE did not flip is_path_b_locked → false within 30s after signed→pending. ' +
            '§8.6 contract: pending = reassignment legal; subscriber is sole writer.',
        },
      )
      .toBe(false)
  })
})
