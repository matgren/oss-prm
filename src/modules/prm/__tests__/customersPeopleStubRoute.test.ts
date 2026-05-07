/**
 * Tests for `GET /api/customers/people` — the PRM-owned stub of the customers
 * people-list endpoint that exists solely to satisfy the @open-mercato/cli
 * `mercato test:integration` readiness probe.
 *
 * Probe contract under test (verbatim from
 * `node_modules/@open-mercato/cli/src/lib/testing/integration.ts`,
 * function `probeAuthenticatedApi`):
 *
 *   const apiResponse = await fetch(`${baseUrl}/api/customers/people?pageSize=1`, {
 *     headers: { Authorization: `Bearer ${token}` },
 *   })
 *   const healthy = apiResponse.status === 200
 *
 * The probe inspects ONLY the status code. We additionally assert the
 * response body shape mirrors the @open-mercato/shared CRUD-factory list
 * envelope (`{ items, total, page, pageSize, totalPages }`) so any
 * non-probe consumer that reads the body sees a well-formed empty page.
 */

const getAuthFromRequestMock = jest.fn()
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequestMock(...args),
}))

import { GET } from '../api/customers/people/route'

const TENANT = 'tenant-1'
const ORG = 'org-1'

function makeRequest(query: string = ''): Request {
  return new Request(`http://localhost:3000/api/customers/people${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  })
}

beforeEach(() => {
  getAuthFromRequestMock.mockReset()
})

describe('GET /api/customers/people (integration-test readiness stub)', () => {
  it('returns HTTP 200 for the canonical probe URL `?pageSize=1`', async () => {
    // This is the EXACT URL shape the probe uses. If this assertion ever fails,
    // `mercato test:integration` will not reach ready state.
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'admin-user' })

    const res = await GET(makeRequest('?pageSize=1'))

    expect(res.status).toBe(200)
  })

  it('returns the CRUD-factory paged-list envelope for the canonical probe URL', async () => {
    // Defence: even though the probe ignores the body, mirror the shape so any
    // downstream consumer that reads the body sees a well-formed empty page.
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'admin-user' })

    const res = await GET(makeRequest('?pageSize=1'))
    const body = await res.json()

    expect(body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 1,
      totalPages: 0,
    })
  })

  it('falls back to default page=1 / pageSize=50 when query string is empty', async () => {
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'admin-user' })

    const res = await GET(makeRequest(''))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    })
  })

  it('still returns 200 with normalised defaults when query is malformed', async () => {
    // Stub contract: never 4xx on auth-valid requests. Bad query must degrade
    // gracefully into the empty-page response so the probe does not flake.
    getAuthFromRequestMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: 'admin-user' })

    const res = await GET(makeRequest('?pageSize=not-a-number&page=-7'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    })
  })

  it('returns 401 when getAuthFromRequest yields null', async () => {
    // Defence-in-depth: framework catch-all should run requireAuth BEFORE this
    // handler is invoked, but direct unit-test invocation must still 401 rather
    // than fabricate a 200 for an unauthenticated request.
    getAuthFromRequestMock.mockResolvedValue(null)

    const res = await GET(makeRequest('?pageSize=1'))

    expect(res.status).toBe(401)
  })

  it('respects `requireAuth: true` declarative metadata', async () => {
    // Metadata is what the framework reads at route-registration time. Keep
    // this test so any accidental drop of the gate fails CI loudly.
    const { metadata } = await import('../api/customers/people/route')
    expect(metadata).toEqual({ GET: { requireAuth: true } })
  })

  it('exports an OpenAPI doc for the GET method', async () => {
    // AGENTS.md: every API route MUST export an `openApi` object.
    const { openApi } = await import('../api/customers/people/route')
    expect(openApi).toBeDefined()
    expect(openApi.methods.GET).toBeDefined()
    expect(openApi.methods.GET?.summary).toMatch(/stub/i)
  })
})
