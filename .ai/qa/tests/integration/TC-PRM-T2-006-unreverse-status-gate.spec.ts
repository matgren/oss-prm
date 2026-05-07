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
 * TC-PRM-T2-006 — Spec #3 §9 IT-9.6 US4.4b status-unreverse gate.
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.6 + §3.1.3 + §8.6,
 *   POST-MVP-FOLLOW-UPS.md "Playwright integration tests (deferred) →
 *   T2 Attribution Loop → IT-9.6".
 *
 * Scenario:
 *   "US4.4b status unreverse gate — `/unreverse-status` precondition;
 *    reverse only succeeds after status walk-back."
 *
 * Invariant #7 contract (Spec #3 §3.1.2 + §3.1.3):
 *   - `status >= active` freezes attribution. `/reverse` returns 409
 *     `attribution_frozen` with the canonical "Use /unreverse-status first" hint.
 *   - `/unreverse-status` is the scoped bypass (US4.4b). Allowed transitions:
 *     `active → signed` (lock stays per §8.6) and `signed → pending`
 *     (lock releases). `churned` is terminal — covered by IT-9.7.
 *   - After walking the deal back to `signed` (or `pending`), `/reverse`
 *     succeeds and the LIFO compensation walks the prospect back to qualified.
 *
 * Asserted end-to-end:
 *   1. Boot Agency, register + qualify Prospect, attribute Path A → status `signed`.
 *   2. Forward-transition `signed → active` via `/transition` (the legitimate
 *      go-live path). Attribution is now FROZEN per invariant #7.
 *   3. Attempt `/reverse` → 409 `attribution_frozen` with the standard hint.
 *   4. Call `/unreverse-status active → signed` → 200 (the gate opens; lock
 *      semantics §8.6: lock STAYS at this hop because signed is in the locking set).
 *   5. Re-attempt `/reverse` → 202. Compensation runs async via the
 *      `prm:license-deal-reversal-compensation` subscriber.
 *   6. Poll portal `/prospects/{id}` (≤30s) until `qualified` — proves the
 *      reverse path now works once the gate is opened.
 *   7. Sanity: re-running `/unreverse-status` from `pending` (already there
 *      after reverse) returns 409 `status_change_not_allowed` — `pending → *`
 *      is not in the unreverse table; only forward `/transition` is legal.
 *
 * Real saga, no stubs.
 */
test.describe('TC-PRM-T2-006: Spec #3 §9 IT-9.6 — US4.4b status-unreverse gate (active → signed → reverse)', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('reverse on active 409s; unreverse-status active→signed re-opens; reverse then succeeds + walks prospect to qualified', async ({
    request,
  }) => {
    // Forward saga + reverse compensation polls; multiple state walks. Allow 120s.
    test.setTimeout(120_000)
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-006-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    const clientCompanyName = `T2-006 LicenseClient ${suffix}`
    const contactEmail = `t2-006-buyer-${suffix}@example.test`
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
      annualValueUsd: 72_000,
      monthlyLicenseAmount: 6_000,
    })

    const candidates = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
    })
    expect(candidates.find((c) => c.isDefaultPick)?.prospectId).toBe(prospectId)

    // ---- Step 1: Path A attribute → status `signed`.
    const attribResult = await attributeLicenseDealFixture(
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
    expect(attribResult.status).toBe(202)
    expect(attribResult.body?.licenseDeal?.status).toBe('signed')

    // Wait for forward saga so prospect = `won` before we test reverse.
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
        { timeout: 30_000, intervals: [200, 500, 1000, 2000] },
      )
      .toBe('won')

    // ---- Step 2: Forward-transition signed → active (legitimate go-live).
    const transitionResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/transition`,
      {
        token: staffToken,
        data: {
          toStatus: 'active',
          reason: 'Customer went live; tier-counter switch flips per §1.4 contract.',
        },
      },
    )
    const transitionBody = await readJsonSafe<{
      ok?: boolean
      licenseDeal?: { status?: string }
    }>(transitionResp)
    expect(
      transitionResp.status(),
      `signed→active transition should 200; body=${JSON.stringify(transitionBody)}`,
    ).toBe(200)
    expect(transitionBody?.licenseDeal?.status).toBe('active')

    // ---- Step 3: /reverse on active deal → 409 attribution_frozen.
    const reverseFrozenResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/reverse`,
      {
        token: staffToken,
        data: {
          reason: 'Cannot reverse — should be blocked by invariant #7 active-freeze.',
        },
      },
    )
    const reverseFrozenBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string; message?: string }
    }>(reverseFrozenResp)
    expect(
      reverseFrozenResp.status(),
      `reverse on active should 409 attribution_frozen; body=${JSON.stringify(reverseFrozenBody)}`,
    ).toBe(409)
    expect(reverseFrozenBody?.error?.code).toBe('attribution_frozen')

    // Prospect MUST still be won — failed reverse should not have triggered compensation.
    const prospectStillWon = await getProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
    )
    expect(prospectStillWon.status).toBe('won')

    // ---- Step 4: /unreverse-status active → signed → 200.
    const unreverseResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/unreverse-status`,
      {
        token: staffToken,
        data: {
          toStatus: 'signed',
          reason: 'US4.4b: walk back from active to signed so we can reverse attribution.',
        },
      },
    )
    const unreverseBody = await readJsonSafe<{
      ok?: boolean
      licenseDeal?: { status?: string }
    }>(unreverseResp)
    expect(
      unreverseResp.status(),
      `unreverse-status active→signed should 200; body=${JSON.stringify(unreverseBody)}`,
    ).toBe(200)
    expect(unreverseBody?.licenseDeal?.status).toBe('signed')

    // ---- Step 5: /reverse now succeeds (status < active again).
    const reverseOkResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/reverse`,
      {
        token: staffToken,
        data: {
          reason: 'Reverse path now legal: status walked back to signed via US4.4b.',
        },
      },
    )
    const reverseOkBody = await readJsonSafe<{
      ok?: boolean
      licenseDeal?: { status?: string; attributionPath?: string }
      emittedEvents?: string[]
    }>(reverseOkResp)
    expect(
      reverseOkResp.status(),
      `reverse after unreverse-status should 202; body=${JSON.stringify(reverseOkBody)}`,
    ).toBe(202)
    expect(reverseOkBody?.licenseDeal?.status).toBe('pending')
    expect(reverseOkBody?.licenseDeal?.attributionPath).toBe('none')
    expect(reverseOkBody?.emittedEvents).toEqual(
      expect.arrayContaining([
        'prm.license_deal.reversal_started',
        'prm.license_deal.reversed',
      ]),
    )

    // ---- Step 6: compensation walks prospect won → qualified (≤30s).
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
            'Reverse compensation did not walk Prospect won → qualified within 30s. ' +
            'Real bug: workers not running OR compensateAttributionSaga broken.',
        },
      )
      .toBe('qualified')

    // ---- Step 7: Sanity — pending → * is not allowed via /unreverse-status.
    // The unreverse-status table is { signed: ['pending'], active: ['signed'] }.
    // Calling on a pending deal returns 409 status_change_not_allowed (NOT 422
    // — Zod accepts the body shape; the gate is at the service layer).
    const sanityResp = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/unreverse-status`,
      {
        token: staffToken,
        data: {
          toStatus: 'pending',
          reason: 'Sanity: pending → pending must be rejected (no-op or invalid).',
        },
      },
    )
    const sanityBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string }
    }>(sanityResp)
    expect(
      sanityResp.status(),
      `unreverse-status from pending should 409 status_change_not_allowed; body=${JSON.stringify(sanityBody)}`,
    ).toBe(409)
    expect(sanityBody?.error?.code).toBe('status_change_not_allowed')
  })
})
