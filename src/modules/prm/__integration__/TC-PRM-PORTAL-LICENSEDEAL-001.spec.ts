/**
 * TC-PRM-PORTAL-LICENSEDEAL-001 — partner views attribution candidates.
 *
 * STATUS: SCAFFOLDED + SKIPPED. The portal `/api/prm/portal/min` route (and
 * the portal license-deal listings) resolve the caller's AgencyMember from
 * `customerUserId`. Same blocker family as TC-PRM-T1-001.
 *
 * Coverage shape (when unblocked):
 * - Seed Agency + invite-and-accept partner_admin (=> linked AgencyMember).
 * - As staff, create a LicenseDeal + attribute to the agency via Path C.
 * - As partner_admin, GET `/api/prm/portal/min` (or the equivalent
 *   license-deal portal route) and assert the deal appears in the agency's
 *   own attribution roster.
 */

import { test } from './fixtures/tenantFixture'

test.skip('TC-PRM-PORTAL-LICENSEDEAL-001 — partner views own LicenseDeal attribution', async () => {
  // See file header for the unblock condition (SPEC-2026-05-09c upstream PR).
})
