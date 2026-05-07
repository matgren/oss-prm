import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bulkSeedAgenciesFixture,
  createRfpDraftFixture,
  publishRfpFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'
import { buildPerfAgencyRoster } from '@/modules/prm/testing/fixtures/perfAgencyRoster'

/**
 * TC-PRM-T5-PERF-001 — Eligibility evaluator perf smoke at 500 agencies.
 *
 * Closes Spec #5 §9.6 #27 + §8.1 R2 (POST-MVP-FOLLOW-UPS.md "Spec #5 §9.6
 * perf smoke"). The pure-function evaluator at `lib/rfpEligibility.ts`
 * already has 14 unit-level cases. This smoke exercises the full publish
 * hot path against a real Postgres roster:
 *
 *   1. TRUNCATE PRM tables (cross-spec isolation).
 *   2. Seed 500 paired Organization + Agency rows via the bulk-seed test
 *      seam in <1s. Tier mix: 250 om_agency / 150 ai_native /
 *      75 ai_native_expert / 25 ai_native_core (FROZEN by `perfAgencyRoster`).
 *      A 5%-slice is `onboarded=false` so the SQL pre-filter has something
 *      to actually filter — defence in depth against a publish-side bug
 *      that drops the WHERE clause.
 *   3. Create an RFP draft with `eligibility_filter='by_min_tier'`,
 *      `min_tier='ai_native_expert'` (representative — picks the upper
 *      half of the tier distribution: 75+25=100 broadcasts at full count;
 *      slightly fewer with the 5% non-onboarded slice).
 *   4. Publish, measure wall-clock.
 *   5. Assert: status=200, RFP=published, broadcastAgencyIds non-empty,
 *      contains the pinned spot-check ai_native_core agency, every id
 *      belongs to the seeded set, and wall-clock < 2000ms.
 *
 * Threshold rationale: §9.6 #27 specifies "publish < 2s P95 at 500
 * agencies." Threshold is intentionally generous — this is a smoke, not a
 * benchmark. CI variance, ephemeral container cold-start, cold connection
 * pool, etc. would all eat into a tighter budget. A regression that pushes
 * the publish path past 2s is far past R2's "Medium" impact threshold.
 *
 * Reusability: the `buildPerfAgencyRoster` generator is parameterised on
 * `size` so future perf work (e.g. the §8.1 R2 "above ~5k push tier filter
 * into SQL" trigger) reuses the same fixture with `size: 5000`.
 *
 * ----------------------------------------------------------------------
 * Required env at the running app:
 *   - `OM_PRM_TEST_FIXTURES_ENABLED=1` — gates the bulk-seed + reset seams.
 *   - `DATABASE_URL` — set by the ephemeral integration runner; the seam
 *     uses the request-scoped `EntityManager` so any DB the framework is
 *     wired to works (Postgres-only — the seam uses Postgres knex syntax).
 *
 * Required env at this Playwright runner (set by `yarn test:integration*`):
 *   - `BASE_URL` (defaults to `http://localhost:3000`).
 *
 * To run locally against an ephemeral DB:
 *   `OM_PRM_TEST_FIXTURES_ENABLED=1 yarn test:integration:ephemeral`
 *
 * To run against a long-lived dev server:
 *   - Start the dev server with `OM_PRM_TEST_FIXTURES_ENABLED=1 yarn dev`.
 *   - In another terminal: `yarn test:integration` (default BASE_URL).
 * ----------------------------------------------------------------------
 */

// Default Playwright timeout is 20s. Bulk-seed + publish at 500 agencies
// can edge into the upper teens on a cold container; bump the per-test
// timeout to 60s so the smoke isn't killed before its own assertions run.
test.describe('TC-PRM-T5-PERF-001: eligibility evaluator perf smoke (500 agencies)', () => {
  test.describe.configure({ timeout: 60_000 })

  // Cross-spec isolation: previous PRM specs (T0/T1/T2/T3/T5-001/...) seed
  // their own Agencies that would otherwise inflate the eligibility set.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('publish with by_min_tier=ai_native_expert at 500 agencies stays under the 2s perf budget', async ({
    request,
  }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = `t5-perf-${Date.now().toString(36)}`

    // 1. Build the deterministic roster (250/150/75/25 + 5% non-onboarded).
    const roster = buildPerfAgencyRoster({
      slugPrefix: suffix,
      size: 500,
      withSomeNonOnboarded: true,
    })
    expect(roster.agencies.length).toBe(500)

    // Sanity: the spot-check pinned-id should be in the seeded roster AND
    // in the expected-eligible set for the by_min_tier=ai_native_expert filter.
    const expectedEligibleIds = new Set(roster.eligibleIdsByMinTier.ai_native_expert)
    expect(expectedEligibleIds.has(roster.spotCheckAgencyId)).toBe(true)
    // 95%-onboarded tier mix: 75 ai_native_expert + 25 ai_native_core. Of the
    // 5% non-onboarded slice (every 20th), some land in the upper tiers and
    // are stripped from `eligibleIdsByMinTier`. The smoke does not care about
    // the exact count — only that the resulting set is non-empty and the
    // pinned spot-check id is included.
    expect(expectedEligibleIds.size).toBeGreaterThan(0)
    expect(expectedEligibleIds.size).toBeLessThanOrEqual(100)

    // 2. Seed via the bulk-seed seam.
    const seedResult = await bulkSeedAgenciesFixture(request, token, roster.agencies)
    expect(seedResult.insertedAgencies).toBe(500)
    expect(seedResult.insertedOrganizations).toBe(500)
    // Diagnostic — surfaces the seed cost in CI logs without gating on it.
    // eslint-disable-next-line no-console
    console.log(
      `[TC-PRM-T5-PERF-001] bulk-seed 500 agencies: ${seedResult.seedDurationMs}ms`,
    )

    // 3. Create an RFP draft with the representative filter.
    const rfpId = await createRfpDraftFixture(request, token, {
      title: `T5-PERF-001 by_min_tier=ai_native_expert ${suffix}`,
      eligibility_filter: 'by_min_tier',
      min_tier: 'ai_native_expert',
    })

    // 4. Publish — measure wall-clock around the HTTP round-trip. The
    //    publish handler runs `evaluateRfpEligibility` over the SQL-pre-
    //    filtered roster + writes one RfpBroadcast row per eligible agency
    //    in a single flush. Any regression (missing index, dropped WHERE,
    //    O(N²) loop) shows up here as wall-clock breach.
    const publishStartedAt = Date.now()
    const publishResult = await publishRfpFixture(request, token, rfpId)
    const publishDurationMs = Date.now() - publishStartedAt
    // eslint-disable-next-line no-console
    console.log(
      `[TC-PRM-T5-PERF-001] publish wall-clock: ${publishDurationMs}ms ` +
        `(broadcast=${publishResult.body?.broadcastAgencyIds?.length ?? 0})`,
    )

    // 5. Correctness assertions — non-negotiable, the perf threshold is the
    //    secondary quality gate.
    expect(
      publishResult.status,
      `publish status; body=${JSON.stringify(publishResult.body)}`,
    ).toBe(200)
    expect(publishResult.body?.ok).toBe(true)
    expect(publishResult.body?.status).toBe('published')

    const broadcasted = publishResult.body?.broadcastAgencyIds ?? []
    expect(broadcasted.length).toBeGreaterThan(0)
    // Spot-check: the pinned ai_native_core agency MUST be broadcasted.
    expect(broadcasted).toContain(roster.spotCheckAgencyId)
    // Every broadcasted id must be one we seeded — defence against a
    // publish bug that picks up bleed from an unrelated fixture.
    const seededIds = new Set(roster.agencies.map((a) => a.id))
    for (const id of broadcasted) {
      expect(seededIds.has(id), `broadcasted id ${id} is not in the seeded roster`).toBe(true)
    }
    // Every broadcasted id must satisfy the eligibility predicate.
    for (const id of broadcasted) {
      expect(
        expectedEligibleIds.has(id),
        `broadcasted id ${id} is not in the expected by_min_tier=ai_native_expert eligible set ` +
          `(seeded but tier or onboarded flag does not match)`,
      ).toBe(true)
    }

    // Defence-in-depth: read RFP detail back, confirm status persisted.
    const detailResponse = await apiRequest(request, 'GET', `/api/prm/rfp/${rfpId}`, { token })
    const detailBody = await readJsonSafe<{ ok: true; rfp?: { status?: string } }>(detailResponse)
    expect(detailResponse.status()).toBe(200)
    expect(detailBody?.rfp?.status).toBe('published')

    // 6. Perf assertion — generous 2s threshold per §9.6 #27.
    const PERF_BUDGET_MS = 2_000
    expect(
      publishDurationMs,
      `publish wall-clock ${publishDurationMs}ms exceeded the §9.6 #27 perf budget of ${PERF_BUDGET_MS}ms ` +
        `at 500 agencies. The eligibility evaluator path (lib/rfpEligibility.ts → RfpService.publish) ` +
        `has regressed; check for a missing index, dropped SQL WHERE clause, or an O(N²) loop.`,
    ).toBeLessThan(PERF_BUDGET_MS)
  })
})
