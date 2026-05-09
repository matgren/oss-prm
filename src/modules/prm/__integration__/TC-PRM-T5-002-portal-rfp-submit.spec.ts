/**
 * TC-PRM-T5-002 — Portal partner submits an RFP response (Spec #5 §3.2 / US5.4).
 *
 * STATUS: SCAFFOLDED + SKIPPED. Unblocks when SPEC-2026-05-09c (upstream PR
 * for partner-invite-acceptance) merges and `@open-mercato/core` is bumped.
 *
 * Why skipped:
 *   The portal RFP routes (`/api/prm/portal/rfp/...`) resolve the caller's
 *   `AgencyMember` from `customerUserId` to determine the agencyId for
 *   visibility filtering and authorship. No AgencyMember link → all portal
 *   RFP routes return 403 / silent 404. See TC-PRM-T1-001 for full
 *   blocker rationale.
 *
 * Coverage shape (when unblocked):
 * - Seed Agency A + invite-and-accept partner_admin (becomes AgencyMember).
 * - Seed Agency B (recipient candidate, set active+onboarded).
 * - As staff, create RFP + publish (broadcasts to A + B).
 * - As partner_admin (Agency A's CustomerUser), draft a response via
 *   `draftPortalRfpResponseFixture`.
 * - Submit via `submitPortalRfpResponseFixture`.
 * - Assert: 200 + status='submitted' + appears in 'responded' tab inbox.
 */

import { test } from './fixtures/tenantFixture'

test.skip('TC-PRM-T5-002 — partner CustomerUser submits a portal RFP response', async () => {
  // See file header for the unblock condition.
})
