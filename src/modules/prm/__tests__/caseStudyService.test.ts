import {
  CaseStudyService,
  isCurrentlyPublished,
  toCaseStudyDto,
} from '../lib/caseStudyService'
import { CaseStudy } from '../data/entities'
import { PRM_ERROR_CODES, PrmDomainError } from '../lib/errors'

type AnyRow = Record<string, any>

class FakeEm {
  rows: AnyRow[] = []
  flushCount = 0

  create<T extends AnyRow>(_Ctor: any, payload: T): T {
    return { ...payload, id: payload.id ?? `cs-${Math.random().toString(36).slice(2, 8)}` }
  }

  persist(row: AnyRow): void {
    const idx = this.rows.findIndex((r) => r.id === row.id)
    if (idx >= 0) this.rows[idx] = row
    else this.rows.push(row)
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async findOne(_Ctor: any, where: AnyRow): Promise<AnyRow | null> {
    return (
      this.rows.find((r) => {
        if (where.id !== undefined && r.id !== where.id) return false
        if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false
        if (where.agencyId !== undefined && r.agencyId !== where.agencyId) return false
        if (where.deletedAt === null && r.deletedAt) return false
        return true
      }) ?? null
    )
  }

  async findAndCount(_Ctor: any, where: AnyRow, opts: AnyRow): Promise<[AnyRow[], number]> {
    let filtered = this.rows.filter((r) => {
      if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false
      if (where.agencyId !== undefined && r.agencyId !== where.agencyId) return false
      if (where.deletedAt === null && r.deletedAt) return false
      if (where.mayPublishOnOmWebsite !== undefined && r.mayPublishOnOmWebsite !== where.mayPublishOnOmWebsite) return false
      if (where.publishedUrl !== undefined) {
        if (where.publishedUrl?.$ne === null) {
          if (r.publishedUrl == null) return false
        } else if (where.publishedUrl === null) {
          if (r.publishedUrl != null) return false
        }
      }
      if (where.title?.$ilike) {
        const needle = String(where.title.$ilike).toLowerCase().replace(/^%|%$/g, '')
        if (!String(r.title).toLowerCase().includes(needle)) return false
      }
      return true
    })
    if (where.$or) {
      filtered = filtered.filter((r) =>
        (where.$or as AnyRow[]).some((alt) => {
          if (alt.mayPublishOnOmWebsite !== undefined && r.mayPublishOnOmWebsite !== alt.mayPublishOnOmWebsite) return false
          if (alt.publishedUrl === null && r.publishedUrl != null) return false
          return true
        }),
      )
    }
    const total = filtered.length
    const limit = (opts.limit as number) ?? total
    const offset = (opts.offset as number) ?? 0
    return [filtered.slice(offset, offset + limit), total]
  }

  async find(_Ctor: any, where: AnyRow): Promise<AnyRow[]> {
    const ids: string[] = where.id?.$in ?? []
    return this.rows.filter((r) => {
      if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false
      if (where.agencyId !== undefined && r.agencyId !== where.agencyId) return false
      if (where.deletedAt === null && r.deletedAt) return false
      if (ids.length && !ids.includes(r.id)) return false
      return true
    })
  }
}

const ORG = 'org-1'
const AGENCY = 'agency-1'
const OTHER_AGENCY = 'agency-2'
const USER = 'cu-1'

function baseInput() {
  return {
    title: 'Acme growth case study',
    clientName: 'Acme Corp',
    clientIndustry: 'fintech',
    clientCountry: 'US',
    challengeMarkdown: 'They had a problem',
    approachMarkdown: 'We solved it',
    outcomeMarkdown: 'Big result',
    technologiesUsed: ['react', 'postgres'],
    servicesDelivered: ['discovery'],
    heroImageAttachmentId: null,
    galleryAttachmentIds: [],
  }
}

describe('CaseStudyService.createDraft', () => {
  it('persists a new draft scoped to the agency', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const cs = await service.createDraft(baseInput(), {
      organizationId: ORG,
      agencyId: AGENCY,
    })
    expect(cs.title).toBe('Acme growth case study')
    expect(cs.agencyId).toBe(AGENCY)
    expect(cs.mayPublishOnOmWebsite).toBe(false)
    expect(cs.publishedUrl).toBeNull()
    expect(cs.deletedAt).toBeNull()
    expect(em.rows).toHaveLength(1)
    expect(em.flushCount).toBe(1)
  })
})

describe('CaseStudyService.updateDraft', () => {
  it('updates only supplied fields', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    const updated = await service.updateDraft(
      created.id,
      { title: 'New title' },
      { organizationId: ORG, agencyId: AGENCY },
    )
    expect(updated.title).toBe('New title')
    expect(updated.clientName).toBe('Acme Corp')
  })

  it('404s when not owned by the calling agency', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    await expect(
      service.updateDraft(
        created.id,
        { title: 'Hijack' },
        { organizationId: ORG, agencyId: OTHER_AGENCY },
      ),
    ).rejects.toBeInstanceOf(PrmDomainError)
  })
})

describe('CaseStudyService.softDelete + restore', () => {
  it('soft-deletes a non-published case study', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    const deleted = await service.softDelete(
      created.id,
      { organizationId: ORG, agencyId: AGENCY },
      { customerUserId: USER },
    )
    expect(deleted.deletedAt).toBeInstanceOf(Date)
  })

  it('refuses soft-delete when published (invariant #8)', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    em.rows[0]!.mayPublishOnOmWebsite = true
    em.rows[0]!.publishedUrl = 'https://openmercato.com/cs/1'
    await expect(
      service.softDelete(
        created.id,
        { organizationId: ORG, agencyId: AGENCY },
        { customerUserId: USER },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.CASE_STUDY_PUBLISHED_GUARD, status: 409 })
  })

  it('restores a soft-deleted row', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    await service.softDelete(
      created.id,
      { organizationId: ORG, agencyId: AGENCY },
      { customerUserId: USER },
    )
    const restored = await service.restore(
      created.id,
      { organizationId: ORG, agencyId: AGENCY },
      { customerUserId: USER },
    )
    expect(restored.deletedAt).toBeNull()
  })

  it('409s when restoring a non-deleted row', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    await expect(
      service.restore(
        created.id,
        { organizationId: ORG, agencyId: AGENCY },
        { customerUserId: USER },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.CASE_STUDY_NOT_DELETED, status: 409 })
  })
})

describe('CaseStudyService.setPublicationFlag', () => {
  it('sets the flag and url together', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    const flagged = await service.setPublicationFlag(
      created.id,
      { mayPublishOnOmWebsite: true, publishedUrl: 'https://openmercato.com/cs/1' },
      { organizationId: ORG },
      { userId: 'staff-1' },
    )
    expect(flagged.mayPublishOnOmWebsite).toBe(true)
    expect(flagged.publishedUrl).toBe('https://openmercato.com/cs/1')
    expect(isCurrentlyPublished(flagged)).toBe(true)
  })

  it('rejects publishedUrl with flag = false (defence-in-depth)', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const created = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    await expect(
      service.setPublicationFlag(
        created.id,
        { mayPublishOnOmWebsite: false, publishedUrl: 'https://openmercato.com/cs/1' },
        { organizationId: ORG },
        { userId: 'staff-1' },
      ),
    ).rejects.toMatchObject({ code: PRM_ERROR_CODES.CASE_STUDY_INVALID_PUBLISH_STATE })
  })
})

describe('CaseStudyService.validateAttachedCaseStudyOwnership (cross-spec — Spec #5)', () => {
  it('returns no missing ids for own-Agency live rows', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const a = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    const b = await service.createDraft(
      { ...baseInput(), title: 'Second' },
      { organizationId: ORG, agencyId: AGENCY },
    )
    const result = await service.validateAttachedCaseStudyOwnership(
      [a.id, b.id],
      { organizationId: ORG, agencyId: AGENCY },
    )
    expect(result.missingIds).toEqual([])
  })

  it('flags cross-Agency case study ids as missing', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const own = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    const other = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: OTHER_AGENCY })
    const result = await service.validateAttachedCaseStudyOwnership(
      [own.id, other.id],
      { organizationId: ORG, agencyId: AGENCY },
    )
    expect(result.missingIds).toEqual([other.id])
  })

  it('flags soft-deleted case study ids as missing', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const own = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    await service.softDelete(
      own.id,
      { organizationId: ORG, agencyId: AGENCY },
      { customerUserId: USER },
    )
    const result = await service.validateAttachedCaseStudyOwnership(
      [own.id],
      { organizationId: ORG, agencyId: AGENCY },
    )
    expect(result.missingIds).toEqual([own.id])
  })
})

describe('CaseStudyService DTO + publication predicate', () => {
  it('round-trips through toCaseStudyDto', () => {
    const cs = new CaseStudy()
    cs.id = 'id-1'
    cs.organizationId = ORG
    cs.agencyId = AGENCY
    cs.title = 't'
    cs.clientName = 'c'
    cs.challengeMarkdown = 'a'
    cs.approachMarkdown = 'b'
    cs.outcomeMarkdown = 'c'
    cs.createdAt = new Date('2026-05-07T00:00:00Z')
    cs.updatedAt = new Date('2026-05-07T00:00:00Z')
    cs.mayPublishOnOmWebsite = true
    cs.publishedUrl = 'https://openmercato.com/cs/1'
    const dto = toCaseStudyDto(cs)
    expect(dto.isCurrentlyPublished).toBe(true)
    expect(dto.publishedUrl).toBe('https://openmercato.com/cs/1')
  })
})

describe('CaseStudyService.listAll', () => {
  it('filters by isPublished correctly', async () => {
    const em = new FakeEm()
    const service = new CaseStudyService(em as any)
    const a = await service.createDraft(baseInput(), { organizationId: ORG, agencyId: AGENCY })
    await service.createDraft(
      { ...baseInput(), title: 'Second' },
      { organizationId: ORG, agencyId: AGENCY },
    )
    em.rows.find((r) => r.id === a.id)!.mayPublishOnOmWebsite = true
    em.rows.find((r) => r.id === a.id)!.publishedUrl = 'https://x'
    const published = await service.listAll(
      { organizationId: ORG },
      { isPublished: true, includeDeleted: true, limit: 10, offset: 0 },
    )
    expect(published.items).toHaveLength(1)
    expect(published.items[0]!.id).toBe(a.id)
  })
})
