import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Rfp, RfpBroadcast } from '../data/entities'
import { RFP_PORTAL_VISIBLE_STATUSES } from '../data/validators'

/**
 * Visibility gate for portal RFP routes — Spec #5 invariant #15 (R3).
 *
 * Every `GET /api/prm/portal/rfp/*` route MUST funnel through
 * `assertBroadcastedOrNotFound` before reading any RFP-shaped data.
 *
 * The gate intentionally returns a *byte-identical* 404 envelope regardless
 * of the failure cause:
 *   - Malformed UUID
 *   - RFP doesn't exist for this tenant
 *   - RFP exists but is in a non-portal-visible status (`draft` / `closed`)
 *   - RFP is published, but this Agency was not in the broadcast set
 *
 * That uniform shape is the load-bearing privacy property: a partner Agency
 * cannot probe `GET /api/prm/portal/rfp/{guess}` to distinguish "RFP exists
 * but you can't see it" from "RFP doesn't exist". Any deviation (extra hint
 * in the body, different status code, different content-length) breaks the
 * silent-404 invariant. Tested against a fake-UUID baseline in §9.2 #7.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const NOT_FOUND_BODY = { ok: false as const, error: 'Not found' as const }

export type RfpVisibilityFailureReason =
  | 'invalid_id'
  | 'rfp_not_found'
  | 'rfp_not_portal_visible'
  | 'broadcast_not_found'

export class RfpVisibilityNotFoundError extends Error {
  constructor(public readonly reason: RfpVisibilityFailureReason) {
    super('RFP not visible')
    this.name = 'RfpVisibilityNotFoundError'
  }
}

/**
 * Returns the canonical 404 NextResponse used by every portal RFP route.
 * Centralised so byte-identity is guaranteed across all callers.
 */
export function rfpNotFoundResponse(): NextResponse {
  return NextResponse.json(NOT_FOUND_BODY, { status: 404 })
}

/**
 * Asserts that `agencyId` was broadcasted to `rfpId` AND the RFP is in a
 * portal-visible status. Throws `RfpVisibilityNotFoundError` on any failure
 * — caller catches and converts to `rfpNotFoundResponse()`.
 *
 * Returns the loaded `{ rfp, broadcast }` so callers don't have to re-query.
 */
export async function assertBroadcastedOrNotFound(
  rfpId: string,
  agencyId: string,
  em: EntityManager,
  scope: { organizationId: string },
): Promise<{ rfp: Rfp; broadcast: RfpBroadcast }> {
  if (!UUID_REGEX.test(rfpId)) {
    throw new RfpVisibilityNotFoundError('invalid_id')
  }
  const rfp = await em.findOne(Rfp, {
    id: rfpId,
    organizationId: scope.organizationId,
    deletedAt: null,
  } as any)
  if (!rfp) {
    throw new RfpVisibilityNotFoundError('rfp_not_found')
  }
  if (!(RFP_PORTAL_VISIBLE_STATUSES as readonly string[]).includes(rfp.status)) {
    // Draft or closed — invisible to every Agency.
    throw new RfpVisibilityNotFoundError('rfp_not_portal_visible')
  }
  const broadcast = await em.findOne(RfpBroadcast, {
    rfpId,
    agencyId,
    organizationId: scope.organizationId,
  } as any)
  if (!broadcast) {
    throw new RfpVisibilityNotFoundError('broadcast_not_found')
  }
  return { rfp, broadcast }
}
