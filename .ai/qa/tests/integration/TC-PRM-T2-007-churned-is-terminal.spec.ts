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
 * TC-PRM-T2-007 — Spec #3 §9 IT-9.7 Churned is terminal.
 *
 * Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.7 + §3.1.3 + §11
 *   FROZEN error code `churned_is_terminal`, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T2 Attribution Loop → IT-9.7".
 *
 * Scenario:
 *   "Churned is terminal — `/unreverse-status` from `churned` → 409."
 *
 * Contract (Spec #3 §3.1.3):
 *   - LicenseDeal status `churned` is the v1 terminal state for contract
 *     termination (App Spec §1.4.1; the original spec's `invalidated`
 *     synonym is realised as `pending` + audit event, never as a status
 *     value — see §2 reconciliation note).
 *   - `/unreverse-status` from `churned` is REJECTED with 409
 *     `churned_is_terminal`. Recovery path is to create a NEW LicenseDeal
 *     (the successor row carries the audit context).
 *   - `/reverse` from `churned` is also blocked by invariant #7's
 *     attribution-freeze gate, returning 409 `attribution_frozen`. We
 *     verify both rejections to lock the terminal-state contract.
 *
 * Asserted end-to-end:
 *   1. Boot Agency, register + qualify Prospect, attribute Path A → `signed`.
 *   2. Forward-transition `signed → active` (legitimate go-live).
 *   3. Forward-transition `active → churned` (legitimate termination).
 *   4. POST `/unreverse-status` with `toStatus: 'signed'` → 409
 *      `churned_is_terminal`. Spec body: "churned is terminal — create a new
 *      license deal to record a successor." Both `signed` and `pending`
 *      target inputs are rejected because the Zod schema accepts both,
 *      but the service short-circuits on `deal.status === 'churned'` BEFORE
 *      the allowed-transition table is consulted.
 *   5. POST `/reverse` is also blocked (attribution_frozen — `churned` is
 *      in the locked-status set). Confirms there is no second escape hatch.
 *
 * The forward saga still walked the prospect to `won` in step 1, and that
 * remains stable across the failed unreverse + failed reverse attempts —
 * proving the rejection is "fail closed" (no side effects on the linked
 * Prospect aggregate).
 */
test.describe('TC-PRM-T2-007: Spec #3 §9 IT-9.7 — Churned is terminal (unreverse-status returns 409)', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('unreverse-status from churned → 409 churned_is_terminal; reverse also frozen; prospect remains won', async ({
    request,
  }) => {
    // Forward saga poll + post-condition checks. Allow 60s.
    test.setTimeout(60_000)
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t2-007-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    const clientCompanyName = `T2-007 LicenseClient ${suffix}`
    const contactEmail = `t2-007-buyer-${suffix}@example.test`
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
      annualValueUsd: 60_000,
      monthlyLicenseAmount: 5_000,
    })

    const candidates = await listGoldenRuleCandidatesFixture(request, staffToken, {
      clientCompanyName,
    })
    expect(candidates.find((c) => c.isDefaultPick)?.prospectId).toBe(prospectId)

    // ---- Step 1: Path A attribute → signed.
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
    const wonChangedAt = (
      await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    ).statusChangedAt

    // ---- Step 2: signed → active.
    const toActive = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/transition`,
      {
        token: staffToken,
        data: { toStatus: 'active', reason: 'Customer went live.' },
      },
    )
    expect(toActive.status()).toBe(200)

    // ---- Step 3: active → churned (legitimate termination).
    const toChurned = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/transition`,
      {
        token: staffToken,
        data: {
          toStatus: 'churned',
          reason: 'Customer terminated contract; recording end of license.',
        },
      },
    )
    const toChurnedBody = await readJsonSafe<{
      ok?: boolean
      licenseDeal?: { status?: string }
    }>(toChurned)
    expect(
      toChurned.status(),
      `active→churned transition should 200; body=${JSON.stringify(toChurnedBody)}`,
    ).toBe(200)
    expect(toChurnedBody?.licenseDeal?.status).toBe('churned')

    // ---- Step 4: unreverse-status from churned → 409 churned_is_terminal.
    // Both target statuses (`signed` / `pending`) are accepted by Zod but
    // the service short-circuits on the churned check BEFORE consulting the
    // allowed-transition table.
    const unreverseToSigned = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/unreverse-status`,
      {
        token: staffToken,
        data: {
          toStatus: 'signed',
          reason: 'Cannot unwind churned — must be rejected per spec §3.1.3.',
        },
      },
    )
    const unreverseToSignedBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string; message?: string }
    }>(unreverseToSigned)
    expect(
      unreverseToSigned.status(),
      `unreverse-status from churned should 409 churned_is_terminal; body=${JSON.stringify(unreverseToSignedBody)}`,
    ).toBe(409)
    expect(unreverseToSignedBody?.error?.code).toBe('churned_is_terminal')

    // Repeat with toStatus: 'pending' to lock down the terminality contract.
    const unreverseToPending = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/unreverse-status`,
      {
        token: staffToken,
        data: {
          toStatus: 'pending',
          reason: 'Cannot unwind churned to pending either.',
        },
      },
    )
    const unreverseToPendingBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string }
    }>(unreverseToPending)
    expect(
      unreverseToPending.status(),
      `unreverse-status churned→pending should also 409 churned_is_terminal; body=${JSON.stringify(unreverseToPendingBody)}`,
    ).toBe(409)
    expect(unreverseToPendingBody?.error?.code).toBe('churned_is_terminal')

    // ---- Step 5: /reverse from churned is also frozen (no second escape hatch).
    const reverseFromChurned = await apiRequest(
      request,
      'POST',
      `/api/prm/license-deal/${licenseDealId}/reverse`,
      {
        token: staffToken,
        data: { reason: 'Should be blocked by invariant #7 (active+churned freeze).' },
      },
    )
    const reverseFromChurnedBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string }
    }>(reverseFromChurned)
    expect(
      reverseFromChurned.status(),
      `reverse from churned should 409 attribution_frozen; body=${JSON.stringify(reverseFromChurnedBody)}`,
    ).toBe(409)
    expect(reverseFromChurnedBody?.error?.code).toBe('attribution_frozen')

    // Fail-closed verification: prospect remains won; no side effects from rejected paths.
    const prospectFinal = await getProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
    )
    expect(prospectFinal.status).toBe('won')
    expect(
      prospectFinal.statusChangedAt,
      'rejected unreverse + rejected reverse must NOT touch the linked Prospect',
    ).toBe(wonChangedAt)

    // Deal still shows churned + Path A attribution intact.
    const dealResp = await apiRequest(
      request,
      'GET',
      `/api/prm/license-deal/${licenseDealId}`,
      { token: staffToken },
    )
    const dealBody = await readJsonSafe<{
      licenseDeal?: {
        status?: string
        attributionPath?: string
        attributedAgencyId?: string | null
        prospectId?: string | null
      }
    }>(dealResp)
    expect(dealResp.status()).toBe(200)
    expect(dealBody?.licenseDeal?.status).toBe('churned')
    expect(dealBody?.licenseDeal?.attributionPath).toBe('A')
    expect(dealBody?.licenseDeal?.attributedAgencyId).toBe(agency.agencyId)
    expect(dealBody?.licenseDeal?.prospectId).toBe(prospectId)
  })
})
