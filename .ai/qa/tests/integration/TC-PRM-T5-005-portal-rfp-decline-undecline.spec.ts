import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createRfpDraftFixture,
  customerApiRequest,
  publishRfpFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T5-005 — Spec #5 §9.4 #20-#22 P10 decline + un-decline (US5.5).
 *
 * Promotes the previously-deferred decline / undecline cases to a Playwright
 * HTTP-contract test. Until PR-A's customer-portal auth helper shipped,
 * §9.4 was locked at the service-test level (`__tests__/rfpService.test.ts`).
 * PR #30 closed the portal-org-mismatch gap so the partner_admin lands in
 * the agency's org; the visibility gate now passes straightforwardly.
 *
 * Flow under test:
 *   1. Boot a partner Agency + partner_admin + partner_member (auth helper).
 *   2. Staff publishes an RFP broadcast to that Agency.
 *   3. PartnerMember POST /decline → 403 (decline is an Agency-level decision;
 *      §6.2 restricts it to PartnerAdmin).
 *   4. PartnerAdmin POST /decline with a reason (§9.4 #20) → 200, declinedAt
 *      stamped, declineReason persisted, declined=true.
 *   5. Idempotency: a second PartnerAdmin /decline returns declined=false
 *      and the same declinedAt — the §3.3 idempotency contract.
 *   6. PartnerAdmin POST /undecline (§9.4 #22) → 200, declinedAt cleared,
 *      declineReason cleared, reverted=true.
 *   7. Idempotency: a second /undecline returns reverted=false (already
 *      cleared, no event re-emitted).
 *   8. PartnerAdmin POST /decline without a reason (§9.4 #21) — re-decline
 *      after un-decline → declined=true, declineReason=null (allowed).
 *
 * Spec refs:
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §3.2 (POST /decline, /undecline)
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §3.3 idempotency table
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §6.2 portal RBAC (PartnerAdmin only)
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §9.4 #20-#22 decline lifecycle
 */
test.describe('TC-PRM-T5-005: Spec #5 P10 decline / un-decline (§9.4)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('PartnerAdmin can decline + un-decline a broadcast (idempotent both ways); PartnerMember is rejected', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t5-005-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'ai_native',
    })

    // Staff: create + publish RFP scoped explicitly to this Agency.
    const rfpId = await createRfpDraftFixture(request, staffToken, {
      title: `T5-005 decline lifecycle ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agency.agencyId],
    })
    const publishResult = await publishRfpFixture(request, staffToken, rfpId)
    expect(publishResult.status, JSON.stringify(publishResult.body)).toBe(200)
    expect(publishResult.body?.broadcastAgencyIds).toContain(agency.agencyId)

    // 1. PartnerMember tries to decline → 403 (§6.2 — Agency-level decision).
    const memberDeclineResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/decline`,
      {
        customerToken: agency.member.token,
        data: { decline_reason: 'Member should not be allowed to do this.' },
      },
    )
    const memberDeclineBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string; message?: string } | string
    }>(memberDeclineResponse)
    expect(
      memberDeclineResponse.status(),
      `PartnerMember /decline must 403; got ${memberDeclineResponse.status()} body=${JSON.stringify(memberDeclineBody)}`,
    ).toBe(403)
    expect(memberDeclineBody?.ok).toBe(false)

    // 2. PartnerAdmin declines with a reason (§9.4 #20).
    const declineReason = 'Conflict of interest — sister Agency already engaged.'
    const declineResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/decline`,
      {
        customerToken: agency.admin.token,
        data: { decline_reason: declineReason },
      },
    )
    const declineBody = await readJsonSafe<{
      ok?: boolean
      id?: string
      declinedAt?: string | null
      declineReason?: string | null
      declined?: boolean
    }>(declineResponse)
    expect(declineResponse.status(), JSON.stringify(declineBody)).toBe(200)
    expect(declineBody?.ok).toBe(true)
    expect(declineBody?.declined).toBe(true)
    expect(declineBody?.declinedAt).toBeTruthy()
    expect(declineBody?.declineReason).toBe(declineReason)
    const firstDeclinedAt = declineBody?.declinedAt

    // 3. Idempotency: second decline on an already-declined broadcast returns
    //    declined=false (no event re-emitted) and the same declinedAt.
    const decline2Response = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/decline`,
      {
        customerToken: agency.admin.token,
        data: { decline_reason: 'Different reason — should be ignored on retry.' },
      },
    )
    const decline2Body = await readJsonSafe<{
      declinedAt?: string | null
      declineReason?: string | null
      declined?: boolean
    }>(decline2Response)
    expect(decline2Response.status()).toBe(200)
    expect(decline2Body?.declined).toBe(false)
    expect(decline2Body?.declinedAt).toBe(firstDeclinedAt)
    // Original reason is preserved — idempotent decline does NOT overwrite it.
    expect(decline2Body?.declineReason).toBe(declineReason)

    // 4. PartnerAdmin un-declines (§9.4 #22).
    const undeclineResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/undecline`,
      { customerToken: agency.admin.token, data: {} },
    )
    const undeclineBody = await readJsonSafe<{
      ok?: boolean
      id?: string
      declinedAt?: string | null
      declineReason?: string | null
      reverted?: boolean
    }>(undeclineResponse)
    expect(undeclineResponse.status(), JSON.stringify(undeclineBody)).toBe(200)
    expect(undeclineBody?.ok).toBe(true)
    expect(undeclineBody?.reverted).toBe(true)
    expect(undeclineBody?.declinedAt).toBeNull()
    expect(undeclineBody?.declineReason).toBeNull()

    // 5. Idempotency: second un-decline on the cleared broadcast returns
    //    reverted=false.
    const undecline2Response = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/undecline`,
      { customerToken: agency.admin.token, data: {} },
    )
    const undecline2Body = await readJsonSafe<{
      declinedAt?: string | null
      reverted?: boolean
    }>(undecline2Response)
    expect(undecline2Response.status()).toBe(200)
    expect(undecline2Body?.reverted).toBe(false)
    expect(undecline2Body?.declinedAt).toBeNull()

    // 6. Re-decline without a reason (§9.4 #21 — allowed).
    const redeclineResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/decline`,
      { customerToken: agency.admin.token, data: {} },
    )
    const redeclineBody = await readJsonSafe<{
      declinedAt?: string | null
      declineReason?: string | null
      declined?: boolean
    }>(redeclineResponse)
    expect(redeclineResponse.status(), JSON.stringify(redeclineBody)).toBe(200)
    expect(redeclineBody?.declined).toBe(true)
    expect(redeclineBody?.declinedAt).toBeTruthy()
    expect(redeclineBody?.declineReason).toBeNull()
  })
})
