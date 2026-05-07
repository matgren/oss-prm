import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createAgencyFixture,
  customerApiRequest,
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

    // Profile fill — PATCH /api/prm/portal/agency/{id}/member/{memberId} with the
    // partner_admin self-edit feature. Uses the portal contract surface (US1.4).
    const ghHandle = `t0-001-${suffix}`.toLowerCase().slice(0, 39)
    const profileResponse = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/agency/${agencyB.agencyId}/member/${agencyB.admin.agencyMemberId}`,
      {
        customerToken: agencyB.admin.token,
        data: {
          firstName: 'Avery',
          lastName: 'Admin-T0-001',
          roleInAgency: 'Director, Partnerships',
          githubProfile: ghHandle,
        },
      },
    )
    const profileBody = await readJsonSafe<{
      ok?: boolean
      agencyMember?: {
        id?: string
        firstName?: string
        lastName?: string
        roleInAgency?: string | null
        githubProfile?: string | null
      }
    }>(profileResponse)
    expect(
      profileResponse.status(),
      `PATCH portal/agency/${agencyB.agencyId}/member should return 200; body=${JSON.stringify(profileBody)}`,
    ).toBe(200)
    expect(profileBody?.agencyMember?.firstName).toBe('Avery')
    expect(profileBody?.agencyMember?.lastName).toBe('Admin-T0-001')
    expect(profileBody?.agencyMember?.githubProfile).toBe(ghHandle)
    expect(profileBody?.agencyMember?.roleInAgency).toBe('Director, Partnerships')

    // Sanity GET — partner_admin can read their post-edit profile via /me.
    const verifyResponse = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agencyB.admin.token,
    })
    const verifyBody = await readJsonSafe<{
      ok?: boolean
      member?: { firstName?: string; lastName?: string; githubProfile?: string | null }
    }>(verifyResponse)
    expect(verifyResponse.status()).toBe(200)
    expect(verifyBody?.member?.firstName).toBe('Avery')
    expect(verifyBody?.member?.githubProfile).toBe(ghHandle)
  })
})
