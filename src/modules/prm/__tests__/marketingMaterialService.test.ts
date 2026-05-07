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
      if (where.materialType !== undefined && r.materialType !== where.materialType) return false
      if (where.visibility !== undefined && r.visibility !== where.visibility) return false
      if (where.publishedAt?.$ne === null && r.publishedAt == null) return false
      if (where.unpublishedAt === null && r.unpublishedAt != null) return false
      if (where.publishedAt === null && r.publishedAt != null) return false
      if (where.unpublishedAt?.$ne === null && r.unpublishedAt == null) return false
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
    if (clause.visibility !== undefined && row.visibility !== clause.visibility) return false
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

function baseInput(overrides: any = {}) {
  return {
    title: 'Sales playbook',
    description: 'How to sell',
    materialType: 'playbook' as const,
    visibility: 'all_partners' as const,
    minTier: null,
    topics: ['sales-plays'],
    audiences: ['active_partner'] as const,
    primaryAttachmentId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  }
}

describe('MarketingMaterialService.create', () => {
  it('creates a draft material', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
    expect(m.title).toBe('Sales playbook')
    expect(m.publishedAt).toBeNull()
    expect(m.unpublishedAt).toBeNull()
    expect(m.minTierRank).toBeNull()
  })

  it('rejects tier_gated without minTier', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    await expect(
      service.create(baseInput({ visibility: 'tier_gated', minTier: null }), {
        organizationId: ORG,
        userId: USER,
      }),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.MARKETING_MATERIAL_INVALID_TIER, status: 400 })
  })

  it('computes minTierRank correctly', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ visibility: 'tier_gated', minTier: 'ai_native_expert' }),
      { organizationId: ORG, userId: USER },
    )
    expect(m.minTierRank).toBe(3)
  })
})

describe('MarketingMaterialService.publish + unpublish', () => {
  it('publishes a draft, then unpublishes it', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
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
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
    await expect(
      service.unpublish(m.id, {}, { organizationId: ORG }, { userId: USER }),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.MARKETING_MATERIAL_NOT_PUBLISHED, status: 409 })
  })

  it('republishing a previously-unpublished material clears unpublished_at', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
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
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
    await service.delete(m.id, { organizationId: ORG })
    expect(em.rows).toHaveLength(0)
  })

  it('refuses delete after publish (must unpublish + soft-retain)', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    await expect(service.delete(m.id, { organizationId: ORG })).rejects.toMatchObject({ status: 409 })
  })
})

describe('MarketingMaterialService.listPublishedForViewer (tier gate)', () => {
  it('shows all_partners content to any viewer', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { organizationId: ORG, viewerTier: 'om_agency' },
      { limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toContain(m.id)
  })

  it('hides tier_gated content from below-tier viewers', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ visibility: 'tier_gated', minTier: 'ai_native_expert' }),
      { organizationId: ORG, userId: USER },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { organizationId: ORG, viewerTier: 'ai_native' },
      { limit: 10, offset: 0 },
    )
    expect(result.items).toHaveLength(0)
  })

  it('reveals tier_gated content to at-or-above-tier viewers', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ visibility: 'tier_gated', minTier: 'ai_native' }),
      { organizationId: ORG, userId: USER },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { organizationId: ORG, viewerTier: 'ai_native_core' },
      { limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toContain(m.id)
  })

  it('hides tier_gated content from a viewer with no tier (defence-in-depth)', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ visibility: 'tier_gated', minTier: 'om_agency' }),
      { organizationId: ORG, userId: USER },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { organizationId: ORG, viewerTier: null },
      { limit: 10, offset: 0 },
    )
    expect(result.items).toHaveLength(0)
  })

  it('hides unpublished material from viewer', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(baseInput(), { organizationId: ORG, userId: USER })
    const result = await service.listPublishedForViewer(
      { organizationId: ORG, viewerTier: 'ai_native' },
      { limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).not.toContain(m.id)
  })

  it('applies topic filter as post-filter', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const a = await service.create(baseInput({ topics: ['sales-plays'] }), { organizationId: ORG, userId: USER })
    const b = await service.create(baseInput({ topics: ['delivery-playbooks'] }), { organizationId: ORG, userId: USER })
    await service.publish(a.id, { organizationId: ORG }, { userId: USER })
    await service.publish(b.id, { organizationId: ORG }, { userId: USER })
    const result = await service.listPublishedForViewer(
      { organizationId: ORG, viewerTier: 'om_agency' },
      { topics: ['sales-plays'], limit: 10, offset: 0 },
    )
    expect(result.items.map((it) => it.id)).toEqual([a.id])
  })
})

describe('MarketingMaterial DTOs', () => {
  it('public DTO never exposes minTier', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ visibility: 'tier_gated', minTier: 'ai_native_expert' }),
      { organizationId: ORG, userId: USER },
    )
    await service.publish(m.id, { organizationId: ORG }, { userId: USER })
    const dto = toPublicLibraryDto(em.rows[0]! as any)
    expect(Object.keys(dto)).not.toContain('minTier')
    expect(dto.primaryAttachmentDownloadPath).toBe(`/api/prm/portal/library/${m.id}/download`)
  })

  it('admin DTO includes minTier + lifecycle stamps', async () => {
    const em = new FakeEm()
    const service = new MarketingMaterialService(em as any)
    const m = await service.create(
      baseInput({ visibility: 'tier_gated', minTier: 'ai_native_expert' }),
      { organizationId: ORG, userId: USER },
    )
    const dto = toMarketingMaterialDto(em.rows[0]! as any)
    expect(dto.minTier).toBe('ai_native_expert')
    expect(dto.minTierRank).toBe(3)
    expect(dto.isCurrentlyPublished).toBe(false)
  })
})
