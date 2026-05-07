/**
 * B5 saga retry dashboard link helpers (POST-MVP follow-up wiring
 * SPEC-2026-04-23-attribution-loop.md §8.1 — saga retry/cancel).
 *
 * These pure helpers live in their own module so unit tests can lock down
 * the contract surface (correlation-key shape, frozen workflowId, response
 * picker) without pulling in React or the full B5 page render tree, mirroring
 * the `reasonDialog.ts` / `classifyDialogKey` split used by the existing
 * `reasonDialog.test.ts` and `confirmDialog.test.ts` files.
 *
 * Saga correlation key shape: `{licenseDealId}:{attributionSource}` — see
 * `licenseDealCorrelationKey()` in `data/validators.ts`.
 *
 * Frozen workflowId: `prm.license_deal.attribution_saga` — see
 * `src/modules/prm/workflows/license-deal-attribution.json`.
 */

/**
 * Builds the `/api/workflows/instances?...` lookup URL for a given
 * LicenseDeal's attribution saga.
 */
export function buildSagaInstanceLookupUrl(input: {
  licenseDealId: string
  attributionSource: string
}): string {
  const params = new URLSearchParams({
    workflowId: 'prm.license_deal.attribution_saga',
    correlationKey: `${input.licenseDealId}:${input.attributionSource}`,
    limit: '1',
  })
  return `/api/workflows/instances?${params.toString()}`
}

/**
 * Picks the first workflow instance id from the `/api/workflows/instances`
 * response (`{ data: [{ id, ... }, ...] }`). Returns `null` for empty /
 * malformed responses (e.g. older deals attributed before the saga existed,
 * or a workflow runtime that's disabled).
 */
export function pickFirstSagaInstanceId(
  response: { data?: Array<{ id?: unknown }> } | null | undefined,
): string | null {
  const first = response?.data?.[0]
  if (!first) return null
  const id = first.id
  return typeof id === 'string' && id.length > 0 ? id : null
}
