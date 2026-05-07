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
 * TC-PRM-T1-002 — Spec #2 §9 IT-9.2 invariant #12 illegal-transition enforcement.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.2, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.2".
 *
 * Scenario:
 *   "Illegal transition blocked with 409."
 *
 * Invariant #12 transition matrix (from `data/validators.ts`):
 *
 *   new       → qualified | lost
 *   qualified → contacted | won | lost
 *   contacted → won | lost | dormant
 *   dormant   → qualified | lost
 *   won       → ∅ (terminal)
 *   lost      → ∅ (terminal)
 *
 * This test exercises the wire-level rejection of two illegal transitions a
 * partner could realistically attempt:
 *   (a) `new → contacted` — skipping the `qualified` gate (US3.2 W4 failure path).
 *   (b) `lost → qualified` — reviving a terminal prospect (US3.2 W6 failure path).
 *
 * Both must surface as `409 invalid_transition` per §3.1 PATCH error table.
 * The portal contract is `requireCustomerAuth` + `requireCustomerFeature` →
 * `prospectService.transitionStatus` → `PrmDomainError(INVALID_TRANSITION, …, 409)`.
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-002: Spec #2 §9 IT-9.2 — invariant #12 illegal transitions return 409', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Portal PATCH with illegal toStatus returns 409 invalid_transition', async ({ request }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-002-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // Seed a fresh Prospect — starts in `new`.
    const prospectId = await createProspectFixture(request, agency.admin.token, {
      companyName: `T1-002 Acme ${suffix}`,
      contactName: 'Jamie Lead',
      contactEmail: `t1-002-lead-${suffix}@example.test`,
      source: 'agency_owned',
    })
    const fresh = await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    expect(fresh.status).toBe('new')
    // Sanity: server never advertises `contacted` as reachable from `new`.
    expect(fresh.canTransitionTo).not.toContain('contacted')

    // ---- Case (a): new → contacted is illegal (must go via qualified first).
    const illegalNewToContacted = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectId}`,
      {
        customerToken: agency.admin.token,
        data: {
          kind: 'transition',
          toStatus: 'contacted',
          ifMatchStatusChangedAt: fresh.statusChangedAt,
        },
      },
    )
    const illegalBodyA = await readJsonSafe<{
      ok?: false
      error?: { code?: string; message?: string; details?: { fromStatus?: string; toStatus?: string } }
    }>(illegalNewToContacted)
    expect(
      illegalNewToContacted.status(),
      `PATCH new→contacted must return 409 invalid_transition; body=${JSON.stringify(illegalBodyA)}`,
    ).toBe(409)
    expect(illegalBodyA?.error?.code).toBe('invalid_transition')
    // Aggregate persisted error envelope carries the rejected pair so UIs can
    // explain the failure (`{ fromStatus, toStatus }`).
    expect(illegalBodyA?.error?.details?.fromStatus).toBe('new')
    expect(illegalBodyA?.error?.details?.toStatus).toBe('contacted')

    // The prospect MUST remain in `new` — defence-in-depth that the rejected
    // PATCH did not partially apply.
    const stillNew = await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    expect(stillNew.status).toBe('new')
    expect(stillNew.statusChangedAt).toBe(fresh.statusChangedAt)

    // ---- Case (b): drive the same prospect to `lost`, then attempt lost → qualified.
    const lost = await transitionProspectViaPortalFixture(
      request,
      agency.admin.token,
      prospectId,
      'lost',
      { lostReason: 'TC-PRM-T1-002 verification of terminal-state guard' },
    )
    expect(lost.status).toBe('lost')
    // Server-computed reachability set is empty for terminal `lost`.
    expect(lost.canTransitionTo).toEqual([])

    const illegalLostToQualified = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectId}`,
      {
        customerToken: agency.admin.token,
        data: {
          kind: 'transition',
          toStatus: 'qualified',
          ifMatchStatusChangedAt: lost.statusChangedAt,
        },
      },
    )
    const illegalBodyB = await readJsonSafe<{
      ok?: false
      error?: { code?: string; message?: string; details?: { fromStatus?: string; toStatus?: string } }
    }>(illegalLostToQualified)
    expect(
      illegalLostToQualified.status(),
      `PATCH lost→qualified must return 409 invalid_transition; body=${JSON.stringify(illegalBodyB)}`,
    ).toBe(409)
    expect(illegalBodyB?.error?.code).toBe('invalid_transition')
    expect(illegalBodyB?.error?.details?.fromStatus).toBe('lost')
    expect(illegalBodyB?.error?.details?.toStatus).toBe('qualified')

    // Final read — still `lost`, status_changed_at unchanged from the legal
    // transition (proving the second illegal attempt was a true no-op).
    const stillLost = await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    expect(stillLost.status).toBe('lost')
    expect(stillLost.statusChangedAt).toBe(lost.statusChangedAt)
  })
})
