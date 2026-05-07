import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-004 — Spec #1 §9 IT-4 lockout recovery (US1.6).
 *
 * Source: SPEC-2026-04-23-agency-foundation.md §9 IT-4, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T0 Agency Foundation → IT-4".
 *
 * Scenario (US1.6 — "OM PartnerOps promotes a PartnerMember to PartnerAdmin
 * in ≤1 minute" per spec §1.4):
 *   When the sole `partner_admin` of an Agency loses access (lockout), an
 *   OMPartnerOps staff user must be able to promote an existing
 *   `partner_member` to `partner_admin` so the Agency regains an admin in
 *   the portal. Spec §3.1 routes this through the existing B3 PATCH
 *   endpoint `PATCH /api/prm/agency-member/{id}` with `roleSlug` change —
 *   "zero new UI" per §1.4.
 *
 * The PRM service-side path:
 *   1. Validate via `updateAgencyMemberBackendSchema` (allows `roleSlug`).
 *   2. `agencyMemberService.update(member, { roleSlug }, { allowRoleChange: true })`.
 *      This emits `prm.agency_member.role_changed`.
 *   3. Because the member already has a `customerUserId` (post-accept state
 *      via the test seam), the route's `syncCustomerRoleAssignment` helper
 *      drops the existing `partner_member` `CustomerUserRole` row and inserts
 *      a fresh `partner_admin` assignment in the same transaction. This is
 *      the data the customer JWT carries on next login — the actual
 *      "lockout recovery" mechanism.
 *
 * Test coverage:
 *   - Boot Agency with both partner_admin + partner_member CustomerUsers.
 *   - PATCH the partner_member → roleSlug=partner_admin via B3.
 *   - Assert response carries `agencyMember.roleSlug === 'partner_admin'`.
 *   - GET the same member — confirm persisted roleSlug.
 *   - GET the partner_admin's member by id — confirm UNCHANGED (only the
 *     promoted member's roleSlug should have flipped, not both).
 */
test.describe('TC-PRM-T0-004: Spec #1 §9 IT-4 — Lockout recovery (US1.6)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('OMPartnerOps promotes partner_member → partner_admin via B3 PATCH; only target member changes', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-004-${Date.now().toString(36)}`

    // Boot Agency with admin + member; the seam stamps both members
    // post-accept (customer_user_id NOT NULL, activated_at NOW()), so the
    // role-change path will exercise `syncCustomerRoleAssignment`.
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // Sanity: pre-state — confirm the seam wired both members to their
    // expected slugs. This guards against silent drift in the boot helper.
    const preMemberRead = await apiRequest(
      request,
      'GET',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken },
    )
    const preMemberBody = await readJsonSafe<{
      ok?: boolean
      agencyMember?: { id?: string; roleSlug?: string; customerUserId?: string | null }
    }>(preMemberRead)
    expect(preMemberRead.status(), JSON.stringify(preMemberBody)).toBe(200)
    expect(preMemberBody?.agencyMember?.roleSlug).toBe('partner_member')
    expect(
      preMemberBody?.agencyMember?.customerUserId,
      'partner_member must be post-accept (customerUserId NOT NULL) so role-sync runs',
    ).toBe(agency.member.customerUserId)

    // ---- Step 1: PATCH the partner_member's roleSlug to partner_admin (US1.6).
    const promoteResponse = await apiRequest(
      request,
      'PATCH',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      {
        token: staffToken,
        data: { roleSlug: 'partner_admin' },
      },
    )
    const promoteBody = await readJsonSafe<{
      ok?: boolean
      agencyMember?: { id?: string; roleSlug?: string }
      error?: { code: string; message: string }
    }>(promoteResponse)
    expect(
      promoteResponse.status(),
      `PATCH agency-member roleSlug=partner_admin must return 200; body=${JSON.stringify(promoteBody)}`,
    ).toBe(200)
    expect(promoteBody?.agencyMember?.id).toBe(agency.member.agencyMemberId)
    expect(promoteBody?.agencyMember?.roleSlug).toBe('partner_admin')

    // ---- Step 2: GET the promoted member — persisted roleSlug.
    const postMemberRead = await apiRequest(
      request,
      'GET',
      `/api/prm/agency-member/${agency.member.agencyMemberId}`,
      { token: staffToken },
    )
    const postMemberBody = await readJsonSafe<{
      ok?: boolean
      agencyMember?: { id?: string; roleSlug?: string }
    }>(postMemberRead)
    expect(postMemberRead.status(), JSON.stringify(postMemberBody)).toBe(200)
    expect(postMemberBody?.agencyMember?.roleSlug).toBe('partner_admin')

    // ---- Step 3: GET the original partner_admin — must be unchanged.
    // Lockout recovery is a one-way promotion; the existing admin's row is not
    // touched (the spec's "zero new UI" claim assumes a single targeted PATCH).
    const adminRead = await apiRequest(
      request,
      'GET',
      `/api/prm/agency-member/${agency.admin.agencyMemberId}`,
      { token: staffToken },
    )
    const adminBody = await readJsonSafe<{
      ok?: boolean
      agencyMember?: { id?: string; roleSlug?: string }
    }>(adminRead)
    expect(adminRead.status(), JSON.stringify(adminBody)).toBe(200)
    expect(
      adminBody?.agencyMember?.roleSlug,
      'pre-existing partner_admin must remain unchanged after promoting another member',
    ).toBe('partner_admin')
  })
})
