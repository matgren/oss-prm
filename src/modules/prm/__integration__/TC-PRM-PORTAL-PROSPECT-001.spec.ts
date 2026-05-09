/**
 * TC-PRM-PORTAL-PROSPECT-001 — partner views + transitions own Prospect.
 *
 * STATUS: SCAFFOLDED + SKIPPED. Same blocker as TC-PRM-T1-001 — Prospect
 * read/write portal routes resolve the AgencyMember from `customerUserId`.
 *
 * Coverage shape (when unblocked):
 * - Seed Agency + invite-and-accept partner_admin (=> linked AgencyMember).
 * - As that partner_admin, register a Prospect via createProspectFixture.
 * - GET that Prospect via getProspectViaPortalFixture; assert canEdit=true.
 * - PATCH a transition (`new` → `qualified`) via
 *   transitionProspectViaPortalFixture; assert the resulting status.
 * - Verify cross-agency isolation: a second partner_admin cannot see
 *   the first agency's Prospect.
 */

import { test } from './fixtures/tenantFixture'

test.skip('TC-PRM-PORTAL-PROSPECT-001 — partner views + transitions own Prospect', async () => {
  // See file header for the unblock condition (SPEC-2026-05-09c upstream PR).
})
