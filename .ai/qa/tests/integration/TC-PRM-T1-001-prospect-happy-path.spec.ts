import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createProspectFixture,
  customerApiRequest,
  getProspectViaPortalFixture,
  transitionProspectViaPortalFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-001 — Spec #2 §9 IT-9.1 happy-path Prospect register → transition → widget.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.1, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.1".
 *
 * Scenario:
 *   "Register → transition → widget update — Full P5/P6/P2 happy path."
 *
 * Asserts the contract that drives the partner-portal WIP loop:
 *   1. PartnerAdmin POSTs to `POST /api/prm/portal/prospects` (P5 register form).
 *   2. PartnerAdmin transitions `new → qualified` via portal PATCH (P6 detail).
 *   3. PartnerAdmin transitions `qualified → contacted` via portal PATCH.
 *   4. GET `/api/prm/portal/dashboard` reflects the new prospect in the WIP
 *      yearly count + per-status breakdown (P2 widget).
 *   5. Tier widget (`tier.current`) is present (cross-check the dashboard
 *      aggregate route returns all three widget surfaces in one round-trip).
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T5-002/003.
 * The §9 IT-9.1 wording is "P5/P6/P2 happy path" which is exactly the API
 * contract under test; UI render is covered by `TC-PRM-T0-002` (already
 * shipped) and outside this smoke's scope.
 */
test.describe('TC-PRM-T1-001: Spec #2 §9 IT-9.1 — Prospect register/transition/widget happy path', () => {
  test('PartnerAdmin registers Prospect, transitions qualified→contacted, dashboard reflects', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-001-${Date.now().toString(36)}`

    // Boot a partner Agency + partner_admin (via the test seam — emulates
    // the post-accept onboarded state).
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Step 1: PartnerAdmin registers a Prospect (US3.1, P5)
    const companyName = `T1-001 Acme ${suffix}`
    const prospectId = await createProspectFixture(request, agency.admin.token, {
      companyName,
      contactName: 'Jamie Lead',
      contactEmail: `t1-001-lead-${suffix}@example.test`,
      source: 'agency_owned',
    })
    expect(prospectId).toBeTruthy()

    // GET sanity — fresh prospect starts in `new`.
    const fresh = await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    expect(fresh.status).toBe('new')
    expect(fresh.companyName).toBe(companyName)
    expect(fresh.canTransitionTo).toContain('qualified')

    // ---- Step 2: transition new → qualified (US3.2, invariant #12)
    const qualified = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
      'qualified',
    )
    expect(qualified.status).toBe('qualified')
    expect(qualified.canTransitionTo).toContain('contacted')

    // ---- Step 3: transition qualified → contacted
    const contacted = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
      'contacted',
    )
    expect(contacted.status).toBe('contacted')
    expect(contacted.statusChangedAt).not.toBe(qualified.statusChangedAt)

    // ---- Step 4: portal dashboard aggregate reflects the new prospect (P2 widget)
    const dashboardResponse = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/dashboard',
      { customerToken: agency.admin.token },
    )
    const dashboardBody = await readJsonSafe<{
      ok?: boolean
      dashboard?: {
        agency?: { id?: string; status?: string; tier?: string }
        period?: { year?: number; month?: number }
        wip?: { monthly?: number; yearly?: number; byStatus?: Record<string, number> }
        wic?: { awaiting?: boolean; monthlyTotal?: number; yearlyTotal?: number }
        tier?: { current?: { tier?: string; rank?: number }; next?: unknown; pctToNext?: number } | null
      } | null
    }>(dashboardResponse)
    expect(
      dashboardResponse.status(),
      `GET /api/prm/portal/dashboard body=${JSON.stringify(dashboardBody)}`,
    ).toBe(200)
    expect(dashboardBody?.dashboard).toBeTruthy()
    expect(dashboardBody?.dashboard?.agency?.id).toBe(agency.agencyId)
    expect(dashboardBody?.dashboard?.agency?.status).toBe('active')

    // WIP widget: at least 1 yearly prospect (the one we just registered, in
    // status=contacted, source=agency_owned per invariant #14).
    const wipYearly = dashboardBody?.dashboard?.wip?.yearly ?? 0
    expect(wipYearly).toBeGreaterThanOrEqual(1)
    const byStatus = dashboardBody?.dashboard?.wip?.byStatus ?? {}
    expect(byStatus.contacted ?? 0).toBeGreaterThanOrEqual(1)

    // Tier widget: present + the current tier descriptor identifies the
    // agency's tier slug. `tier.current` is a structured descriptor
    // (see `computeTierProgress` — `{ tier, rank, minWip, minMonthlyWic }`),
    // not a bare string.
    expect(dashboardBody?.dashboard?.tier).toBeTruthy()
    expect(dashboardBody?.dashboard?.tier?.current?.tier).toBe('om_agency')
  })
})
