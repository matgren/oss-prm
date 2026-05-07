/**
 * Verifies the services dictionary seed (Spec #1 §1.2 / §2 / §5.5 M3 / §11).
 *
 * The seed runs in `setup.seedDefaults` + `setup.onTenantCreated`. Asserts:
 *   - The canonical slug list is exposed (kebab-case, Spec #1 slug-tag convention).
 *   - First call inserts one Dictionary + N DictionaryEntry rows.
 *   - Second call is a no-op (idempotent — safe to re-run on existing tenants).
 *
 * Mirrors `setupTopicsDictionary.test.ts` shape verbatim.
 */
import {
  SERVICES_DICTIONARY_SEED,
  seedServicesDictionary,
} from '../lib/servicesDictionarySeed'

type AnyRow = Record<string, any>

class FakeEm {
  dictionaries: AnyRow[] = []
  entries: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(_Ctor: any, payload: T): T {
    return { ...payload, id: payload.id ?? `id-${Math.random().toString(36).slice(2, 8)}` }
  }

  persist(row: AnyRow): void {
    if (row.key && row.name && !row.value) {
      // Dictionary
      const idx = this.dictionaries.findIndex((d) => d.id === row.id)
      if (idx >= 0) this.dictionaries[idx] = row
      else this.dictionaries.push(row)
    } else if (row.value && row.label) {
      const idx = this.entries.findIndex((e) => e.id === row.id)
      if (idx >= 0) this.entries[idx] = row
      else this.entries.push(row)
    }
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async findOne(_Ctor: any, where: AnyRow): Promise<AnyRow | null> {
    if (where.key === 'services') {
      return (
        this.dictionaries.find(
          (d) =>
            d.tenantId === where.tenantId &&
            d.organizationId === where.organizationId &&
            d.key === 'services',
        ) ?? null
      )
    }
    if (where.normalizedValue !== undefined) {
      return (
        this.entries.find(
          (e) =>
            e.tenantId === where.tenantId &&
            e.organizationId === where.organizationId &&
            e.normalizedValue === where.normalizedValue &&
            (e.dictionary?.id ?? e.dictionary) === where.dictionary,
        ) ?? null
      )
    }
    return null
  }
}

describe('seedServicesDictionary', () => {
  const TENANT = 'tenant-1'
  const ORG = 'org-1'

  it('exposes the canonical kebab-case slug seed list', () => {
    expect(SERVICES_DICTIONARY_SEED.map((s) => s.value).sort()).toEqual([
      'ai-ml-integration',
      'custom-web-development',
      'cybersecurity',
      'data-engineering',
      'devops-cloud-infrastructure',
      'mobile-app-development',
      'product-strategy-consulting',
      'quality-assurance',
      'technical-training',
      'ui-ux-design',
    ])
  })

  it('creates the services dictionary + N entries on first call', async () => {
    const em = new FakeEm()
    await seedServicesDictionary(em as any, { tenantId: TENANT, organizationId: ORG })
    const dict = em.dictionaries.find((d) => d.key === 'services')
    expect(dict).toBeDefined()
    expect(dict?.isSystem).toBe(true)
    expect(em.entries.length).toBe(SERVICES_DICTIONARY_SEED.length)
  })

  it('is idempotent — running twice does not duplicate entries', async () => {
    const em = new FakeEm()
    await seedServicesDictionary(em as any, { tenantId: TENANT, organizationId: ORG })
    const firstCount = em.entries.length
    await seedServicesDictionary(em as any, { tenantId: TENANT, organizationId: ORG })
    expect(em.entries.length).toBe(firstCount)
  })
})
