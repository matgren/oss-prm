import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CaseStudy } from '../data/entities'
import {
  type CreateCaseStudyInput,
  type SetCaseStudyPublicationFlagInput,
  type UpdateCaseStudyInput,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'

/**
 * Domain helper for the `CaseStudy` aggregate (Spec #7 §3.1 / §3.2).
 *
 * Owns:
 *   - `createDraft` / `updateDraft` — portal P8 authoring
 *   - `softDelete` / `restore`     — invariant #8 + soft-delete pair
 *   - `setPublicationFlag`         — backend B8 (Marketing-only)
 *   - `listForAgency`              — portal P7 + Spec #5 P10 picker
 *   - `listAll`                    — backend B8 cross-Agency
 *   - `getOwnedById`               — portal detail load
 *   - `validateAttachedCaseStudyOwnership` — Spec #5 cross-spec contract
 *
 * Marketing-only fields (`mayPublishOnOmWebsite`, `publishedUrl`) are NEVER
 * touched by the portal write methods — they remain at their existing
 * values. The B8-only `setPublicationFlag` is the sole writer.
 */
export class CaseStudyService {
  constructor(private readonly em: EntityManager) {}

  async createDraft(
    input: CreateCaseStudyInput,
    scope: { organizationId: string; agencyId: string },
  ): Promise<CaseStudy> {
    const cs = this.em.create(CaseStudy, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      agencyId: scope.agencyId,
      title: input.title,
      clientName: input.clientName,
      clientIndustry: input.clientIndustry ?? null,
      clientCountry: input.clientCountry ?? null,
      challengeMarkdown: input.challengeMarkdown,
      approachMarkdown: input.approachMarkdown,
      outcomeMarkdown: input.outcomeMarkdown,
      technologiesUsed: input.technologiesUsed ?? [],
      servicesDelivered: input.servicesDelivered ?? [],
      heroImageAttachmentId: input.heroImageAttachmentId ?? null,
      galleryAttachmentIds: input.galleryAttachmentIds ?? [],
      mayPublishOnOmWebsite: false,
      publishedUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as any)
    this.em.persist(cs)
    await this.em.flush()

    await safeEmit('prm.case_study.created', {
      case_study_id: cs.id,
      agency_id: cs.agencyId,
      organization_id: cs.organizationId,
    })
    return cs
  }

  async updateDraft(
    id: string,
    input: UpdateCaseStudyInput,
    scope: { organizationId: string; agencyId: string },
  ): Promise<CaseStudy> {
    const cs = await this.loadOwned(id, scope, { allowDeleted: false })
    if (input.title !== undefined) cs.title = input.title
    if (input.clientName !== undefined) cs.clientName = input.clientName
    if (input.clientIndustry !== undefined) cs.clientIndustry = input.clientIndustry ?? null
    if (input.clientCountry !== undefined) cs.clientCountry = input.clientCountry ?? null
    if (input.challengeMarkdown !== undefined) cs.challengeMarkdown = input.challengeMarkdown
    if (input.approachMarkdown !== undefined) cs.approachMarkdown = input.approachMarkdown
    if (input.outcomeMarkdown !== undefined) cs.outcomeMarkdown = input.outcomeMarkdown
    if (input.technologiesUsed !== undefined) cs.technologiesUsed = input.technologiesUsed ?? []
    if (input.servicesDelivered !== undefined) cs.servicesDelivered = input.servicesDelivered ?? []
    if (input.heroImageAttachmentId !== undefined) cs.heroImageAttachmentId = input.heroImageAttachmentId ?? null
    if (input.galleryAttachmentIds !== undefined) cs.galleryAttachmentIds = input.galleryAttachmentIds ?? []
    cs.updatedAt = new Date()
    this.em.persist(cs)
    await this.em.flush()

    const isPublished = isCurrentlyPublished(cs)
    await safeEmit('prm.case_study.updated', {
      case_study_id: cs.id,
      agency_id: cs.agencyId,
      organization_id: cs.organizationId,
      published: isPublished,
    })
    return cs
  }

  async softDelete(
    id: string,
    scope: { organizationId: string; agencyId: string },
    deleter: { customerUserId: string },
  ): Promise<CaseStudy> {
    const cs = await this.loadOwned(id, scope, { allowDeleted: false })
    if (isCurrentlyPublished(cs)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CASE_STUDY_PUBLISHED_GUARD,
        'This Case Study is published on the OM website. Ask OM Marketing to unflag or remove before deleting.',
        409,
        { case_study_id: cs.id },
      )
    }
    cs.deletedAt = new Date()
    cs.updatedAt = new Date()
    this.em.persist(cs)
    await this.em.flush()

    await safeEmit('prm.case_study.deleted', {
      case_study_id: cs.id,
      agency_id: cs.agencyId,
      organization_id: cs.organizationId,
      deleted_by_customer_user_id: deleter.customerUserId,
    })
    return cs
  }

  async restore(
    id: string,
    scope: { organizationId: string; agencyId: string },
    restorer: { customerUserId: string },
  ): Promise<CaseStudy> {
    const cs = await this.loadOwned(id, scope, { allowDeleted: true })
    if (!cs.deletedAt) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CASE_STUDY_NOT_DELETED,
        'Case study is not in a deleted state.',
        409,
        { case_study_id: cs.id },
      )
    }
    cs.deletedAt = null
    cs.updatedAt = new Date()
    this.em.persist(cs)
    await this.em.flush()

    await safeEmit('prm.case_study.restored', {
      case_study_id: cs.id,
      agency_id: cs.agencyId,
      organization_id: cs.organizationId,
      restored_by_customer_user_id: restorer.customerUserId,
    })
    return cs
  }

  async setPublicationFlag(
    id: string,
    input: SetCaseStudyPublicationFlagInput,
    scope: { organizationId: string },
    actor: { userId: string },
  ): Promise<CaseStudy> {
    const cs = await this.em.findOne(CaseStudy, {
      id,
      organizationId: scope.organizationId,
    } as any)
    if (!cs) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CASE_STUDY_NOT_FOUND,
        'Case study not found.',
        404,
        { case_study_id: id },
      )
    }
    // Defence-in-depth: route Zod refine catches publishedUrl-without-flag,
    // but the service rejects it too in case a non-route caller sneaks in.
    if (!input.mayPublishOnOmWebsite && input.publishedUrl !== null) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CASE_STUDY_INVALID_PUBLISH_STATE,
        'Cannot set publishedUrl while mayPublishOnOmWebsite = false.',
        400,
      )
    }
    cs.mayPublishOnOmWebsite = input.mayPublishOnOmWebsite
    cs.publishedUrl = input.publishedUrl
    cs.updatedAt = new Date()
    this.em.persist(cs)
    await this.em.flush()

    await safeEmit('prm.case_study.publication_flag_changed', {
      case_study_id: cs.id,
      agency_id: cs.agencyId,
      organization_id: cs.organizationId,
      may_publish_on_om_website: cs.mayPublishOnOmWebsite,
      published_url: cs.publishedUrl,
      set_by_user_id: actor.userId,
    })
    return cs
  }

  async getOwnedById(
    id: string,
    scope: { organizationId: string; agencyId: string },
  ): Promise<CaseStudy> {
    return this.loadOwned(id, scope, { allowDeleted: true })
  }

  async listForAgency(
    scope: { organizationId: string; agencyId: string },
    options: { includeDeleted: boolean; q?: string; limit: number; offset: number },
  ): Promise<{ items: CaseStudy[]; total: number }> {
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      agencyId: scope.agencyId,
    }
    if (!options.includeDeleted) {
      where.deletedAt = null
    }
    if (options.q) {
      where.title = { $ilike: `%${options.q.replace(/[%_]/g, (c) => `\\${c}`)}%` }
    }
    const [items, total] = await this.em.findAndCount(CaseStudy, where as any, {
      orderBy: { createdAt: 'desc' },
      limit: options.limit,
      offset: options.offset,
    })
    return { items, total }
  }

  async listAll(
    scope: { organizationId: string },
    options: {
      agencyId?: string
      mayPublish?: boolean
      isPublished?: boolean
      includeDeleted: boolean
      q?: string
      limit: number
      offset: number
    },
  ): Promise<{ items: CaseStudy[]; total: number }> {
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
    }
    if (options.agencyId) where.agencyId = options.agencyId
    if (!options.includeDeleted) where.deletedAt = null
    if (options.mayPublish !== undefined) where.mayPublishOnOmWebsite = options.mayPublish
    if (options.isPublished !== undefined) {
      if (options.isPublished) {
        where.mayPublishOnOmWebsite = true
        where.publishedUrl = { $ne: null }
      } else {
        // (mayPublishOnOmWebsite = false) OR (publishedUrl IS NULL).
        where.$or = [
          { mayPublishOnOmWebsite: false },
          { publishedUrl: null },
        ]
      }
    }
    if (options.q) {
      where.title = { $ilike: `%${options.q.replace(/[%_]/g, (c) => `\\${c}`)}%` }
    }
    const [items, total] = await this.em.findAndCount(CaseStudy, where as any, {
      orderBy: { createdAt: 'desc' },
      limit: options.limit,
      offset: options.offset,
    })
    return { items, total }
  }

  /**
   * Cross-spec contract — Spec #5 P10 case-study picker (US5.4).
   *
   * Validates that every id in `caseStudyIds` resolves to a CaseStudy with
   * `agency_id = scope.agencyId` AND `deleted_at IS NULL`. Returns the missing
   * ids; an empty array means the input is fully owned + non-deleted.
   *
   * Publication state is NOT required here — Agencies attach drafts to RFP
   * responses too (the RFPResponse picker is "show all my case studies").
   */
  async validateAttachedCaseStudyOwnership(
    caseStudyIds: string[],
    scope: { organizationId: string; agencyId: string },
  ): Promise<{ missingIds: string[] }> {
    if (caseStudyIds.length === 0) return { missingIds: [] }
    const unique = Array.from(new Set(caseStudyIds))
    const found = await findWithDecryption<CaseStudy>(
      this.em,
      CaseStudy,
      {
        id: { $in: unique },
        organizationId: scope.organizationId,
        agencyId: scope.agencyId,
        deletedAt: null,
      } as any,
      undefined,
      { tenantId: null, organizationId: scope.organizationId },
    )
    const foundIds = new Set(found.map((row) => row.id))
    const missing = unique.filter((id) => !foundIds.has(id))
    return { missingIds: missing }
  }

  private async loadOwned(
    id: string,
    scope: { organizationId: string; agencyId: string },
    options: { allowDeleted: boolean },
  ): Promise<CaseStudy> {
    const where: Record<string, unknown> = {
      id,
      organizationId: scope.organizationId,
      agencyId: scope.agencyId,
    }
    if (!options.allowDeleted) where.deletedAt = null
    const cs = await this.em.findOne(CaseStudy, where as any)
    if (!cs) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CASE_STUDY_NOT_FOUND,
        'Case study not found.',
        404,
        { case_study_id: id },
      )
    }
    return cs
  }
}

/** Invariant #8 predicate. */
export function isCurrentlyPublished(cs: CaseStudy): boolean {
  return cs.mayPublishOnOmWebsite === true && cs.publishedUrl != null && cs.publishedUrl.length > 0
}

export type CaseStudyDto = {
  id: string
  organizationId: string
  agencyId: string
  title: string
  clientName: string
  clientIndustry: string | null
  clientCountry: string | null
  challengeMarkdown: string
  approachMarkdown: string
  outcomeMarkdown: string
  technologiesUsed: string[]
  servicesDelivered: string[]
  heroImageAttachmentId: string | null
  galleryAttachmentIds: string[]
  mayPublishOnOmWebsite: boolean
  publishedUrl: string | null
  isCurrentlyPublished: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export function toCaseStudyDto(cs: CaseStudy): CaseStudyDto {
  return {
    id: cs.id,
    organizationId: cs.organizationId,
    agencyId: cs.agencyId,
    title: cs.title,
    clientName: cs.clientName,
    clientIndustry: cs.clientIndustry ?? null,
    clientCountry: cs.clientCountry ?? null,
    challengeMarkdown: cs.challengeMarkdown,
    approachMarkdown: cs.approachMarkdown,
    outcomeMarkdown: cs.outcomeMarkdown,
    technologiesUsed: cs.technologiesUsed ?? [],
    servicesDelivered: cs.servicesDelivered ?? [],
    heroImageAttachmentId: cs.heroImageAttachmentId ?? null,
    galleryAttachmentIds: cs.galleryAttachmentIds ?? [],
    mayPublishOnOmWebsite: cs.mayPublishOnOmWebsite,
    publishedUrl: cs.publishedUrl ?? null,
    isCurrentlyPublished: isCurrentlyPublished(cs),
    createdAt: cs.createdAt.toISOString(),
    updatedAt: cs.updatedAt.toISOString(),
    deletedAt: cs.deletedAt ? cs.deletedAt.toISOString() : null,
  }
}
