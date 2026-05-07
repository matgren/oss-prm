/**
 * PRM integration-test fixtures.
 *
 * Public surface for Playwright integration specs that need to seed PRM
 * entities (Agency, LicenseDeal, Prospect). Mirrors the OM core fixture
 * pattern at `@open-mercato/core/testing/integration`:
 * - Each `create*Fixture(request, token, input)` POSTs to the corresponding
 *   PRM API route and returns the new id.
 * - Each `delete*IfExists(request, token, id)` is a best-effort cleanup.
 * - All seeding goes through `apiRequest` (no raw SQL).
 *
 * Import in specs as:
 *   import { createAgencyFixture, deleteAgencyIfExists }
 *     from '@/modules/prm/testing/integration'
 *
 * Tests still use core helpers for cross-cutting concerns:
 *   import { getAuthToken } from '@open-mercato/core/testing/integration'
 */
export {
  createAgencyFixture,
  deleteAgencyIfExists,
  setAgencyOnboardedFixture,
  createLicenseDealFixture,
  deleteLicenseDealIfExists,
  createProspectFixture,
  deleteProspectIfExists,
  createRfpDraftFixture,
  publishRfpFixture,
  unpublishRfpFixture,
} from './fixtures'

export {
  loginCustomer,
  customerApiRequest,
  getCustomerRoleIdBySlug,
  createCustomerUserFixture,
  linkAgencyMemberFixture,
  bootPartnerAgencyWithMembers,
} from './customerAuth'

export type {
  CustomerApiOptions,
  PartnerAgencyMember,
  PartnerAgencyFixture,
} from './customerAuth'
