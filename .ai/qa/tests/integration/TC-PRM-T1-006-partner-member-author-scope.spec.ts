import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createProspectFixture,
  customerApiRequest,
  getProspectViaPortalFixture,
  resetPrmState,
  transitionProspectViaPortalFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-006 — Spec #2 §9 IT-9.6 PartnerMember author-scope guard.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.6 + §6.3 (Author-scope
 *   check, invariant #12 C4), POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.6".
 *
 * Scenario:
 *   "Non-author cannot transition another member's Prospect."
 *
 * Invariant #12 C4 — author-scope check (from `prospectService.transitionStatus`):
 *   if (actor.role === 'PartnerMember' && !actor.has('prm.prospect.transition_any_in_agency')
 *       && prospect.registered_by_agency_member_id !== actor.agency_member_id) → 403
 *
 * The route surfaces this as `403 not_author_or_admin` with the canonical
 * message "Only the author or your PartnerAdmin can transition this Prospect".
 *
 * Test setup:
 *   - One Agency, two members:
 *       * `partner_admin` — has `prm.prospect.transition_any_in_agency`
 *       * `partner_member` — has `prm.prospect.transition_own_authored` only
 *   - PartnerAdmin registers a Prospect (author = admin's AgencyMember).
 *   - PartnerMember (NOT the author, no admin grant) attempts to transition →
 *     MUST 403 not_author_or_admin.
 *   - PartnerAdmin can still transition the same Prospect (sanity).
 *   - PartnerMember registers a *different* Prospect (author = member) and
 *     transitions THAT one fine — proves the guard is author-scoped, not
 *     a blanket member-write block.
 *   - The author-scoped path is also reflected in the GET response's
 *     `canTransitionTo` array — verifies §6.3 server-computed flag stays
 *     consistent with the runtime guard.
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-006: Spec #2 §9 IT-9.6 — PartnerMember author-scope (invariant #12 C4)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('PartnerMember cannot transition another member-authored prospect (403 not_author_or_admin)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-006-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Step 1: PartnerAdmin authors a Prospect.
    const adminAuthoredId = await createProspectFixture(request, agency.admin.token, {
      companyName: `T1-006 Admin-Authored ${suffix}`,
      contactName: 'Andy Author',
      contactEmail: `t1-006-admin-${suffix}@example.test`,
      source: 'agency_owned',
    })
    const adminAuthored = await getProspectViaPortalFixture(request, agency.admin.token, adminAuthoredId)
    expect(adminAuthored.registeredByAgencyMemberId).toBe(agency.admin.agencyMemberId)
    expect(adminAuthored.status).toBe('new')

    // ---- Step 2: PartnerMember (non-author, no admin grant) attempts to transition.
    // Reading the prospect first — partner_member has `prm.prospect.read_own_agency`
    // so GET succeeds and returns `canTransitionTo: []` (server-computed reachability
    // for a non-author, non-admin actor).
    const memberView = await getProspectViaPortalFixture(request, agency.member.token, adminAuthoredId)
    expect(memberView.id).toBe(adminAuthoredId)
    expect(
      memberView.canTransitionTo,
      'partner_member viewing another author\'s prospect must see canTransitionTo=[]',
    ).toEqual([])
    expect(
      memberView.canEdit,
      'partner_member viewing another author\'s prospect must see canEdit=false',
    ).toBe(false)

    const blockedTransition = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${adminAuthoredId}`,
      {
        customerToken: agency.member.token,
        data: {
          kind: 'transition',
          toStatus: 'qualified',
          ifMatchStatusChangedAt: memberView.statusChangedAt,
        },
      },
    )
    const blockedBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string; message?: string }
    }>(blockedTransition)
    expect(
      blockedTransition.status(),
      `member transitioning admin-authored prospect must 403 not_author_or_admin; body=${JSON.stringify(blockedBody)}`,
    ).toBe(403)
    expect(blockedBody?.error?.code).toBe('not_author_or_admin')

    // The aggregate's status_changed_at MUST be unchanged.
    const stillNew = await getProspectViaPortalFixture(request, agency.admin.token, adminAuthoredId)
    expect(stillNew.status).toBe('new')
    expect(stillNew.statusChangedAt).toBe(adminAuthored.statusChangedAt)

    // ---- Step 3: same blocked-edit contract — author-scope also gates `update()`
    // (`prospectService.update` shares the C4 guard). PartnerMember edit attempt
    // on admin-authored prospect must 403.
    const blockedEdit = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${adminAuthoredId}`,
      {
        customerToken: agency.member.token,
        data: { kind: 'edit', contactName: 'Hijacked Name' },
      },
    )
    const blockedEditBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string }
    }>(blockedEdit)
    expect(
      blockedEdit.status(),
      `member editing admin-authored prospect must 403 not_author_or_admin; body=${JSON.stringify(blockedEditBody)}`,
    ).toBe(403)
    expect(blockedEditBody?.error?.code).toBe('not_author_or_admin')

    // ---- Step 4: PartnerAdmin transitions the same Prospect successfully —
    // proves the guard is author/admin scoped, not a route-level write block.
    const adminTransitioned = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      adminAuthoredId,
      'qualified',
    )
    expect(adminTransitioned.status).toBe('qualified')

    // ---- Step 5: PartnerMember authors their OWN Prospect and transitions it.
    // Confirms `transition_own_authored` works the way the spec describes.
    const memberAuthoredId = await createProspectFixture(request, agency.member.token, {
      companyName: `T1-006 Member-Authored ${suffix}`,
      contactName: 'Mary Member',
      contactEmail: `t1-006-member-${suffix}@example.test`,
      source: 'agency_owned',
    })
    const memberAuthoredFresh = await getProspectViaPortalFixture(
      request,
      agency.member.token,
      memberAuthoredId,
    )
    expect(memberAuthoredFresh.registeredByAgencyMemberId).toBe(agency.member.agencyMemberId)
    expect(memberAuthoredFresh.canTransitionTo).toContain('qualified')
    expect(memberAuthoredFresh.canEdit).toBe(true)

    const ownTransition = await transitionProspectViaPortalFixture(
      request,
      agency.member.token,
      memberAuthoredId,
      'qualified',
    )
    expect(ownTransition.status).toBe('qualified')
  })
})
