import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createProspectFixture,
  customerApiRequest,
  resetPrmState,
  transitionProspectViaPortalFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-008 — Spec #2 §9 IT-9.8 dashboard widgets render with seeded data.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.8 + §3.3 dashboard route +
 *   §6.2 per-role grants (`prm.wic.read_own_agency`, `prm.tier_requirement.read`),
 *   POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.8".
 *
 * Scenario:
 *   "WIP / WIC / tier widgets with seeded data."
 *
 * `GET /api/prm/portal/dashboard` returns a single round-trip aggregate with
 * three widget surfaces:
 *
 *   - **WIP** — counts `prm_prospects` rows for the caller's agency where
 *     `source = 'agency_owned' AND status NOT IN ('lost')`. Splits into
 *     `monthly | yearly | byStatus` (per-status breakdown for the year).
 *
 *   - **WIC** — best-effort introspection of `prm_wic_contributions` (Spec #4).
 *     If the table is empty for the caller's agency, the route surfaces
 *     `{ awaiting: true, monthlyTotal: 0, yearlyTotal: 0, perMember: [] }`.
 *     T1 ships with no WIC seed mechanism — the test must therefore allow the
 *     `awaiting:true` placeholder shape and verify the PRESENCE of the
 *     widget descriptor, not specific non-zero values. (T3 ships its own
 *     IT covering non-empty WIC.)
 *
 *   - **Tier** — uses the in-code `tier_requirements` registry. For the
 *     `om_agency` tier (default) the descriptor advertises a `next` tier,
 *     `pctToNext` numeric in [0, 1], and `current.tier === 'om_agency'`.
 *
 * Test seeds three prospects:
 *   1. Prospect-A — registered, transitioned to `qualified` (counted under
 *      WIP yearly + status=qualified).
 *   2. Prospect-B — registered, transitioned to `contacted` (counted under
 *      WIP yearly + status=contacted).
 *   3. Prospect-C — registered then transitioned to `lost`. §3.3 says
 *      `status NOT IN ('lost')` so this prospect MUST NOT be counted in WIP
 *      yearly/monthly aggregates. (The byStatus breakdown also filters lost
 *      by the same predicate.)
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-008: Spec #2 §9 IT-9.8 — dashboard widgets render with seeded data', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('WIP / WIC / tier widgets reflect seeded prospects (lost excluded from WIP)', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-008-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Seed three prospects with deterministic terminal/non-terminal mix.
    const prospectA = await createProspectFixture(request, agency.admin.token, {
      companyName: `T1-008 Alpha ${suffix}`,
      contactName: 'Alice Author',
      contactEmail: `t1-008-a-${suffix}@example.test`,
      source: 'agency_owned',
    })
    const transitionedA = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectA,
      'qualified',
    )
    expect(transitionedA.status).toBe('qualified')

    const prospectB = await createProspectFixture(request, agency.admin.token, {
      companyName: `T1-008 Bravo ${suffix}`,
      contactName: 'Bob Author',
      contactEmail: `t1-008-b-${suffix}@example.test`,
      source: 'agency_owned',
    })
    const qualifiedB = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectB,
      'qualified',
    )
    const contactedB = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectB,
      'contacted',
    )
    expect(qualifiedB.status).toBe('qualified')
    expect(contactedB.status).toBe('contacted')

    const prospectC = await createProspectFixture(request, agency.admin.token, {
      companyName: `T1-008 Charlie ${suffix}`,
      contactName: 'Cathy Author',
      contactEmail: `t1-008-c-${suffix}@example.test`,
      source: 'agency_owned',
    })
    const lostC = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectC,
      'lost',
      { lostReason: 'TC-PRM-T1-008 verification of WIP lost-exclusion' },
    )
    expect(lostC.status).toBe('lost')

    // ---- Single round-trip dashboard fetch.
    const dashboardResponse = await customerApiRequest(
      request,
      'GET',
      '/api/prm/portal/dashboard',
      { customerToken: agency.admin.token },
    )
    const dashboardBody = await readJsonSafe<{
      ok?: true
      dashboard?: {
        agency?: { id?: string; name?: string; status?: string; tier?: string }
        period?: { year?: number; month?: number }
        wip?: { monthly?: number; yearly?: number; byStatus?: Record<string, number> }
        wic?: {
          awaiting?: boolean
          monthlyTotal?: number
          yearlyTotal?: number
          perMember?: Array<unknown>
        }
        tier?: {
          current?: { tier?: string; rank?: number; minWip?: number; minMonthlyWic?: number }
          next?: unknown
          pctToNext?: number
        } | null
      } | null
    }>(dashboardResponse)
    expect(
      dashboardResponse.status(),
      `GET /api/prm/portal/dashboard body=${JSON.stringify(dashboardBody)}`,
    ).toBe(200)
    expect(dashboardBody?.dashboard).toBeTruthy()
    const dash = dashboardBody!.dashboard!

    // ---- Agency banner.
    expect(dash.agency?.id).toBe(agency.agencyId)
    expect(dash.agency?.status).toBe('active')
    expect(dash.agency?.tier).toBe('om_agency')

    // ---- Period — defaults to current UTC year/month.
    const now = new Date()
    expect(dash.period?.year).toBe(now.getUTCFullYear())
    expect(dash.period?.month).toBe(now.getUTCMonth() + 1)

    // ---- WIP widget. We seeded 3 agency_owned prospects; lost is excluded.
    // 2 should be counted under both monthly + yearly (since the test creates
    // them in the current month). byStatus mirrors the same predicate.
    const wip = dash.wip
    expect(wip).toBeTruthy()
    expect(wip!.yearly, `WIP yearly: lost excluded → expect 2; got=${wip!.yearly}`).toBe(2)
    expect(wip!.monthly, `WIP monthly: lost excluded → expect 2; got=${wip!.monthly}`).toBe(2)
    const byStatus = wip!.byStatus ?? {}
    expect(byStatus.qualified).toBe(1)
    expect(byStatus.contacted).toBe(1)
    // `lost` MUST be absent OR 0 — the WIP query filters with `whereNot('status', 'lost')`,
    // so the GROUP BY simply never emits a `lost` row. Either shape is acceptable.
    expect((byStatus.lost ?? 0)).toBe(0)
    expect((byStatus.new ?? 0)).toBe(0)

    // ---- WIC widget. T1 ships no seeding mechanism for `prm_wic_contributions`,
    // so we validate the descriptor SHAPE (route returns the canonical
    // `awaiting:true` placeholder when the table is empty). T3 covers the
    // non-empty path.
    const wic = dash.wic
    expect(wic, 'WIC widget descriptor must be present').toBeTruthy()
    expect(typeof wic!.awaiting).toBe('boolean')
    expect(typeof wic!.monthlyTotal).toBe('number')
    expect(typeof wic!.yearlyTotal).toBe('number')
    expect(Array.isArray(wic!.perMember)).toBe(true)

    // ---- Tier widget.
    const tier = dash.tier
    expect(tier, 'tier descriptor must be present for an om_agency partner').toBeTruthy()
    expect(tier!.current?.tier).toBe('om_agency')
    expect(typeof tier!.current?.rank).toBe('number')
    // `pctToNext` is a 0..1 fraction.
    expect(typeof tier!.pctToNext).toBe('number')
    expect(tier!.pctToNext).toBeGreaterThanOrEqual(0)
    expect(tier!.pctToNext).toBeLessThanOrEqual(1)
    // `om_agency` is the entry tier, so `next` MUST be a non-null descriptor
    // (the registry advertises a target tier above the entry). When the
    // partner sits at the top of the ladder `next` is null; for `om_agency`
    // it is always populated.
    expect(tier!.next, 'om_agency tier must advertise a next-tier descriptor').toBeTruthy()
  })
})
