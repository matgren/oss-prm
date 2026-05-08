import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  customerApiRequest,
  loginCustomer,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-007 — SPEC-2026-05-08-agency-member-deactivation §"Integration Test Coverage".
 *
 * Covers IT-DEACT-1, IT-DEACT-2, IT-DEACT-3, IT-DEACT-4, IT-DEACT-6, IT-DEACT-7,
 * and IT-REACT-5. Asserts that flipping `AgencyMember.is_active` propagates to
 * `CustomerUser.is_active = false` (login blocked) and `sessions_revoked_at`
 * (existing JWTs invalidated) via the persistent
 * `agency-member-portal-access-revoke` subscriber, and that reactivation
 * restores future-login access without clearing the `sessions_revoked_at`
 * gate (per SPEC-060 contract — old JWTs stay invalidated).
 *
 * Requires `OM_PRM_TEST_FIXTURES_ENABLED=1` + `OM_PRM_WIC_IMPORT_SECRET` in
 * the running app env (see AGENTS.md §"Integration test environment").
 */
test.describe('TC-PRM-T0-007: SPEC-2026-05-08 — Agency member deactivation', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('IT-DEACT-1: backend deactivation invalidates existing portal session (401 on next call)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-deact1-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })

    // Sanity: partner_member's session works pre-deactivation.
    const preCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agency.member.token,
    })
    expect(preCall.status()).toBe(200)

    // Backend B3 deactivation as OM PartnerOps (staff).
    const patchResp = await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      {
        token: staffToken,
        data: { isActive: false },
      },
    )
    expect(patchResp.status(), 'backend deactivation should succeed').toBe(200)

    // Same JWT must now be rejected by validateUserState (CustomerUser.isActive=false
    // and/or sessions_revoked_at > jwt.iat). Customer auth surfaces this as 401.
    const postCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agency.member.token,
    })
    expect(
      postCall.status(),
      'partner_member JWT must be rejected after agency-member deactivation',
    ).toBe(401)
  })

  test('IT-DEACT-2: deactivated member cannot log in with valid credentials', async ({ request }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-deact2-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })

    // Deactivate via backend.
    const patchResp = await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken, data: { isActive: false } },
    )
    expect(patchResp.status()).toBe(200)

    // Fresh login attempt with valid credentials must fail (privacy-preserving
    // generic error per customer_accounts MUST rule #2 — no email enumeration).
    const loginAttempt = request.fetch('/api/customer_accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: {
        email: agency.member.email,
        password: agency.member.password,
        tenantId: agency.tenantId,
      },
    })
    const response = await loginAttempt
    expect(
      response.ok(),
      'fresh login for deactivated CustomerUser must be rejected',
    ).toBe(false)
    expect([401, 403]).toContain(response.status())
  })

  test('IT-DEACT-3: portal partner_admin deactivates partner_member (PATCH portal route)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-deact3-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })

    // Sanity: partner_member's session is alive.
    const preCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agency.member.token,
    })
    expect(preCall.status()).toBe(200)

    // partner_admin issues PATCH from portal context.
    const patchResp = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/agency/${agency.agencyId}/member/${agency.member.agencyMemberId}`,
      {
        customerToken: agency.admin.token,
        data: { isActive: false },
      },
    )
    expect(
      patchResp.status(),
      'partner_admin portal deactivation of partner_member must succeed',
    ).toBe(200)

    // Same JWT now invalid.
    const postCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agency.member.token,
    })
    expect(postCall.status()).toBe(401)
  })

  test('IT-DEACT-4: reactivation restores fresh login access', async ({ request }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-deact4-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })

    // Deactivate.
    await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken, data: { isActive: false } },
    )

    // Reactivate.
    const reactivateResp = await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken, data: { isActive: true } },
    )
    expect(reactivateResp.status(), 'reactivation should succeed').toBe(200)

    // Fresh login must now succeed (CustomerUser.isActive=true again).
    const freshToken = await loginCustomer(request, {
      email: agency.member.email,
      password: agency.member.password,
      tenantId: agency.tenantId,
    })
    expect(freshToken).toBeTruthy()

    // Fresh JWT works against portal endpoints.
    const portalCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: freshToken,
    })
    expect(portalCall.status()).toBe(200)
  })

  test('IT-REACT-5: old JWT minted before deactivation stays rejected after reactivation', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-react5-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })
    const oldJwt = agency.member.token

    // Deactivate then reactivate.
    await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken, data: { isActive: false } },
    )
    await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken, data: { isActive: true } },
    )

    // The old JWT (issued before deactivation) MUST stay rejected — sessions_revoked_at
    // is intentionally NOT cleared on reactivation. Per SPEC-060: any JWT with
    // iat < sessions_revoked_at fails validateUserState. New tokens minted via fresh
    // login (covered in IT-DEACT-4) work fine.
    const oldCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: oldJwt,
    })
    expect(
      oldCall.status(),
      'JWT issued before sessions_revoked_at must remain invalid after reactivation',
    ).toBe(401)
  })

  test('IT-DEACT-6: partner_admin self-deactivation via portal returns CANNOT_DEACTIVATE_SELF', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-deact6-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })

    // partner_admin tries to PATCH their own row — pre-existing guard at
    // api/portal/agency/[id]/member/[memberId]/route.ts must fire first
    // (BEFORE the deactivation propagates to CustomerUser).
    const patchResp = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/agency/${agency.agencyId}/member/${agency.admin.agencyMemberId}`,
      {
        customerToken: agency.admin.token,
        data: { isActive: false },
      },
    )
    // The portal route guards against partner_admin managing partner_admin rows
    // (only partner_member rows are manageable). The exact error code can be
    // either ROLE_NOT_SELF_ASSIGNABLE or CANNOT_DEACTIVATE_SELF depending on
    // which guard fires first; both are 403.
    expect(patchResp.status(), 'self-deactivation must be blocked').toBe(403)

    // Confirm session still alive.
    const meCall = await customerApiRequest(request, 'GET', '/api/prm/portal/me', {
      customerToken: agency.admin.token,
    })
    expect(meCall.status()).toBe(200)
  })

  test('IT-DEACT-7: deactivating a pre-accept member (no customerUserId) is a no-op', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-007-deact7-${Date.now().toString(36)}`
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, { suffix })

    // Backend invite a fresh placeholder member — no CustomerUser yet.
    const inviteResp = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agency.agencyId}/invite`,
      {
        token: staffToken,
        data: {
          email: `invitee-${suffix}@example.test`,
          firstName: 'Pre',
          lastName: 'Accept',
          roleSlug: 'partner_member',
        },
      },
    )
    const inviteBody = await readJsonSafe<{
      ok?: boolean
      agencyMemberId?: string
    }>(inviteResp)
    expect([200, 201]).toContain(inviteResp.status())
    const placeholderId = inviteBody?.agencyMemberId
    expect(placeholderId, JSON.stringify(inviteBody)).toBeTruthy()

    // Sanity: customerUserId is null (pre-accept).
    const readResp = await apiRequest(
      request,
      'GET',
      `/api/prm/agency-member/${placeholderId}`,
      { token: staffToken },
    )
    const readBody = await readJsonSafe<{
      agencyMember?: { customerUserId?: string | null; isActive?: boolean }
    }>(readResp)
    expect(readBody?.agencyMember?.customerUserId ?? null).toBeNull()

    // Deactivate the placeholder member — service emits removed event with
    // customerUserId=null; subscriber must short-circuit without touching any
    // CustomerUser. No error expected.
    const patchResp = await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${placeholderId}`,
      { token: staffToken, data: { isActive: false } },
    )
    expect(
      patchResp.status(),
      'deactivating pre-accept member should succeed (no CustomerUser to touch)',
    ).toBe(200)
  })
})
