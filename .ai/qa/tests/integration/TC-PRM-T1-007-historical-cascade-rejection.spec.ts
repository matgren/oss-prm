import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  customerApiRequest,
  resetPrmState,
  setAgencyOnboardedFixture,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-007 — Spec #2 §9 IT-9.7 Agency `historical` cascade rejection.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.7 + §3.1 POST route +
 *   §8.2 R-4 (`status = historical` cascade vs in-flight Prospect edits),
 *   POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.7".
 *
 * Scenario:
 *   "POST Prospect on historical agency → 409."
 *
 * Aggregate precondition (`prospectService.register`):
 *   if (agency.status !== 'active') →
 *     PrmDomainError(AGENCY_HISTORICAL, 'Your Agency is historical — contact OM PartnerOps', 409)
 *
 * The route surfaces this as `409 agency_historical`. Surface text is
 * specified in §3.1 — `"Your Agency is historical — contact OM support"`
 * (the shipped service uses "OM PartnerOps" which is the same human-facing
 * party; we assert the code, not the message string, to keep this test
 * stable against copy edits).
 *
 * Setup:
 *   1. Boot agency in `active` state (default for `bootPartnerAgencyWithMembers`).
 *   2. Sanity register one Prospect — confirms the active path works.
 *   3. Staff PATCHes agency `status = historical` via `setAgencyOnboardedFixture`.
 *   4. Same partner_admin token attempts `POST /api/prm/portal/prospects` →
 *      MUST 409 agency_historical.
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-007: Spec #2 §9 IT-9.7 — POST Prospect on historical agency rejected with 409', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Historical agency: POST /api/prm/portal/prospects returns 409 agency_historical', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-007-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Step 1: while the agency is `active`, registration succeeds.
    const happyPath = await customerApiRequest(
      request,
      'POST',
      '/api/prm/portal/prospects',
      {
        customerToken: agency.admin.token,
        data: {
          companyName: `T1-007 Pre-Historical ${suffix}`,
          contactName: 'Pre Author',
          contactEmail: `t1-007-pre-${suffix}@example.test`,
          source: 'agency_owned',
        },
      },
    )
    const happyBody = await readJsonSafe<{
      ok?: true
      prospect?: { id?: string; status?: string }
    }>(happyPath)
    expect(
      happyPath.status(),
      `pre-historical POST should succeed with 201; body=${JSON.stringify(happyBody)}`,
    ).toBe(201)
    expect(happyBody?.prospect?.status).toBe('new')

    // ---- Step 2: staff flips the agency to `historical` (US1.7 / Vernon C3).
    // The PATCH route (`/api/prm/agency/{id}`) accepts `status: 'historical'`
    // and the aggregate cascades into the read-model used by the precondition
    // subscriber. Note that `setAgencyOnboardedFixture` defaults `onboarded`
    // to true; we keep onboarded since the historical-cascade is the only
    // gate this test is exercising.
    await setAgencyOnboardedFixture(request, staffToken, agency.agencyId, {
      status: 'historical',
    })

    // ---- Step 3: post-historical POST must surface 409 agency_historical.
    const blocked = await customerApiRequest(
      request,
      'POST',
      '/api/prm/portal/prospects',
      {
        customerToken: agency.admin.token,
        data: {
          companyName: `T1-007 Post-Historical ${suffix}`,
          contactName: 'Post Author',
          contactEmail: `t1-007-post-${suffix}@example.test`,
          source: 'agency_owned',
        },
      },
    )
    const blockedBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string; message?: string }
    }>(blocked)
    expect(
      blocked.status(),
      `historical POST must return 409 agency_historical; body=${JSON.stringify(blockedBody)}`,
    ).toBe(409)
    expect(blockedBody?.error?.code).toBe('agency_historical')
    // Surface message must NOT be empty — UX shows a banner with this text.
    // We don't pin the exact string (spec wording vs shipped wording differ
    // on "OM support" vs "OM PartnerOps"), but the message must mention the
    // human-facing reason. Loose check keeps the test stable against copy edits.
    expect(typeof blockedBody?.error?.message).toBe('string')
    expect((blockedBody?.error?.message ?? '').length).toBeGreaterThan(0)
  })
})
