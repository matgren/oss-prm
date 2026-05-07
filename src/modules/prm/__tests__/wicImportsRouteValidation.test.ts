/**
 * Spec #4 jest coverage for the POST imports HTTP route's pre-business
 * validation gates (route layer, not service or middleware).
 *
 * Complements:
 *   - serviceAuthMiddleware.test.ts — covers all auth + idempotency paths
 *   - wicImportService.test.ts — covers the per-row ACL pipeline
 *   - TC-PRM-T3-001 (Playwright) — covers T1/T3/T7/T8 happy + auth paths
 *
 * Adds: invalid batch_id → 400, non-JSON body → 400, envelope-shape Zod
 * failure → 422. These run before `processWicBatch`, so we can stub the
 * service helpers to assert short-circuit behaviour.
 */

const authenticateMock = jest.fn()
const processWicBatchMock = jest.fn()

jest.mock('../lib/serviceAuthMiddleware', () => {
  const actual = jest.requireActual('../lib/serviceAuthMiddleware')
  return {
    ...actual,
    authenticateServiceRequest: (...args: unknown[]) => authenticateMock(...args),
  }
})

jest.mock('../lib/wicImportService', () => {
  const actual = jest.requireActual('../lib/wicImportService')
  return {
    ...actual,
    processWicBatch: (...args: unknown[]) => processWicBatchMock(...args),
  }
})

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') return {}
      throw new Error(`Unexpected DI key: ${key}`)
    },
  })),
}))

const VALID_BATCH = '6b4f0cd8-9b7a-4a40-87f6-6c1e2a9d4e10'
const VALID_KEY = '7e2c1c88-21d9-4f2b-87b1-02a0ff7b2dd8'

beforeEach(() => {
  authenticateMock.mockReset()
  processWicBatchMock.mockReset()
  // Default: auth middleware succeeds.
  authenticateMock.mockResolvedValue({
    ok: true,
    identity: {
      clientId: 'n8n-wic',
      requestId: 'svc-abc',
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      idempotencyKey: VALID_KEY,
    },
    persistIdempotency: jest.fn(async () => undefined),
  })
})

async function loadHandler() {
  const mod = await import('../api/service/wic/imports/[batchId]/route')
  return mod.POST
}

function makeReq(batchId: string, body: string | object) {
  return new Request(`http://test.local/api/prm/service/wic/imports/${batchId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Om-Import-Secret': 'unit-test',
      'X-Om-Request-Timestamp': '2026-04-23T10:00:00Z',
      'X-Om-Idempotency-Key': VALID_KEY,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/prm/service/wic/imports/[batchId] — validation gates', () => {
  it('rejects a non-UUID batch_id with 400 before auth runs', async () => {
    const POST = await loadHandler()
    const res = await POST(makeReq('not-a-uuid', { script_version: 'x', month: '2026-03', rows: [] }), {
      params: { batchId: 'not-a-uuid' },
    })
    expect(res.status).toBe(400)
    expect(authenticateMock).not.toHaveBeenCalled()
    expect(processWicBatchMock).not.toHaveBeenCalled()
  })

  it('returns 400 on non-JSON body (after auth, before envelope Zod)', async () => {
    const POST = await loadHandler()
    const res = await POST(makeReq(VALID_BATCH, 'this is not json'), {
      params: { batchId: VALID_BATCH },
    })
    expect(res.status).toBe(400)
    expect(processWicBatchMock).not.toHaveBeenCalled()
  })

  it('returns 422 on envelope-level Zod failure (bad month)', async () => {
    const POST = await loadHandler()
    const res = await POST(
      makeReq(VALID_BATCH, { script_version: '1.0', month: 'not-a-month', rows: [] }),
      { params: { batchId: VALID_BATCH } },
    )
    expect(res.status).toBe(422)
    expect(processWicBatchMock).not.toHaveBeenCalled()
  })

  it('returns 422 when rows is not an array', async () => {
    const POST = await loadHandler()
    const res = await POST(
      makeReq(VALID_BATCH, { script_version: '1.0', month: '2026-03', rows: 'oops' }),
      { params: { batchId: VALID_BATCH } },
    )
    expect(res.status).toBe(422)
  })

  it('forwards auth failures without invoking processWicBatch', async () => {
    authenticateMock.mockResolvedValueOnce({
      ok: false,
      response: new Response('{"ok":false,"error":"bad secret"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
    const POST = await loadHandler()
    const res = await POST(
      makeReq(VALID_BATCH, { script_version: '1.0', month: '2026-03', rows: [] }),
      { params: { batchId: VALID_BATCH } },
    )
    expect(res.status).toBe(401)
    expect(processWicBatchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when middleware succeeds but tenant context is unresolved', async () => {
    authenticateMock.mockResolvedValueOnce({
      ok: true,
      identity: {
        clientId: 'n8n-wic',
        requestId: 'svc-abc',
        tenantId: null,
        organizationId: null,
      },
      persistIdempotency: jest.fn(),
    })
    const POST = await loadHandler()
    const res = await POST(
      makeReq(VALID_BATCH, { script_version: '1.0', month: '2026-03', rows: [] }),
      { params: { batchId: VALID_BATCH } },
    )
    expect(res.status).toBe(503)
    expect(processWicBatchMock).not.toHaveBeenCalled()
  })
})
