import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  createAgencyFixture,
  resetPrmState,
  setAgencyOnboardedFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-002 — Spec #1 §9 IT-2 duplicate GitHub-profile rejection (L-010).
 *
 * Source: SPEC-2026-04-23-agency-foundation.md §9 IT-2, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T0 Agency Foundation → IT-2".
 *
 * Scenario (US1.2, US1.5, invariant #5):
 *   Two Agencies invite a member with the same `githubProfile`. The first
 *   invite succeeds; the second MUST be rejected with HTTP 409 +
 *   `code: github_profile_conflict` and the canonical L-010 privacy-preserving
 *   message — no Agency name leaked.
 *
 * Why this matters:
 *   - Invariant #5 — `agency_member.github_profile` is **globally unique**
 *     while `is_active = true`. The lock is held from invite creation
 *     (Vernon C6 + L-013), enforced by a partial UNIQUE index named
 *     `prm_agency_members_github_profile_active_uniq`.
 *   - L-010 — the user-visible 409 message MUST NOT reveal which other
 *     Agency owns the conflicting handle (privacy-preserving). The
 *     diagnostic event `prm.agency_member.github_profile_conflict_attempted`
 *     carries the cross-tenant detail for OM-staff visibility only.
 *
 * Path:
 *   1. Staff creates Agency A and invites a member with githubProfile=`octo-A`.
 *      Service-side path triggers the "pre-check" branch in
 *      `agencyMemberService.invite` — first call succeeds, member row holds
 *      the GH-profile lock.
 *   2. Staff creates Agency B and invites a member with the same GH profile.
 *      Service-side path catches the same pre-check (now finds the existing
 *      active member) and throws `PrmDomainError(GITHUB_PROFILE_CONFLICT, …)`.
 *   3. Test asserts:
 *        - status === 409
 *        - error.code === 'github_profile_conflict'
 *        - error.message === GITHUB_PROFILE_CONFLICT_MESSAGE (privacy-preserving copy)
 *        - body does NOT contain Agency-A's name or slug anywhere (string scan)
 */
test.describe('TC-PRM-T0-002: Spec #1 §9 IT-2 — Duplicate GitHub-profile rejection (L-010)', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('second invite with same GH profile across Agencies returns 409 with privacy-preserving message', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-002-${Date.now().toString(36)}`
    // GitHub handle regex per inviteAgencyMemberSchema — must satisfy
    // `^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$`. Keep it simple
    // and unique-per-test-run so repeated runs in the same DB don't collide
    // (the global GH lock would still see a stale active row otherwise).
    const sharedGithubProfile = `octo${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`

    // --- Step 1: Create Agency A. Use a recognisable secret name + slug we can
    // string-scan against in the conflict response body to enforce L-010 privacy.
    const agencyASecretName = `T0-002 Owner Agency Secret-${suffix}`
    const agencyASlug = `t0-002-secret-${suffix}`
    const agencyAId = await createAgencyFixture(request, staffToken, {
      name: agencyASecretName,
      slug: agencyASlug,
      tier: 'om_agency',
    })
    await setAgencyOnboardedFixture(request, staffToken, agencyAId, {
      onboarded: true,
      status: 'active',
    })

    // --- Step 2: Create Agency B (active+onboarded so the route doesn't 409 us
    // on agency_historical before the GH check runs).
    const agencyBId = await createAgencyFixture(request, staffToken, {
      name: `T0-002 Probe Agency ${suffix}`,
      slug: `t0-002-probe-${suffix}`,
      tier: 'om_agency',
    })
    await setAgencyOnboardedFixture(request, staffToken, agencyBId, {
      onboarded: true,
      status: 'active',
    })

    // --- Step 3: Invite into Agency A — must succeed (201). This places the
    // GH-profile lock on Agency A's placeholder member row (is_active=true).
    const firstResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyAId}/invite`,
      {
        token: staffToken,
        data: {
          email: `t0-002-first-${suffix}@example.test`,
          firstName: 'First',
          lastName: 'Owner',
          roleSlug: 'partner_admin',
          githubProfile: sharedGithubProfile,
        },
      },
    )
    const firstBody = await readJsonSafe<{
      ok?: boolean
      agencyMemberId?: string
      invitationId?: string
      error?: { code: string; message: string }
    }>(firstResponse)
    expect(
      firstResponse.status(),
      `First invite (Agency A) must succeed; status=${firstResponse.status()} body=${JSON.stringify(firstBody)}`,
    ).toBe(201)
    expect(firstBody?.agencyMemberId, 'first invite must return agencyMemberId').toBeTruthy()

    // --- Step 4: Invite into Agency B with the SAME GH profile — must 409.
    const secondResponse = await apiRequest(
      request,
      'POST',
      `/api/prm/agency/${agencyBId}/invite`,
      {
        token: staffToken,
        data: {
          email: `t0-002-second-${suffix}@example.test`,
          firstName: 'Second',
          lastName: 'Probe',
          roleSlug: 'partner_admin',
          githubProfile: sharedGithubProfile,
        },
      },
    )
    expect(secondResponse.status(), 'cross-Agency duplicate GH profile MUST return 409').toBe(409)

    const secondBody = await readJsonSafe<{
      ok?: boolean
      error?: { code: string; message: string; details?: Record<string, unknown> }
    }>(secondResponse)
    expect(secondBody?.error?.code, JSON.stringify(secondBody)).toBe('github_profile_conflict')

    // L-010 privacy-preserving message — verbatim copy from
    // `lib/errors.ts` GITHUB_PROFILE_CONFLICT_MESSAGE. Asserting on the exact
    // string protects against accidental copy changes that might leak hints.
    expect(secondBody?.error?.message).toBe(
      'A profile with this GitHub handle is already active in our partner network. Please contact OM PartnerOps if you believe this is in error.',
    )

    // L-010 privacy guard — no Agency-A identifier may appear anywhere in the
    // response body (covers name, slug, id leakage in error.details).
    const bodyJson = JSON.stringify(secondBody)
    expect(
      bodyJson,
      `409 body MUST NOT leak Agency-A name "${agencyASecretName}". body=${bodyJson}`,
    ).not.toContain(agencyASecretName)
    expect(
      bodyJson,
      `409 body MUST NOT leak Agency-A slug "${agencyASlug}". body=${bodyJson}`,
    ).not.toContain(agencyASlug)
    expect(
      bodyJson,
      `409 body MUST NOT leak Agency-A id "${agencyAId}". body=${bodyJson}`,
    ).not.toContain(agencyAId)
  })
})
