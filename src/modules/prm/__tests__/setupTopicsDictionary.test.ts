/**
 * Verifies the topics dictionary seed (Spec #7 §5.3 / OQ-012).
 *
 * The seed runs in `setup.seedDefaults` on tenant creation. Asserts:
 *   - First call inserts one Dictionary + N DictionaryEntry rows.
 *   - Second call is a no-op (idempotent).
 */
import {
  TOPICS_DICTIONARY_SEED,
  seedTopicsDictionary,
} from '../lib/topicsDictionarySeed'

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
    if (where.key === 'topics') {
      return (
        this.dictionaries.find(
          (d) =>
            d.tenantId === where.tenantId &&
            d.organizationId === where.organizationId &&
            d.key === 'topics',
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

describe('seedTopicsDictionary', () => {
  const TENANT = 'tenant-1'
  const ORG = 'org-1'

  it('exposes the canonical 6-slug seed list', () => {
    expect(TOPICS_DICTIONARY_SEED.map((s) => s.value).sort()).toEqual([
      'case-study-patterns',
      'delivery-playbooks',
      'new-partner-onboarding',
      'pricing-positioning',
      'sales-plays',
      'technical-enablement',
    ])
  })

  it('creates the topics dictionary + 6 entries on first call', async () => {
    const em = new FakeEm()
    await seedTopicsDictionary(em as any, { tenantId: TENANT, organizationId: ORG })
    const dict = em.dictionaries.find((d) => d.key === 'topics')
    expect(dict).toBeDefined()
    expect(dict?.isSystem).toBe(true)
    expect(em.entries.length).toBe(TOPICS_DICTIONARY_SEED.length)
  })

  it('is idempotent — running twice does not duplicate entries', async () => {
    const em = new FakeEm()
    await seedTopicsDictionary(em as any, { tenantId: TENANT, organizationId: ORG })
    const firstCount = em.entries.length
    await seedTopicsDictionary(em as any, { tenantId: TENANT, organizationId: ORG })
    expect(em.entries.length).toBe(firstCount)
  })
})
