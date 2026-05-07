/**
 * Unit tests for the additive Playwright fixture wrappers shipped alongside
 * the T0/T1/T2 §9 happy-path smokes.
 *
 * These wrappers are thin `apiRequest`-style shells; the goal of these tests
 * is NOT to re-test the underlying routes (which have their own unit
 * coverage) but to lock the **HTTP contract the fixtures emit** — verb, path,
 * Bearer header, body shape — so the §9 Playwright specs can rely on them.
 *
 * The Playwright `APIRequestContext` is stubbed; the fixtures are called
 * directly. We assert the resulting `request.fetch(...)` call site, then
 * manufacture a canned response and assert the helper-level behaviour
 * (e.g. `transitionProspectViaPortalFixture` first GETs, then PATCHes).
 */

import type { APIRequestContext, APIResponse } from '@playwright/test'

// We use `apiRequest` from `@open-mercato/core/testing/integration` under the
// hood; mocking it would tie us to its internals. Instead, use a real-ish
// `APIRequestContext` stub and assert the relayed call.
type FetchCallArgs = {
  url: string
  options: Record<string, unknown>
}

function makeStubContext(
  responder: (args: FetchCallArgs) => { status: number; body: unknown },
): { context: APIRequestContext; calls: FetchCallArgs[] } {
  const calls: FetchCallArgs[] = []
  const context = {
    fetch: async (url: string, options: Record<string, unknown> = {}) => {
      const args = { url, options }
      calls.push(args)
      const result = responder(args)
      const text = JSON.stringify(result.body)
      const headersArray: Array<{ name: string; value: string }> = []
      const response = {
        status: () => result.status,
        ok: () => result.status >= 200 && result.status < 300,
        json: async () => result.body,
        text: async () => text,
        headersArray: () => headersArray,
        body: async () => Buffer.from(text),
      } as unknown as APIResponse
      return response
    },
  } as unknown as APIRequestContext
  return { context, calls }
}

describe('PRM testing/integration fixtures (additive helpers for T0/T1/T2 smokes)', () => {
  describe('getProspectViaPortalFixture', () => {
    it('GETs /api/prm/portal/prospects/{id} with Bearer token + returns prospect summary', async () => {
      const prospect = {
        id: 'p-1',
        agencyId: 'a-1',
        organizationId: 'o-1',
        companyName: 'Acme',
        contactName: 'Jane',
        contactEmail: 'jane@acme.example',
        source: 'agency_owned',
        status: 'qualified',
        lostReason: null,
        notes: null,
        registeredAt: '2026-05-07T10:00:00.000Z',
        statusChangedAt: '2026-05-07T10:00:00.000Z',
        registeredByAgencyMemberId: 'm-1',
      }
      const { context, calls } = makeStubContext(() => ({
        status: 200,
        body: { ok: true, prospect },
      }))
      const { getProspectViaPortalFixture } = await import('../testing/integration')
      const result = await getProspectViaPortalFixture(context, 'cust-jwt', 'p-1')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toMatch(/\/api\/prm\/portal\/prospects\/p-1$/)
      expect(calls[0]!.options.method).toBe('GET')
      const headers = calls[0]!.options.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer cust-jwt')
      expect(result.id).toBe('p-1')
      expect(result.status).toBe('qualified')
      expect(result.statusChangedAt).toBe('2026-05-07T10:00:00.000Z')
    })

    it('throws when the portal returns 404', async () => {
      const { context } = makeStubContext(() => ({
        status: 404,
        body: { ok: false, error: 'Not found' },
      }))
      const { getProspectViaPortalFixture } = await import('../testing/integration')
      await expect(getProspectViaPortalFixture(context, 'cust-jwt', 'nope')).rejects.toThrow()
    })
  })

  describe('transitionProspectViaPortalFixture', () => {
    it('reads statusChangedAt then PATCHes with kind=transition + ifMatchStatusChangedAt', async () => {
      const prospectInitial = {
        id: 'p-1',
        agencyId: 'a-1',
        organizationId: 'o-1',
        companyName: 'Acme',
        contactName: 'Jane',
        contactEmail: 'jane@acme.example',
        source: 'agency_owned',
        status: 'new',
        lostReason: null,
        notes: null,
        registeredAt: '2026-05-07T10:00:00.000Z',
        statusChangedAt: '2026-05-07T10:00:00.000Z',
        registeredByAgencyMemberId: 'm-1',
      }
      const prospectAfter = {
        ...prospectInitial,
        status: 'qualified',
        statusChangedAt: '2026-05-07T10:05:00.000Z',
      }
      let getCount = 0
      const { context, calls } = makeStubContext((args) => {
        if (args.options.method === 'GET') {
          getCount += 1
          return { status: 200, body: { ok: true, prospect: prospectInitial } }
        }
        return { status: 200, body: { ok: true, prospect: prospectAfter } }
      })
      const { transitionProspectViaPortalFixture } = await import('../testing/integration')
      const result = await transitionProspectViaPortalFixture(context, 'cust-jwt', 'p-1', 'qualified')

      expect(getCount).toBe(1)
      expect(calls).toHaveLength(2)
      expect(calls[0]!.options.method).toBe('GET')
      expect(calls[1]!.options.method).toBe('PATCH')
      expect(calls[1]!.url).toMatch(/\/api\/prm\/portal\/prospects\/p-1$/)
      const data = calls[1]!.options.data as Record<string, unknown>
      expect(data.kind).toBe('transition')
      expect(data.toStatus).toBe('qualified')
      expect(data.ifMatchStatusChangedAt).toBe('2026-05-07T10:00:00.000Z')
      expect(result.status).toBe('qualified')
    })

    it('requires lostReason when toStatus="lost"', async () => {
      const { context } = makeStubContext(() => ({ status: 200, body: { ok: true, prospect: {} } }))
      const { transitionProspectViaPortalFixture } = await import('../testing/integration')
      await expect(
        transitionProspectViaPortalFixture(context, 'cust-jwt', 'p-1', 'lost'),
      ).rejects.toThrow(/lostReason is required/)
    })
  })

  describe('attributeLicenseDealFixture', () => {
    it('POSTs Path A payload to /api/prm/license-deal/{id}/attribute and returns the 202 envelope', async () => {
      const { context, calls } = makeStubContext(() => ({
        status: 202,
        body: {
          ok: true,
          licenseDealId: 'ld-1',
          sagaCorrelationKey: 'license-deal:ld-1:attribute',
          emittedEvents: ['prm.license_deal.attributed'],
          licenseDeal: { id: 'ld-1', attributedAgencyId: 'a-1', status: 'signed', attributionPath: 'A' },
        },
      }))
      const { attributeLicenseDealFixture } = await import('../testing/integration')
      const result = await attributeLicenseDealFixture(context, 'staff-jwt', 'ld-1', {
        attribution_path: 'A',
        prospect_id: 'p-1',
        golden_rule_default_prospect_id: 'p-1',
        competing_prospect_ids_to_retire: [],
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toMatch(/\/api\/prm\/license-deal\/ld-1\/attribute$/)
      expect(calls[0]!.options.method).toBe('POST')
      const data = calls[0]!.options.data as Record<string, unknown>
      expect(data.attribution_path).toBe('A')
      expect(data.prospect_id).toBe('p-1')
      expect(result.status).toBe(202)
      expect(result.body?.licenseDeal?.attributedAgencyId).toBe('a-1')
      expect(result.body?.sagaCorrelationKey).toBe('license-deal:ld-1:attribute')
    })

    it('preserves error envelopes from non-202 responses', async () => {
      const { context } = makeStubContext(() => ({
        status: 409,
        body: { ok: false, error: { code: 'attribution_frozen', message: 'Cannot re-attribute' } },
      }))
      const { attributeLicenseDealFixture } = await import('../testing/integration')
      const result = await attributeLicenseDealFixture(context, 'staff-jwt', 'ld-1', {
        attribution_path: 'A',
        prospect_id: 'p-1',
        golden_rule_default_prospect_id: 'p-1',
      })
      expect(result.status).toBe(409)
      expect(result.body?.error?.code).toBe('attribution_frozen')
    })
  })

  describe('listGoldenRuleCandidatesFixture', () => {
    it('GETs /golden-rule-candidates with the clientCompanyName + contactEmail query', async () => {
      const { context, calls } = makeStubContext(() => ({
        status: 200,
        body: {
          ok: true,
          candidates: [
            {
              prospectId: 'p-1',
              agencyId: 'a-1',
              organizationId: 'o-1',
              companyName: 'Acme',
              contactName: 'Jane',
              contactEmail: 'jane@acme.example',
              status: 'qualified',
              registeredAt: '2026-05-01T10:00:00.000Z',
              registeredByAgencyMemberId: 'm-1',
              isDefaultPick: true,
            },
          ],
        },
      }))
      const { listGoldenRuleCandidatesFixture } = await import('../testing/integration')
      const candidates = await listGoldenRuleCandidatesFixture(context, 'staff-jwt', {
        clientCompanyName: 'Acme',
        contactEmail: 'jane@acme.example',
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toMatch(/\/api\/prm\/license-deal\/golden-rule-candidates\?/)
      expect(calls[0]!.url).toContain('clientCompanyName=Acme')
      expect(calls[0]!.url).toContain('contactEmail=jane%40acme.example')
      expect(candidates).toHaveLength(1)
      expect(candidates[0]!.isDefaultPick).toBe(true)
    })

    it('returns empty array when no candidates match', async () => {
      const { context } = makeStubContext(() => ({
        status: 200,
        body: { ok: true, candidates: [] },
      }))
      const { listGoldenRuleCandidatesFixture } = await import('../testing/integration')
      const candidates = await listGoldenRuleCandidatesFixture(context, 'staff-jwt', {
        clientCompanyName: 'Nonexistent Inc',
      })
      expect(candidates).toEqual([])
    })
  })
})
