import type { EntityManager } from '@mikro-orm/postgresql'
import {
  Dictionary,
  DictionaryEntry,
} from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'

/**
 * Services dictionary seed (Spec #1 §1.2 / §2 / §5.5 M3 / §11). Idempotent.
 *
 * Powers the `Agency.services: string[]` slug-tag picklist on the B1 staff
 * Agency form and P3 portal Agency form. Spec #1 §3.1 documents the deliberate
 * slug-tag-array storage convention. Also referenced by CaseStudy
 * `services_delivered[]` (Spec #7).
 *
 * v1 seed — admins can extend or prune via the `dictionaries` module B14 page.
 *
 * Mirrors `topicsDictionarySeed.ts` shape (Spec #7 §5.3 / OQ-012). Stored as
 * a separate module so it can be unit-tested without going through `setup.ts`'s
 * `import.meta.url` (Jest fails to evaluate that under CommonJS module mode).
 */
export const SERVICES_DICTIONARY_SEED: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'custom-web-development', label: 'Custom Web Development' },
  { value: 'mobile-app-development', label: 'Mobile App Development' },
  { value: 'ai-ml-integration', label: 'AI/ML Integration' },
  { value: 'data-engineering', label: 'Data Engineering' },
  { value: 'devops-cloud-infrastructure', label: 'DevOps & Cloud Infrastructure' },
  { value: 'ui-ux-design', label: 'UI/UX Design' },
  { value: 'product-strategy-consulting', label: 'Product Strategy & Consulting' },
  { value: 'quality-assurance', label: 'Quality Assurance' },
  { value: 'cybersecurity', label: 'Cybersecurity' },
  { value: 'technical-training', label: 'Technical Training' },
]

export async function seedServicesDictionary(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  let dictionary = await em.findOne(Dictionary, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    key: 'services',
  } as any)
  if (!dictionary) {
    dictionary = em.create(Dictionary, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      key: 'services',
      name: 'Services',
      description:
        'Agency service-offering taxonomy (Spec #1). Slug-tag values stored on Agency.services[] and CaseStudy.services_delivered[].',
      isSystem: true,
      isActive: true,
      managerVisibility: 'default',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    em.persist(dictionary)
    await em.flush()
  }

  for (const entry of SERVICES_DICTIONARY_SEED) {
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
