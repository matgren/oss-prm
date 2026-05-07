/**
 * Tests for `POST /api/prm/test-fixtures/reset` — the test-only PRM TRUNCATE
 * seam used by Playwright integration specs to wipe the PRM slice between
 * tests so cross-spec Agency leaks don't inflate the §9.1 #1 broadcast set.
 *
 * Covers:
 *  - Disabled by default — returns 404 without `OM_PRM_TEST_FIXTURES_ENABLED=1`,
 *    byte-identical to a non-existent route. Production attack-surface gate.
 *  - Enabled gate without auth → 401.
 *  - Enabled gate with staff auth → 200 + executes a TRUNCATE statement
 *    containing every PRM-owned table from `data/entities.ts`. Non-PRM tables
 *    (organizations, customer_users, etc.) are NOT in the statement.
 *  - The auth gate does not run when fixtures are disabled (no probe leak).
 */

const getAuthFromRequestMock = jest.fn()
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequestMock(...args),
}))

const knexRawMock = jest.fn(async () => undefined)
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') {
        return {
          getKnex: () => ({ raw: knexRawMock }),
        }
      }
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

import { POST } from '../api/test-fixtures/reset/route'

const TENANT = 'tenant-1'
const ORG = 'org-1'

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/prm/test-fixtures/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  getAuthFromRequestMock.mockReset()
  knexRawMock.mockReset()
  knexRawMock.mockResolvedValue(undefined)
  delete process.env.OM_PRM_TEST_FIXTURES_ENABLED
})

afterAll(() => {
  delete process.env.OM_PRM_TEST_FIXTURES_ENABLED
})

describe('POST /api/prm/test-fixtures/reset', () => {
  it('returns 404 when fixtures are disabled (no env opt-in)', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ ok: false, error: 'Not found' })
    // Auth is intentionally NOT checked when disabled — the gate must look
    // identical to a missing route (no auth probe, no leak).
    expect(getAuthFromRequestMock).not.toHaveBeenCalled()
    expect(knexRawMock).not.toHaveBeenCalled()
  })

  it('returns 401 when fixtures enabled but unauthenticated', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue(null)
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(knexRawMock).not.toHaveBeenCalled()
  })

  it('returns 401 when auth resolves but is missing tenant/org', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ sub: 'staff-1' })
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(knexRawMock).not.toHaveBeenCalled()
  })

  it('TRUNCATEs every PRM-owned table on success and reports them in the response', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Single TRUNCATE call.
    expect(knexRawMock).toHaveBeenCalledTimes(1)
    const sql = knexRawMock.mock.calls[0]![0] as string
    expect(sql).toMatch(/^TRUNCATE TABLE /i)
    expect(sql).toMatch(/RESTART IDENTITY CASCADE$/i)

    // Every PRM table from data/entities.ts must appear. If a future entity is
    // added and forgotten here, this test fails loudly.
    const expectedTables = [
      'prm_agencies',
      'prm_agency_members',
      'prm_prospects',
      'prm_prospect_candidate_index',
      'prm_license_deals',
      'prm_rfps',
      'prm_rfp_broadcasts',
      'prm_rfp_responses',
      'prm_rfp_response_scores',
      'prm_wic_contributions',
      'prm_wic_import_audit_log',
      'prm_case_studies',
      'prm_marketing_materials',
      'prm_service_idempotency_key',
    ]
    for (const t of expectedTables) {
      expect(sql).toContain(t)
    }
    expect(body.truncatedTables).toEqual(expect.arrayContaining(expectedTables))
    expect(body.truncatedTables.length).toBe(expectedTables.length)
  })

  it('does NOT TRUNCATE any non-PRM tables', async () => {
    process.env.OM_PRM_TEST_FIXTURES_ENABLED = '1'
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'staff-1' })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    const sql = knexRawMock.mock.calls[0]![0] as string
    // Spot-check the most load-bearing non-PRM tables. The seam must never
    // touch organisation / customer / staff tables — those are seeded once
    // per ephemeral run and the suite depends on that state surviving.
    const forbidden = [
      'organizations',
      'customer_users',
      'customer_user_invitations',
      'customer_roles',
      'customer_user_roles',
      'auth_users',
      'auth_roles',
      'tenants',
    ]
    for (const t of forbidden) {
      // Match table name as a whole word so `customer_users` doesn't trip on
      // a hypothetical `prm_customer_users_x` (it doesn't exist today, but
      // future-proofs the assertion).
      expect(sql).not.toMatch(new RegExp(`(^|[\\s,])${t}([\\s,]|$)`))
    }
  })
})
