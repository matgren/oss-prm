/**
 * Route-handler test for `GET /api/prm/portal/library` cache write-side
 * (Spec #7 §3.4). Closes the architectural gap surfaced by the
 * post-mvp-beta-t3 audit: the 4 invalidator subscribers fire against
 * what was an unwritten cache.
 *
 * Asserts:
 *   - identical authenticated request twice → service called once (cache hit)
 *   - `MarketingLibraryPublishedInvalidator` clears via `prm:library` tag,
 *     next request re-queries
 *   - `AgencyTierChangeLibraryInvalidator` clears via the per-agency
 *     enumerated tier tag set, next request re-queries
 *   - separate cache keys per `agencyId`
 *   - response shape unchanged on miss and on hit
 *
 * Design notes:
 *   - `cache` is registered in DI as `'cache'` (per `@open-mercato/core/bootstrap`).
 *   - The in-memory test double mimics `@open-mercato/cache.deleteByTags` —
 *     exact-string-match against the tag set written via `set`.
 */

const requireCustomerAuthMock = jest.fn()
const requireCustomerFeatureMock = jest.fn()

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuth', () => ({
  requireCustomerAuth: (...args: unknown[]) => requireCustomerAuthMock(...args),
  requireCustomerFeature: (...args: unknown[]) => requireCustomerFeatureMock(...args),
}))

jest.mock(
  '@open-mercato/core/modules/customer_accounts/services/customerRbacService',
  () => ({ CustomerRbacService: class {} }),
  { virtual: true },
)

const containerStateRef: { current: ContainerState | null } = { current: null }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: <T,>(name: string): T => {
      const state = containerStateRef.current
      if (!state) throw new Error('container state not set')
      if (name === 'customerRbacService') return state.rbac as T
      if (name === 'agencyMemberService') return state.memberService as T
      if (name === 'em') return state.em as T
      if (name === 'marketingMaterialService') return state.materialService as T
      if (name === 'cache') return state.cache as T
      throw new Error(`Unexpected DI key: ${name}`)
    },
  })),
}))

import { GET } from '../api/portal/library/route'
import publishedHandle from '../subscribers/marketing-library-published-invalidator'
import tierChangedHandle from '../subscribers/agency-tier-change-library-invalidator'

type CacheEntry = { value: unknown; tags: string[] }

class InMemoryCache {
  store = new Map<string, CacheEntry>()
  getCalls = 0
  setCalls = 0
  deleteByTagsCalls: string[][] = []

  async get(key: string): Promise<unknown> {
    this.getCalls += 1
    const entry = this.store.get(key)
    return entry ? entry.value : null
  }

  async set(key: string, value: unknown, options?: { ttl?: number; tags?: string[] }): Promise<void> {
    this.setCalls += 1
    this.store.set(key, { value, tags: options?.tags ?? [] })
  }

  async deleteByTags(tags: string[]): Promise<number> {
    this.deleteByTagsCalls.push(tags)
    let removed = 0
    for (const [key, entry] of this.store.entries()) {
      if (entry.tags.some((t) => tags.includes(t))) {
        this.store.delete(key)
        removed += 1
      }
    }
    return removed
  }
}

type ContainerState = {
  rbac: unknown
  memberService: { findByCustomerUserId: jest.Mock }
  em: { findOne: jest.Mock }
  materialService: { listPublishedForViewer: jest.Mock }
  cache: InMemoryCache
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const AGENCY_A = 'agency-a'
const AGENCY_B = 'agency-b'

function makeRequest(query = ''): Request {
  const url = `http://localhost:3000/api/prm/portal/library${query ? `?${query}` : ''}`
  return new Request(url, { method: 'GET' })
}

function makeMaterial(id: string) {
  return {
    id,
    organizationId: ORG,
    title: `Material ${id}`,
    description: null,
    materialType: 'playbook',
    visibility: 'all_partners',
    minTier: null,
    minTierRank: null,
    topics: ['ai'],
    audiences: ['cmo'],
    primaryAttachmentId: 'att-1',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    unpublishedAt: null,
  }
}

function makeContainerState(opts: { agencyId: string; tier: string | null }): ContainerState {
  const cache = new InMemoryCache()
  const memberService = {
    findByCustomerUserId: jest.fn(async () => ({ agencyId: opts.agencyId, customerUserId: USER })),
  }
  const em = {
    findOne: jest.fn(async (_Ctor: any, where: any) => {
      if (where?.id === opts.agencyId) return { id: opts.agencyId, tier: opts.tier }
      return null
    }),
  }
  const materialService = {
    listPublishedForViewer: jest.fn(async (_scope: any, options: any) => {
      // Single-row response is enough; we care about call count, not shape.
      const items = [makeMaterial('m-1')]
      return {
        items: items.slice(options.offset, options.offset + options.limit),
        total: items.length,
      }
    }),
  }
  return { rbac: {}, memberService, em, materialService, cache }
}

beforeEach(() => {
  requireCustomerAuthMock.mockReset()
  requireCustomerFeatureMock.mockReset()
  requireCustomerAuthMock.mockResolvedValue({ tenantId: TENANT, orgId: ORG, sub: USER })
  requireCustomerFeatureMock.mockResolvedValue(undefined)
})

describe('GET /api/prm/portal/library — cache write-side (Spec #7 §3.4)', () => {
  it('serves the second identical request from cache (service called once)', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    containerStateRef.current = state

    const res1 = await GET(makeRequest('page=1&pageSize=50'))
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.ok).toBe(true)
    expect(body1.items).toHaveLength(1)
    expect(body1.totalPages).toBe(1)

    const res2 = await GET(makeRequest('page=1&pageSize=50'))
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2).toEqual(body1)

    // First request: 1 list call (page) + 1 list call (facets) = 2 calls.
    // Second request: 0 calls (cache hit).
    expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(2)
    expect(state.cache.setCalls).toBe(1)
    expect(state.cache.getCalls).toBe(2)
  })

  it('caches under the spec-declared tag set', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    containerStateRef.current = state

    await GET(makeRequest('page=1&pageSize=50'))

    expect(state.cache.store.size).toBe(1)
    const [entry] = state.cache.store.values()
    expect(entry.tags).toEqual([
      'prm:library',
      'prm:agency:agency-a:tier:ai_native',
    ])
  })

  it('MarketingLibraryPublishedInvalidator clears the cache → next request re-queries', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    containerStateRef.current = state

    await GET(makeRequest('page=1&pageSize=50'))
    expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(2)
    await GET(makeRequest('page=1&pageSize=50'))
    expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(2) // hit

    // Simulate the published invalidator running through the same DI cache.
    await publishedHandle(
      {
        material_id: 'm-2',
        organization_id: ORG,
        visibility: 'all_partners',
        min_tier: null,
        published_at: new Date().toISOString(),
      },
      {
        resolve: <T,>(name: string): T => {
          if (name === 'cache') return state.cache as T
          throw new Error(`unexpected ${name}`)
        },
      },
    )
    expect(state.cache.deleteByTagsCalls).toContainEqual(['prm:library'])

    await GET(makeRequest('page=1&pageSize=50'))
    // 2 more service calls (page + facets) — cache was cleared.
    expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(4)
  })

  it('AgencyTierChangeLibraryInvalidator clears the cache via enumerated tier tags → next request re-queries', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    containerStateRef.current = state

    await GET(makeRequest('page=1&pageSize=50'))
    expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(2)

    await tierChangedHandle(
      { agency_id: AGENCY_A, fromTier: 'ai_native', toTier: 'ai_native_expert' },
      {
        resolve: <T,>(name: string): T => {
          if (name === 'cache') return state.cache as T
          throw new Error(`unexpected ${name}`)
        },
      },
    )
    // The enumerated tag set MUST include the tag the route wrote
    // (`prm:agency:agency-a:tier:ai_native`).
    const tags = state.cache.deleteByTagsCalls[0]
    expect(tags).toContain('prm:agency:agency-a:tier:ai_native')
    expect(tags).toContain('prm:agency:agency-a:tier:ai_native_expert')
    expect(state.cache.store.size).toBe(0)

    await GET(makeRequest('page=1&pageSize=50'))
    expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(4) // re-queried
  })

  it('writes a separate cache entry per agencyId', async () => {
    const stateA = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    containerStateRef.current = stateA
    await GET(makeRequest('page=1&pageSize=50'))
    expect(stateA.cache.store.size).toBe(1)

    const stateB = makeContainerState({ agencyId: AGENCY_B, tier: 'ai_native' })
    containerStateRef.current = stateB
    await GET(makeRequest('page=1&pageSize=50'))
    expect(stateB.cache.store.size).toBe(1)

    // Keys differ — assert by inspecting key strings since each container
    // owns its own InMemoryCache (we can't share state cleanly across
    // requests in this test setup, but the per-agency key derivation is
    // already covered by `libraryCacheHelpers.test.ts`). Here we just assert
    // that each agency's request produced a write — there is no cross-agency
    // bleed at the cache layer.
    const [[keyA]] = [[...stateA.cache.store.keys()]]
    const [[keyB]] = [[...stateB.cache.store.keys()]]
    expect(keyA).not.toEqual(keyB)
    expect(keyA).toContain(AGENCY_A)
    expect(keyB).toContain(AGENCY_B)
  })

  it('soft-fails when cache.get throws — falls through to DB', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    state.cache.get = jest.fn(async () => {
      throw new Error('boom')
    }) as any
    containerStateRef.current = state

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await GET(makeRequest('page=1&pageSize=50'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(state.materialService.listPublishedForViewer).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not cache the empty-no-member response', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    state.memberService.findByCustomerUserId = jest.fn(async () => null)
    containerStateRef.current = state

    const res = await GET(makeRequest('page=1&pageSize=50'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([])
    expect(state.cache.setCalls).toBe(0)
  })

  it('returns 400 on invalid query params without touching cache', async () => {
    const state = makeContainerState({ agencyId: AGENCY_A, tier: 'ai_native' })
    containerStateRef.current = state

    const res = await GET(makeRequest('page=not-a-number'))
    expect(res.status).toBe(400)
    expect(state.cache.setCalls).toBe(0)
    expect(state.cache.getCalls).toBe(0)
  })
})
