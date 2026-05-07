import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  createAgencyFixture,
  setAgencyOnboardedFixture,
  createRfpDraftFixture,
  publishRfpFixture,
  resetPrmState,
  unpublishRfpFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T5-001 — RFP create + publish + unpublish happy path (Spec #5 §9.1).
 *
 * Covers §9.1 cases #1, #2, #3, #5. (Cases #4 partial-insert rollback and #6
 * undo-refused-after-first-open are deferred to follow-up commits — #4 needs a
 * DB-error injection hook in the publish handler that is not yet wired, and #6
 * needs the C2 portal GET stamp on `first_opened_at`.)
 *
 * Eligibility evaluator constraints (Spec #5 §2 / `lib/rfpEligibility.ts`):
 *   - Only Agencies with `status='active' AND onboarded=true` are candidates.
 *   - Tier rank order: om_agency (0) < ai_native (1) < ai_native_expert (2)
 *     < ai_native_core (3). `by_min_tier` keeps tier rank ≥ filter rank.
 *
 * Each test seeds 3 Agencies (A=ai_native_expert, B=ai_native, C=om_agency)
 * via the staff `admin` token, PATCHes them onboarded, then drives publish via
 * the RFP API. No UI interaction — these are HTTP-level contract tests.
 */
test.describe('TC-PRM-T5-001: RFP publish + unpublish happy paths (§9.1 #1, #2, #3, #5)', () => {
  // Reset every PRM table between tests so cross-spec Agency leaks (T0/T1/T2/T3
  // each seed onboarded ai_native+ Agencies and have no teardown) don't inflate
  // the eligibility evaluator's broadcast set. Without this, §9.1 #1 fails with
  // 4 broadcasted agencies (the 2 just-seeded by this test PLUS 2 leftovers).
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('§9.1 #1 — by_min_tier publish broadcasts to ≥ ai_native (A + B), excludes C', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)

    const agencyA = await createAgencyFixture(request, token, {
      name: `T5-001-A ${suffix}`,
      slug: `t5-001-a-${suffix}`,
      tier: 'ai_native_expert',
    })
    const agencyB = await createAgencyFixture(request, token, {
      name: `T5-001-B ${suffix}`,
      slug: `t5-001-b-${suffix}`,
      tier: 'ai_native',
    })
    const agencyC = await createAgencyFixture(request, token, {
      name: `T5-001-C ${suffix}`,
      slug: `t5-001-c-${suffix}`,
      tier: 'om_agency',
    })

    await setAgencyOnboardedFixture(request, token, agencyA, { onboarded: true })
    await setAgencyOnboardedFixture(request, token, agencyB, { onboarded: true })
    await setAgencyOnboardedFixture(request, token, agencyC, { onboarded: true })

    const rfpId = await createRfpDraftFixture(request, token, {
      title: `T5-001 by_min_tier ${suffix}`,
      eligibility_filter: 'by_min_tier',
      min_tier: 'ai_native',
    })

    const publishResult = await publishRfpFixture(request, token, rfpId)
    expect(
      publishResult.status,
      `publish status; body=${JSON.stringify(publishResult.body)}`,
    ).toBe(200)
    expect(publishResult.body?.ok).toBe(true)
    expect(publishResult.body?.status).toBe('published')

    const broadcasted = (publishResult.body?.broadcastAgencyIds ?? []).slice().sort()
    const expected = [agencyA, agencyB].slice().sort()
    expect(broadcasted, 'A + B broadcasted; C excluded').toEqual(expected)
    expect(broadcasted).not.toContain(agencyC)
  })

  test('§9.1 #2 — explicit publish broadcasts to listed Agency only', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)

    const agencyA = await createAgencyFixture(request, token, {
      name: `T5-001-explicit-A ${suffix}`,
      slug: `t5-001-explicit-a-${suffix}`,
      tier: 'ai_native',
    })
    const agencyB = await createAgencyFixture(request, token, {
      name: `T5-001-explicit-B ${suffix}`,
      slug: `t5-001-explicit-b-${suffix}`,
      tier: 'ai_native',
    })

    await setAgencyOnboardedFixture(request, token, agencyA, { onboarded: true })
    await setAgencyOnboardedFixture(request, token, agencyB, { onboarded: true })

    const rfpId = await createRfpDraftFixture(request, token, {
      title: `T5-001 explicit ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agencyA],
    })

    const publishResult = await publishRfpFixture(request, token, rfpId)
    expect(
      publishResult.status,
      `publish status; body=${JSON.stringify(publishResult.body)}`,
    ).toBe(200)
    expect(publishResult.body?.broadcastAgencyIds).toEqual([agencyA])
    expect(publishResult.body?.broadcastAgencyIds).not.toContain(agencyB)
  })

  test('§9.1 #3 — zero-eligible publish blocked with 409, RFP stays draft', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)

    // Seed only an om_agency tier — by_min_tier=ai_native_core matches none.
    const agencyA = await createAgencyFixture(request, token, {
      name: `T5-001-zero-A ${suffix}`,
      slug: `t5-001-zero-a-${suffix}`,
      tier: 'om_agency',
    })
    await setAgencyOnboardedFixture(request, token, agencyA, { onboarded: true })

    const rfpId = await createRfpDraftFixture(request, token, {
      title: `T5-001 zero-eligible ${suffix}`,
      eligibility_filter: 'by_min_tier',
      min_tier: 'ai_native_core',
    })

    const publishResult = await publishRfpFixture(request, token, rfpId)
    expect(
      publishResult.status,
      `expected 409; body=${JSON.stringify(publishResult.body)}`,
    ).toBe(409)
    expect(publishResult.body?.ok).toBe(false)
    expect(publishResult.body?.error?.code).toBe('validation_failed')
    expect(publishResult.body?.error?.message ?? '').toMatch(/zero eligible/i)

    // RFP must remain `draft` after a refused publish.
    const detailResponse = await apiRequest(request, 'GET', `/api/prm/rfp/${rfpId}`, { token })
    const detailBody = await readJsonSafe<{ ok: true; rfp?: { status?: string } }>(detailResponse)
    expect(detailResponse.status()).toBe(200)
    expect(detailBody?.rfp?.status).toBe('draft')
  })

  test('§9.1 #5 — publish then immediate unpublish reverts RFP to draft', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)

    const agencyA = await createAgencyFixture(request, token, {
      name: `T5-001-undo-A ${suffix}`,
      slug: `t5-001-undo-a-${suffix}`,
      tier: 'ai_native',
    })
    await setAgencyOnboardedFixture(request, token, agencyA, { onboarded: true })

    const rfpId = await createRfpDraftFixture(request, token, {
      title: `T5-001 undo-publish ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agencyA],
    })

    const publishResult = await publishRfpFixture(request, token, rfpId)
    expect(publishResult.status).toBe(200)
    expect(publishResult.body?.status).toBe('published')

    const unpublishResult = await unpublishRfpFixture(
      request,
      token,
      rfpId,
      'Decided to retract before any agency interaction',
    )
    expect(
      unpublishResult.status,
      `unpublish status; body=${JSON.stringify(unpublishResult.body)}`,
    ).toBe(200)
    expect(unpublishResult.body?.status).toBe('draft')

    // Verify RFP is observably draft via detail GET (defence-in-depth — guards
    // against the route returning a stale snapshot).
    const detailResponse = await apiRequest(request, 'GET', `/api/prm/rfp/${rfpId}`, { token })
    const detailBody = await readJsonSafe<{ ok: true; rfp?: { status?: string } }>(detailResponse)
    expect(detailResponse.status()).toBe(200)
    expect(detailBody?.rfp?.status).toBe('draft')
  })
})
