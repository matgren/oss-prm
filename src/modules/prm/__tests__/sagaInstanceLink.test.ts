import {
  buildSagaInstanceLookupUrl,
  pickFirstSagaInstanceId,
} from '../backend/prm/license-deals/[id]/sagaInstanceLink'

/**
 * Unit tests for the B5 saga retry dashboard link helpers (POST-MVP follow-up
 * wiring SPEC-2026-04-23-attribution-loop.md §8.1 — saga retry/cancel).
 *
 * These tests lock down the *contract* surface used by the `<SagaInstanceLink>`
 * component without mounting React (this project's jest env intentionally
 * avoids jsdom — see `confirmDialog.test.ts` and `reasonDialog.test.ts` for
 * the established pattern).
 *
 * What this file specifically locks down:
 *   - The correlation-key shape MUST stay `{license_deal_id}:{attribution_source}`
 *     because that is what `attributionSaga.ts` uses to correlate workflow
 *     instances back to a LicenseDeal.
 *   - The workflowId MUST stay `prm.license_deal.attribution_saga` (the
 *     workflow definition's frozen `workflowId` per
 *     `src/modules/prm/workflows/license-deal-attribution.json`).
 *   - The component renders nothing when no instance is found — empty data,
 *     missing data array, malformed id, etc.
 */
describe('SagaInstanceLink helpers — B5 saga retry dashboard wiring', () => {
  describe('buildSagaInstanceLookupUrl', () => {
    it('builds a URL with the frozen workflowId + correlation-key shape', () => {
      const url = buildSagaInstanceLookupUrl({
        licenseDealId: 'ld-123',
        attributionSource: 'prospect',
      })
      const parsed = new URL(`http://example.com${url}`)
      expect(parsed.pathname).toBe('/api/workflows/instances')
      expect(parsed.searchParams.get('workflowId')).toBe(
        'prm.license_deal.attribution_saga',
      )
      expect(parsed.searchParams.get('correlationKey')).toBe('ld-123:prospect')
      expect(parsed.searchParams.get('limit')).toBe('1')
    })

    it.each([
      ['prospect', 'ld-A:prospect'],
      ['rfp', 'ld-A:rfp'],
      ['direct', 'ld-A:direct'],
    ])('encodes Path %s attribution source into the correlation key', (source, expected) => {
      const url = buildSagaInstanceLookupUrl({
        licenseDealId: 'ld-A',
        attributionSource: source,
      })
      const parsed = new URL(`http://example.com${url}`)
      expect(parsed.searchParams.get('correlationKey')).toBe(expected)
    })

    it('URL-encodes deal ids that contain reserved characters', () => {
      const url = buildSagaInstanceLookupUrl({
        licenseDealId: 'ld with space&amp',
        attributionSource: 'prospect',
      })
      // URLSearchParams encodes the value, so the raw URL is still safe.
      const parsed = new URL(`http://example.com${url}`)
      expect(parsed.searchParams.get('correlationKey')).toBe(
        'ld with space&amp:prospect',
      )
    })
  })

  describe('pickFirstSagaInstanceId', () => {
    it('returns the first instance id when the API returns at least one row', () => {
      expect(
        pickFirstSagaInstanceId({
          data: [
            { id: 'wf-instance-1' },
            { id: 'wf-instance-2' },
          ],
        }),
      ).toBe('wf-instance-1')
    })

    it('returns null on an empty data array (no saga ever started)', () => {
      expect(pickFirstSagaInstanceId({ data: [] })).toBeNull()
    })

    it('returns null when the response shape is malformed', () => {
      expect(pickFirstSagaInstanceId(null)).toBeNull()
      expect(pickFirstSagaInstanceId(undefined)).toBeNull()
      expect(pickFirstSagaInstanceId({} as any)).toBeNull()
      expect(pickFirstSagaInstanceId({ data: undefined } as any)).toBeNull()
    })

    it('returns null when the first row is missing a string id', () => {
      expect(
        pickFirstSagaInstanceId({ data: [{ id: undefined }] } as any),
      ).toBeNull()
      expect(pickFirstSagaInstanceId({ data: [{ id: 123 }] } as any)).toBeNull()
      expect(pickFirstSagaInstanceId({ data: [{ id: '' }] } as any)).toBeNull()
    })
  })

  describe('contract: link href construction', () => {
    it('the resulting `/backend/workflows/instances/{id}` href round-trips through both helpers', () => {
      const apiResponse = {
        data: [
          {
            id: '11111111-2222-3333-4444-555555555555',
            workflowId: 'prm.license_deal.attribution_saga',
          },
        ],
      }
      const id = pickFirstSagaInstanceId(apiResponse)
      expect(id).toBe('11111111-2222-3333-4444-555555555555')
      const href = `/backend/workflows/instances/${id}`
      expect(href).toBe(
        '/backend/workflows/instances/11111111-2222-3333-4444-555555555555',
      )
    })

    it('does NOT construct a href when no instance was found', () => {
      const id = pickFirstSagaInstanceId({ data: [] })
      // Component logic: `if (!instanceId) return null`.
      expect(id).toBeNull()
    })
  })
})
