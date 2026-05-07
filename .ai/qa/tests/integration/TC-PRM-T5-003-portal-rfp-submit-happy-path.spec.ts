import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createRfpDraftFixture,
  customerApiRequest,
  publishRfpFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T5-003 — Spec #5 §9.3 P10 submit happy path.
 *
 * Demonstrates the new customer-portal Playwright auth helper end-to-end on
 * a PartnerAdmin's "save draft → submit" flow:
 *
 *   1. Boot a partner Agency + partner_admin + partner_member (auth helper).
 *   2. Staff publishes an RFP broadcast to that Agency.
 *   3. PartnerAdmin GETs the RFP (P10 detail) — expects 200 with broadcast data.
 *   4. PartnerAdmin POSTs a draft (US5.4 step 2/5) — fills tech + domain.
 *   5. PartnerAdmin POSTs submit (US5.4 step 5/5) — expects 200, status flips
 *      to "submitted", `firstSubmittedAt` stamped.
 *   6. Idempotency check: second submit returns 200 with
 *      `isInitialSubmission: false`.
 *
 * Until this auth helper shipped, the §9.3 happy path was locked at the
 * service-test level in `__tests__/rfpService.test.ts`. This Playwright test
 * elevates it to a real HTTP-contract assertion.
 */
test.describe('TC-PRM-T5-003: Spec #5 P10 submit happy path (§9.3)', () => {
  test('PartnerAdmin can draft + submit a response on a broadcast RFP (idempotent)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t5-003-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'ai_native',
    })

    // Staff: create + publish RFP scoped explicitly to this Agency.
    const rfpId = await createRfpDraftFixture(request, staffToken, {
      title: `T5-003 submit happy ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agency.agencyId],
    })
    const publishResult = await publishRfpFixture(request, staffToken, rfpId)
    expect(publishResult.status, JSON.stringify(publishResult.body)).toBe(200)
    expect(publishResult.body?.broadcastAgencyIds).toContain(agency.agencyId)

    // 1. PartnerAdmin GET — should see the RFP detail (visibility gate open,
    //    broadcast.first_opened_at stamped on first call).
    const detailResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${rfpId}`,
      { customerToken: agency.admin.token },
    )
    const detail = await readJsonSafe<{
      ok?: boolean
      rfp?: { id?: string; status?: string }
      broadcast?: { firstOpenedAt?: string | null }
      response?: { status?: string } | null
    }>(detailResponse)
    expect(detailResponse.status(), JSON.stringify(detail)).toBe(200)
    expect(detail?.rfp?.id).toBe(rfpId)
    expect(detail?.rfp?.status).toBe('published')
    expect(detail?.broadcast?.firstOpenedAt).toBeTruthy()

    // 2. PartnerAdmin POSTs a draft with both required fields filled.
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
    const draftBody = await readJsonSafe<{
      ok?: boolean
      id?: string
      status?: string
      lastUpdatedAt?: string
    }>(draftResponse)
    expect(draftResponse.status(), JSON.stringify(draftBody)).toBe(200)
    expect(draftBody?.status).toBe('draft')
    expect(draftBody?.id).toBeTruthy()

    // 3. PartnerAdmin submits.
    const submitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/submit`,
      { customerToken: agency.admin.token, data: {} },
    )
    const submitBody = await readJsonSafe<{
      ok?: boolean
      id?: string
      status?: string
      firstSubmittedAt?: string | null
      isInitialSubmission?: boolean
    }>(submitResponse)
    expect(submitResponse.status(), JSON.stringify(submitBody)).toBe(200)
    expect(submitBody?.status).toBe('submitted')
    expect(submitBody?.firstSubmittedAt).toBeTruthy()
    expect(submitBody?.isInitialSubmission).toBe(true)

    // 4. Idempotency: second submit returns 200 with isInitialSubmission=false
    //    and the same firstSubmittedAt.
    const submit2Response = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/submit`,
      { customerToken: agency.admin.token, data: {} },
    )
    const submit2Body = await readJsonSafe<{
      status?: string
      firstSubmittedAt?: string | null
      isInitialSubmission?: boolean
    }>(submit2Response)
    expect(submit2Response.status()).toBe(200)
    expect(submit2Body?.status).toBe('submitted')
    expect(submit2Body?.isInitialSubmission).toBe(false)
    // The first-submission timestamp must be stable across retries.
    expect(submit2Body?.firstSubmittedAt).toBe(submitBody?.firstSubmittedAt)

    // 5. Detail GET after submit reflects the submitted response.
    const finalDetail = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${rfpId}`,
      { customerToken: agency.admin.token },
    )
    const finalBody = await readJsonSafe<{
      response?: { status?: string; firstSubmittedAt?: string | null }
    }>(finalDetail)
    expect(finalDetail.status()).toBe(200)
    expect(finalBody?.response?.status).toBe('submitted')
    expect(finalBody?.response?.firstSubmittedAt).toBeTruthy()
  })
})
