import publishedHandle from '../subscribers/marketing-library-published-invalidator'
import unpublishedHandle from '../subscribers/marketing-library-unpublished-invalidator'
import updatedHandle from '../subscribers/marketing-library-updated-invalidator'
import tierChangedHandle from '../subscribers/agency-tier-change-library-invalidator'

type CalledTags = string[][]

function makeCache(calls: CalledTags) {
  return {
    deleteByTags: jest.fn(async (tags: string[]) => {
      calls.push(tags)
    }),
  }
}

function makeCtx(cache: any, em?: any): { resolve: <T = unknown>(name: string) => T } {
  return {
    resolve: <T = unknown>(name: string): T => {
      if (name === 'cache') return cache as T
      if (name === 'em') return em as T
      throw new Error(`unexpected resolve("${name}")`)
    },
  }
}

describe('Cache invalidator subscribers (Spec #7 §4.3 / OQ-019)', () => {
  it('published → cache.deleteByTags(["prm:library"])', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    await publishedHandle(
      {
        material_id: 'm-1',
        organization_id: 'o-1',
        min_tier: null,
        published_at: new Date().toISOString(),
      },
      makeCtx(cache),
    )
    expect(calls).toEqual([['prm:library']])
  })

  it('unpublished → cache.deleteByTags(["prm:library"])', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    await unpublishedHandle(
      {
        material_id: 'm-1',
        organization_id: 'o-1',
        unpublished_at: new Date().toISOString(),
        unpublished_by_user_id: 'u-1',
      },
      makeCtx(cache),
    )
    expect(calls).toEqual([['prm:library']])
  })

  it('updated invalidates cache only when material is currently published', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    const em = {
      findOne: jest.fn(async (_Ctor: any, _where: any) => ({
        id: 'm-1',
        organizationId: 'o-1',
        publishedAt: new Date(),
        unpublishedAt: null,
      })),
    }
    await updatedHandle(
      {
        material_id: 'm-1',
        organization_id: 'o-1',
        material_type: 'playbook',
        min_tier: null,
        allowed_roles: [],
      },
      makeCtx(cache, em),
    )
    expect(calls).toEqual([['prm:library']])
  })

  it('updated is a no-op for draft / unpublished material', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    const em = {
      findOne: jest.fn(async () => ({
        id: 'm-1',
        organizationId: 'o-1',
        publishedAt: null,
        unpublishedAt: null,
      })),
    }
    await updatedHandle(
      {
        material_id: 'm-1',
        organization_id: 'o-1',
        material_type: 'playbook',
        min_tier: null,
        allowed_roles: [],
      },
      makeCtx(cache, em),
    )
    expect(calls).toEqual([])
  })

  it('agency.tier_changed invalidates the enumerated per-Agency tier tag set (cache.deleteByTags has no wildcards)', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    await tierChangedHandle(
      { agency_id: 'agency-A', fromTier: 'om_agency', toTier: 'ai_native' },
      makeCtx(cache),
    )
    // Tag scheme MUST match what `api/portal/library/route.ts` writes; the
    // helper `allAgencyTierTags` is the single source of truth.
    expect(calls).toEqual([
      [
        'prm:agency:agency-A:tier:om_agency',
        'prm:agency:agency-A:tier:ai_native',
        'prm:agency:agency-A:tier:ai_native_expert',
        'prm:agency:agency-A:tier:ai_native_core',
        'prm:agency:agency-A:tier:null',
      ],
    ])
  })

  it('agency.tier_changed throws loudly when payload misses agency_id (non-prod)', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    // jest defaults NODE_ENV='test' which the subscriber treats as non-production.
    await expect(
      tierChangedHandle({ fromTier: 'om_agency', toTier: 'ai_native' }, makeCtx(cache)),
    ).rejects.toThrow(/missing agency_id/)
    expect(calls).toEqual([])
  })

  it('agency.tier_changed silently no-ops in production when payload misses agency_id', async () => {
    const calls: CalledTags = []
    const cache = makeCache(calls)
    const prev = process.env.NODE_ENV
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
    try {
      await expect(
        tierChangedHandle({ fromTier: 'om_agency', toTier: 'ai_native' }, makeCtx(cache)),
      ).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
    }
    expect(calls).toEqual([])
  })

  it('handles missing cache gracefully (DI not yet bound)', async () => {
    const ctx = {
      resolve: <T,>(name: string): T => {
        if (name === 'cache') throw new Error('cache not registered')
        throw new Error(`unexpected resolve("${name}")`)
      },
    }
    await expect(
      publishedHandle(
        {
          material_id: 'm-1',
          organization_id: 'o-1',
          min_tier: null,
          published_at: new Date().toISOString(),
        },
        ctx,
      ),
    ).resolves.toBeUndefined()
  })
})
