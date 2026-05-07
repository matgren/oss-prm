import type { EntityManager } from '@mikro-orm/postgresql'
import {
  Dictionary,
  DictionaryEntry,
} from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'

/**
 * Technologies dictionary seed (Spec #1 §1.2 / §2 / §5.5 M3 / §11). Idempotent.
 *
 * Powers the `Agency.tech_capabilities: string[]` slug-tag picklist on the
 * B1 staff Agency form and P3 portal Agency form. Spec #1 §3.1 documents
 * the column-name choice (`tech_capabilities` for jsonb portability) but the
 * dictionary KEY remains `technologies` per §5.5 M3 / §11. Also referenced
 * by CaseStudy `technologies_used[]` (Spec #7).
 *
 * v1 seed — admins can extend or prune via the `dictionaries` module B14 page.
 *
 * Mirrors `topicsDictionarySeed.ts` shape (Spec #7 §5.3 / OQ-012). Stored as
 * a separate module so it can be unit-tested without going through `setup.ts`'s
 * `import.meta.url` (Jest fails to evaluate that under CommonJS module mode).
 */
export const TECHNOLOGIES_DICTIONARY_SEED: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'react', label: 'React' },
  { value: 'vue', label: 'Vue' },
  { value: 'angular', label: 'Angular' },
  { value: 'node-js', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' },
  { value: 'dot-net', label: '.NET' },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'GCP' },
  { value: 'azure', label: 'Azure' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'kubernetes', label: 'Kubernetes' },
  { value: 'docker', label: 'Docker' },
]

export async function seedTechnologiesDictionary(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  let dictionary = await em.findOne(Dictionary, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    key: 'technologies',
  } as any)
  if (!dictionary) {
    dictionary = em.create(Dictionary, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      key: 'technologies',
      name: 'Technologies',
      description:
        'Agency technology-capability taxonomy (Spec #1). Slug-tag values stored on Agency.tech_capabilities[] and CaseStudy.technologies_used[].',
      isSystem: true,
      isActive: true,
      managerVisibility: 'default',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    em.persist(dictionary)
    await em.flush()
  }

  for (const entry of TECHNOLOGIES_DICTIONARY_SEED) {
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
