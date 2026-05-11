import {
  MarketingMaterialService,
  toMarketingMaterialDto,
  toPublicLibraryDto,
} from '../lib/marketingMaterialService'
import { PRM_ERROR_CODES } from '../lib/errors'

type AnyRow = Record<string, any>

class FakeEm {
  rows: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(_Ctor: any, payload: T): T {
    return { ...payload, id: payload.id ?? `mm-${Math.random().toString(36).slice(2, 8)}` }
  }

  persist(row: AnyRow): void {
    const idx = this.rows.findIndex((r) => r.id === row.id)
    if (idx >= 0) this.rows[idx] = row
    else this.rows.push(row)
  }

  remove(row: AnyRow): void {
    this.rows = this.rows.filter((r) => r.id !== row.id)
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async findOne(_Ctor: any, where: AnyRow): Promise<AnyRow | null> {
    return (
      this.rows.find((r) => {
        if (where.id !== undefined && r.id !== where.id) return false
        if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false
        return true
      }) ?? null
    )
  }

  async findAndCount(_Ctor: any, where: AnyRow, opts: AnyRow): Promise<[AnyRow[], number]> {
    let filtered = this.rows.filter((r) => {
      if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false
      if (where.tenantId !== undefined && r.tenantId !== where.tenantId) return false
      if (where.materialType !== undefined && r.materialType !== where.materialType) return false
      if (where.publishedAt?.$ne === null && r.publishedAt == null) return false
      if (where.unpublishedAt === null && r.unpublishedAt != null) return false
      if (where.publishedAt === null && r.publishedAt != null) return false
      if (where.unpublishedAt?.$ne === null && r.unpublishedAt == null) return false
      if (where.minTier === null && r.minTier != null) return false
      if (where.minTierRank?.$lte !== undefined && (r.minTierRank ?? Infinity) > where.minTierRank.$lte) return false
      if (where.title?.$ilike) {
        const needle = String(where.title.$ilike).toLowerCase().replace(/^%|%$/g, '')
        if (!String(r.title).toLowerCase().includes(needle)) return false
      }
      if (where.$or) {
        const matches = (where.$or as AnyRow[]).some((alt) =>
          this.matchesClause(r, alt),
        )
        if (!matches) return false
      }
      return true
    })
    const total = filtered.length
    const limit = (opts.limit as number) ?? total
    const offset = (opts.offset as number) ?? 0
    return [filtered.slice(offset, offset + limit), total]
  }

  private matchesClause(row: AnyRow, clause: AnyRow): boolean {
    if (clause.minTier === null && row.minTier != null) return false
    if (clause.minTierRank?.$lte !== undefined && (row.minTierRank ?? Infinity) > clause.minTierRank.$lte) return false
    if (clause.publishedAt === null && row.publishedAt != null) return false
    if (clause.publishedAt?.$ne === null && row.publishedAt == null) return false
    if (clause.unpublishedAt?.$ne === null && row.unpublishedAt == null) return false
    if (clause.unpublishedAt === null && row.unpublishedAt != null) return false
    return true
  }
}

const ORG = 'org-1'
const USER = 'staff-1'
const TENANT = 'tenant-1'

function baseInput(overrides: any = {}) {
  return {
    title: 'Sales playbook',
    description: 'How to sell',
    materialType: 'playbook' as const,
    minTier: null,
    topics: ['sales-plays'],
    allowedRoles: [] as string[],
    primaryAttachmentId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  }
}

describe('MarketingMaterialService.create', () => {
  it('creates a draft material with no tier gate', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    expect(m.title).toBe('Sales playbook')
    expect(m.publishedAt).toBeNull()
    expect(m.unpublishedAt).toBeNull()
    expect(m.minTier).toBeNull()
    expect(m.minTierRank).toBeNull()
    expect(m.allowedRoles).toEqual([])
  })

  it('persists a tier-gated minTier and computes minTierRank', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ minTier: 'ai_native_expert' }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    expect(m.minTier).toBe('ai_native_expert')
    expect(m.minTierRank).toBe(3)
  })

  it('persists allowedRoles when provided', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    expect(m.allowedRoles).toEqual(['partner_admin'])
  })
})

describe('MarketingMaterialService.publish + unpublish', () => {
  it('publishes a draft, then unpublishes it', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    const published = await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    expect(published.publishedAt).toBeInstanceOf(Date)
    expect(published.unpublishedAt).toBeNull()
    const unpublished = await service.unpublish(
      m.id,
      { reason: 'Redacted' },
      { organizationId: ORG },
      { userId: USER },
    )
    expect(unpublished.unpublishedAt).toBeInstanceOf(Date)
  })

  it('rejects unpublish on never-published material', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await expect(
      service.unpublish(m.id, {}, { organizationId: ORG }, { userId: USER }),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.MARKETING_MATERIAL_NOT_PUBLISHED, status: 409 })
  })

  it('republishing a previously-unpublished material clears unpublished_at', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    await service.unpublish(m.id, {}, { organizationId: ORG }, { userId: USER })
    const republished = await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    expect(republished.unpublishedAt).toBeNull()
  })
})

describe('MarketingMaterialService.delete', () => {
  it('hard-deletes when never published', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await service.delete(m.id, { organizationId: ORG })
    expect(em.rows).toHaveLength(0)
  })

  it('refuses delete after publish (must unpublish + soft-retain)', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    await expect(service.delete(m.id, { organizationId: ORG })).rejects.toMatchObject({ status: 409 })
  })
})

describe('MarketingMaterialService.listPublishedForViewer (tier gate)', () => {
  it('shows ungated content (minTier = null) to any viewer', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'om_agency' },
      { limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toContain(m.id)
  })

  it('hides tier-gated content from below-tier viewers', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ minTier: 'ai_native_expert' }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'ai_native' },
      { limit: 10, offset: 0 },
    )
    expect(result.items).toHaveLength(0)
  })

  it('reveals tier-gated content to at-or-above-tier viewers', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ minTier: 'ai_native' }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'ai_native_core' },
      { limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toContain(m.id)
  })

  it('viewer with no tier sees only ungated content (tier-gated rows hidden)', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const ungated = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    const gated = await service.create(
      baseInput({ minTier: 'om_agency' }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(ungated.id, { organizationId: ORG }, { userId: USER })
    await service.publish(gated.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: null },
      { limit: 10, offset: 0 },
    )
    const ids = result.items.map((it) => it.id)
    expect(ids).toContain(ungated.id)
    expect(ids).not.toContain(gated.id)
  })

  it('hides unpublished material from viewer', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER, tenantId: TENANT })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'ai_native' },
      { limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).not.toContain(m.id)
  })

  it('applies topic filter as post-filter', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const a = await service.create(baseInput({ topics: ['sales-plays'] }), { organizationId: ORG, userId: USER, tenantId: TENANT })
    const b = await service.create(baseInput({ topics: ['delivery-playbooks'] }), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await service.publish(a.id, { organizationId: ORG }, { userId: USER })
    await service.publish(b.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'om_agency' },
      { topics: ['sales-plays'], limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toEqual([a.id])
  })
})

describe('MarketingMaterialService.listPublishedForViewer (role gate)', () => {
  it('material with empty allowedRoles is visible to any viewer role', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput({ allowedRoles: [] }), { organizationId: ORG, userId: USER, tenantId: TENANT })
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'om_agency' },
      { viewerRoleSlugs: ['partner_member'], limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toContain(m.id)
  })

  it('material restricted to partner_admin is hidden from partner_member', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'om_agency' },
      { viewerRoleSlugs: ['partner_member'], limit: 10, offset: 0 },
    )
    expect(result.items).toHaveLength(0)
  })

  it('material restricted to partner_admin is visible to partner_admin', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'om_agency' },
      { viewerRoleSlugs: ['partner_admin'], limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toContain(m.id)
  })

  it('viewer with no roles is gated out of role-restricted content', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'om_agency' },
      { viewerRoleSlugs: [], limit: 10, offset: 0 },
    )
    expect(result.items).toHaveLength(0)
  })

  it('tier gate composes with role gate (must pass both)', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    // Tier-gated to ai_native_expert, role-gated to partner_admin
    const m = await service.create(
      baseInput({ minTier: 'ai_native_expert', allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })

    // Right role, wrong tier → hidden
    const wrongTier = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'ai_native' },
      { viewerRoleSlugs: ['partner_admin'], limit: 10, offset: 0 },
    )
    expect(wrongTier.items).toHaveLength(0)

    // Right tier, wrong role → hidden
    const wrongRole = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'ai_native_core' },
      { viewerRoleSlugs: ['partner_member'], limit: 10, offset: 0 },
    )
    expect(wrongRole.items).toHaveLength(0)

    // Right tier + right role → visible
    const both = await service.listPublishedForViewer(
      { tenantId: TENANT, viewerTier: 'ai_native_core' },
      { viewerRoleSlugs: ['partner_admin'], limit: 10, offset: 0 },
    )
    expect(both.items.map((it) => it.id)).toContain(m.id)
  })
})

describe('MarketingMaterial DTOs', () => {
  it('public DTO never exposes minTier or allowedRoles', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ minTier: 'ai_native_expert', allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const dto = toPublicLibraryDto(em.rows[0]! as any)
    expect(Object.keys(dto)).not.toContain('minTier')
    expect(Object.keys(dto)).not.toContain('allowedRoles')
    expect(dto.primaryAttachmentDownloadPath).toBe(`/api/prm/portal/library/${m.id}/download`)
  })

  it('admin DTO includes minTier, allowedRoles, and lifecycle stamps', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ minTier: 'ai_native_expert', allowedRoles: ['partner_admin'] }),
      { organizationId: ORG, userId: USER, tenantId: TENANT },
    )
    const dto = toMarketingMaterialDto(em.rows[0]! as any)
    expect(dto.minTier).toBe('ai_native_expert')
    expect(dto.minTierRank).toBe(3)
    expect(dto.allowedRoles).toEqual(['partner_admin'])
    expect(dto.isCurrentlyPublished).toBe(false)
  })
})
