import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  createProspectFixture,
  customerApiRequest,
  getProspectViaPortalFixture,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T1-003 — Spec #2 §9 IT-9.3 invariant #1 `registered_at` immutability.
 *
 * Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.3 + §3.1 PATCH route +
 *   §8.1 R-1 (`registered_at` mutation via malicious API client),
 *   POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T1 WIP Scoreboard → IT-9.3".
 *
 * Scenario:
 *   "PATCH with `registered_at` rejected."
 *
 * Invariant #1 — Golden Rule attribution fairness across all agencies — depends
 * on `registered_at` being write-once. The portal PATCH route (§3.1) defends
 * this with a triple-guard (R-1 mitigation):
 *   (a) Route boundary — explicit reject of any payload carrying `registeredAt`
 *       OR `registered_at` (camelCase OR snake_case) → 400 with code
 *       `registered_at_immutable`. Runs BEFORE zod parse so even malformed
 *       discriminator shapes are caught.
 *   (b) Zod `updateProspectSchema` is a `.strict()` discriminated union — the
 *       edit branch whitelists `companyName | contactName | contactEmail | notes`,
 *       the transition branch whitelists `toStatus | lostReason | ifMatchStatusChangedAt`.
 *   (c) Aggregate `update()` whitelists editable fields and ignores everything else.
 *
 * This spec exercises the PUBLIC contract (a) + verifies the field's value
 * remains identical after the rejected request. It also probes (b) by sending
 * a well-typed `kind:'edit'` body with an extra `registered_at` smuggled in;
 * the route boundary catches that case before zod sees it, hence still 400
 * with the dedicated `registered_at_immutable` code.
 *
 * Uses HTTP-contract assertions (not UI) — same shape as TC-PRM-T1-001.
 */
test.describe('TC-PRM-T1-003: Spec #2 §9 IT-9.3 — `registered_at` immutability', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Portal PATCH containing registered_at is rejected and the timestamp is unchanged', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t1-003-${Date.now().toString(36)}`

    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    const prospectId = await createProspectFixture(request, agency.admin.token, {
      companyName: `T1-003 Acme ${suffix}`,
      contactName: 'Jamie Lead',
      contactEmail: `t1-003-lead-${suffix}@example.test`,
      source: 'agency_owned',
    })

    // Capture the canonical `registeredAt` set by the aggregate's `register()` call.
    // The aggregate stamps `registered_at = now()` and the route never mutates it.
    const beforePatch = await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    const originalRegisteredAt = beforePatch.registeredAt
    expect(originalRegisteredAt).toBeTruthy()

    // ---- Case (a): camelCase smuggling on the edit branch
    const camelInjection = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectId}`,
      {
        customerToken: agency.admin.token,
        data: {
          kind: 'edit',
          contactName: 'Updated Lead Name',
          // Attempt to back-date by 1 year — the spec calls this exact failure mode
          // out as the §8.1 R-1 attack vector (malicious API client).
          registeredAt: new Date(Date.UTC(2000, 0, 1)).toISOString(),
        },
      },
    )
    const camelBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string; message?: string }
    }>(camelInjection)
    expect(
      camelInjection.status(),
      `PATCH with camelCase registeredAt must return 400; body=${JSON.stringify(camelBody)}`,
    ).toBe(400)
    expect(camelBody?.error?.code).toBe('registered_at_immutable')

    // ---- Case (b): snake_case smuggling on the transition branch
    const snakeInjection = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/prospects/${prospectId}`,
      {
        customerToken: agency.admin.token,
        data: {
          kind: 'transition',
          toStatus: 'qualified',
          ifMatchStatusChangedAt: beforePatch.statusChangedAt,
          registered_at: new Date(Date.UTC(2099, 11, 31)).toISOString(),
        },
      },
    )
    const snakeBody = await readJsonSafe<{
      ok?: false
      error?: { code?: string; message?: string }
    }>(snakeInjection)
    expect(
      snakeInjection.status(),
      `PATCH with snake_case registered_at must return 400; body=${JSON.stringify(snakeBody)}`,
    ).toBe(400)
    expect(snakeBody?.error?.code).toBe('registered_at_immutable')

    // ---- Verification: the prospect's `registeredAt` is byte-identical to
    // pre-PATCH state, AND the prospect is still `new` (the transition payload
    // was rejected before the legal `new → qualified` step could be processed).
    const afterPatch = await getProspectViaPortalFixture(request, agency.admin.token, prospectId)
    expect(afterPatch.registeredAt).toBe(originalRegisteredAt)
    expect(afterPatch.status).toBe('new')
    expect(afterPatch.statusChangedAt).toBe(beforePatch.statusChangedAt)
    // The legitimate `contactName` change in case (a) MUST NOT have applied either —
    // the boundary rejection happens before any field is committed.
    expect(afterPatch.contactName).toBe(beforePatch.contactName)
  })
})
