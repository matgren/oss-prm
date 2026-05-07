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
 * TC-PRM-T5-004 — Spec #5 §9.3 #17 P10 unsubmit happy path (US5.4 step 5).
 *
 * Promotes the previously-deferred unsubmit case to a Playwright HTTP-contract
 * test. Until PR-A's customer-portal auth helper shipped, §9.3 #17 was locked
 * at the service-test level (`__tests__/rfpService.test.ts`). PR #30 closed
 * the portal-org-mismatch gap so the boot fixture lands the partner_admin in
 * the agency's org, making the visibility gate pass straightforwardly.
 *
 * Flow under test:
 *   1. Boot a partner Agency + partner_admin (auth helper).
 *   2. Staff publishes an RFP broadcast to that Agency.
 *   3. PartnerAdmin saves a draft, then submits → status="submitted",
 *      firstSubmittedAt stamped (US5.4 step 5/5 fresh submit).
 *   4. PartnerAdmin POST /response/unsubmit → status flips back to "draft",
 *      reverted=true (the "undo submit" affordance from §3.3 idempotency
 *      table).
 *   5. Idempotency: a second unsubmit on the now-draft row returns 200 with
 *      reverted=false (the row is already in draft, no event re-emitted).
 *   6. Detail GET reflects the draft state and preserves `firstSubmittedAt`
 *      (history is preserved across the unsubmit — the contract only flips
 *      the status, never wipes the audit timestamp).
 *
 * Spec refs:
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §3.2 (POST /response/unsubmit)
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §3.3 idempotency table
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §9.3 #17 unsubmit happy path
 */
test.describe('TC-PRM-T5-004: Spec #5 P10 unsubmit happy path (§9.3 #17)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('PartnerAdmin can submit then unsubmit a response (idempotent on the draft row)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t5-004-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'ai_native',
    })

    // Staff: create + publish RFP scoped explicitly to this Agency.
    const rfpId = await createRfpDraftFixture(request, staffToken, {
      title: `T5-004 unsubmit happy ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agency.agencyId],
    })
    const publishResult = await publishRfpFixture(request, staffToken, rfpId)
    expect(publishResult.status, JSON.stringify(publishResult.body)).toBe(200)
    expect(publishResult.body?.broadcastAgencyIds).toContain(agency.agencyId)

    // 1. PartnerAdmin saves a draft with the required fields.
    const draftResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/draft`,
      {
        customerToken: agency.admin.token,
        data: {
          tech_experience: 'Five years of Next.js + Postgres delivery on enterprise SaaS.',
          domain_experience: 'Two regulated-industry rollouts (healthcare, fintech).',
          differentiators: 'In-house design system + 24/7 incident response.',
          attached_case_study_ids: [],
        },
      },
    )
    const draftBody = await readJsonSafe<{ status?: string }>(draftResponse)
    expect(draftResponse.status(), JSON.stringify(draftBody)).toBe(200)
    expect(draftBody?.status).toBe('draft')

    // 2. PartnerAdmin submits.
    const submitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/submit`,
      { customerToken: agency.admin.token, data: {} },
    )
    const submitBody = await readJsonSafe<{
      ok?: boolean
      status?: string
      firstSubmittedAt?: string | null
      isInitialSubmission?: boolean
    }>(submitResponse)
    expect(submitResponse.status(), JSON.stringify(submitBody)).toBe(200)
    expect(submitBody?.status).toBe('submitted')
    expect(submitBody?.firstSubmittedAt).toBeTruthy()
    expect(submitBody?.isInitialSubmission).toBe(true)
    const firstSubmittedAt = submitBody?.firstSubmittedAt

    // 3. PartnerAdmin unsubmits — the canonical undo path.
    const unsubmitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/unsubmit`,
      { customerToken: agency.admin.token, data: { reason: 'Need to revise tech section' } },
    )
    const unsubmitBody = await readJsonSafe<{
      ok?: boolean
      id?: string
      status?: string
      lastUpdatedAt?: string
      reverted?: boolean
    }>(unsubmitResponse)
    expect(unsubmitResponse.status(), JSON.stringify(unsubmitBody)).toBe(200)
    expect(unsubmitBody?.ok).toBe(true)
    expect(unsubmitBody?.status).toBe('draft')
    expect(unsubmitBody?.reverted).toBe(true)
    expect(unsubmitBody?.lastUpdatedAt).toBeTruthy()

    // 4. Idempotency: second unsubmit on the now-draft row returns reverted=false.
    const unsubmit2Response = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/unsubmit`,
      { customerToken: agency.admin.token, data: {} },
    )
    const unsubmit2Body = await readJsonSafe<{
      status?: string
      reverted?: boolean
    }>(unsubmit2Response)
    expect(unsubmit2Response.status()).toBe(200)
    expect(unsubmit2Body?.status).toBe('draft')
    expect(unsubmit2Body?.reverted).toBe(false)

    // 5. Detail GET reflects draft state but preserves firstSubmittedAt
    //    (contract only flips status, never wipes the audit timestamp).
    const detailResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${rfpId}`,
      { customerToken: agency.admin.token },
    )
    const detailBody = await readJsonSafe<{
      response?: { status?: string; firstSubmittedAt?: string | null }
    }>(detailResponse)
    expect(detailResponse.status()).toBe(200)
    expect(detailBody?.response?.status).toBe('draft')
    expect(detailBody?.response?.firstSubmittedAt).toBe(firstSubmittedAt)
  })
})
