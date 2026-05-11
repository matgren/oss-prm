import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { deletePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'
import { MarketingMaterial } from '../data/entities'
import {
  type CreateMarketingMaterialInput,
  type UnpublishMarketingMaterialInput,
  type UpdateMarketingMaterialInput,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'
import { tierRank } from './tierRank'

const PRM_MATERIAL_ENTITY_ID = 'prm:marketing_material'

export type MaterialAttachment = {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  url: string
  isPrimary: boolean
}

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
    scope: { organizationId: string; userId: string; tenantId: string },
  ): Promise<MarketingMaterial> {
    // Legacy callers (single-attachment path, no upload widget) leave
    // `draftRecordId` unset and pass a `primaryAttachmentId` minted somewhere
    // outside this service — skip ownership/rebind verification in that case
    // to preserve backward compatibility.
    const useDraftFlow = !!(input.draftRecordId && scope.tenantId)
    const allDraftIds = useDraftFlow
      ? [
          input.primaryAttachmentId,
          ...((input.extraAttachmentIds ?? []).filter((id) => id !== input.primaryAttachmentId)),
        ]
      : []
    if (useDraftFlow) {
      await this.assertOwnedDraftAttachments(allDraftIds, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId!,
        draftRecordId: input.draftRecordId!,
      })
    }

    const minTier = input.minTier ?? null
    const minTierRank = minTier ? tierRank(minTier) : null
    const materialId = randomUUID()
    const m = this.em.create(MarketingMaterial, {
      id: materialId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      title: input.title,
      description: input.description ?? null,
      materialType: input.materialType,
      minTier,
      minTierRank,
      topics: input.topics ?? [],
      allowedRoles: input.allowedRoles ?? [],
      primaryAttachmentId: input.primaryAttachmentId,
      publishedAt: null,
      unpublishedAt: null,
      createdByUserId: scope.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    this.em.persist(m)
    await this.em.flush()

    if (useDraftFlow) {
      await this.bindAttachmentsToMaterial(allDraftIds, materialId, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId!,
      })
    }

    await safeEmit('prm.marketing_material.created', {
      material_id: m.id,
      organization_id: m.organizationId,
      material_type: m.materialType,
      min_tier: m.minTier ?? null,
      allowed_roles: m.allowedRoles ?? [],
      created_by_user_id: scope.userId,
    })
    return m
  }

  async update(
    id: string,
    input: UpdateMarketingMaterialInput,
    scope: { organizationId: string; tenantId?: string },
  ): Promise<MarketingMaterial> {
    const m = await this.loadOwned(id, scope)

    // Resolve incoming attachment changes BEFORE mutating scalar fields so we
    // can fail fast if the caller sent an attachment id they don't own.
    const incomingExtras = input.extraAttachmentIds ?? []
    const incomingRemoves = input.removedAttachmentIds ?? []
    const nextPrimaryId = input.primaryAttachmentId ?? m.primaryAttachmentId
    const useAttachmentFlow = !!scope.tenantId && (incomingExtras.length > 0 || incomingRemoves.length > 0 || (input.primaryAttachmentId !== undefined && input.primaryAttachmentId !== m.primaryAttachmentId))

    if (incomingRemoves.includes(nextPrimaryId)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Cannot remove the primary attachment. Promote another file to primary first.',
        409,
      )
    }
    if (useAttachmentFlow && incomingExtras.length) {
      await this.assertOwnedDraftAttachments(incomingExtras, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId!,
        draftRecordId: input.draftRecordId ?? null,
        allowAlreadyBoundTo: m.id,
      })
    }
    if (
      useAttachmentFlow &&
      input.primaryAttachmentId !== undefined &&
      input.primaryAttachmentId !== m.primaryAttachmentId
    ) {
      // Promoting an extra to primary — must be an attachment already bound to
      // this material (or one of the staged extras above).
      await this.assertOwnedDraftAttachments([input.primaryAttachmentId], {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId!,
        draftRecordId: input.draftRecordId ?? null,
        allowAlreadyBoundTo: m.id,
      })
    }

    if (input.title !== undefined) m.title = input.title
    if (input.description !== undefined) m.description = input.description ?? null
    if (input.materialType !== undefined) m.materialType = input.materialType
    if (input.minTier !== undefined) {
      m.minTier = input.minTier ?? null
      m.minTierRank = m.minTier ? tierRank(m.minTier) : null
    }
    if (input.topics !== undefined) m.topics = input.topics ?? []
    if (input.allowedRoles !== undefined) m.allowedRoles = input.allowedRoles ?? []
    if (input.primaryAttachmentId !== undefined) m.primaryAttachmentId = input.primaryAttachmentId
    m.updatedAt = new Date()
    this.em.persist(m)
    await this.em.flush()

    if (useAttachmentFlow && incomingExtras.length) {
      await this.bindAttachmentsToMaterial(incomingExtras, m.id, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId!,
      })
    }
    if (useAttachmentFlow && incomingRemoves.length) {
      await this.removeAttachments(incomingRemoves, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId!,
        materialId: m.id,
      })
    }

    await safeEmit('prm.marketing_material.updated', {
      material_id: m.id,
      organization_id: m.organizationId,
      material_type: m.materialType,
      min_tier: m.minTier ?? null,
      allowed_roles: m.allowedRoles ?? [],
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
    scope: { tenantId: string },
    options: {
      materialType?: string
      isPublished?: boolean
      q?: string
      limit: number
      offset: number
    },
  ): Promise<{ items: MarketingMaterial[]; total: number }> {
    // Tenant-wide visibility: OM staff browsing the backend B11 list sees
    // every material in their tenant (any authoring org). Edit ACL is still
    // org-scoped via loadOwned() for write operations.
    const where: Record<string, unknown> = {
      tenantId: scope.tenantId,
    }
    if (options.materialType) where.materialType = options.materialType
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
   * Portal P11 query — applies the tier-gate + role-gate filter inline.
   *
   * SQL contract: `published_at IS NOT NULL AND unpublished_at IS NULL AND
   * (min_tier IS NULL OR min_tier_rank <= :viewer_rank)`. When the viewer has
   * no tier (`viewerRank === null`), only ungated rows (`min_tier IS NULL`)
   * are returned.
   *
   * Role gate is applied as a post-filter on the JSONB `allowed_roles` array:
   * empty array means "all roles", non-empty means viewer must hold at least
   * one of the listed slugs. The route layer caches the response under
   * `[ 'prm:library', 'prm:agency:${agency_id}:tier:${tier}' ]`.
   */
  async listPublishedForViewer(
    scope: { tenantId: string; viewerTier: string | null },
    options: {
      materialType?: string
      topics?: string[]
      viewerRoleSlugs?: string[]
      limit: number
      offset: number
    },
  ): Promise<{ items: MarketingMaterial[]; total: number }> {
    const viewerRank = scope.viewerTier ? tierRank(scope.viewerTier) : null
    // Tenant-wide visibility: every agency in the tenant sees the shared
    // library. OM Marketing publishes once → every agency reads (tier-gated).
    // SQL-side tier gate: when viewer has no tier, only ungated (min_tier
    // IS NULL) rows are eligible. When viewer has a tier, ungated rows
    // always pass and tier-gated rows pass when min_tier_rank ≤ viewer_rank.
    const where: Record<string, unknown> = {
      tenantId: scope.tenantId,
      publishedAt: { $ne: null },
      unpublishedAt: null,
    }
    if (viewerRank !== null) {
      where.$or = [
        { minTier: null },
        { minTierRank: { $lte: viewerRank } },
      ]
    } else {
      where.minTier = null
    }
    if (options.materialType) where.materialType = options.materialType
    const [rawItems] = await this.em.findAndCount(MarketingMaterial, where as any, {
      orderBy: { publishedAt: 'desc' },
    })
    let items = rawItems
    // Topics is a JSONB array filter not directly expressible through
    // MikroORM `where` portably — apply server-side post-filter.
    if (options.topics && options.topics.length) {
      const set = new Set(options.topics)
      items = items.filter((m) => (m.topics ?? []).some((t) => set.has(t)))
    }
    // Role gate. Empty allowed_roles = visible to all roles; non-empty =
    // visible only when viewer's role intersects the list.
    const viewerRoles = options.viewerRoleSlugs ?? []
    const viewerRoleSet = new Set(viewerRoles)
    items = items.filter((m) => {
      const allowed = m.allowedRoles ?? []
      if (allowed.length === 0) return true
      return allowed.some((r) => viewerRoleSet.has(r))
    })
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

  /**
   * Loads every Attachment row currently bound to the material — primary +
   * extras — and returns it in a UI-friendly shape with `isPrimary` resolved
   * from the material's `primary_attachment_id`.
   */
  async listAttachments(
    material: MarketingMaterial,
    scope: { organizationId: string; tenantId: string },
  ): Promise<MaterialAttachment[]> {
    const rows = await this.em.find(Attachment, {
      entityId: PRM_MATERIAL_ENTITY_ID,
      recordId: material.id,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    } as any)
    return rows
      .map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileSize: a.fileSize,
        mimeType: a.mimeType,
        url: a.url,
        isPrimary: a.id === material.primaryAttachmentId,
      }))
      .sort((x, y) => {
        if (x.isPrimary !== y.isPrimary) return x.isPrimary ? -1 : 1
        return x.fileName.localeCompare(y.fileName)
      })
  }

  /**
   * Verify that every supplied attachment id exists in this tenant/org and is
   * either (a) still in its draft state under `draftRecordId`, or (b) already
   * bound to `allowAlreadyBoundTo` (used on update for promote-to-primary).
   */
  private async assertOwnedDraftAttachments(
    ids: string[],
    options: {
      organizationId: string
      tenantId: string
      draftRecordId: string | null
      allowAlreadyBoundTo?: string
    },
  ): Promise<void> {
    if (!ids.length) return
    const rows = await this.em.find(Attachment, {
      id: { $in: ids },
      entityId: PRM_MATERIAL_ENTITY_ID,
      tenantId: options.tenantId,
      organizationId: options.organizationId,
    } as any)
    if (rows.length !== ids.length) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'One or more attachments are missing or do not belong to this organization.',
        400,
        { missing: ids.filter((id) => !rows.some((r) => r.id === id)) },
      )
    }
    for (const row of rows) {
      const isDraft =
        options.draftRecordId !== null && row.recordId === options.draftRecordId
      const isAlreadyBound =
        options.allowAlreadyBoundTo !== undefined &&
        row.recordId === options.allowAlreadyBoundTo
      if (!isDraft && !isAlreadyBound) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.VALIDATION_FAILED,
          'Attachment is not eligible for this material.',
          400,
          { attachment_id: row.id },
        )
      }
    }
  }

  /**
   * Rebind a set of Attachment rows to a saved MarketingMaterial. Idempotent —
   * rows already bound to `materialId` are left in place so update() can pass
   * the full extras list without churn.
   */
  private async bindAttachmentsToMaterial(
    ids: string[],
    materialId: string,
    scope: { organizationId: string; tenantId: string },
  ): Promise<void> {
    if (!ids.length) return
    const rows = await this.em.find(Attachment, {
      id: { $in: ids },
      entityId: PRM_MATERIAL_ENTITY_ID,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as any)
    let mutated = false
    for (const row of rows) {
      if (row.recordId === materialId) continue
      row.recordId = materialId
      this.em.persist(row)
      mutated = true
    }
    if (mutated) await this.em.flush()
  }

  /**
   * Hard-delete a set of Attachment rows currently bound to this material,
   * including their backing files. Skips rows that are not bound to the
   * material (defensive — should not happen given route-level checks).
   */
  private async removeAttachments(
    ids: string[],
    scope: { organizationId: string; tenantId: string; materialId: string },
  ): Promise<void> {
    if (!ids.length) return
    const rows = await this.em.find(Attachment, {
      id: { $in: ids },
      entityId: PRM_MATERIAL_ENTITY_ID,
      recordId: scope.materialId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as any)
    if (!rows.length) return
    const fileSpecs = rows.map((r) => ({
      partitionCode: r.partitionCode,
      storagePath: r.storagePath,
      storageDriver: r.storageDriver,
    }))
    for (const row of rows) this.em.remove(row)
    await this.em.flush()
    await Promise.all(
      fileSpecs.map((f) => deletePartitionFile(f.partitionCode, f.storagePath, f.storageDriver)),
    )
  }
}

export type MarketingMaterialDto = {
  id: string
  organizationId: string
  title: string
  description: string | null
  materialType: string
  minTier: string | null
  minTierRank: number | null
  topics: string[]
  allowedRoles: string[]
  primaryAttachmentId: string
  attachments: MaterialAttachment[]
  publishedAt: string | null
  unpublishedAt: string | null
  isCurrentlyPublished: boolean
  createdAt: string
  updatedAt: string
}

export function toMarketingMaterialDto(
  m: MarketingMaterial,
  attachments: MaterialAttachment[] = [],
): MarketingMaterialDto {
  return {
    id: m.id,
    organizationId: m.organizationId,
    title: m.title,
    description: m.description ?? null,
    materialType: m.materialType,
    minTier: m.minTier ?? null,
    minTierRank: m.minTierRank ?? null,
    topics: m.topics ?? [],
    allowedRoles: m.allowedRoles ?? [],
    primaryAttachmentId: m.primaryAttachmentId,
    attachments,
    publishedAt: m.publishedAt ? m.publishedAt.toISOString() : null,
    unpublishedAt: m.unpublishedAt ? m.unpublishedAt.toISOString() : null,
    isCurrentlyPublished: !!m.publishedAt && !m.unpublishedAt,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

/**
 * Public DTO for portal P11 — never exposes `min_tier` (per §3.4) or
 * `allowed_roles` (the role gate is internal; revealing the gate would leak
 * which roles cannot see a material).
 */
export type MarketingMaterialPublicDto = {
  id: string
  title: string
  description: string | null
  materialType: string
  topics: string[]
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
    primaryAttachmentDownloadPath: `/api/prm/portal/library/${m.id}/download`,
    publishedAt: m.publishedAt ? m.publishedAt.toISOString() : '',
  }
}
