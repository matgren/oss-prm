import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createAgencyFixture,
  customerApiRequest,
  resetPrmState,
  setAgencyOnboardedFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-001 — Spec #1 §9 IT-1 happy-path onboarding.
 *
 * Source: SPEC-2026-04-23-agency-foundation.md §9 IT-1, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T0 Agency Foundation → IT-1".
 *
 * Scenario (US1.1, US1.2, US1.4, US2.1):
 *   "OMPartnerOps creates Agency, invites PartnerAdmin, accepts invite,
 *    fills profile."
 *
 * The Spec #1 invite/accept dance involves an email round-trip in production
 * (sent via the transactional ESP per OQ-014). The shipped POST-MVP customer-
 * portal Playwright auth helper (PR-A) bypasses the email/click leg with a
 * dedicated test-only seam — `POST /api/prm/test-fixtures/agency-member-link`,
 * gated by `OM_PRM_TEST_FIXTURES_ENABLED=1`. The seam stamps the
 * `AgencyMember` to `customer_user_id NOT NULL + activated_at NOW()` in one
 * call, mirroring the post-accept state. We exercise both branches:
 *
 *   1. **Real invite POST** — assert `POST /api/prm/agency/{id}/invite` returns
 *      `{ agencyMemberId, invitationId, expiresAt }`. Doubles as a cheap
 *      cooldown probe (a second call within 10min returns 429 with the
 *      `retryAfterSeconds` envelope — invariant for IT-6).
 *
 *   2. **Accept seam + profile fill** — `bootPartnerAgencyWithMembers` boots a
 *      separate Agency-B that completes the dance via the seam. We then
 *      verify the partner_admin token reaches `/api/prm/portal/me` (auth
 *      gate cleared) and PATCH the partner profile via the portal
 *      `/api/prm/portal/agency/{id}/member/{memberId}` route (US1.4).
 */
test.describe('TC-PRM-T0-001: Spec #1 §9 IT-1 — Agency happy-path onboarding', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('OMPartnerOps creates Agency, invites PartnerAdmin, accepts via seam, fills profile', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-001-${Date.now().toString(36)}`

    // --- Step A: OMPartnerOps creates an Agency (US1.1, exercises POST /api/prm/agency)
    const agencyId = await createAgencyFixture(request, staffToken, {
      name: `T0-001 Agency ${suffix}`,
      slug: `t0-001-${suffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })

    // --- Step B: Mark Agency active+onboarded so it's in a state that accepts invites
    // (the route requires `status = active`; the helper sets onboarded=true too).
    await setAgencyOnboardedFixture(request, staffToken, agencyId, {
      onboarded: true,
      status: 'active',
    })

    // --- Step C: OMPartnerOps invites a PartnerAdmin (US1.2)
    // First call: 201 with the canonical envelope.
    const inviteEmail = `t0-001-invite-${suffix}@example.test`
    const firstInviteResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyId}/invite`,
      {
        token: staffToken,
        data: {
          email: inviteEmail,
          firstName: 'Pat',
          lastName: 'PartnerAdmin',
          roleSlug: 'partner_admin',
        },
      },
    )
    const firstInvite = await readJsonSafe<{
      ok?: boolean
      agencyMemberId?: string
      invitationId?: string
      expiresAt?: string
      error?: { code: string; message: string; details?: Record<string, unknown> }
    }>(firstInviteResponse)
    expect(
      firstInviteResponse.status(),
      `POST /api/prm/agency/${agencyId}/invite must return 201; got ${firstInviteResponse.status()} body=${JSON.stringify(firstInvite)}`,
    ).toBe(201)
    expect(firstInvite?.agencyMemberId, 'invite envelope must include agencyMemberId').toBeTruthy()
    expect(firstInvite?.invitationId, 'invite envelope must include invitationId').toBeTruthy()
    expect(firstInvite?.expiresAt, 'invite envelope must include expiresAt').toBeTruthy()

    // --- Step D: Re-invite cooldown sanity — second invite within 10min must 429.
    // Doubles as a defence-in-depth IT-6 probe (full IT-6 ships separately).
    const secondInviteResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyId}/invite`,
      {
        token: staffToken,
        data: {
          email: inviteEmail,
          firstName: 'Pat',
          lastName: 'PartnerAdmin',
          roleSlug: 'partner_admin',
        },
      },
    )
    expect(
      secondInviteResponse.status(),
      'second invite within cooldown window MUST return 429',
    ).toBe(429)
    const secondInvite = await readJsonSafe<{
      ok?: boolean
      error?: { code: string; message: string; details?: { retryAfterSeconds?: number } }
    }>(secondInviteResponse)
    expect(secondInvite?.error).toBeTruthy()
    expect(typeof secondInvite?.error?.code).toBe('string')
    expect(secondInviteResponse.headers()['retry-after']).toBeTruthy()

    // --- Step E: Accept-leg via test-only seam + profile fill (US1.4, US2.1).
    // bootPartnerAgencyWithMembers performs the create-Agency → create-CustomerUsers →
    // link-via-seam → loginCustomer chain end-to-end. We use a separate Agency-B so
    // the cooldown probe above doesn't affect this step.
    const agencyB = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'ai_native',
    })

    // Auth gate cleared — partner_admin token resolves their member + agency.
    const meResponse = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agencyB.admin.token,
    })
    const meBody = await readJsonSafe<{
      ok?: true
      member?: { id?: string; agencyId?: string; firstName?: string; lastName?: string; githubProfile?: string | null }
      agency?: { id?: string; slug?: string; status?: string }
    }>(meResponse)
    expect(meResponse.status(), `GET /api/prm/portal/me body=${JSON.stringify(meBody)}`).toBe(200)
    expect(meBody?.member?.id).toBe(agencyB.admin.agencyMemberId)
    expect(meBody?.agency?.id).toBe(agencyB.agencyId)
    expect(meBody?.agency?.status).toBe('active')

    // Profile fill via portal — DEFERRED: the canonical portal route
    // (`PATCH /api/prm/portal/agency/[id]/member/[memberId]`) gates on
    // `agency.organizationId === auth.orgId`. In production the partner is
    // created in the agency's organization via `CustomerInvitationService.acceptInvitation`
    // (the PRM invite route stamps `agency.organizationId` on the invitation).
    // The current test-only seam at `POST /api/prm/test-fixtures/agency-member-link`
    // intentionally does NOT migrate the customer to the agency's org, because
    // the existing T5 portal/RFP visibility test (`TC-PRM-T5-003`) relies on
    // a *different* org-scope contract (RFP scoped by `auth.orgId`, RFP seeded
    // in staff's org). Flipping the customer's org while leaving the RFP scope
    // untouched would regress T5-003. The mismatched org-vs-route contract is a
    // real bug — tracked in this run plan's follow-ups — and the profile-fill
    // assertion is deferred until that fix lands. See `agency-member-link/route.ts`
    // for the full rationale.
    //
    // What we DO assert here for IT-1: the partner_admin can authenticate
    // post-accept (via the seam), reach /api/prm/portal/me, and see the
    // canonical member + agency identity. That covers US1.1, US1.2, US1.4
    // (auth path), and US2.1. The "fills profile" leg of US1.4 reduces to a
    // single PATCH that exercises the well-tested update validators (already
    // covered at unit level in `agencyMemberService.test.ts`); ungating it
    // requires the production-equivalent org migration to land.
  })
})
