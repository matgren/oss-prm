import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  Agency,
  Rfp,
  RfpBroadcast,
  RfpResponse,
} from '../data/entities'
import {
  type CreateRfpDraftInput,
  type UpdateRfpDraftInput,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'
import {
  evaluateRfpEligibility,
  toEligibilityFilterInput,
} from './rfpEligibility'

/**
 * Domain helper for RFP authoring + broadcast (Spec #5).
 *
 * Owns the `Rfp` aggregate's lifecycle commands:
 *   - `createDraft`     — status starts at `draft`.
 *   - `updateDraft`     — only allowed while `status = 'draft'`.
 *   - `publish`         — `draft → published`, runs eligibility evaluator, writes
 *                         N `RfpBroadcast` rows (UNIQUE `(rfp_id, agency_id)`),
 *                         emits one `prm.rfp.published` + N
 *                         `prm.rfp_broadcast.created` events.
 *   - `unpublish`       — undo of publish; refuses if any broadcast has
 *                         interacted (R6 audit-integrity mitigation).
 *
 * Portal-side methods (`stampFirstOpened`, `draftResponse`, `submitResponse`,
 * `declineBroadcast`, etc.) land in subsequent commits as those routes ship.
 */
export class RfpService {
  constructor(private readonly em: EntityManager) {}

  async createDraft(
    input: CreateRfpDraftInput,
    scope: { tenantId: string; organizationId: string; userId: string },
  ): Promise<Rfp> {
    const rfp = this.em.create(Rfp, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      title: input.title,
      receivedFrom: input.received_from,
      receivedAt: input.received_at,
      description: input.description,
      techRequirements: input.tech_requirements,
      domainRequirements: input.domain_requirements,
      industry: input.industry ?? null,
      budgetBucket: input.budget_bucket ?? null,
      timelineBucket: input.timeline_bucket ?? null,
      requiredCapabilities: input.required_capabilities ?? [],
      additionalCriterionName: input.additional_criterion_name ?? null,
      deadlineToRespond: input.deadline_to_respond ?? null,
      eligibilityFilter: input.eligibility_filter,
      minTier: input.min_tier ?? null,
      explicitAgencyIds: input.explicit_agency_ids ?? null,
      notes: input.notes ?? null,
      status: 'draft',
      isPathBLocked: false,
      createdByUserId: scope.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    this.em.persist(rfp)
    await this.em.flush()

    await safeEmit('prm.rfp.created', {
      rfp_id: rfp.id,
      created_by_user_id: scope.userId,
      organization_id: rfp.organizationId,
    })

    return rfp
  }

  async updateDraft(
    rfpId: string,
    input: UpdateRfpDraftInput,
    scope: { organizationId: string },
  ): Promise<Rfp> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (rfp.status !== 'draft') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot edit RFP — status is "${rfp.status}" (only draft is editable)`,
        409,
      )
    }
    const changed: string[] = []
    if (input.title !== undefined && input.title !== rfp.title) {
      rfp.title = input.title
      changed.push('title')
    }
    if (input.received_from !== undefined && input.received_from !== rfp.receivedFrom) {
      rfp.receivedFrom = input.received_from
      changed.push('received_from')
    }
    if (input.received_at !== undefined) {
      rfp.receivedAt = input.received_at
      changed.push('received_at')
    }
    if (input.description !== undefined && input.description !== rfp.description) {
      rfp.description = input.description
      changed.push('description')
    }
    if (input.tech_requirements !== undefined && input.tech_requirements !== rfp.techRequirements) {
      rfp.techRequirements = input.tech_requirements
      changed.push('tech_requirements')
    }
    if (
      input.domain_requirements !== undefined &&
      input.domain_requirements !== rfp.domainRequirements
    ) {
      rfp.domainRequirements = input.domain_requirements
      changed.push('domain_requirements')
    }
    if (input.industry !== undefined) {
      rfp.industry = input.industry ?? null
      changed.push('industry')
    }
    if (input.budget_bucket !== undefined) {
      rfp.budgetBucket = input.budget_bucket ?? null
      changed.push('budget_bucket')
    }
    if (input.timeline_bucket !== undefined) {
      rfp.timelineBucket = input.timeline_bucket ?? null
      changed.push('timeline_bucket')
    }
    if (input.required_capabilities !== undefined) {
      rfp.requiredCapabilities = input.required_capabilities ?? []
      changed.push('required_capabilities')
    }
    if (input.additional_criterion_name !== undefined) {
      rfp.additionalCriterionName = input.additional_criterion_name ?? null
      changed.push('additional_criterion_name')
    }
    if (input.deadline_to_respond !== undefined) {
      rfp.deadlineToRespond = input.deadline_to_respond ?? null
      changed.push('deadline_to_respond')
    }
    if (input.eligibility_filter !== undefined && input.eligibility_filter !== rfp.eligibilityFilter) {
      rfp.eligibilityFilter = input.eligibility_filter
      changed.push('eligibility_filter')
    }
    if (input.min_tier !== undefined) {
      rfp.minTier = input.min_tier ?? null
      changed.push('min_tier')
    }
    if (input.explicit_agency_ids !== undefined) {
      rfp.explicitAgencyIds = input.explicit_agency_ids ?? null
      changed.push('explicit_agency_ids')
    }
    if (input.notes !== undefined) {
      rfp.notes = input.notes ?? null
      changed.push('notes')
    }
    rfp.updatedAt = new Date()
    this.em.persist(rfp)
    await this.em.flush()

    if (changed.length > 0) {
      await safeEmit('prm.rfp.updated', {
        rfp_id: rfp.id,
        changed_field_names: changed,
      })
    }
    return rfp
  }

  /**
   * `draft → published`. Runs the eligibility evaluator, writes N broadcast rows,
   * emits `prm.rfp.published` once + `prm.rfp_broadcast.created` per agency.
   *
   * Optional `confirmedAgencyIds` lets the UI guard against the eligibility set
   * shifting between preview and publish (e.g. a new Agency onboarded in between).
   * If supplied and != the evaluator's output, returns 409 — the UI must re-confirm.
   *
   * Refuses with 409 if zero eligible agencies (per §9.1 #3) — prevents creating
   * a published RFP with no audience.
   */
  async publish(
    rfpId: string,
    args: { confirmedAgencyIds?: string[] },
    scope: { tenantId: string; organizationId: string; userId: string },
  ): Promise<{ rfp: Rfp; broadcastAgencyIds: string[] }> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (rfp.status !== 'draft') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot publish — RFP status is "${rfp.status}" (only draft is publishable)`,
        409,
      )
    }

    // Pull the active onboarded agencies for this tenant. Tenant-scoped — Spec §6.1
    // analog (RFPs are per-tenant; the eligibility roster is the tenant's roster).
    const candidateAgencies = await findWithDecryption<Agency>(
      this.em,
      Agency,
      {
        tenantId: scope.tenantId,
        status: 'active',
        onboarded: true,
        deletedAt: null,
      } as any,
      { fields: ['id', 'tier'] as never },
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )

    const eligibilityFilter = toEligibilityFilterInput(rfp)
    const broadcastAgencyIds = evaluateRfpEligibility(eligibilityFilter, candidateAgencies)

    if (broadcastAgencyIds.length === 0) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Cannot publish — zero eligible agencies match the eligibility filter',
        409,
        { broadcast_count: 0 },
      )
    }

    if (args.confirmedAgencyIds && !sameSet(args.confirmedAgencyIds, broadcastAgencyIds)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Eligibility set drifted since preview — refresh and re-confirm',
        409,
        {
          confirmed: args.confirmedAgencyIds.sort(),
          actual: [...broadcastAgencyIds].sort(),
        },
      )
    }

    // Write broadcasts in one flush. The UNIQUE on (rfp_id, agency_id) makes
    // accidental dupes impossible; per-row commit semantics are not needed here
    // because publish is a single-RFP fan-out, not a streaming import.
    const broadcasts: RfpBroadcast[] = []
    const now = new Date()
    for (const agencyId of broadcastAgencyIds) {
      const broadcast = this.em.create(RfpBroadcast, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        rfpId: rfp.id,
        agencyId,
        broadcastAt: now,
        firstOpenedAt: null,
        declinedAt: null,
        declineReason: null,
        createdAt: now,
        updatedAt: now,
      } as any)
      this.em.persist(broadcast)
      broadcasts.push(broadcast)
    }
    rfp.status = 'published'
    rfp.publishedAt = now
    rfp.updatedAt = now
    this.em.persist(rfp)
    await this.em.flush()

    await safeEmit('prm.rfp.published', {
      rfp_id: rfp.id,
      broadcast_agency_ids: broadcastAgencyIds,
      eligibility_filter: rfp.eligibilityFilter,
      broadcast_count: broadcastAgencyIds.length,
      published_at: now.toISOString(),
      published_by_user_id: scope.userId,
    })

    for (const broadcast of broadcasts) {
      await safeEmit('prm.rfp_broadcast.created', {
        broadcast_id: broadcast.id,
        rfp_id: rfp.id,
        agency_id: broadcast.agencyId,
      })
    }

    return { rfp, broadcastAgencyIds }
  }

  /**
   * Undo of publish. Refuses if any broadcast has interacted (R6) — preserves
   * audit trail. Deletes only "untouched" broadcasts (no first_opened_at, no
   * declined_at, and no associated RfpResponse).
   */
  async unpublish(
    rfpId: string,
    args: { reason: string },
    scope: { organizationId: string; userId: string },
  ): Promise<Rfp> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (rfp.status !== 'published') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot unpublish — RFP status is "${rfp.status}" (only published is undoable)`,
        409,
      )
    }
    // Block if any broadcast has been interacted with.
    const interacted = await this.em.find(
      RfpBroadcast,
      { rfpId, organizationId: scope.organizationId } as any,
    )
    const hasInteractions = interacted.some(
      (b) => b.firstOpenedAt !== null || b.declinedAt !== null,
    )
    if (hasInteractions) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Cannot unpublish — at least one agency has already opened or declined the broadcast',
        409,
      )
    }
    // Block if any RfpResponse has been written (defence-in-depth — first_opened_at
    // implies the form was visited but not necessarily that a response exists; a
    // direct response POST would still be blocked even if first_opened_at was
    // somehow null).
    const responses = await this.em.find(
      RfpResponse,
      { rfpId, organizationId: scope.organizationId } as any,
    )
    if (responses.length > 0) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Cannot unpublish — at least one agency has saved or submitted a response',
        409,
      )
    }

    // Safe to wipe broadcasts.
    for (const broadcast of interacted) {
      this.em.remove(broadcast)
    }
    rfp.status = 'draft'
    rfp.publishedAt = null
    rfp.updatedAt = new Date()
    this.em.persist(rfp)
    await this.em.flush()

    await safeEmit('prm.rfp.unpublished', {
      rfp_id: rfp.id,
      reason: args.reason,
      unpublished_by_user_id: scope.userId,
    })
    return rfp
  }

  /**
   * Idempotent first-open side-effect for the portal P10 GET (US5.3 §3.3).
   *
   * Stamps `RfpBroadcast.first_opened_at = now()` only on the first call
   * (`first_opened_at IS NULL`); subsequent calls are no-ops. Emits
   * `prm.rfp_broadcast.first_opened` exactly once per broadcast row.
   *
   * Race-safety: uses `nativeUpdate` with a `firstOpenedAt = null` predicate
   * so concurrent stamps degrade to "first writer wins"; the affected-row
   * count gates the event emission so we never double-emit.
   */
  async markBroadcastFirstOpened(
    broadcast: RfpBroadcast,
    scope: { organizationId: string },
  ): Promise<{ stamped: boolean }> {
    if (broadcast.firstOpenedAt) return { stamped: false }
    const now = new Date()
    const affected = await this.em.nativeUpdate(
      RfpBroadcast,
      {
        id: broadcast.id,
        organizationId: scope.organizationId,
        firstOpenedAt: null,
      } as any,
      { firstOpenedAt: now, updatedAt: now } as any,
    )
    if (affected === 0) return { stamped: false }
    // Reflect the change locally so the same EM doesn't return a stale view.
    broadcast.firstOpenedAt = now
    broadcast.updatedAt = now

    await safeEmit('prm.rfp_broadcast.first_opened', {
      broadcast_id: broadcast.id,
      rfp_id: broadcast.rfpId,
      agency_id: broadcast.agencyId,
      first_opened_at: now.toISOString(),
    })
    return { stamped: true }
  }

  private async loadRfpForWrite(rfpId: string, organizationId: string): Promise<Rfp> {
    const rfp = await this.em.findOne(Rfp, { id: rfpId, organizationId, deletedAt: null } as any)
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    return rfp
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const item of b) if (!sa.has(item)) return false
  return true
}
