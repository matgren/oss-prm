/**
 * TC-PRM-T1-001 — Portal partner registers a Prospect (Spec #2 §3.2).
 *
 * STATUS: SCAFFOLDED + SKIPPED. Unblocks when SPEC-2026-05-09c (upstream PR
 * for partner-invite-acceptance) merges and `@open-mercato/core` is bumped.
 *
 * Why skipped:
 *   `POST /api/prm/portal/prospects` resolves the calling CustomerUser →
 *   `AgencyMember` row by `customerUserId` and uses the agencyId from that
 *   row. Without an AgencyMember link, the route returns 403 even with a
 *   valid CustomerUser JWT. The link is set today only by the
 *   `prm-invitation-accepted` subscriber, which fires on the
 *   `customer_accounts.invitation.accepted` event — itself triggered by the
 *   token-gated `POST /api/customer_accounts/invitations/accept`. Reading
 *   the raw token requires the upstream notifications-tenant-admin-recipient-
 *   filter PR (SPEC-2026-05-09c).
 *
 *   Anti-pattern reminder (per SPEC-2026-05-09b §"Anti-patterns"):
 *   "agency-member-link shortcut if the upstream PR is delayed" is
 *   explicitly forbidden — descope to v2 instead.
 *
 * Coverage shape (when unblocked):
 * - Seed Agency + invite a partner_admin → AgencyMember
 * - Accept the invite via the token (v2 helper)
 * - Login the CustomerUser
 * - POST `/api/prm/portal/prospects` with a minimum-viable payload
 * - Assert 201 + the new prospect appears in the calling agency's listing
 */

import { test } from './fixtures/tenantFixture'

test.skip('TC-PRM-T1-001 — partner CustomerUser registers a Prospect via the portal', async () => {
  // See file header for the unblock condition. When SPEC-2026-05-09c lands:
  // 1. Replace this with the full flow (createAgencyFixture → invite →
  //    accept-via-token → loginCustomer → createProspectFixture →
  //    getProspectViaPortalFixture → assert).
  // 2. Drop `.skip`.
})
