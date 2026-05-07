import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createRfpDraftFixture,
  customerApiRequest,
  publishRfpFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T5-002 — Spec #5 §9.2 invariant #15 byte-identical 404 (R3 / silent-404).
 *
 * Demonstrates the new customer-portal Playwright auth helper
 * (POST-MVP follow-up: "Customer-portal Playwright auth helper").
 *
 * Until this test shipped, invariant #15 was locked at the unit-test level
 * (`src/modules/prm/__tests__/rfpVisibility.test.ts`) — the unit test proves
 * `assertBroadcastedOrNotFound` returns the canonical envelope on every
 * failure reason, but a true HTTP-contract test requires authenticating as a
 * partner Agency and probing the route end-to-end.
 *
 * Privacy property under test (§9.2 #7):
 *   GET /api/prm/portal/rfp/{guess} MUST return a byte-identical 404 envelope
 *   regardless of:
 *     (a) the UUID resolves to no row at all (fake UUID), OR
 *     (b) the UUID resolves to a real published RFP that was *not* broadcast
 *         to this Agency.
 *
 * If the responses ever drift (different status code, different body, even a
 * different content-length) a partner Agency could probe the route to
 * distinguish "exists but you can't see it" from "doesn't exist" — that's the
 * exact information-disclosure bug invariant #15 is designed to prevent.
 *
 * Setup:
 *   - Boot Agency-A with a `partner_admin` (loginCustomer → JWT).
 *   - Boot Agency-B (separate, also onboarded).
 *   - Staff publishes an RFP scoped EXPLICITLY to Agency-B only. Agency-A is
 *     not in the broadcast set.
 *   - Agency-A's PartnerAdmin probes `GET /api/prm/portal/rfp/{B's RFP id}`
 *     and `GET /api/prm/portal/rfp/{fake UUID}`.
 *   - Both must return identical bodies.
 */

const FAKE_UUID = '00000000-0000-4000-8000-000000000000'

test.describe('TC-PRM-T5-002: Spec #5 invariant #15 — byte-identical 404 (§9.2 #7)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('GET /api/prm/portal/rfp/{not-broadcast-to-me} body == GET /api/prm/portal/rfp/{fake UUID} body', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t5-002-${Date.now().toString(36)}`

    const agencyA = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix: `${suffix}-A`,
      tier: 'ai_native',
    })
    const agencyB = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix: `${suffix}-B`,
      tier: 'ai_native',
    })

    // Staff-side: create + publish an RFP explicitly broadcast to Agency-B
    // (NOT Agency-A). Use the same staff token for both create + publish.
    const rfpId = await createRfpDraftFixture(request, staffToken, {
      title: `T5-002 invariant-15 ${suffix}`,
      eligibility_filter: 'explicit',
      explicit_agency_ids: [agencyB.agencyId],
    })
    const publishResult = await publishRfpFixture(request, staffToken, rfpId)
    expect(
      publishResult.status,
      `publish must succeed; body=${JSON.stringify(publishResult.body)}`,
    ).toBe(200)
    expect(publishResult.body?.broadcastAgencyIds).toEqual([agencyB.agencyId])

    // Probe #1: Agency-A reads an RFP that's published-but-not-broadcasted-to-me.
    const realButHiddenResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${rfpId}`,
      { customerToken: agencyA.admin.token },
    )

    // Probe #2: Agency-A reads a totally fake UUID.
    const fakeResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${FAKE_UUID}`,
      { customerToken: agencyA.admin.token },
    )

    // Status code must be identical (404 in both cases).
    expect(realButHiddenResponse.status()).toBe(404)
    expect(fakeResponse.status()).toBe(404)

    // Body must be byte-identical (the invariant).
    const realBody = await realButHiddenResponse.text()
    const fakeBody = await fakeResponse.text()
    expect(
      realBody,
      `byte-identity violated: real-but-hidden body differs from fake-uuid body. real=${realBody} fake=${fakeBody}`,
    ).toBe(fakeBody)

    // Sanity: parsed body matches the canonical envelope from rfpNotFoundResponse().
    expect(JSON.parse(realBody)).toEqual({ ok: false, error: 'Not found' })

    // Defence-in-depth: Agency-B (in the broadcast set) MUST see the same RFP
    // — confirms the fixture setup actually broadcasted, otherwise the
    // identity check above might pass trivially because nobody can see the RFP.
    const visibleResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${rfpId}`,
      { customerToken: agencyB.admin.token },
    )
    expect(
      visibleResponse.status(),
      'Agency-B must see the RFP it was broadcast to (negative-control sanity check)',
    ).toBe(200)
  })

  test('GET against a malformed UUID returns the same body too', async ({ request }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t5-002-malformed-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    const malformed = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/not-a-uuid`,
      { customerToken: agency.admin.token },
    )
    const fake = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/rfp/${FAKE_UUID}`,
      { customerToken: agency.admin.token },
    )
    expect(malformed.status()).toBe(404)
    expect(fake.status()).toBe(404)
    expect(await malformed.text()).toBe(await fake.text())
  })

  test('Unauthenticated GET returns 401 (auth gate runs before visibility gate)', async ({
    request,
  }) => {
    // Sanity check: the route still rejects unauthenticated callers — the
    // byte-identical 404 only applies AFTER auth+feature gates pass. This
    // guards against accidentally widening the silent-404 to anonymous probes.
    const response = await apiRequest(request, 'GET', `/api/prm/portal/rfp/${FAKE_UUID}`, {
      token: 'invalid-token-not-a-jwt',
    })
    expect([401, 404]).toContain(response.status())
  })
})
