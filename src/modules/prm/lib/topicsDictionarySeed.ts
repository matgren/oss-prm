import type { EntityManager } from '@mikro-orm/postgresql'
import {
  Dictionary,
  DictionaryEntry,
} from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'

/**
 * Topics dictionary seed (Spec #7 §5.3 / OQ-012). Idempotent.
 *
 * Stored as a separate module (not inlined in `setup.ts`) so it can be
 * unit-tested without going through `setup.ts`'s `import.meta.url`
 * (Jest fails to evaluate that under CommonJS module mode).
 */
export const TOPICS_DICTIONARY_SEED: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'new-partner-onboarding', label: 'New Partner Onboarding' },
  { value: 'sales-plays', label: 'Sales Plays' },
  { value: 'pricing-positioning', label: 'Pricing & Positioning' },
  { value: 'delivery-playbooks', label: 'Delivery Playbooks' },
  { value: 'case-study-patterns', label: 'Case Study Patterns' },
  { value: 'technical-enablement', label: 'Technical Enablement' },
]

export async function seedTopicsDictionary(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  let dictionary = await em.findOne(Dictionary, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    key: 'topics',
  } as any)
  if (!dictionary) {
    dictionary = em.create(Dictionary, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      key: 'topics',
      name: 'Topics',
      description: 'Marketing material topic taxonomy (Spec #7).',
      isSystem: true,
      isActive: true,
      managerVisibility: 'default',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    em.persist(dictionary)
    await em.flush()
  }

  for (const entry of TOPICS_DICTIONARY_SEED) {
    const normalized = normalizeDictionaryValue(entry.value)
    const existing = await em.findOne(DictionaryEntry, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      dictionary: dictionary.id as any,
      normalizedValue: normalized,
    } as any)
    if (existing) continue
    em.persist(
      em.create(DictionaryEntry, {
        dictionary,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        value: entry.value,
        normalizedValue: normalized,
        label: entry.label,
        color: null,
        icon: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any),
    )
  }
  await em.flush()
}
