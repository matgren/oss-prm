/**
 * Customer-portal Playwright auth helper (POST-MVP follow-up).
 *
 * Mirrors the staff `apiRequest` / `getAuthToken` helpers from
 * `@open-mercato/core/testing/integration` for the customer-portal contract:
 *
 *   - Customer login: `POST /api/customer_accounts/login` with
 *     `{ email, password, tenantId }` → response sets `customer_auth_token`
 *     cookie. We extract the JWT from the `Set-Cookie` header so callers can
 *     pass it as a `Bearer` token to subsequent portal API calls — the same
 *     shape staff fixtures use (`token: string`).
 *
 *   - Customer-aware API call: `customerApiRequest(request, method, path, opts)`
 *     attaches `Authorization: Bearer <jwt>` instead of the staff Bearer.
 *     Header contract is taken straight from `requireCustomerAuth` (which
 *     accepts both `Authorization: Bearer` and the cookie form).
 *
 *   - Boot fixture: `bootPartnerAgencyWithMembers(request, staffToken, opts)`
 *     seeds an Agency, two CustomerUsers (`partner_admin` + `partner_member`),
 *     links each via the test-only `POST /api/prm/test-fixtures/agency-member-link`,
 *     logs them in, and returns ready-to-use customer JWTs.
 *
 * Until this helper shipped, T5 §9.2 invariant #15 was locked at the unit-test
 * level (`__tests__/rfpVisibility.test.ts`) and T5 §9.3/§9.4 were at the
 * service-test level (`rfpService.test.ts`). The two demo Playwright tests in
 * `.ai/qa/tests/integration/TC-PRM-T5-002-*` and `TC-PRM-T5-003-*` elevate
 * the byte-identical 404 invariant and the submit happy path to true HTTP
 * contract tests.
 */

import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import {
  apiRequest,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/testing/integration'
import { createAgencyFixture, setAgencyOnboardedFixture } from './fixtures'

const BASE_URL = process.env.BASE_URL?.trim() || null

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

/** Internal: parse the `customer_auth_token` JWT from a Set-Cookie response. */
function extractCustomerJwt(response: APIResponse): string | null {
  const headers = response.headersArray()
  const setCookies = headers.filter((h) => h.name.toLowerCase() === 'set-cookie')
  for (const header of setCookies) {
    const value = header.value
    const match = value.match(/customer_auth_token=([^;]+)/)
    if (match) {
      try {
        return decodeURIComponent(match[1]!)
      } catch {
        return match[1]!
      }
    }
  }
  return null
}

/**
 * Authenticate a CustomerUser via `POST /api/customer_accounts/login` and
 * return the JWT extracted from the `customer_auth_token` Set-Cookie header.
 *
 * `tenantId` is required by the customer login route. Pass the tenantId
 * decoded from a staff-admin token (use `getTokenContext` from
 * `@open-mercato/core/testing/integration` after `getAuthToken('admin')`).
 */
export async function loginCustomer(
  request: APIRequestContext,
  input: { email: string; password: string; tenantId: string },
): Promise<string> {
  const response = await request.fetch(resolveUrl('/api/customer_accounts/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    data: {
      email: input.email,
      password: input.password,
      tenantId: input.tenantId,
    },
  })
  if (!response.ok()) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Customer login failed for ${input.email}: status=${response.status()} body=${text}`,
    )
  }
  const jwt = extractCustomerJwt(response)
  if (!jwt) {
    throw new Error(
      `Customer login for ${input.email} succeeded but customer_auth_token cookie missing in response`,
    )
  }
  return jwt
}

export type CustomerApiOptions = {
  customerToken: string
  data?: unknown
  headers?: Record<string, string>
}

/**
 * Call a customer-portal API endpoint with a CustomerUser JWT attached as a
 * Bearer token. Same shape as the staff `apiRequest` helper, but uses the
 * customer JWT — the route handler's `requireCustomerAuth` accepts the
 * Authorization header form directly.
 */
export async function customerApiRequest(
  request: APIRequestContext,
  method: string,
  path: string,
  options: CustomerApiOptions,
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.customerToken}`,
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  }
  return request.fetch(resolveUrl(path), { method, headers, data: options.data })
}

type CustomerRoleSummary = { id: string; slug: string; name: string }

/**
 * Look up a customer role id by slug via the staff-admin
 * `GET /api/customer_accounts/admin/roles?search=<slug>` endpoint. Used by
 * `bootPartnerAgencyWithMembers` to assign `partner_admin` / `partner_member`
 * at user-create time.
 */
export async function getCustomerRoleIdBySlug(
  request: APIRequestContext,
  staffToken: string,
  slug: string,
): Promise<string> {
  const response = await apiRequest(
    request,
    'GET',
    `/api/customer_accounts/admin/roles?pageSize=100&search=${encodeURIComponent(slug)}`,
    { token: staffToken },
  )
  const body = await readJsonSafe<{ ok?: boolean; items?: CustomerRoleSummary[] }>(response)
  expect(
    response.status(),
    `GET /api/customer_accounts/admin/roles should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(200)
  const role = body?.items?.find((r) => r.slug === slug)
  return expectId(role?.id, `CustomerRole with slug "${slug}" must be seeded for the tenant`)
}

/**
 * Create a CustomerUser via the staff-admin `POST /api/customer_accounts/admin/users`
 * endpoint. The endpoint marks the user `email_verified_at = now()` automatically,
 * so the returned credentials are immediately usable with `loginCustomer`.
 */
export async function createCustomerUserFixture(
  request: APIRequestContext,
  staffToken: string,
  input: {
    email: string
    password: string
    displayName: string
    roleIds?: string[]
  },
): Promise<{ id: string; email: string }> {
  const response = await apiRequest(request, 'POST', '/api/customer_accounts/admin/users', {
    token: staffToken,
    data: {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      ...(input.roleIds && input.roleIds.length > 0 ? { roleIds: input.roleIds } : {}),
    },
  })
  const body = await readJsonSafe<{
    ok: true
    user?: { id: string; email: string }
  }>(response)
  expect(
    response.status(),
    `POST /api/customer_accounts/admin/users should return 201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(201)
  const id = expectId(body?.user?.id, 'CustomerUser response must include user.id')
  return { id, email: body!.user!.email }
}

/**
 * Link an existing CustomerUser to an Agency as a `partner_admin` /
 * `partner_member` via the test-only PRM seam endpoint.
 *
 * Requires `OM_PRM_TEST_FIXTURES_ENABLED=1` in the running app env. Without
 * that, the endpoint returns 404 (production gate) and this helper throws.
 */
export async function linkAgencyMemberFixture(
  request: APIRequestContext,
  staffToken: string,
  input: {
    agencyId: string
    customerUserId: string
    email: string
    firstName: string
    lastName: string
    roleSlug: 'partner_admin' | 'partner_member'
    githubProfile?: string | null
  },
): Promise<{ agencyMemberId: string; reused: boolean }> {
  const response = await apiRequest(
    request,
    'POST',
    '/api/prm/test-fixtures/agency-member-link',
    {
      token: staffToken,
      data: {
        agencyId: input.agencyId,
        customerUserId: input.customerUserId,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        roleSlug: input.roleSlug,
        ...(input.githubProfile !== undefined ? { githubProfile: input.githubProfile } : {}),
      },
    },
  )
  const body = await readJsonSafe<{
    ok?: boolean
    agencyMemberId?: string
    reused?: boolean
    error?: string
  }>(response)
  if (response.status() === 404) {
    throw new Error(
      'POST /api/prm/test-fixtures/agency-member-link returned 404 — likely OM_PRM_TEST_FIXTURES_ENABLED is not set in the running app env. ' +
        `body=${JSON.stringify(body)}`,
    )
  }
  expect(
    [200, 201].includes(response.status()),
    `POST /api/prm/test-fixtures/agency-member-link should return 200/201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(true)
  return {
    agencyMemberId: expectId(body?.agencyMemberId, 'agency-member-link response missing agencyMemberId'),
    reused: body?.reused === true,
  }
}

export type PartnerAgencyMember = {
  customerUserId: string
  agencyMemberId: string
  email: string
  password: string
  /** Customer JWT — pass to `customerApiRequest({ customerToken })`. */
  token: string
}

export type PartnerAgencyFixture = {
  agencyId: string
  agencySlug: string
  tenantId: string
  organizationId: string
  admin: PartnerAgencyMember
  member: PartnerAgencyMember
}

/**
 * One-call boot for portal integration tests. Seeds:
 *  - A fresh Agency (active, onboarded, default `om_agency` tier).
 *  - A `partner_admin` CustomerUser linked to the Agency.
 *  - A `partner_member` CustomerUser linked to the Agency.
 *
 * Returns both members with their customer JWTs ready for
 * `customerApiRequest({ customerToken })`.
 *
 * Requires the staff `admin` token (call `getAuthToken(request, 'admin')`).
 * The tenant is inferred from the staff token's claims.
 */
export async function bootPartnerAgencyWithMembers(
  request: APIRequestContext,
  staffToken: string,
  options: {
    suffix?: string
    onboarded?: boolean
    tier?: 'om_agency' | 'ai_native' | 'ai_native_expert' | 'ai_native_core'
    /** Lets a caller pre-resolve the role IDs once and reuse across boots. */
    partnerAdminRoleId?: string
    partnerMemberRoleId?: string
  } = {},
): Promise<PartnerAgencyFixture> {
  const suffix = options.suffix ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tier = options.tier ?? 'om_agency'

  const { tenantId, organizationId } = getTokenContext(staffToken)
  if (!tenantId) {
    throw new Error('Staff token is missing tenantId; cannot boot partner agency')
  }

  const agencyId = await createAgencyFixture(request, staffToken, {
    name: `Portal Test Agency ${suffix}`,
    slug: `portal-test-${suffix}`,
    tier,
  })
  if (options.onboarded !== false) {
    await setAgencyOnboardedFixture(request, staffToken, agencyId, {
      onboarded: true,
      status: 'active',
    })
  }

  const adminRoleId =
    options.partnerAdminRoleId ?? (await getCustomerRoleIdBySlug(request, staffToken, 'partner_admin'))
  const memberRoleId =
    options.partnerMemberRoleId ?? (await getCustomerRoleIdBySlug(request, staffToken, 'partner_member'))

  const password = 'PortalTest!Secret-123'
  const adminEmail = `portal-admin-${suffix}@example.test`
  const memberEmail = `portal-member-${suffix}@example.test`

  const adminUser = await createCustomerUserFixture(request, staffToken, {
    email: adminEmail,
    password,
    displayName: `Portal Admin ${suffix}`,
    roleIds: [adminRoleId],
  })
  const memberUser = await createCustomerUserFixture(request, staffToken, {
    email: memberEmail,
    password,
    displayName: `Portal Member ${suffix}`,
    roleIds: [memberRoleId],
  })

  const adminLink = await linkAgencyMemberFixture(request, staffToken, {
    agencyId,
    customerUserId: adminUser.id,
    email: adminEmail,
    firstName: 'Adam',
    lastName: `Admin-${suffix}`,
    roleSlug: 'partner_admin',
  })
  const memberLink = await linkAgencyMemberFixture(request, staffToken, {
    agencyId,
    customerUserId: memberUser.id,
    email: memberEmail,
    firstName: 'Mary',
    lastName: `Member-${suffix}`,
    roleSlug: 'partner_member',
  })

  const adminToken = await loginCustomer(request, {
    email: adminEmail,
    password,
    tenantId,
  })
  const memberToken = await loginCustomer(request, {
    email: memberEmail,
    password,
    tenantId,
  })

  return {
    agencyId,
    agencySlug: `portal-test-${suffix}`,
    tenantId,
    organizationId,
    admin: {
      customerUserId: adminUser.id,
      agencyMemberId: adminLink.agencyMemberId,
      email: adminEmail,
      password,
      token: adminToken,
    },
    member: {
      customerUserId: memberUser.id,
      agencyMemberId: memberLink.agencyMemberId,
      email: memberEmail,
      password,
      token: memberToken,
    },
  }
}
