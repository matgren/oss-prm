import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  createAgencyFixture,
  resetPrmState,
  setAgencyOnboardedFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-006 — Spec #1 §9 IT-6 re-invite cooldown.
 *
 * Source: SPEC-2026-04-23-agency-foundation.md §9 IT-6, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T0 Agency Foundation → IT-6".
 *
 * Scenario (US1.2 — re-invite cooldown):
 *   A second invite to the same `(agency_id, lower(email))` pair within
 *   10 minutes MUST be rejected with HTTP 429 carrying:
 *     - error.code = `invite_cooldown_active`
 *     - error.details.retryAfterSeconds (number, > 0)
 *     - HTTP `Retry-After` header (seconds)
 *
 * The cooldown is enforced via `@open-mercato/shared/lib/ratelimit`'s
 * `RateLimiterService.consume(key, ...)` per spec §3.1.5; PRM owns no
 * cooldown column. The 10-minute window is asserted at unit level in
 * `__tests__/reinviteCooldownService.test.ts`. This integration spec
 * verifies the route-layer envelope.
 *
 * Key per-(agency_id, email) — so we additionally verify that:
 *   - Re-inviting the SAME email at a DIFFERENT Agency is unaffected (200).
 *   - Inviting a DIFFERENT email at the SAME Agency is unaffected (200).
 *
 * Both cross-axis assertions guard against an over-broad cooldown key
 * (e.g. just-by-email) that would block legitimate cross-Agency invites
 * from the same address.
 */
test.describe('TC-PRM-T0-006: Spec #1 §9 IT-6 — Re-invite cooldown', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('second invite within window returns 429 with retryAfterSeconds + Retry-After header', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-006-${Date.now().toString(36)}`

    // ---- Setup: two Agencies (A + B) + two emails (target + sibling).
    const agencyAId = await createAgencyFixture(request, staffToken, {
      name: `T0-006 Agency A ${suffix}`,
      slug: `t0-006-a-${suffix}`,
      tier: 'om_agency',
    })
    await setAgencyOnboardedFixture(request, staffToken, agencyAId, {
      onboarded: true,
      status: 'active',
    })

    const agencyBId = await createAgencyFixture(request, staffToken, {
      name: `T0-006 Agency B ${suffix}`,
      slug: `t0-006-b-${suffix}`,
      tier: 'om_agency',
    })
    await setAgencyOnboardedFixture(request, staffToken, agencyBId, {
      onboarded: true,
      status: 'active',
    })

    const targetEmail = `t0-006-target-${suffix}@example.test`
    const siblingEmail = `t0-006-sibling-${suffix}@example.test`

    // ---- Step 1: First invite to (Agency A, targetEmail) — 201.
    const firstResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyAId}/invite`,
      {
        token: staffToken,
        data: {
          email: targetEmail,
          firstName: 'Pat',
          lastName: 'Target',
          roleSlug: 'partner_admin',
        },
      },
    )
    const firstBody = await readJsonSafe<{
      ok?: boolean
      agencyMemberId?: string
      error?: { code: string; message: string }
    }>(firstResponse)
    expect(
      firstResponse.status(),
      `First invite must succeed; status=${firstResponse.status()} body=${JSON.stringify(firstBody)}`,
    ).toBe(201)
    expect(firstBody?.agencyMemberId).toBeTruthy()

    // ---- Step 2: Second invite to (Agency A, targetEmail) — 429.
    const secondResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyAId}/invite`,
      {
        token: staffToken,
        data: {
          email: targetEmail,
          firstName: 'Pat',
          lastName: 'Target',
          roleSlug: 'partner_admin',
        },
      },
    )
    expect(
      secondResponse.status(),
      'Second invite within 10min cooldown MUST return 429',
    ).toBe(429)

    const secondBody = await readJsonSafe<{
      ok?: boolean
      error?: {
        code?: string
        message?: string
        details?: { retryAfterSeconds?: number }
      }
    }>(secondResponse)
    expect(secondBody?.error?.code, JSON.stringify(secondBody)).toBe('invite_cooldown_active')

    // retry_after_seconds is per spec §3.1.5 ("returns 429 invite_cooldown_active
    // with `{ retry_after_seconds }`"). Shipped JSON envelope keys camelCase
    // per `api/agency/[id]/invite/route.ts:80` — accept either the raw camelCase
    // or its snake_case mirror so a future BC follow-up doesn't accidentally
    // break this test.
    const retryAfterSeconds =
      secondBody?.error?.details?.retryAfterSeconds ??
      (secondBody?.error?.details as Record<string, unknown> | undefined)?.retry_after_seconds
    expect(
      typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0,
      `error.details.retryAfterSeconds must be a positive number; got ${JSON.stringify(secondBody?.error?.details)}`,
    ).toBe(true)

    // HTTP Retry-After header — required for well-behaved client back-off.
    const retryAfterHeader = secondResponse.headers()['retry-after']
    expect(retryAfterHeader, 'Retry-After header must be present on 429').toBeTruthy()
    expect(Number(retryAfterHeader), 'Retry-After header must be a positive integer').toBeGreaterThan(0)

    // ---- Step 3: Cross-Agency cooldown axis — same email, different Agency
    // MUST succeed (cooldown key is `(agency_id, lower(email))`).
    const crossAgencyResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyBId}/invite`,
      {
        token: staffToken,
        data: {
          email: targetEmail,
          firstName: 'Pat',
          lastName: 'Target',
          roleSlug: 'partner_admin',
        },
      },
    )
    expect(
      crossAgencyResponse.status(),
      'Same email at a different Agency must NOT be cooldown-blocked',
    ).toBe(201)

    // ---- Step 4: Cross-email cooldown axis — same Agency, different email
    // MUST succeed (cooldown is per-email, not per-Agency).
    const crossEmailResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyAId}/invite`,
      {
        token: staffToken,
        data: {
          email: siblingEmail,
          firstName: 'Pat',
          lastName: 'Sibling',
          roleSlug: 'partner_admin',
        },
      },
    )
    expect(
      crossEmailResponse.status(),
      'Different email at the same Agency must NOT be cooldown-blocked',
    ).toBe(201)
  })
})
