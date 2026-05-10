import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CacheStrategy } from '@open-mercato/cache'
import { runWithCacheTenant } from '@open-mercato/cache'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { seedPartnersFirstSidebarOrder } from './lib/sidebarPreferenceSeed'

async function disposeContainer(container: unknown) {
  const disposable = container as { dispose?: () => Promise<void> }
  if (typeof disposable.dispose === 'function') {
    await disposable.dispose()
  }
}

// Backend chrome caches the rendered sidebar under `nav:sidebar:v2:*` keys
// scoped per (locale, userId, tenantId, organizationId). Writing a new role
// preference does not bust those keys, so existing renders keep the old
// groupOrder until TTL. Drop the tenant-scoped nav:* keys here so the next
// request rebuilds chrome with the freshly seeded preference.
async function purgeNavCacheForTenant(
  cache: CacheStrategy,
  tenantId: string,
): Promise<number> {
  return runWithCacheTenant(tenantId, async () => {
    const keys = await cache.keys('nav:*')
    for (const key of keys) await cache.delete(key)
    return keys.length
  })
}

const seedSidebarOrder: ModuleCli = {
  command: 'seed-sidebar-order',
  async run(rest) {
    const tenantArg = rest.find((part) => part?.startsWith('--tenant='))?.slice('--tenant='.length)
    const container = await createRequestContainer()
    try {
      const em = container.resolve('em') as EntityManager
      let cache: CacheStrategy | null = null
      try {
        cache = container.resolve('cache') as CacheStrategy
      } catch {
        cache = null
      }
      const tenants = tenantArg
        ? await em.find(Tenant, { id: tenantArg, deletedAt: null })
        : await em.find(Tenant, { deletedAt: null })
      if (tenants.length === 0) {
        console.log('[prm] No tenants matched — nothing to seed.')
        return
      }
      for (const tenant of tenants) {
        await seedPartnersFirstSidebarOrder(em, { tenantId: tenant.id })
        let purged = 0
        if (cache) {
          try {
            purged = await purgeNavCacheForTenant(cache, tenant.id)
          } catch (err) {
            console.warn(`[prm] nav cache purge failed for tenant ${tenant.id}:`, err)
          }
        }
        console.log(
          `[prm] sidebar groupOrder seeded for tenant ${tenant.id} (${tenant.name ?? '—'})`
            + ` — purged ${purged} nav:* cache key(s)`,
        )
      }
    } finally {
      await disposeContainer(container)
    }
  },
}

const help: ModuleCli = {
  command: 'help',
  async run() {
    console.log('🤝 PRM CLI')
    console.log('')
    console.log('🚀 Usage:')
    console.log('  yarn mercato prm seed-sidebar-order [--tenant=<id>]')
    console.log('    Pin the Partners group to the top of the backend sidebar')
    console.log('    for staff roles (superadmin, admin, employee) across all')
    console.log('    locales (en, de, es, pl). Idempotent. Omit --tenant to')
    console.log('    apply to every tenant.')
  },
}

export default [seedSidebarOrder, help]
