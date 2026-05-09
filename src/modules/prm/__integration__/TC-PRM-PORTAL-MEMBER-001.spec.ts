/**
 * TC-PRM-PORTAL-MEMBER-001 — partner_admin manages own AgencyMember roster.
 *
 * STATUS: SCAFFOLDED + SKIPPED. Same blocker as TC-PRM-T1-001 — the portal
 * member-management routes (`/api/prm/portal/agency/{id}/member`) resolve
 * the caller's AgencyMember from `customerUserId`.
 *
 * Coverage shape (when unblocked):
 * - Seed Agency + invite-and-accept partner_admin (=> linked AgencyMember).
 * - As that partner_admin, list teammates via portal route.
 * - PATCH a member's `firstName`/`isActive` via the portal PATCH route.
 * - Assert tenant-scope guard rejects cross-org members (404).
 */

import { test } from './fixtures/tenantFixture'

test.skip('TC-PRM-PORTAL-MEMBER-001 — partner_admin manages teammates via the portal', async () => {
  // See file header for the unblock condition (SPEC-2026-05-09c upstream PR).
})
