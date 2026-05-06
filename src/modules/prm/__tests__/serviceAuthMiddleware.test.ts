import {
  _resetServiceAuthSingletonCache,
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

type FakeAgencyRow = {
  id: string
  tenantId: string
  organizationId: string
  deletedAt: Date | null
  createdAt: Date
}

class FakeEm {
  public stored: Array<Partial<ServiceIdempotencyKey>> = []
  /**
   * Optional Agency rows used by the singleton-tenant fallback path. Tests that exercise
   * the fallback (env unset) seed this; tests that pin env to TENANT/ORG can ignore it.
   */
  public agencies: FakeAgencyRow[] = []
  async findOne(
    cls: unknown,
    where: Partial<ServiceIdempotencyKey> & { tenantId?: string },
  ) {
    const name = (cls as { name?: string })?.name
    if (name === 'ServiceIdempotencyKey') {
      return (
        this.stored.find(
          (row) =>
            row.endpoint === where.endpoint &&
            row.idempotencyKey === where.idempotencyKey &&
            (where.tenantId === undefined || row.tenantId === where.tenantId),
        ) ?? null
      )
    }
    return null
  }
  async find(cls: unknown, _where: unknown, opts?: { limit?: number }) {
    const name = (cls as { name?: string })?.name
    if (name === 'Agency') {
      const sorted = [...this.agencies].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )
      const limited = opts?.limit ? sorted.slice(0, opts.limit) : sorted
      return limited
    }
    return []
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
  /**
   * Forked EM shares the parent's `stored` array so test assertions can read what the
   * forked persist wrote. In production code the fork has its own UoW; for unit tests
   * we collapse that distinction since we do not need to test MikroORM's transaction
   * scoping (only our use of `fork()` to insulate the parent from idempotency-key
   * UNIQUE collisions). Tests that need to observe a flush failure swap the fork's
   * `flush` for a throwing stub.
   */
  fork(_opts?: unknown): FakeEm {
    const child = new FakeEm()
    child.stored = this.stored
    child.agencies = this.agencies
    return child
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
    _resetServiceAuthSingletonCache()
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
      tenantId: TENANT,
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
      tenantId: TENANT,
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

  it('POST refuses with 503 when env unset and multiple PRM Agencies span tenants (fail-closed singleton fallback)', async () => {
    setEnv({ OM_PRM_WIC_TENANT_ID: undefined, OM_PRM_WIC_ORG_ID: undefined })
    const em = new FakeEm()
    em.agencies.push({
      id: 'agency-1',
      tenantId: TENANT,
      organizationId: ORG,
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    em.agencies.push({
      id: 'agency-2',
      tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      organizationId: 'ffffffff-9999-8888-7777-666666666666',
      deletedAt: null,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    })
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
    const body = await result.response.json()
    expect(body.error).toMatch(/ambiguous/i)
  })

  it('POST accepts multi-Agency same-tenant fallback (each Agency has its own paired Organization)', async () => {
    // Regression: prior to the tenant-only ambiguity check, the resolver fail-closed
    // whenever 2+ Agencies in the SAME tenant had different `organizationId`s — but
    // every Agency in PRM creates its own paired Organization via
    // `agencyService.createAgencyWithOrganization`, so a tenant with N Agencies has
    // N+ Organizations. WIC ingestion is per-tenant; multi-org within the same
    // tenant must resolve to a singleton tenant context (organizationId pinned to
    // the first Agency's Organization for backwards compat with the cache shape).
    setEnv({ OM_PRM_WIC_TENANT_ID: undefined, OM_PRM_WIC_ORG_ID: undefined })
    const em = new FakeEm()
    em.agencies.push({
      id: 'agency-1',
      tenantId: TENANT,
      organizationId: ORG,
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    em.agencies.push({
      id: 'agency-2',
      tenantId: TENANT,
      organizationId: 'ffffffff-9999-8888-7777-666666666666',
      deletedAt: null,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    })
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
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`)
    expect(result.identity.tenantId).toBe(TENANT)
    // organizationId is pinned to the first (oldest) Agency's Organization.
    expect(result.identity.organizationId).toBe(ORG)
  })

  it('POST falls back to the lone PRM Agency when env unset and only one tenant exists', async () => {
    setEnv({ OM_PRM_WIC_TENANT_ID: undefined, OM_PRM_WIC_ORG_ID: undefined })
    const em = new FakeEm()
    em.agencies.push({
      id: 'agency-1',
      tenantId: TENANT,
      organizationId: ORG,
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
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
    if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`)
    expect(result.identity.tenantId).toBe(TENANT)
    expect(result.identity.organizationId).toBe(ORG)
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

  it('persistIdempotency runs on a forked EM (UNIQUE collision swallowed; non-collision errors surface)', async () => {
    // Set up an EM whose fork() throws on flush. We assert two things:
    //   (a) UNIQUE-PK collision (modeled by an isUniqueViolation-shaped error) is logged
    //       + swallowed — caller sees no exception, but no row is recorded as ours.
    //   (b) Any OTHER error (e.g. connection drop) re-throws so operators can observe it.
    const buildEmWithFlushError = (err: unknown) => {
      const em = new FakeEm()
      const realFork = em.fork.bind(em)
      em.fork = (opts?: unknown) => {
        const child = realFork(opts)
        child.flush = async () => {
          throw err
        }
        return child
      }
      return em
    }

    const buildAuthForEm = async (em: FakeEm) => {
      const req = buildRequest({
        method: 'POST',
        headers: {
          'x-om-import-secret': SECRET,
          'x-om-request-timestamp': NOW_ISO,
          'x-om-idempotency-key': VALID_KEY,
        },
        body: '{"y":2}',
      })
      const result = await authenticateServiceRequest(req, {
        endpoint: ENDPOINT,
        em: em as any,
        bodyText: '{"y":2}',
        now: () => FIXED_NOW,
      })
      if (!result.ok) throw new Error(`expected ok, got ${result.response.status}`)
      return result
    }

    // (a) UNIQUE-PK collision is swallowed.
    const uniqueError: any = new Error('duplicate key value violates unique constraint')
    uniqueError.code = '23505'
    const emCollision = buildEmWithFlushError(uniqueError)
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const auth = await buildAuthForEm(emCollision)
      await auth.persistIdempotency!({
        em: emCollision as any,
        responseStatus: 200,
        responseBody: { import_batch_id: 'collision', accepted_count: 1 },
      })
      // The forked flush threw, so the row was never committed.
      // No assertion on stored.length (FakeEm appends synchronously in persist before
      // flush throws). The key invariant is that the parent EM did not throw.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('idempotency PK collision'),
      )
    } finally {
      warnSpy.mockRestore()
    }

    // (b) Other errors bubble up.
    _resetServiceAuthSingletonCache()
    const emCrash = buildEmWithFlushError(new Error('connection refused'))
    const auth = await buildAuthForEm(emCrash)
    await expect(
      auth.persistIdempotency!({
        em: emCrash as any,
        responseStatus: 200,
        responseBody: { import_batch_id: 'crash', accepted_count: 1 },
      }),
    ).rejects.toThrow('connection refused')
  })
})
