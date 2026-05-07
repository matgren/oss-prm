import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createCustomerUserFixture,
  createRfpDraftFixture,
  customerApiRequest,
  getCustomerRoleIdBySlug,
  linkAgencyMemberFixture,
  loginCustomer,
  publishRfpFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T5-006 — Spec #5 §9.3 #16 partner_member author-scope 403.
 *
 * Promotes the previously-deferred author-scope invariant to a Playwright
 * HTTP-contract test. Until PR-A's customer-portal auth helper shipped, this
 * was locked at the service-test level. PR #30 closed the portal-org-mismatch
 * gap so both partner_members land in the agency's org and share visibility.
 *
 * Property under test (US5.4 / §9.3 #16):
 *   The partner_member who first saved the draft (i.e. owns
 *   `RfpResponse.submittedByMemberId`) is the only partner_member allowed to
 *   submit OR unsubmit it. A *different* partner_member from the same Agency
 *   sees the RFP (visibility is Agency-scoped, not member-scoped) but the
 *   submit / unsubmit routes return 403. PartnerAdmin always overrides.
 *
 * Setup:
 *   1. Boot a partner Agency with `partner_admin` + `partner_member` (M1).
 *   2. Provision a second `partner_member` (M2) on the same Agency via the
 *      same low-level helpers `bootPartnerAgencyWithMembers` calls.
 *   3. Staff publishes an RFP broadcast to the Agency.
 *   4. M1 saves a draft — `submittedByMemberId` is stamped to M1.
 *   5. M2 submits → expect 403 (M2 is not the author).
 *   6. M1 submits → expect 200 (the author succeeds).
 *   7. M2 unsubmits → expect 403 (mirror of submit author-scope).
 *   8. PartnerAdmin unsubmits → expect 200 (admin overrides member scope).
 *
 * Spec refs:
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §3.2 (POST /response/submit
 *     enforces author-scope at the route layer)
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §6.2 portal RBAC
 *   - SPEC-2026-04-23-rfp-broadcast-response.md §9.3 #16 (M1 drafts → M2
 *     submit denied → M1 submit succeeds)
 */
test.describe('TC-PRM-T5-006: Spec #5 partner_member author-scope 403 (§9.3 #16)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('M2 cannot submit/unsubmit M1’s draft; M1 + PartnerAdmin always succeed', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t5-006-${Date.now().toString(36)}`

    // 1. Boot the Agency with PartnerAdmin + first PartnerMember (M1).
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'ai_native',
    })

    // 2. Provision a second `partner_member` (M2) on the same Agency. This
    //    mirrors the inner work `bootPartnerAgencyWithMembers` does for M1
    //    (createCustomerUserFixture → linkAgencyMemberFixture → loginCustomer).
    const memberRoleId = await getCustomerRoleIdBySlug(request, staffToken, 'partner_member')
    const m2Email = `portal-member2-${suffix}@example.test`
    const m2Password = 'PortalTest!Secret-123'
    const m2User = await createCustomerUserFixture(request, staffToken, {
      email: m2Email,
      password: m2Password,
      displayName: `Portal Member-2 ${suffix}`,
      roleIds: [memberRoleId],
    })
    await linkAgencyMemberFixture(request, staffToken, {
      agencyId: agency.agencyId,
      customerUserId: m2User.id,
      email: m2Email,
      firstName: 'Mickey',
      lastName: `Member2-${suffix}`,
      roleSlug: 'partner_member',
    })
    const m2Token = await loginCustomer(request, {
      email: m2Email,
      password: m2Password,
      tenantId: agency.tenantId,
    })

    // 3. Staff: create + publish RFP scoped explicitly to this Agency.
    const rfpId = await createRfpDraftFixture(request, staffToken, {
      title: `T5-006 author-scope ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agency.agencyId],
    })
    const publishResult = await publishRfpFixture(request, staffToken, rfpId)
    expect(publishResult.status, JSON.stringify(publishResult.body)).toBe(200)
    expect(publishResult.body?.broadcastAgencyIds).toContain(agency.agencyId)

    // 4. M1 saves the draft — this stamps submittedByMemberId = M1's
    //    AgencyMember id. The required-field set is filled so submit will
    //    pass server-side draft validation.
    const m1DraftResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/draft`,
      {
        customerToken: agency.member.token,
        data: {
          tech_experience: 'Two years of OM-stack delivery on regulated SaaS.',
          domain_experience: 'One healthcare rollout + one fintech pilot.',
          differentiators: 'Author-scope verified: M1 owns this draft.',
          attached_case_study_ids: [],
        },
      },
    )
    const m1DraftBody = await readJsonSafe<{ status?: string; id?: string }>(m1DraftResponse)
    expect(m1DraftResponse.status(), JSON.stringify(m1DraftBody)).toBe(200)
    expect(m1DraftBody?.status).toBe('draft')

    // Defence-in-depth: M2 can SEE the RFP (visibility is Agency-scoped) —
    // ensures the 403 below is genuinely an author-scope rejection, not a
    // silent-404 visibility miss.
    const m2DetailResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${rfpId}`,
      { customerToken: m2Token },
    )
    expect(
      m2DetailResponse.status(),
      'M2 must see the same RFP (visibility is Agency-scoped); otherwise the 403 below is masked by a 404',
    ).toBe(200)

    // 5. M2 submits → expect 403 (author-scope rejection — §9.3 #16).
    const m2SubmitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/submit`,
      { customerToken: m2Token, data: {} },
    )
    const m2SubmitBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string; message?: string } | string
    }>(m2SubmitResponse)
    expect(
      m2SubmitResponse.status(),
      `M2 /submit must 403 — author-scope violation; got ${m2SubmitResponse.status()} body=${JSON.stringify(m2SubmitBody)}`,
    ).toBe(403)
    expect(m2SubmitBody?.ok).toBe(false)

    // 6. M1 submits → expect 200 (author succeeds, §9.3 #16 happy leg).
    const m1SubmitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/submit`,
      { customerToken: agency.member.token, data: {} },
    )
    const m1SubmitBody = await readJsonSafe<{
      status?: string
      isInitialSubmission?: boolean
    }>(m1SubmitResponse)
    expect(m1SubmitResponse.status(), JSON.stringify(m1SubmitBody)).toBe(200)
    expect(m1SubmitBody?.status).toBe('submitted')
    expect(m1SubmitBody?.isInitialSubmission).toBe(true)

    // 7. M2 unsubmits → expect 403 (author-scope mirror on the undo path).
    const m2UnsubmitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/unsubmit`,
      { customerToken: m2Token, data: {} },
    )
    const m2UnsubmitBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string } | string
    }>(m2UnsubmitResponse)
    expect(
      m2UnsubmitResponse.status(),
      `M2 /unsubmit must 403 — author-scope mirror; got ${m2UnsubmitResponse.status()} body=${JSON.stringify(m2UnsubmitBody)}`,
    ).toBe(403)
    expect(m2UnsubmitBody?.ok).toBe(false)

    // 8. PartnerAdmin unsubmits → expect 200 (admin overrides member scope —
    //    only the partner_member role-slug is gated by author-scope).
    const adminUnsubmitResponse = await customerApiRequest(
      request,
      'POST',
      `/api/prm/portal/rfp/${rfpId}/response/unsubmit`,
      { customerToken: agency.admin.token, data: {} },
    )
    const adminUnsubmitBody = await readJsonSafe<{
      status?: string
      reverted?: boolean
    }>(adminUnsubmitResponse)
    expect(adminUnsubmitResponse.status(), JSON.stringify(adminUnsubmitBody)).toBe(200)
    expect(adminUnsubmitBody?.status).toBe('draft')
    expect(adminUnsubmitBody?.reverted).toBe(true)
  })
})
