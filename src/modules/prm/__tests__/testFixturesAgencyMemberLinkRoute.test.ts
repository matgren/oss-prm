/**
 * Tests for `POST /api/prm/test-fixtures/agency-member-link` — the test-only
 * customer-portal auth seam (POST-MVP customer-portal Playwright auth helper).
 *
 * Covers:
 *  - Disabled by default — returns 404 without `OM_PRM_TEST_FIXTURES_ENABLED=1`,
 *    byte-identical to a non-existent route. Production attack-surface gate.
 *  - Enabled gate accepts a fully-formed request and inserts an active
 *    AgencyMember (`customer_user_id` set, `activated_at` set) without going
 *    through the invite/email/accept dance.
 *  - Idempotent re-call returns the same `agencyMemberId` with `reused: true`
 *    (so test fixtures can be safely re-run).
 *  - Validation rejects non-PRM role slugs.
 *  - Missing Agency / CustomerUser yield 404.
 */

const getAuthFromRequestMock = jest.fn()
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequestMock(...args),
}))

const findOneWithDecryptionMock = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
}))

const containerEmFindOneMock = jest.fn()
const containerEmCreateMock = jest.fn()
const containerEmPersistMock = jest.fn()
const containerEmFlushMock = jest.fn(async () => undefined)
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') {
        return {
          findOne: containerEmFindOneMock,
          create: containerEmCreateMock,
          persist: containerEmPersistMock,
          flush: containerEmFlushMock,
        }
      }
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

import { POST } from '../api/test-fixtures/agency-member-link/route'

const TENANT = 'tenant-1'
const ORG = 'org-1'
const AGENCY = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_USER = '22222222-2222-4222-8222-222222222222'

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/prm/test-fixtures/agency-member-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  getAuthFromRequestMock.mockReset()
  findOneWithDecryptionMock.mockReset()
  containerEmFindOneMock.mockReset()
  containerEmCreateMock.mockReset()
  containerEmPersistMock.mockReset()
  containerEmFlushMock.mockClear()
  delete process.env.OM_PRM_TEST_FIXTURES_ENABLED
})

afterAll(() => {
  delete process.env.OM_PRM_TEST_FIXTURES_ENABLED
})

describe('POST /api/prm/test-fixtures/agency-member-link', () => {
  it('returns 404 when fixtures are disabled (no env opt-in)', async () => {
    const req = makeRequest({})
    const res = await POST(req)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ ok: false, error: 'Not found' })
    // Auth is intentionally NOT checked when disabled — the gate must look
    // identical to a missing route (no auth probe, no leak).
    expect(getAuthFromRequestMock).not.toHaveBeenCalled()
  })

  it('returns 401 when fixtures enabled but unauthenticated', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue(null)
    const res = await POST(
      makeRequest({
        agencyId: AGENCY,
        customerUserId: CUSTOMER_USER,
        email: 'a@b.test',
        firstName: 'A',
        lastName: 'B',
        roleSlug: 'partner_admin',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('400 on invalid roleSlug', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })
    const res = await POST(
      makeRequest({
        agencyId: AGENCY,
        customerUserId: CUSTOMER_USER,
        email: 'a@b.test',
        firstName: 'A',
        lastName: 'B',
        roleSlug: 'super_admin', // not a PRM role
      }),
    )
    expect(res.status).toBe(400)
  })

  it('404 when agency does not exist for tenant', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })
    findOneWithDecryptionMock.mockResolvedValueOnce(null) // Agency lookup
    const res = await POST(
      makeRequest({
        agencyId: AGENCY,
        customerUserId: CUSTOMER_USER,
        email: 'a@b.test',
        firstName: 'A',
        lastName: 'B',
        roleSlug: 'partner_admin',
      }),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/agency/i)
  })

  it('inserts a linked active AgencyMember on first call (201, reused=false)', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })
    findOneWithDecryptionMock
      // 1. Agency lookup
      .mockResolvedValueOnce({ id: AGENCY, tenantId: TENANT, organizationId: ORG, status: 'active' })
      // 2. CustomerRole lookup (after CustomerUser & existing-member checks)
      .mockResolvedValueOnce({ id: 'role-partner-admin', slug: 'partner_admin' })
    containerEmFindOneMock
      // CustomerUser lookup
      .mockResolvedValueOnce({ id: CUSTOMER_USER, tenantId: TENANT })
      // Existing AgencyMember lookup (none)
      .mockResolvedValueOnce(null)
      // Existing CustomerUserRole link (none)
      .mockResolvedValueOnce(null)

    let createdAgencyMember: any = null
    containerEmCreateMock.mockImplementation((cls: any, data: any) => {
      if (cls?.name === 'AgencyMember') {
        const m = { id: 'mem-new', ...data }
        createdAgencyMember = m
        return m
      }
      return { ...data }
    })

    const res = await POST(
      makeRequest({
        agencyId: AGENCY,
        customerUserId: CUSTOMER_USER,
        email: 'admin@example.test',
        firstName: 'Adam',
        lastName: 'Min',
        roleSlug: 'partner_admin',
        githubProfile: 'octocat',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.reused).toBe(false)
    expect(body.agencyMemberId).toBe('mem-new')
    expect(containerEmFlushMock).toHaveBeenCalled()
    expect(createdAgencyMember).toMatchObject({
      tenantId: TENANT,
      agencyId: AGENCY,
      customerUserId: CUSTOMER_USER,
      isActive: true,
      roleSlug: 'partner_admin',
      githubProfile: 'octocat',
    })
    expect(createdAgencyMember.activatedAt).toBeInstanceOf(Date)
  })

  it('does NOT migrate the CustomerUser organizationId in this seam (deferred — see route.ts comments)', async () => {
    // Tracking the deliberate non-migration. In production the
    // accept-invitation flow flips the user's org to the agency's org. The
    // test seam currently leaves the customer in the staff org so the
    // existing T5 portal/RFP visibility test does not regress. See
    // `route.ts` deferred-fix comment block + the TC-PRM-T0-001 commit body
    // for the full chain. When the route-side org-scope fix lands, this test
    // flips to assert the migration.
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })
    findOneWithDecryptionMock
      .mockResolvedValueOnce({
        id: AGENCY,
        tenantId: TENANT,
        organizationId: 'agency-org-99', // distinct from staff `orgId`
        status: 'active',
      })
      .mockResolvedValueOnce({ id: 'role-partner-admin', slug: 'partner_admin' })
    const customerUser = { id: CUSTOMER_USER, tenantId: TENANT, organizationId: ORG }
    containerEmFindOneMock
      .mockResolvedValueOnce(customerUser)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    containerEmCreateMock.mockImplementation((cls: any, data: any) => {
      if (cls?.name === 'AgencyMember') return { id: 'mem-new', ...data }
      return { ...data }
    })

    const res = await POST(
      makeRequest({
        agencyId: AGENCY,
        customerUserId: CUSTOMER_USER,
        email: 'admin@example.test',
        firstName: 'Adam',
        lastName: 'Min',
        roleSlug: 'partner_admin',
      }),
    )
    expect(res.status).toBe(201)
    // The customer org is NOT flipped — see the deferred-fix comment in route.ts.
    expect(customerUser.organizationId).toBe(ORG)
  })

  it('returns existing member with reused=true on second call (idempotent)', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })
    findOneWithDecryptionMock.mockResolvedValueOnce({ id: AGENCY, tenantId: TENANT, status: 'active' })
    containerEmFindOneMock
      // CustomerUser lookup
      .mockResolvedValueOnce({ id: CUSTOMER_USER, tenantId: TENANT })
      // Existing AgencyMember already linked
      .mockResolvedValueOnce({ id: 'mem-existing', customerUserId: CUSTOMER_USER, agencyId: AGENCY })

    const res = await POST(
      makeRequest({
        agencyId: AGENCY,
        customerUserId: CUSTOMER_USER,
        email: 'admin@example.test',
        firstName: 'Adam',
        lastName: 'Min',
        roleSlug: 'partner_admin',
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, reused: true, agencyMemberId: 'mem-existing' })
    expect(containerEmCreateMock).not.toHaveBeenCalled()
    expect(containerEmFlushMock).not.toHaveBeenCalled()
  })
})
