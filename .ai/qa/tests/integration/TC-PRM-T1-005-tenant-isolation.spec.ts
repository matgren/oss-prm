import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createProspectFixture,
  customerApiRequest,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-005 — Spec #2 §9 IT-9.5 cross-agency Prospect leak blocked.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.5 + §6.3 (Tenant isolation)
 *   + §8.3 R-6 (Portal PartnerMember sees another agency's Prospects),
 *   POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.5".
 *
 * Scenario:
 *   "Cross-agency Prospect leak blocked."
 *
 * §6.3 mandates that every portal query filters by `tenant_id` + `agency_id`.
 * The §3.1 GET-by-id route is documented as `404 for cross-agency IDs (do not
 * leak existence)` — the route MUST respond with 404, not 403, so a malicious
 * client cannot enumerate which prospect IDs exist outside their agency scope.
 *
 * This test boots two SEPARATE Agencies under the same staff tenant (the seam
 * keeps customers in the staff org for the reasons documented in
 * `customerAuth.ts`; the test still drives the §6.3 contract because the
 * scope filter is `tenant_id + agency_id`, not `organization_id`). Each
 * agency's `partner_admin` registers a Prospect, then we attempt to:
 *   (a) GET Agency-B's prospect from Agency-A's session  → 404
 *   (b) PATCH (transition) Agency-B's prospect from Agency-A's session  → 404
 *   (c) PATCH (edit) Agency-B's prospect from Agency-A's session        → 404
 *
 * Plus an own-agency list assertion: Agency-A's `/api/prm/portal/prospects`
 * MUST NOT include Agency-B's prospect ID, even though the rows share a
 * tenant.
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-005: Spec #2 §9 IT-9.5 — cross-agency Prospect access returns 404', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Agency A cannot read or mutate Agency B prospects (404 — existence not leaked)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const baseSuffix = `t1-005-${Date.now().toString(36)}`

    // Two distinct agencies under the same tenant (seam keeps both customers
    // in the staff org — see customerAuth.ts header). The §6.3 scope filter is
    // `tenant_id + agency_id` so this faithfully drives the leak path.
    const agencyA = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix: `${baseSuffix}-a`,
      tier: 'om_agency',
    })
    const agencyB = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix: `${baseSuffix}-b`,
      tier: 'om_agency',
    })
    expect(agencyA.agencyId).not.toBe(agencyB.agencyId)
    expect(agencyA.tenantId).toBe(agencyB.tenantId)

    // ---- Each agency registers a private Prospect.
    const prospectA = await createProspectFixture(request, agencyA.admin.token, {
      companyName: `T1-005 A-Owned ${baseSuffix}`,
      contactName: 'Aida Author',
      contactEmail: `t1-005-a-${baseSuffix}@example.test`,
      source: 'agency_owned',
    })
    const prospectB = await createProspectFixture(request, agencyB.admin.token, {
      companyName: `T1-005 B-Owned ${baseSuffix}`,
      contactName: 'Bob Author',
      contactEmail: `t1-005-b-${baseSuffix}@example.test`,
      source: 'agency_owned',
    })
    expect(prospectA).not.toBe(prospectB)

    // ---- Case (a): cross-agency GET by ID — must 404, NOT 403 (existence non-leak).
    const crossGet = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/prospects/${prospectB}`,
      { customerToken: agencyA.admin.token },
    )
    const crossGetBody = await readJsonSafe<{
      ok?: false
      prospect?: unknown
      error?: { code?: string; message?: string }
    }>(crossGet)
    expect(
      crossGet.status(),
      `cross-agency GET must 404 (not 403) to avoid leaking existence; body=${JSON.stringify(crossGetBody)}`,
    ).toBe(404)
    expect(crossGetBody?.error?.code).toBe('prospect_not_found')
    expect(crossGetBody?.prospect, 'cross-agency GET MUST NOT return the prospect body').toBeFalsy()

    // ---- Case (b): cross-agency PATCH (transition) — must 404 with the same code.
    // We don't have B's `statusChangedAt` (we never read it from A's session)
    // but it doesn't matter — the route 404s before optimistic-concurrency runs.
    const crossTransition = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectB}`,
      {
        customerToken: agencyA.admin.token,
        data: {
          kind: 'transition',
          toStatus: 'qualified',
          ifMatchStatusChangedAt: new Date().toISOString(),
        },
      },
    )
    const crossTransitionBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string }
    }>(crossTransition)
    expect(
      crossTransition.status(),
      `cross-agency PATCH transition must 404; body=${JSON.stringify(crossTransitionBody)}`,
    ).toBe(404)
    expect(crossTransitionBody?.error?.code).toBe('prospect_not_found')

    // ---- Case (c): cross-agency PATCH (edit) — same 404 contract.
    const crossEdit = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectB}`,
      {
        customerToken: agencyA.admin.token,
        data: {
          kind: 'edit',
          contactName: 'Hijack Attempt',
        },
      },
    )
    const crossEditBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string }
    }>(crossEdit)
    expect(
      crossEdit.status(),
      `cross-agency PATCH edit must 404; body=${JSON.stringify(crossEditBody)}`,
    ).toBe(404)
    expect(crossEditBody?.error?.code).toBe('prospect_not_found')

    // ---- Symmetry: Agency B can read its own prospect (sanity — confirms the
    // route is wired correctly; otherwise we might be passing 404 for ANY id).
    const ownRead = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/prospects/${prospectB}`,
      { customerToken: agencyB.admin.token },
    )
    const ownReadBody = await readJsonSafe<{
      ok?: true
      prospect?: { id?: string; agencyId?: string }
    }>(ownRead)
    expect(ownRead.status()).toBe(200)
    expect(ownReadBody?.prospect?.id).toBe(prospectB)
    expect(ownReadBody?.prospect?.agencyId).toBe(agencyB.agencyId)

    // ---- List leak: Agency A's portal list MUST NOT include Agency B's prospect.
    const listA = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/prospects?pageSize=100',
      { customerToken: agencyA.admin.token },
    )
    const listABody = await readJsonSafe<{
      ok?: true
      items?: Array<{ id: string; agencyId: string }>
      total?: number
    }>(listA)
    expect(listA.status()).toBe(200)
    const listIdsA = (listABody?.items ?? []).map((p) => p.id)
    const listAgenciesA = new Set((listABody?.items ?? []).map((p) => p.agencyId))
    expect(listIdsA, 'Agency A list MUST contain its own prospect').toContain(prospectA)
    expect(
      listIdsA,
      'Agency A list MUST NOT contain Agency B prospect (cross-agency leak)',
    ).not.toContain(prospectB)
    // Per §6.3, every row carries the caller's agency id — never B's.
    expect(listAgenciesA.size).toBeLessThanOrEqual(1)
    if (listAgenciesA.size === 1) {
      expect(Array.from(listAgenciesA)[0]).toBe(agencyA.agencyId)
    }

    // Symmetric check from Agency B's side as well.
    const listB = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/prospects?pageSize=100',
      { customerToken: agencyB.admin.token },
    )
    const listBBody = await readJsonSafe<{
      ok?: true
      items?: Array<{ id: string; agencyId: string }>
    }>(listB)
    expect(listB.status()).toBe(200)
    const listIdsB = (listBBody?.items ?? []).map((p) => p.id)
    expect(listIdsB).toContain(prospectB)
    expect(listIdsB).not.toContain(prospectA)
  })
})
