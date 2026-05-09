/**
 * TC-PRM-PORTAL-AGENCY-001 — partner CustomerUser views Agency in own org.
 *
 * Spec #1 §3.2 — `GET /api/prm/portal/agency/{id}` is gated on:
 *   1. valid CustomerUser JWT (any portal role)
 *   2. `prm.agency.view` feature (granted to both `partner_admin` and
 *      `partner_member` portal roles via `setup.ts`)
 *   3. `agency.organizationId === auth.orgId` (tenant-scope guard)
 *
 * The route does NOT require an `AgencyMember.customerUserId` link, which
 * makes this the canonical "portal smoke that doesn't need invite-acceptance"
 * — implementable today without SPEC-2026-05-09c (the upstream PR for the
 * partner-invite-acceptance flow).
 *
 * Coverage:
 * - Real `POST /api/prm/agency` (staff) seeds the Agency.
 * - Real `POST /api/customer_accounts/admin/users` (staff) creates a
 *   CustomerUser with the `partner_admin` role.
 * - Real `POST /api/customer_accounts/login` returns a portal JWT.
 * - Real `GET /api/prm/portal/agency/{id}` (customer JWT) returns the
 *   portal-shaped view of the Agency.
 *
 * Other portal-entity smokes (TC-PRM-PORTAL-MEMBER, -PROSPECT, -LICENSEDEAL,
 * -RFP-BROWSE) are scaffolded as `test.skip` because their target routes
 * resolve the caller's `AgencyMember` from `customerUserId` — a link that
 * today is set only by `prm-invitation-accepted` after the v2 flow.
 */

import { test, expect } from './fixtures/tenantFixture'
import {
  createAgencyFixture,
  setAgencyOnboardedFixture,
  createCustomerUserFixture,
  getCustomerRoleIdBySlug,
  loginCustomer,
  customerApiRequest,
} from '../testing/integration'

test('TC-PRM-PORTAL-AGENCY-001 — partner CustomerUser GETs an Agency in their own org', async ({ tenant }) => {
  const stamp = Date.now().toString(36)
  const slug = `portal-agency-${tenant.workerIndex}-${stamp}`

  // Seed the Agency to view.
  const agencyId = await createAgencyFixture(tenant.request, tenant.staffToken, {
    name: `Portal-View Target w${tenant.workerIndex}`,
    slug,
    tier: 'om_agency',
    headquartersCountry: 'US',
  })
  await setAgencyOnboardedFixture(tenant.request, tenant.staffToken, agencyId, {
    onboarded: true,
    status: 'active',
  })

  // Look up the partner_admin customer role id (seeded by prm/setup.ts).
  const partnerAdminRoleId = await getCustomerRoleIdBySlug(
    tenant.request,
    tenant.staffToken,
    'partner_admin',
  )

  // Create a CustomerUser with partner_admin → grants `prm.agency.view`.
  const customerEmail = `${slug}-cu@pw.test`
  const customerPassword = 'secret-pw-1!'
  await createCustomerUserFixture(tenant.request, tenant.staffToken, {
    email: customerEmail,
    password: customerPassword,
    displayName: `Portal Smoke User w${tenant.workerIndex}`,
    roleIds: [partnerAdminRoleId],
  })

  // Login as the CustomerUser.
  const customerToken = await loginCustomer(tenant.request, {
    email: customerEmail,
    password: customerPassword,
    tenantId: tenant.tenantId,
  })

  // GET the Agency through the portal route.
  const response = await customerApiRequest(
    tenant.request,
    'GET',
    `/api/prm/portal/agency/${agencyId}`,
    { customerToken },
  )
  expect(
    response.ok(),
    `GET /api/prm/portal/agency/${agencyId} should return 200; got ${response.status()}`,
  ).toBeTruthy()

  const body = (await response.json()) as {
    ok?: true
    agency?: {
      id: string
      slug: string
      organizationId: string
      name: string
    }
  }
  expect(body.agency?.id).toBe(agencyId)
  expect(body.agency?.slug).toBe(slug)
  expect(body.agency?.organizationId).toBe(tenant.organizationId)
})
