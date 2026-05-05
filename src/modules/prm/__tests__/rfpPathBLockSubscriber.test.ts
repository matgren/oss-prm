import handler from '../subscribers/rfp-path-b-lock'

/**
 * Unit test for `RfpPathBLockSubscriber` (Spec #3 §8.4 deferred-write contract).
 *
 * The subscriber is the SOLE writer for `prm_rfps.is_path_b_locked`. The
 * `prm_rfps` table is owned by Spec #5 (rfp-broadcast-response) and may not yet
 * exist when T2 ships. The handler MUST silently no-op on absent table /
 * absent column, never throwing through to the parent event runtime.
 *
 * Branches under test:
 *   1. table missing            → `to_regclass` returns null → no-op
 *   2. table exists, column missing → `information_schema.columns` empty → no-op
 *   3. both present             → counts live signed/active Path-B deals
 *                                  for the RFP and writes the new flag
 */

type StatusChangedPayload = Parameters<typeof handler>[0]

type RawCall = { sql: string; bindings: unknown[] }

/** Single chainable knex query builder mock that records every call. */
class FakeKnexBuilder {
  private record: { table: string; whereCalls: Array<[string, unknown]>; whereInCalls: Array<[string, unknown[]]>; whereNullCalls: string[]; updateCall: Record<string, unknown> | null; countResult: Array<{ c: string }>; updateResult: number } = {
    table: '',
    whereCalls: [],
    whereInCalls: [],
    whereNullCalls: [],
    updateCall: null,
    countResult: [{ c: '0' }],
    updateResult: 1,
  }

  setTable(table: string): void {
    this.record.table = table
  }

  setCountResult(rows: Array<{ c: string }>): void {
    this.record.countResult = rows
  }

  where(_col: string, _val: unknown): this {
    this.record.whereCalls.push([_col, _val])
    return this
  }

  whereIn(_col: string, vals: unknown[]): this {
    this.record.whereInCalls.push([_col, vals])
    return this
  }

  whereNull(col: string): this {
    this.record.whereNullCalls.push(col)
    return this
  }

  async count<T>(_alias: string): Promise<T> {
    return this.record.countResult as unknown as T
  }

  async update(payload: Record<string, unknown>): Promise<number> {
    this.record.updateCall = payload
    return this.record.updateResult
  }

  inspect(): typeof this.record {
    return this.record
  }
}

/**
 * Knex factory mock — distinguishes between the two table paths the
 * subscriber takes (`prm_license_deals` for the count, `prm_rfps` for the
 * UPDATE). Captures `.raw()` calls used for introspection.
 */
function buildKnexMock(opts: {
  toRegclass: string | null
  columnRows: Array<{ column_name: string }>
  liveCount: string
}) {
  const raws: RawCall[] = []
  const dealsBuilder = new FakeKnexBuilder()
  dealsBuilder.setTable('prm_license_deals')
  dealsBuilder.setCountResult([{ c: opts.liveCount }])

  const rfpsBuilder = new FakeKnexBuilder()
  rfpsBuilder.setTable('prm_rfps')

  const knex: any = jest.fn((table: string) => {
    if (table === 'prm_license_deals') return dealsBuilder
    if (table === 'prm_rfps') return rfpsBuilder
    throw new Error(`unexpected table ${table}`)
  })

  knex.raw = jest.fn(async (sql: string) => {
    raws.push({ sql, bindings: [] })
    if (sql.includes('to_regclass')) {
      return { rows: [{ oid: opts.toRegclass }] }
    }
    if (sql.includes('information_schema.columns')) {
      return { rows: opts.columnRows }
    }
    return { rows: [] }
  })

  return { knex, raws, dealsBuilder, rfpsBuilder }
}

function buildPayload(overrides: Partial<StatusChangedPayload> = {}): StatusChangedPayload {
  return {
    licenseDealId: 'deal-1',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    attributionPath: 'B',
    attributionSource: 'rfp',
    rfpId: 'rfp-9',
    fromStatus: 'pending',
    toStatus: 'signed',
    ...overrides,
  }
}

let warnSpy: jest.SpyInstance

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('RfpPathBLockSubscriber — payload guards', () => {
  it('no-ops when tenantId or rfpId is missing (no DI lookup)', async () => {
    const ctx = { resolve: jest.fn() }
    await handler({ ...buildPayload(), tenantId: undefined } as any, ctx as any)
    await handler({ ...buildPayload(), rfpId: null } as any, ctx as any)
    expect(ctx.resolve).not.toHaveBeenCalled()
  })

  it('no-ops when attributionPath is not B (other paths cannot affect the RFP lock)', async () => {
    const ctx = { resolve: jest.fn() }
    await handler(buildPayload({ attributionPath: 'A' }), ctx as any)
    await handler(buildPayload({ attributionPath: 'C' }), ctx as any)
    await handler(buildPayload({ attributionPath: 'none' }), ctx as any)
    expect(ctx.resolve).not.toHaveBeenCalled()
  })
})

describe('RfpPathBLockSubscriber — branch 1: table does not exist', () => {
  it('silently no-ops when to_regclass returns null and never queries prm_rfps', async () => {
    const { knex, raws, rfpsBuilder } = buildKnexMock({
      toRegclass: null,
      columnRows: [],
      liveCount: '0',
    })
    const ctx = {
      resolve: jest.fn(() => ({ getKnex: () => knex })),
    }

    await expect(handler(buildPayload(), ctx as any)).resolves.toBeUndefined()

    // Only the to_regclass introspection ran.
    expect(raws.length).toBe(1)
    expect(raws[0].sql).toContain('to_regclass')
    // No information_schema lookup, no count, no update.
    expect(knex).not.toHaveBeenCalledWith('prm_license_deals')
    expect(rfpsBuilder.inspect().updateCall).toBeNull()
    // No error log path was hit.
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('RfpPathBLockSubscriber — branch 2: column does not exist', () => {
  it('no-ops when prm_rfps exists but is_path_b_locked column is missing', async () => {
    const { knex, raws, rfpsBuilder } = buildKnexMock({
      toRegclass: 'public.prm_rfps',
      columnRows: [],
      liveCount: '5',
    })
    const ctx = {
      resolve: jest.fn(() => ({ getKnex: () => knex })),
    }

    await expect(handler(buildPayload(), ctx as any)).resolves.toBeUndefined()

    // Both introspection queries ran...
    expect(raws.length).toBe(2)
    expect(raws[0].sql).toContain('to_regclass')
    expect(raws[1].sql).toContain('information_schema.columns')
    // ...but the writer never reached the count or the UPDATE.
    expect(knex).not.toHaveBeenCalledWith('prm_license_deals')
    expect(rfpsBuilder.inspect().updateCall).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('RfpPathBLockSubscriber — branch 3: both present', () => {
  it('writes is_path_b_locked = true when at least one signed/active Path-B deal is live', async () => {
    const { knex, dealsBuilder, rfpsBuilder } = buildKnexMock({
      toRegclass: 'public.prm_rfps',
      columnRows: [{ column_name: 'is_path_b_locked' }],
      liveCount: '1',
    })
    const ctx = {
      resolve: jest.fn(() => ({ getKnex: () => knex })),
    }

    await handler(buildPayload(), ctx as any)

    // Counted live deals against the right table with the right filters.
    const dealsRecord = dealsBuilder.inspect()
    expect(dealsRecord.whereCalls).toEqual(
      expect.arrayContaining([
        ['rfp_id', 'rfp-9'],
        ['tenant_id', 'tenant-1'],
        ['attribution_path', 'B'],
      ]),
    )
    expect(dealsRecord.whereInCalls).toEqual([['status', ['signed', 'active']]])
    expect(dealsRecord.whereNullCalls).toEqual(['deleted_at'])

    // Wrote the lock flag = true to the matching RFP row.
    const rfpsRecord = rfpsBuilder.inspect()
    expect(rfpsRecord.whereCalls).toEqual(
      expect.arrayContaining([
        ['id', 'rfp-9'],
        ['tenant_id', 'tenant-1'],
      ]),
    )
    expect(rfpsRecord.updateCall).toMatchObject({ is_path_b_locked: true })
    expect(rfpsRecord.updateCall?.updated_at).toBeInstanceOf(Date)
  })

  it('writes is_path_b_locked = false when no live Path-B deals remain (lock release)', async () => {
    const { knex, rfpsBuilder } = buildKnexMock({
      toRegclass: 'public.prm_rfps',
      columnRows: [{ column_name: 'is_path_b_locked' }],
      liveCount: '0',
    })
    const ctx = {
      resolve: jest.fn(() => ({ getKnex: () => knex })),
    }

    await handler(buildPayload({ toStatus: 'pending' }), ctx as any)

    expect(rfpsBuilder.inspect().updateCall).toMatchObject({ is_path_b_locked: false })
  })
})

describe('RfpPathBLockSubscriber — robustness', () => {
  it('does not throw when DI cannot resolve the EM (logs a warning and returns)', async () => {
    const ctx = {
      resolve: jest.fn(() => {
        throw new Error('em-not-bound')
      }),
    }
    await expect(handler(buildPayload(), ctx as any)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      '[prm:rfp-path-b-lock] em resolve failed',
      expect.any(Error),
    )
  })

  it('does not throw when introspection itself fails (logs a warning and returns)', async () => {
    const knex: any = jest.fn()
    knex.raw = jest.fn(async () => {
      throw new Error('connection-refused')
    })
    const ctx = {
      resolve: jest.fn(() => ({ getKnex: () => knex })),
    }
    await expect(handler(buildPayload(), ctx as any)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      '[prm:rfp-path-b-lock] schema introspection failed',
      expect.any(Error),
    )
  })
})
