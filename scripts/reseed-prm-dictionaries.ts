#!/usr/bin/env tsx
/**
 * Re-seed the four PRM dictionaries (industries, services, technologies, topics)
 * for ALL existing tenants in this DB.
 *
 * Why: PRM's `setup.onTenantCreated` + `setup.seedDefaults` hooks both seed
 * these dictionaries at tenant-create time. But if a tenant existed BEFORE
 * the seeds were added — or before SPEC-2026-05-11 added new entries — the
 * dictionary tables are empty for that tenant, and the closed-vocab
 * Combobox in P8 (industries) shows zero suggestions.
 *
 * The four seeds are idempotent (each uses `normalizeDictionaryValue` +
 * UPSERT semantics in `Dictionary` + `DictionaryEntry`), so re-running is
 * safe for tenants that already have entries — adds missing ones, leaves
 * existing ones alone.
 *
 * USAGE:
 *
 *   tsx scripts/reseed-prm-dictionaries.ts
 *
 * Output is human-readable; one line per tenant + a final summary.
 *
 * SAFETY: read-only against tenant identity; only writes to the PRM
 * dictionary tables (`dictionaries`, `dictionary_entries`). Does not touch
 * Agencies, CaseStudies, Users, or any other tenant data.
 */

import { config as loadDotenv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
loadDotenv({ path: path.join(appRoot, '.env') })

if (!process.env.DATABASE_URL) {
  process.stderr.write('ERROR: DATABASE_URL is not set. Run from the app root with `.env` configured.\n')
  process.exit(1)
}

async function main() {
  const { bootstrapFromAppRoot } = await import('@open-mercato/shared/lib/bootstrap/dynamicLoader')
  await bootstrapFromAppRoot(appRoot)

  const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
  const { resolve } = await createRequestContainer()
  const em = resolve('em') as import('@mikro-orm/postgresql').EntityManager

  // Discover all tenants via the directory module's Tenant entity.
  const { Tenant } = await import('@open-mercato/core/modules/directory/data/entities')
  const { Organization } = await import('@open-mercato/core/modules/directory/data/entities')
  type TenantRow = { id: string; name: string | null }
  type OrgRow = { id: string; name: string | null; tenantId: string }

  const tenants = (await em.find(Tenant, {}, { fields: ['id', 'name'] as any })) as unknown as TenantRow[]
  if (tenants.length === 0) {
    process.stdout.write('No tenants found. Nothing to re-seed.\n')
    return
  }

  // For each tenant, pick its primary organization (any active one — seeds are
  // organization-scoped, but PRM dictionaries are tenant-wide so the org-id is
  // only used as a provenance tag on the seeded rows).
  const orgs = (await em.find(Organization, {}, { fields: ['id', 'name', 'tenantId'] as any })) as unknown as OrgRow[]
  const orgByTenant = new Map<string, OrgRow>()
  for (const org of orgs) {
    if (!orgByTenant.has(org.tenantId)) orgByTenant.set(org.tenantId, org)
  }

  const { seedIndustriesDictionary } = await import('../src/modules/prm/lib/industriesDictionarySeed')
  const { seedServicesDictionary } = await import('../src/modules/prm/lib/servicesDictionarySeed')
  const { seedTechnologiesDictionary } = await import('../src/modules/prm/lib/technologiesDictionarySeed')
  const { seedTopicsDictionary } = await import('../src/modules/prm/lib/topicsDictionarySeed')

  let ok = 0
  let skipped = 0
  let failed = 0
  for (const tenant of tenants) {
    const org = orgByTenant.get(tenant.id)
    if (!org) {
      process.stdout.write(`SKIP tenant=${tenant.id} (no organization)\n`)
      skipped += 1
      continue
    }
    try {
      await seedTopicsDictionary(em, { tenantId: tenant.id, organizationId: org.id })
      await seedIndustriesDictionary(em, { tenantId: tenant.id, organizationId: org.id })
      await seedServicesDictionary(em, { tenantId: tenant.id, organizationId: org.id })
      await seedTechnologiesDictionary(em, { tenantId: tenant.id, organizationId: org.id })
      process.stdout.write(`OK   tenant=${tenant.id} (org=${org.id})\n`)
      ok += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`FAIL tenant=${tenant.id} — ${message}\n`)
      failed += 1
    }
  }

  process.stdout.write(`\nDone — ok=${ok}, skipped=${skipped}, failed=${failed}\n`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`FATAL: ${message}\n`)
  process.exit(1)
})
