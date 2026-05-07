import {
  assertBroadcastedOrNotFound,
  rfpNotFoundResponse,
  RfpVisibilityNotFoundError,
} from '../lib/rfpVisibility'
import { Rfp, RfpBroadcast } from '../data/entities'

type AnyRow = Record<string, any>

class FakeEm {
  rfps: AnyRow[] = []
  broadcasts: AnyRow[] = []

  async findOne(EntityCtor: any, where: AnyRow): Promise<AnyRow | null> {
    const collection = EntityCtor === Rfp ? this.rfps : EntityCtor === RfpBroadcast ? this.broadcasts : []
    return (
      collection.find((row) => {
        for (const [k, v] of Object.entries(where)) {
          if (v === null) {
            if (row[k] != null) return false
          } else if (row[k] !== v) {
            return false
          }
        }
        return true
      }) ?? null
    )
  }
}

// Valid UUIDv4-shaped strings (version 4, variant 8/9/a/b).
const ORG = '11111111-1111-4111-8111-111111111111'
const RFP = '22222222-2222-4222-8222-222222222222'
const AGENCY = '33333333-3333-4333-8333-333333333333'
const OTHER_AGENCY = '44444444-4444-4444-8444-444444444444'

describe('rfpNotFoundResponse — byte-identical 404 (Spec #5 §9.2 #7 invariant #15)', () => {
  it('returns the canonical body and status code on every call', async () => {
    const a = rfpNotFoundResponse()
    const b = rfpNotFoundResponse()
    expect(a.status).toBe(404)
    expect(b.status).toBe(404)
    const aBody = await a.text()
    const bBody = await b.text()
    expect(aBody).toEqual(bBody)
    expect(JSON.parse(aBody)).toEqual({ ok: false, error: 'Not found' })
  })
})

describe('assertBroadcastedOrNotFound — uniform-failure semantics', () => {
  function makeRfp(overrides: Partial<AnyRow> = {}): AnyRow {
    return {
      id: RFP,
      organizationId: ORG,
      status: 'published',
      deletedAt: null,
      ...overrides,
    }
  }

  function makeBroadcast(overrides: Partial<AnyRow> = {}): AnyRow {
    return {
      id: 'broadcast-1',
      organizationId: ORG,
      rfpId: RFP,
      agencyId: AGENCY,
      ...overrides,
    }
  }

  it('throws "invalid_id" on malformed UUID without touching the EM', async () => {
    const em = new FakeEm()
    await expect(
      assertBroadcastedOrNotFound('not-a-uuid', AGENCY, em as any, { organizationId: ORG }),
    ).rejects.toMatchObject({
      name: 'RfpVisibilityNotFoundError',
      reason: 'invalid_id',
    })
  })

  it('throws "rfp_not_found" when no RFP row exists for the tenant', async () => {
    const em = new FakeEm()
    await expect(
      assertBroadcastedOrNotFound(RFP, AGENCY, em as any, { organizationId: ORG }),
    ).rejects.toMatchObject({ reason: 'rfp_not_found' })
  })

  it('throws "rfp_not_portal_visible" for draft / closed status (invisible to every Agency)', async () => {
    const em = new FakeEm()
    em.rfps.push(makeRfp({ status: 'draft' }))
    em.broadcasts.push(makeBroadcast())
    await expect(
      assertBroadcastedOrNotFound(RFP, AGENCY, em as any, { organizationId: ORG }),
    ).rejects.toMatchObject({ reason: 'rfp_not_portal_visible' })

    em.rfps[0].status = 'closed'
    await expect(
      assertBroadcastedOrNotFound(RFP, AGENCY, em as any, { organizationId: ORG }),
    ).rejects.toMatchObject({ reason: 'rfp_not_portal_visible' })
  })

  it('throws "broadcast_not_found" when the Agency was not in the broadcast set', async () => {
    const em = new FakeEm()
    em.rfps.push(makeRfp())
    em.broadcasts.push(makeBroadcast({ agencyId: OTHER_AGENCY }))
    await expect(
      assertBroadcastedOrNotFound(RFP, AGENCY, em as any, { organizationId: ORG }),
    ).rejects.toMatchObject({ reason: 'broadcast_not_found' })
  })

  it('returns { rfp, broadcast } when the gate is open', async () => {
    const em = new FakeEm()
    em.rfps.push(makeRfp())
    em.broadcasts.push(makeBroadcast())
    const result = await assertBroadcastedOrNotFound(RFP, AGENCY, em as any, { organizationId: ORG })
    expect(result.rfp.id).toBe(RFP)
    expect(result.broadcast.agencyId).toBe(AGENCY)
  })

  it('every failure reason is a typed RfpVisibilityNotFoundError so callers can convert uniformly', async () => {
    const em = new FakeEm()
    let captured: unknown
    try {
      await assertBroadcastedOrNotFound('not-a-uuid', AGENCY, em as any, { organizationId: ORG })
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(RfpVisibilityNotFoundError)
  })
})
