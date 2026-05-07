import createdHandle from '../subscribers/agency-cache-on-created'
import tierChangedHandle from '../subscribers/agency-cache-on-tier-changed'
import statusChangedHandle from '../subscribers/agency-cache-on-status-changed'
import onboardingChangedHandle from '../subscribers/agency-cache-on-onboarding-state-changed'
import deletedHandle from '../subscribers/agency-cache-on-deleted'

/**
 * Unit tests for the five Agency cache invalidator subscribers wired in this
 * POST-MVP follow-up. Mirrors the existing `marketingLibraryInvalidators.test.ts`
 * test shape (jest + in-memory mocks for cache + DI).
 *
 * Cache tag matrix (from SPEC-2026-04-23-agency-foundation.md §3.1.2-§3.1.4 +
 * §3.2.1):
 *
 *   prm.agency.created                    → ['prm:agency:list:tenant:{T}']
 *   prm.agency.tier_changed               → ['prm:agency:list:tenant:{T}', 'prm:agency:{A}']
 *   prm.agency.status_changed             → ['prm:agency:list:tenant:{T}', 'prm:agency:{A}', 'prm:portal:agency:{A}:status_banner']
 *   prm.agency.onboarding_state_changed   → ['prm:agency:list:tenant:{T}', 'prm:agency:{A}', 'prm:portal:agency:{A}:status_banner']
 *   prm.agency.deleted                    → ['prm:agency:list:tenant:{T}', 'prm:agency:{A}']
 */

type CalledTags = string[][]

function makeCache(calls: CalledTags) {
  return {
    deleteByTags: jest.fn(async (tags: string[]) => {
      calls.push(tags)
    }),
  }
}

function makeCtx(cache: any): { resolve: <T = unknown>(name: string) => T } {
  return {
    resolve: <T = unknown>(name: string): T => {
      if (name === 'cache') return cache as T
      throw new Error(`unexpected resolve("${name}")`)
    },
  }
}

function makeUnboundCacheCtx(): { resolve: <T = unknown>(name: string) => T } {
  return {
    resolve: <T,>(name: string): T => {
      if (name === 'cache') throw new Error('cache not registered')
      throw new Error(`unexpected resolve("${name}")`)
    },
  }
}

describe('Agency cache invalidator subscribers (POST-MVP T0 wiring of SPEC-2026-04-23 §3.1.2-§3.1.4)', () => {
  describe('prm.agency.created → AgencyCacheOnCreatedInvalidator', () => {
    it('invalidates the tenant-scoped Agency list cache', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await createdHandle(
        {
          agency_id: 'agency-A',
          tenant_id: 'tenant-T',
          organization_id: 'org-O',
          slug: 'whatever',
          tier: 'om_agency',
        } as any,
        makeCtx(cache),
      )
      expect(calls).toEqual([['prm:agency:list:tenant:tenant-T']])
    })

    it('accepts camelCase payload keys (agencyId / tenantId)', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await createdHandle(
        { agencyId: 'agency-A', tenantId: 'tenant-T' } as any,
        makeCtx(cache),
      )
      expect(calls).toEqual([['prm:agency:list:tenant:tenant-T']])
    })

    it('throws loudly in non-production when tenant_id is missing', async () => {
      await expect(
        createdHandle({ agency_id: 'agency-A' } as any, makeCtx(makeCache([]))),
      ).rejects.toThrow(/missing tenant_id/)
    })

    it('silently no-ops in production when tenant_id is missing', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      const prev = process.env.NODE_ENV
      Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
      try {
        await expect(
          createdHandle({ agency_id: 'agency-A' } as any, makeCtx(cache)),
        ).resolves.toBeUndefined()
      } finally {
        Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
      }
      expect(calls).toEqual([])
    })

    it('soft-fails gracefully when cache is unbound in DI', async () => {
      await expect(
        createdHandle(
          { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
          makeUnboundCacheCtx(),
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('prm.agency.tier_changed → AgencyCacheOnTierChangedInvalidator', () => {
    it('invalidates the tenant-list + single-agency caches', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await tierChangedHandle(
        {
          agency_id: 'agency-A',
          tenant_id: 'tenant-T',
          fromTier: 'om_agency',
          toTier: 'ai_native',
        } as any,
        makeCtx(cache),
      )
      expect(calls).toEqual([
        ['prm:agency:list:tenant:tenant-T', 'prm:agency:agency-A'],
      ])
    })

    it('does NOT touch the portal status banner cache (tier change is invisible there)', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await tierChangedHandle(
        { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
        makeCtx(cache),
      )
      const flat = calls.flat()
      expect(flat).not.toContain('prm:portal:agency:agency-A:status_banner')
    })

    it('throws loudly in non-production when agency_id is missing', async () => {
      await expect(
        tierChangedHandle({ tenant_id: 'tenant-T' } as any, makeCtx(makeCache([]))),
      ).rejects.toThrow(/missing agency_id or tenant_id/)
    })

    it('silently no-ops in production when tenant_id is missing', async () => {
      const calls: CalledTags = []
      const prev = process.env.NODE_ENV
      Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
      try {
        await expect(
          tierChangedHandle({ agency_id: 'agency-A' } as any, makeCtx(makeCache(calls))),
        ).resolves.toBeUndefined()
      } finally {
        Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
      }
      expect(calls).toEqual([])
    })

    it('soft-fails gracefully when cache is unbound', async () => {
      await expect(
        tierChangedHandle(
          { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
          makeUnboundCacheCtx(),
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('prm.agency.status_changed → AgencyCacheOnStatusChangedInvalidator', () => {
    it('invalidates all three declared tag families', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await statusChangedHandle(
        {
          agency_id: 'agency-A',
          tenant_id: 'tenant-T',
          fromStatus: 'active',
          toStatus: 'suspended',
        } as any,
        makeCtx(cache),
      )
      expect(calls).toEqual([
        [
          'prm:agency:list:tenant:tenant-T',
          'prm:agency:agency-A',
          'prm:portal:agency:agency-A:status_banner',
        ],
      ])
    })

    it('throws loudly in non-production when agency_id is missing', async () => {
      await expect(
        statusChangedHandle({ tenant_id: 'tenant-T' } as any, makeCtx(makeCache([]))),
      ).rejects.toThrow(/missing agency_id or tenant_id/)
    })

    it('silently no-ops in production when both ids missing', async () => {
      const calls: CalledTags = []
      const prev = process.env.NODE_ENV
      Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
      try {
        await expect(
          statusChangedHandle({} as any, makeCtx(makeCache(calls))),
        ).resolves.toBeUndefined()
      } finally {
        Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
      }
      expect(calls).toEqual([])
    })

    it('soft-fails gracefully when cache is unbound', async () => {
      await expect(
        statusChangedHandle(
          { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
          makeUnboundCacheCtx(),
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('prm.agency.onboarding_state_changed → AgencyCacheOnOnboardingStateChangedInvalidator', () => {
    it('invalidates all three declared tag families', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await onboardingChangedHandle(
        {
          agency_id: 'agency-A',
          tenant_id: 'tenant-T',
          contractSigned: true,
          ndaSigned: false,
          onboarded: false,
        } as any,
        makeCtx(cache),
      )
      expect(calls).toEqual([
        [
          'prm:agency:list:tenant:tenant-T',
          'prm:agency:agency-A',
          'prm:portal:agency:agency-A:status_banner',
        ],
      ])
    })

    it('throws loudly in non-production when agency_id is missing', async () => {
      await expect(
        onboardingChangedHandle({ tenant_id: 'tenant-T' } as any, makeCtx(makeCache([]))),
      ).rejects.toThrow(/missing agency_id or tenant_id/)
    })

    it('silently no-ops in production when tenant_id is missing', async () => {
      const calls: CalledTags = []
      const prev = process.env.NODE_ENV
      Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
      try {
        await expect(
          onboardingChangedHandle({ agency_id: 'agency-A' } as any, makeCtx(makeCache(calls))),
        ).resolves.toBeUndefined()
      } finally {
        Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
      }
      expect(calls).toEqual([])
    })

    it('soft-fails gracefully when cache is unbound', async () => {
      await expect(
        onboardingChangedHandle(
          { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
          makeUnboundCacheCtx(),
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('prm.agency.deleted → AgencyCacheOnDeletedInvalidator', () => {
    it('invalidates the tenant-list + single-agency caches (no banner)', async () => {
      const calls: CalledTags = []
      const cache = makeCache(calls)
      await deletedHandle(
        { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
        makeCtx(cache),
      )
      expect(calls).toEqual([
        ['prm:agency:list:tenant:tenant-T', 'prm:agency:agency-A'],
      ])
      expect(calls.flat()).not.toContain('prm:portal:agency:agency-A:status_banner')
    })

    it('throws loudly in non-production when agency_id is missing', async () => {
      await expect(
        deletedHandle({ tenant_id: 'tenant-T' } as any, makeCtx(makeCache([]))),
      ).rejects.toThrow(/missing agency_id or tenant_id/)
    })

    it('silently no-ops in production when tenant_id is missing', async () => {
      const calls: CalledTags = []
      const prev = process.env.NODE_ENV
      Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
      try {
        await expect(
          deletedHandle({ agency_id: 'agency-A' } as any, makeCtx(makeCache(calls))),
        ).resolves.toBeUndefined()
      } finally {
        Object.defineProperty(process.env, 'NODE_ENV', { value: prev, configurable: true })
      }
      expect(calls).toEqual([])
    })

    it('soft-fails gracefully when cache is unbound', async () => {
      await expect(
        deletedHandle(
          { agency_id: 'agency-A', tenant_id: 'tenant-T' } as any,
          makeUnboundCacheCtx(),
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('contract: cache tag families (sanity)', () => {
    it('exactly three declared tag families exist across all five subscribers', async () => {
      const seen = new Set<string>()
      const cache = {
        deleteByTags: jest.fn(async (tags: string[]) => {
          for (const t of tags) {
            // Reduce concrete tags to their family by replacing ids with `*`.
            const family = t
              .replace(/tenant:[^:]+/, 'tenant:*')
              .replace(/agency:[A-Za-z0-9-]+/, (m) =>
                m === 'agency:list' ? m : 'agency:*',
              )
            seen.add(family)
          }
        }),
      }
      const ctx = makeCtx(cache)
      await createdHandle({ agency_id: 'a', tenant_id: 't' } as any, ctx)
      await tierChangedHandle({ agency_id: 'a', tenant_id: 't' } as any, ctx)
      await statusChangedHandle({ agency_id: 'a', tenant_id: 't' } as any, ctx)
      await onboardingChangedHandle({ agency_id: 'a', tenant_id: 't' } as any, ctx)
      await deletedHandle({ agency_id: 'a', tenant_id: 't' } as any, ctx)
      // Order-independent — assert by sorted set.
      expect([...seen].sort()).toEqual([
        'prm:agency:*',
        'prm:agency:list:tenant:*',
        'prm:portal:agency:*:status_banner',
      ])
    })
  })
})
