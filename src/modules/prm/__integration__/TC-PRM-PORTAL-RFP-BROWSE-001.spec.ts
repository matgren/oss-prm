/**
 * TC-PRM-PORTAL-RFP-BROWSE-001 — partner browses published RFP inbox.
 *
 * STATUS: SCAFFOLDED + SKIPPED. Same blocker as TC-PRM-T1-001 — the portal
 * RFP inbox at `/api/prm/portal/rfp` resolves the AgencyMember from
 * `customerUserId` to compute visibility (only the broadcasts addressed to
 * the caller's agency are returned).
 *
 * Coverage shape (when unblocked):
 * - Seed Agency + invite-and-accept partner_admin (=> linked AgencyMember).
 * - As staff, create + publish an RFP with the agency in the eligibility set.
 * - As partner_admin, GET `/api/prm/portal/rfp?tab=unread` via
 *   listPortalRfpInboxFixture; assert the RFP shows up in the inbox with
 *   `firstOpenedAt=null` and the broadcast's id present.
 *
 * NOTE: This spec is the canonical "portal-side RFP read" path. It does NOT
 * need to submit a response (TC-PRM-T5-002 covers submit). Browse coverage
 * is enough to satisfy the spec's portal-entity rule §6 ("any PRM domain
 * entity that surfaces in the customer portal MUST ship with at least one
 * happy-path portal-flow smoke spec").
 */

import { test } from './fixtures/tenantFixture'

test.skip('TC-PRM-PORTAL-RFP-BROWSE-001 — partner browses portal RFP inbox', async () => {
  // See file header for the unblock condition (SPEC-2026-05-09c upstream PR).
})
