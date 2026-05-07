import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { MarketingMaterial } from '../data/entities'
import {
  type CreateMarketingMaterialInput,
  type UnpublishMarketingMaterialInput,
  type UpdateMarketingMaterialInput,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'
import { tierRank } from './tierRank'

/**
 * Domain helper for `MarketingMaterial` (Spec #7 §3.3).
 *
 * Owns:
 *   - `create` / `update`        — backend B9 CRUD.
 *   - `publish` / `unpublish`    — toggle the lifecycle pair (`published_at`
 *                                   / `unpublished_at`); enforces
 *                                   `unpublished_at IS NULL OR published_at
 *                                   IS NOT NULL` invariant.
 *   - `list`                     — backend list with filters.
 *   - `delete`                   — only legal while never-published; otherwise
 *                                   the contract is unpublish + soft-retain.
 *
 * `min_tier_rank` is maintained here (not by Postgres GENERATED) to keep the
 * mapping portable; the lookup is `lib/tierRank.ts`.
 */
export class MarketingMaterialService {
  constructor(private readonly em: EntityManager) {}

  async create(
    input: CreateMarketingMaterialInput,
    scope: { organizationId: string; userId: string },
  ): Promise<MarketingMaterial> {
    if (input.visibility === 'tier_gated' && (input.minTier ?? null) === null) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.MARKETING_MATERIAL_INVALID_TIER,
        'minTier is required when visibility = tier_gated.',
        400,
      )
    }
    const minTier = input.minTier ?? null
    const minTierRank = minTier ? tierRank(minTier) : null
    const m = this.em.create(MarketingMaterial, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      title: input.title,
      description: input.description ?? null,
      materialType: input.materialType,
      visibility: input.visibility ?? 'all_partners',
      minTier,
      minTierRank,
      topics: input.topics ?? [],
      audiences: input.audiences ?? [],
      primaryAttachmentId: input.primaryAttachmentId,
      publishedAt: null,
      unpublishedAt: null,
      createdByUserId: scope.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    this.em.persist(m)
    await this.em.flush()

    await safeEmit('prm.marketing_material.created', {
      material_id: m.id,
      organization_id: m.organizationId,
      material_type: m.materialType,
      visibility: m.visibility,
      min_tier: m.minTier ?? null,
      created_by_user_id: scope.userId,
    })
    return m
  }

  async update(
    id: string,
    input: UpdateMarketingMaterialInput,
    scope: { organizationId: string },
  ): Promise<MarketingMaterial> {
    const m = await this.loadOwned(id, scope)
    if (input.title !== undefined) m.title = input.title
    if (input.description !== undefined) m.description = input.description ?? null
    if (input.materialType !== undefined) m.materialType = input.materialType
    if (input.visibility !== undefined) m.visibility = input.visibility
    if (input.minTier !== undefined) {
      m.minTier = input.minTier ?? null
      m.minTierRank = m.minTier ? tierRank(m.minTier) : null
    }
    if (input.topics !== undefined) m.topics = input.topics ?? []
    if (input.audiences !== undefined) m.audiences = input.audiences ?? []
    if (input.primaryAttachmentId !== undefined) m.primaryAttachmentId = input.primaryAttachmentId
    if (m.visibility === 'tier_gated' && (m.minTier ?? null) === null) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.MARKETING_MATERIAL_INVALID_TIER,
        'minTier is required when visibility = tier_gated.',
        400,
      )
    }
    m.updatedAt = new Date()
    this.em.persist(m)
    await this.em.flush()

    await safeEmit('prm.marketing_material.updated', {
      material_id: m.id,
      organization_id: m.organizationId,
      material_type: m.materialType,
      visibility: m.visibility,
      min_tier: m.minTier ?? null,
    })
    return m
  }

  async publish(
    id: string,
    scope: { organizationId: string },
    actor: { userId: string },
  ): Promise<MarketingMaterial> {
    const m = await this.loadOwned(id, scope)
    const now = new Date()
    m.publishedAt = now
    m.unpublishedAt = null
    m.updatedAt = now
    this.em.persist(m)
    await this.em.flush()

    await safeEmit('prm.marketing_material.published', {
      material_id: m.id,
      organization_id: m.organizationId,
      visibility: m.visibility,
      min_tier: m.minTier ?? null,
      published_at: now.toISOString(),
      published_by_user_id: actor.userId,
    })
    return m
  }

  async unpublish(
    id: string,
    input: UnpublishMarketingMaterialInput,
    scope: { organizationId: string },
    actor: { userId: string },
  ): Promise<MarketingMaterial> {
    const m = await this.loadOwned(id, scope)
    if (!m.publishedAt) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.MARKETING_MATERIAL_NOT_PUBLISHED,
        'Cannot unpublish — material was never published.',
        409,
      )
    }
    const now = new Date()
    m.unpublishedAt = now
    m.updatedAt = now
    this.em.persist(m)
    await this.em.flush()

    await safeEmit('prm.marketing_material.unpublished', {
      material_id: m.id,
      organization_id: m.organizationId,
      unpublished_at: now.toISOString(),
      unpublished_by_user_id: actor.userId,
      reason: input.reason ?? null,
    })
    return m
  }

  async delete(id: string, scope: { organizationId: string }): Promise<void> {
    const m = await this.loadOwned(id, scope)
    if (m.publishedAt) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Cannot hard-delete — material has been published. Unpublish first.',
        409,
      )
    }
    this.em.remove(m)
    await this.em.flush()
  }

  async list(
    scope: { organizationId: string },
    options: {
      materialType?: string
      visibility?: string
      isPublished?: boolean
      q?: string
      limit: number
      offset: number
    },
  ): Promise<{ items: MarketingMaterial[]; total: number }> {
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
    }
    if (options.materialType) where.materialType = options.materialType
    if (options.visibility) where.visibility = options.visibility
    if (options.isPublished !== undefined) {
      if (options.isPublished) {
        where.publishedAt = { $ne: null }
        where.unpublishedAt = null
      } else {
        where.$or = [{ publishedAt: null }, { unpublishedAt: { $ne: null } }]
      }
    }
    if (options.q) {
      where.title = { $ilike: `%${options.q.replace(/[%_]/g, (c) => `\\${c}`)}%` }
    }
    const [items, total] = await this.em.findAndCount(MarketingMaterial, where as any, {
      orderBy: { createdAt: 'desc' },
      limit: options.limit,
      offset: options.offset,
    })
    return { items, total }
  }

  async getById(
    id: string,
    scope: { organizationId: string },
  ): Promise<MarketingMaterial> {
    return this.loadOwned(id, scope)
  }

  /**
   * Portal P11 query — applies the tier-gate filter inline.
   *
   * SQL contract: `published_at IS NOT NULL AND unpublished_at IS NULL AND
   * (visibility = 'all_partners' OR (visibility = 'tier_gated' AND
   * min_tier_rank <= :viewer_rank))`. The route layer caches the response
   * under `[ 'prm:library', 'prm:agency:${agency_id}:tier:${tier}' ]`.
   */
  async listPublishedForViewer(
    scope: { organizationId: string; viewerTier: string | null },
    options: {
      materialType?: string
      topics?: string[]
      audiences?: string[]
      limit: number
      offset: number
    },
  ): Promise<{ items: MarketingMaterial[]; total: number }> {
    const viewerRank = scope.viewerTier ? tierRank(scope.viewerTier) : null
    // Build a combined visibility filter. We use $or so all_partners always
    // wins; tier_gated requires viewer rank > 0 + min_tier_rank ≤ viewer_rank.
    const visibilityClause: Record<string, unknown>[] = [
      { visibility: 'all_partners' },
    ]
    if (viewerRank !== null) {
      visibilityClause.push({
        visibility: 'tier_gated',
        minTierRank: { $lte: viewerRank },
      })
    }
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      publishedAt: { $ne: null },
      unpublishedAt: null,
      $or: visibilityClause,
    }
    if (options.materialType) where.materialType = options.materialType
    const [rawItems, totalAll] = await this.em.findAndCount(MarketingMaterial, where as any, {
      orderBy: { publishedAt: 'desc' },
    })
    let items = rawItems
    // Topics / audiences are JSONB array filters not directly expressible
    // through MikroORM `where` portably — apply server-side post-filter on
    // the already-narrowed result set.
    if (options.topics && options.topics.length) {
      const set = new Set(options.topics)
      items = items.filter((m) => (m.topics ?? []).some((t) => set.has(t)))
    }
    if (options.audiences && options.audiences.length) {
      const set = new Set(options.audiences)
      items = items.filter((m) => (m.audiences ?? []).some((a) => set.has(a)))
    }
    const total = items.length
    const paged = items.slice(options.offset, options.offset + options.limit)
    return { items: paged, total }
  }

  private async loadOwned(
    id: string,
    scope: { organizationId: string },
  ): Promise<MarketingMaterial> {
    const m = await this.em.findOne(MarketingMaterial, {
      id,
      organizationId: scope.organizationId,
    } as any)
    if (!m) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.MARKETING_MATERIAL_NOT_FOUND,
        'Marketing material not found.',
        404,
        { material_id: id },
      )
    }
    return m
  }
}

export type MarketingMaterialDto = {
  id: string
  organizationId: string
  title: string
  description: string | null
  materialType: string
  visibility: string
  minTier: string | null
  minTierRank: number | null
  topics: string[]
  audiences: string[]
  primaryAttachmentId: string
  publishedAt: string | null
  unpublishedAt: string | null
  isCurrentlyPublished: boolean
  createdAt: string
  updatedAt: string
}

export function toMarketingMaterialDto(m: MarketingMaterial): MarketingMaterialDto {
  return {
    id: m.id,
    organizationId: m.organizationId,
    title: m.title,
    description: m.description ?? null,
    materialType: m.materialType,
    visibility: m.visibility,
    minTier: m.minTier ?? null,
    minTierRank: m.minTierRank ?? null,
    topics: m.topics ?? [],
    audiences: m.audiences ?? [],
    primaryAttachmentId: m.primaryAttachmentId,
    publishedAt: m.publishedAt ? m.publishedAt.toISOString() : null,
    unpublishedAt: m.unpublishedAt ? m.unpublishedAt.toISOString() : null,
    isCurrentlyPublished: !!m.publishedAt && !m.unpublishedAt,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

/** Public DTO for portal P11 — never exposes `min_tier` per §3.4. */
export type MarketingMaterialPublicDto = {
  id: string
  title: string
  description: string | null
  materialType: string
  topics: string[]
  audiences: string[]
  primaryAttachmentDownloadPath: string
  publishedAt: string
}

export function toPublicLibraryDto(m: MarketingMaterial): MarketingMaterialPublicDto {
  return {
    id: m.id,
    title: m.title,
    description: m.description ?? null,
    materialType: m.materialType,
    topics: m.topics ?? [],
    audiences: m.audiences ?? [],
    primaryAttachmentDownloadPath: `/api/prm/portal/library/${m.id}/download`,
    publishedAt: m.publishedAt ? m.publishedAt.toISOString() : '',
  }
}
