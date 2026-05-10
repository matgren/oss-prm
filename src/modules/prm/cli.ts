import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { seedPartnersFirstSidebarOrder } from './lib/sidebarPreferenceSeed'

async function disposeContainer(container: unknown) {
  const disposable = container as { dispose?: () => Promise<void> }
  if (typeof disposable.dispose === 'function') {
    await disposable.dispose()
  }
}

const seedSidebarOrder: ModuleCli = {
  command: 'seed-sidebar-order',
  async run(rest) {
    const tenantArg = rest.find((part) => part?.startsWith('--tenant='))?.slice('--tenant='.length)
    const container = await createRequestContainer()
    try {
      const em = container.resolve('em') as EntityManager
      const tenants = tenantArg
        ? await em.find(Tenant, { id: tenantArg, deletedAt: null })
        : await em.find(Tenant, { deletedAt: null })
      if (tenants.length === 0) {
        console.log('[prm] No tenants matched — nothing to seed.')
        return
      }
      for (const tenant of tenants) {
        await seedPartnersFirstSidebarOrder(em, { tenantId: tenant.id })
        console.log(`[prm] sidebar groupOrder seeded for tenant ${tenant.id} (${tenant.name ?? '—'})`)
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
