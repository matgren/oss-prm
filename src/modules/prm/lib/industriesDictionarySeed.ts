import type { EntityManager } from '@mikro-orm/postgresql'
import {
  Dictionary,
  DictionaryEntry,
} from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'

/**
 * Industries dictionary seed (Spec #1 §1.2 / §2 / §5.5 M3 / §11). Idempotent.
 *
 * Powers the `Agency.industries: string[]` slug-tag picklist surfaced on the
 * B1 staff Agency form and P3 portal Agency form. Spec #1 §3.1 documents the
 * deliberate slug-tag-array storage convention (jsonb of dictionary slugs,
 * not uuid FK references).
 *
 * v1 seed — admins can extend or prune via the `dictionaries` module B14 page.
 *
 * Stored as a separate module (not inlined in `setup.ts`) so it can be
 * unit-tested without going through `setup.ts`'s `import.meta.url`
 * (Jest fails to evaluate that under CommonJS module mode). Mirrors
 * `topicsDictionarySeed.ts` (Spec #7 §5.3 / OQ-012).
 */
export const INDUSTRIES_DICTIONARY_SEED: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'saas', label: 'SaaS' },
  { value: 'e-commerce', label: 'E-commerce' },
  { value: 'fintech', label: 'FinTech' },
  { value: 'healthtech', label: 'HealthTech' },
  { value: 'edtech', label: 'EdTech' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'media-entertainment', label: 'Media & Entertainment' },
  { value: 'government-public-sector', label: 'Government & Public Sector' },
  { value: 'non-profit', label: 'Non-profit' },
  { value: 'other', label: 'Other' },
]

export async function seedIndustriesDictionary(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  let dictionary = await em.findOne(Dictionary, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    key: 'industries',
  } as any)
  if (!dictionary) {
    dictionary = em.create(Dictionary, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      key: 'industries',
      name: 'Industries',
      description:
        'Agency target-industry taxonomy (Spec #1). Slug-tag values stored on Agency.industries[].',
      isSystem: true,
      isActive: true,
      managerVisibility: 'default',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    em.persist(dictionary)
    await em.flush()
  }

  for (const entry of INDUSTRIES_DICTIONARY_SEED) {
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
