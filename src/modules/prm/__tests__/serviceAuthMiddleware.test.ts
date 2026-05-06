import {
  authenticateServiceRequest,
  hashPayload,
} from '../lib/serviceAuthMiddleware'
import { ServiceIdempotencyKey } from '../data/entities'

const SECRET = 'test-secret-1234567890'
const NEXT_SECRET = 'rotation-overlap-secret-9999'
const VALID_KEY = '7e2c1c88-21d9-4f2b-87b1-02a0ff7b2dd8'
const NOW_ISO = '2026-04-23T10:00:00Z'
const FIXED_NOW = new Date(NOW_ISO)
const TENANT = '11111111-1111-1111-1111-111111111111'
const ORG = '22222222-2222-2222-2222-222222222222'
const ENDPOINT = 'POST /api/prm/service/wic/imports'

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function buildRequest({
  method = 'POST',
  headers = {},
  body = '',
}: {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}): Request {
  return new Request(`https://test.local/api/prm/service/wic/imports/${VALID_KEY}`, {
    method,
    headers: new Headers(headers),
    body: method === 'POST' ? body : undefined,
  })
}

class FakeEm {
  public stored: Array<Partial<ServiceIdempotencyKey>> = []
  async findOne(_cls: unknown, where: { endpoint: string; idempotencyKey: string }) {
    return (
      this.stored.find(
        (row) => row.endpoint === where.endpoint && row.idempotencyKey === where.idempotencyKey,
      ) ?? null
    )
  }
  create(_cls: unknown, data: Partial<ServiceIdempotencyKey>) {
    return data
  }
  persist(row: Partial<ServiceIdempotencyKey>) {
    this.stored.push(row)
    return this
  }
  async flush() {
    /* no-op */
  }
}

describe('ServiceAuthMiddleware (Spec #4 §3.1)', () => {
  const baseEnv = { ...process.env }

  beforeEach(() => {
    setEnv({
      OM_PRM_WIC_IMPORT_SECRET: SECRET,
      OM_PRM_WIC_IMPORT_SECRET_NEXT: undefined,
      OM_PRM_WIC_TENANT_ID: TENANT,
      OM_PRM_WIC_ORG_ID: ORG,
    })
  })

  afterAll(() => {
    process.env = baseEnv
  })

  it('returns 401 when X-Om-Import-Secret is missing', async () => {
    const req = buildRequest({
      method: 'GET',
      headers: { 'x-om-request-timestamp': NOW_ISO },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(401)
  })

  it('returns 401 when X-Om-Import-Secret is wrong', async () => {
    const req = buildRequest({
      method: 'GET',
      headers: {
        'x-om-import-secret': 'wrong',
        'x-om-request-timestamp': NOW_ISO,
      },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(401)
  })

  it('accepts the rotation-overlap secret (NEXT)', async () => {
    setEnv({ OM_PRM_WIC_IMPORT_SECRET_NEXT: NEXT_SECRET })
    const req = buildRequest({
      method: 'GET',
      headers: {
        'x-om-import-secret': NEXT_SECRET,
        'x-om-request-timestamp': NOW_ISO,
      },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`)
    expect(result.identity.clientId).toBe('n8n-wic')
  })

  it('returns 503 when neither secret env is set', async () => {
    setEnv({ OM_PRM_WIC_IMPORT_SECRET: undefined, OM_PRM_WIC_IMPORT_SECRET_NEXT: undefined })
    const req = buildRequest({
      method: 'GET',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
      },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(503)
  })

  it('returns 400 when X-Om-Request-Timestamp is missing', async () => {
    const req = buildRequest({
      method: 'GET',
      headers: { 'x-om-import-secret': SECRET },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(400)
  })

  it('returns 408 when X-Om-Request-Timestamp is outside the ±5min window', async () => {
    const tenMinAgo = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000).toISOString()
    const req = buildRequest({
      method: 'GET',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': tenMinAgo,
      },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(408)
  })

  it('GET ignores X-Om-Idempotency-Key', async () => {
    const req = buildRequest({
      method: 'GET',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        // Intentionally absent → must still pass on GET
      },
    })
    const result = await authenticateServiceRequest(req, { endpoint: ENDPOINT, now: () => FIXED_NOW })
    if (!result.ok) throw new Error(`expected ok on GET, got ${result.response.status}`)
    expect(result.identity.idempotencyKey).toBeNull()
    expect(result.persistIdempotency).toBeNull()
  })

  it('POST without X-Om-Idempotency-Key returns 400', async () => {
    const em = new FakeEm()
    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
      },
      body: '{}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{}',
      now: () => FIXED_NOW,
    })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(400)
  })

  it('POST with malformed UUID returns 400', async () => {
    const em = new FakeEm()
    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        'x-om-idempotency-key': 'not-a-uuid',
      },
      body: '{}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{}',
      now: () => FIXED_NOW,
    })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(400)
  })

  it('POST happy path returns identity + persistIdempotency callback', async () => {
    const em = new FakeEm()
    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        'x-om-idempotency-key': VALID_KEY,
      },
      body: '{"x":1}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{"x":1}',
      now: () => FIXED_NOW,
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`)
    expect(result.identity.idempotencyKey).toBe(VALID_KEY)
    expect(typeof result.persistIdempotency).toBe('function')
  })

  it('POST replay with same key + same payload returns cached response with Idempotent-Replay header', async () => {
    const em = new FakeEm()
    em.stored.push({
      endpoint: ENDPOINT,
      idempotencyKey: VALID_KEY,
      payloadHash: hashPayload('{"x":1}'),
      responseStatus: 200,
      responseBody: { import_batch_id: 'cached-batch', accepted_count: 5 },
    } as any)

    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        'x-om-idempotency-key': VALID_KEY,
      },
      body: '{"x":1}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{"x":1}',
      now: () => FIXED_NOW,
    })
    if (result.ok) throw new Error('expected replay (returned via response, not ok=true)')
    expect(result.response.status).toBe(200)
    expect(result.response.headers.get('Idempotent-Replay')).toBe('true')
    const body = await result.response.json()
    expect(body).toMatchObject({ import_batch_id: 'cached-batch', accepted_count: 5 })
  })

  it('POST replay with same key + different payload returns 409', async () => {
    const em = new FakeEm()
    em.stored.push({
      endpoint: ENDPOINT,
      idempotencyKey: VALID_KEY,
      payloadHash: hashPayload('{"x":1}'),
      responseStatus: 200,
      responseBody: { import_batch_id: 'cached-batch' },
    } as any)

    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        'x-om-idempotency-key': VALID_KEY,
      },
      body: '{"x":2}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{"x":2}',
      now: () => FIXED_NOW,
    })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(409)
  })

  it('POST returns 503 when tenant env vars are absent', async () => {
    setEnv({ OM_PRM_WIC_TENANT_ID: undefined, OM_PRM_WIC_ORG_ID: undefined })
    const em = new FakeEm()
    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        'x-om-idempotency-key': VALID_KEY,
      },
      body: '{}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{}',
      now: () => FIXED_NOW,
    })
    if (result.ok) throw new Error('expected error')
    expect(result.response.status).toBe(503)
  })

  it('persistIdempotency stores the response for later replay', async () => {
    const em = new FakeEm()
    const req = buildRequest({
      method: 'POST',
      headers: {
        'x-om-import-secret': SECRET,
        'x-om-request-timestamp': NOW_ISO,
        'x-om-idempotency-key': VALID_KEY,
      },
      body: '{"x":1}',
    })
    const result = await authenticateServiceRequest(req, {
      endpoint: ENDPOINT,
      em: em as any,
      bodyText: '{"x":1}',
      now: () => FIXED_NOW,
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`)
    await result.persistIdempotency!({
      em: em as any,
      responseStatus: 200,
      responseBody: { import_batch_id: 'fresh-batch', accepted_count: 3 },
    })
    expect(em.stored.length).toBe(1)
    expect(em.stored[0]?.responseStatus).toBe(200)
    expect(em.stored[0]?.responseBody).toMatchObject({ accepted_count: 3 })
    expect(em.stored[0]?.tenantId).toBe(TENANT)
  })
})
