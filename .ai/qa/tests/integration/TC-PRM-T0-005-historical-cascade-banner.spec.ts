import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  customerApiRequest,
  resetPrmState,
  setAgencyOnboardedFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-005 — Spec #1 §9 IT-5 `status = historical` cascade banner.
 *
 * Source: SPEC-2026-04-23-agency-foundation.md §9 IT-5, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T0 Agency Foundation → IT-5".
 *
 * Scenario (US1.7 — historical cascade, Vernon C3):
 *   When OMPartnerOps flips an Agency from `status='active'` to
 *   `status='historical'`, the change MUST propagate via
 *   `prm.agency.status_changed` to the AgencyMember read-model column
 *   (`agency_status`) and the portal MUST surface
 *   `agency.status === 'historical'` so the partner-status banner can
 *   render ("Your partnership is historical — contact OM PartnerOps to
 *   reactivate." per `frontend/.../portal/agency/page.tsx`).
 *
 * Service-side wiring (per `subscribers/agency-member-status-readmodel.ts`):
 *   - Subscriber metadata: `event = prm.agency.status_changed`,
 *     `persistent = true` (queued).
 *   - Updates every active `AgencyMember.agencyStatus` to the new status
 *     in the same tenant.
 *
 * Because the subscriber is `persistent: true`, the read-model write happens
 * asynchronously through the queue worker. We poll the staff
 * `GET /api/prm/agency-member/{id}` until `agencyStatus === 'historical'`.
 *
 * The portal `/api/prm/portal/me` (returns `agency.status` from the live
 * `prm_agencies` row, NOT from the read-model) reflects the change
 * synchronously — so we additionally assert it post-PATCH as a stricter
 * gate on the banner data path.
 */
test.describe('TC-PRM-T0-005: Spec #1 §9 IT-5 — historical cascade banner', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('flipping Agency to historical cascades to AgencyMember read-model + portal banner data', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-005-${Date.now().toString(36)}`

    // Boot active+onboarded Agency with linked partner_admin + partner_member.
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // Pre-state sanity — both members carry agencyStatus='active' (stamped by
    // the seam at link time from `agency.status`).
    const preAdminRead = await apiRequest(
      request,
      'GET',
      `/api/prm/agency-member/${agency.admin.agencyMemberId}`,
      { token: staffToken },
    )
    const preAdminBody = await readJsonSafe<{
      ok?: boolean
      agencyMember?: { agencyStatus?: string }
    }>(preAdminRead)
    expect(preAdminRead.status(), JSON.stringify(preAdminBody)).toBe(200)
    expect(preAdminBody?.agencyMember?.agencyStatus).toBe('active')

    // Portal /me — agency.status is 'active' before the cascade.
    const preMeResponse = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/me',
      { customerToken: agency.admin.token },
    )
    const preMeBody = await readJsonSafe<{
      ok?: true
      agency?: { id?: string; status?: string }
    }>(preMeResponse)
    expect(preMeResponse.status(), JSON.stringify(preMeBody)).toBe(200)
    expect(preMeBody?.agency?.status).toBe('active')

    // ---- Step 1: Flip Agency to historical via backend PATCH. The
    // setAgencyOnboardedFixture helper accepts `status` and posts to the
    // canonical `PATCH /api/prm/agency/{id}`. The route delegates to
    // `agencyService.updateAgency` which emits `prm.agency.status_changed`.
    await setAgencyOnboardedFixture(request, staffToken, agency.agencyId, {
      status: 'historical',
    })

    // ---- Step 2: Portal /me reflects the new status synchronously (the
    // route reads from `prm_agencies.status`, not the read-model).
    const postMeResponse = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/me',
      { customerToken: agency.admin.token },
    )
    const postMeBody = await readJsonSafe<{
      ok?: true
      agency?: { id?: string; status?: string }
    }>(postMeResponse)
    expect(postMeResponse.status(), JSON.stringify(postMeBody)).toBe(200)
    expect(
      postMeBody?.agency?.status,
      `portal /me MUST surface agency.status='historical' so the banner can render; body=${JSON.stringify(postMeBody)}`,
    ).toBe('historical')

    // ---- Step 3: Persistent subscriber (Vernon C3 read-model) walks
    // AgencyMember.agencyStatus to 'historical' for every active member.
    // The handler is `persistent: true` (queued), so we poll. 30s budget is
    // defence-in-depth for workers-not-running regressions; the queue runs
    // through within <1s under normal load.
    await expect
      .poll(
        async () => {
          const adminRead = await apiRequest(
            request,
            'GET',
            `/api/prm/agency-member/${agency.admin.agencyMemberId}`,
            { token: staffToken },
          )
          const body = await readJsonSafe<{
            agencyMember?: { agencyStatus?: string }
          }>(adminRead)
          return body?.agencyMember?.agencyStatus
        },
        {
          timeout: 30_000,
          intervals: [200, 500, 1000, 2000],
          message:
            'AgencyMemberStatusReadModelSubscriber did not propagate ' +
            'agency.status="historical" to AgencyMember.agencyStatus within 30s. ' +
            'This is the bug the smoke is designed to catch (workers not running, ' +
            'or subscriber broken). Do NOT stub.',
        },
      )
      .toBe('historical')

    // ---- Step 4: BOTH members updated, not just one (Vernon C3 — every
    // active AgencyMember in the same tenant + agency).
    const memberRead = await apiRequest(
      request,
      'GET',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken },
    )
    const memberBody = await readJsonSafe<{
      agencyMember?: { agencyStatus?: string }
    }>(memberRead)
    expect(memberRead.status(), JSON.stringify(memberBody)).toBe(200)
    expect(memberBody?.agencyMember?.agencyStatus).toBe('historical')
  })
})
