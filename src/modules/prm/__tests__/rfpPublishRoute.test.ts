/**
 * Route-handler tests for `POST /api/prm/rfp/{id}/publish` — guards the
 * HTTP boundary against the regression that surfaced TC-PRM-T5-001 §9.1 #3
 * (zero-eligible publish returned 500/null instead of 409 `validation_failed`).
 *
 * The bug was caused by Next.js Turbopack splitting the service-side and
 * route-side chunks so each had its own copy of `PrmDomainError`. The
 * route-side `err instanceof PrmDomainError` then returned `false` for an
 * error thrown by the service-side class, and Next.js surfaced a bare 500.
 *
 * These tests assert the route returns the structured `{ ok: false, error:
 * { code, message } }` envelope with the right status whether the thrown
 * error is a real `PrmDomainError` (same-chunk) OR a sibling-chunk one
 * (correct `name` + structural shape, different prototype). The latter is
 * the case that reproduced the 500/null in production.
 */

const getAuthFromRequestMock = jest.fn()
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequestMock(...args),
}))

const rfpServicePublishMock = jest.fn()
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'rfpService') {
        return { publish: rfpServicePublishMock }
      }
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

// Mock summariseRfp via the shared parent-route module — the publish route
// re-imports it from `../../route`. Returning a stable shape lets the test
// assert the success-path body too.
jest.mock('../api/rfp/route', () => ({
  __esModule: true,
  summariseRfp: (rfp: { id: string; status: string }) => ({
    id: rfp.id,
    status: rfp.status,
  }),
}))

import { POST } from '../api/rfp/[id]/publish/route'
import { PRM_ERROR_CODES, PrmDomainError } from '../lib/errors'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const RFP_ID = '44444444-4444-4444-8444-444444444444'

function makeRequest(): Request {
  return new Request(`http://localhost:3000/api/prm/rfp/${RFP_ID}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

const ctx = { params: Promise.resolve({ id: RFP_ID }) }

beforeEach(() => {
  getAuthFromRequestMock.mockReset()
  rfpServicePublishMock.mockReset()
  getAuthFromRequestMock.mockResolvedValue({
    tenantId: TENANT,
    orgId: ORG,
    sub: USER,
  })
})

describe('POST /api/prm/rfp/{id}/publish — error envelope at the HTTP boundary', () => {
  it('returns 409 with `validation_failed` body when the service throws a real PrmDomainError (zero-eligible)', async () => {
    rfpServicePublishMock.mockRejectedValue(
      new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Cannot publish — zero eligible agencies match the eligibility filter',
        409,
        { broadcast_count: 0 },
      ),
    )
    const res = await POST(makeRequest(), ctx as any)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'validation_failed',
        message: expect.stringMatching(/zero eligible/i),
        details: { broadcast_count: 0 },
      },
    })
  })

  it('returns 409 with `validation_failed` body when the service throws a SIBLING-CHUNK PrmDomainError (regression for TC-PRM-T5-001 §9.1 #3)', async () => {
    // This is the exact failure mode the integration test surfaced:
    // a thrown error whose `name === "PrmDomainError"` and `code` / `status`
    // / `message` are correctly set, but whose prototype chain is a
    // different class instance (because Turbopack split the chunks).
    //
    // Before the `isPrmDomainError(err)` guard landed, the catch block's
    // `err instanceof PrmDomainError` returned `false` for this object and
    // the route fell through to `throw err`, which Next.js converted to a
    // bare 500 with `body=null`.
    class SiblingPrmDomainError extends Error {
      public readonly code: string
      public readonly status: number
      public readonly details?: Record<string, unknown>
      constructor(
        code: string,
        message: string,
        status: number,
        details?: Record<string, unknown>,
      ) {
        super(message)
        this.name = 'PrmDomainError'
        this.code = code
        this.status = status
        this.details = details
      }
    }
    const sibling = new SiblingPrmDomainError(
      'validation_failed',
      'Cannot publish — zero eligible agencies match the eligibility filter',
      409,
      { broadcast_count: 0 },
    )
    expect(sibling instanceof PrmDomainError).toBe(false) // sanity check the simulation
    rfpServicePublishMock.mockRejectedValue(sibling)

    const res = await POST(makeRequest(), ctx as any)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('validation_failed')
    expect(body.error?.message ?? '').toMatch(/zero eligible/i)
    expect(body.error?.details).toEqual({ broadcast_count: 0 })
  })

  it('returns 200 + summarised RFP on the happy path', async () => {
    rfpServicePublishMock.mockResolvedValue({
      rfp: { id: RFP_ID, status: 'published' },
      broadcastAgencyIds: ['agency-1', 'agency-2'],
    })
    const res = await POST(makeRequest(), ctx as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      id: RFP_ID,
      status: 'published',
      broadcastAgencyIds: ['agency-1', 'agency-2'],
      rfp: { id: RFP_ID, status: 'published' },
    })
  })

  it('returns 401 without auth', async () => {
    getAuthFromRequestMock.mockResolvedValue(null)
    const res = await POST(makeRequest(), ctx as any)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('returns 400 for an invalid UUID path param', async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'not-a-uuid' }) } as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('rethrows non-PrmDomainError surface errors so Next.js renders a structured 500', async () => {
    // Defence-in-depth: if the service throws something that genuinely
    // is NOT a PrmDomainError (e.g., a real DB failure), the route MUST
    // re-throw so the framework's error boundary handles it. The route
    // must NOT pretend a generic `Error` is a domain error.
    rfpServicePublishMock.mockRejectedValue(new Error('unrelated DB hiccup'))
    await expect(POST(makeRequest(), ctx as any)).rejects.toThrow('unrelated DB hiccup')
  })
})
