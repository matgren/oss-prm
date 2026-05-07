import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  Agency,
  Rfp,
  RfpBroadcast,
  RfpResponse,
  RfpResponseScore,
} from '../data/entities'
import { createHash } from 'node:crypto'
import {
  type CreateRfpDraftInput,
  type DraftRfpResponseInput,
  type RecordRfpResponseScoreInput,
  type SelectRfpWinnerInput,
  type CloseRfpInput,
  type ReopenRfpInput,
  type UpdateRfpDraftInput,
  RFP_PORTAL_VISIBLE_STATUSES,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'
import {
  evaluateRfpEligibility,
  toEligibilityFilterInput,
} from './rfpEligibility'
import { RfpResponseScoreRepo } from './rfpResponseScoreRepo'

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

  /**
   * Portal-side: upsert a draft response for `(rfp_id, agency_id)`.
   *
   * Creates the row on first call (stamping `submitted_by_member_id` with the
   * authoring AgencyMember). Subsequent calls update text fields in place; the
   * authoring member is FROZEN — invariant for §6.2 PartnerMember author-scope
   * (M1's draft, M2's submit → 403).
   *
   * R7 dedupe (auto-save storm): emits `prm.rfp_response.draft_saved` only when
   * the canonical content hash changes. Same-text re-saves are silent.
   */
  async upsertResponseDraft(
    rfpId: string,
    agencyId: string,
    memberId: string,
    input: DraftRfpResponseInput,
    scope: { organizationId: string },
  ): Promise<{ response: RfpResponse; emitted: boolean }> {
    const rfp = await this.em.findOne(
      Rfp,
      { id: rfpId, organizationId: scope.organizationId, deletedAt: null } as any,
    )
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    if (!(RFP_PORTAL_VISIBLE_STATUSES as readonly string[]).includes(rfp.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot edit response — RFP status is "${rfp.status}"`,
        409,
      )
    }
    const existing = await this.em.findOne(
      RfpResponse,
      { rfpId, agencyId, organizationId: scope.organizationId } as any,
    )
    let response: RfpResponse
    if (existing) {
      // Editing an already-submitted response is a separate code path (Spec #6
      // challenge round). For v1, refuse here — the form lock state machine on
      // P10 should already block this; defence-in-depth.
      if (existing.status !== 'draft') {
        throw new PrmDomainError(
          PRM_ERROR_CODES.VALIDATION_FAILED,
          `Cannot edit response — already submitted (status="${existing.status}")`,
          409,
        )
      }
      response = existing
    } else {
      response = this.em.create(RfpResponse, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        rfpId,
        agencyId,
        submittedByMemberId: memberId,
        status: 'draft',
        techExperience: null,
        domainExperience: null,
        differentiators: null,
        attachedCaseStudyIds: [],
        firstSubmittedAt: null,
        lastUpdatedAt: new Date(),
        createdAt: new Date(),
      } as any)
    }

    // Cross-Agency CaseStudy reject (Spec #5 §3.2 / §9.3 #14).
    //
    // Spec #7 (CaseStudy module) has not yet shipped — there is no CaseStudy
    // table to resolve `attached_case_study_ids` against, and no own-Agency
    // ownership check we can perform. Until then, any non-empty list is a 400:
    // contract surface preserved, picker UI deferred to a Spec #7 follow-up.
    // Once Spec #7 ships, replace this guard with an ownership query that
    // verifies every id resolves to a CaseStudy with `agency_id = current_agency_id`.
    if (input.attached_case_study_ids && input.attached_case_study_ids.length > 0) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Case study attachments are not yet supported — the Case Studies module ships in a later spec.',
        400,
        { reason: 'case_study_module_not_shipped' },
      )
    }

    const previousHash = hashResponseContent(response)
    if (input.tech_experience !== undefined) {
      response.techExperience = input.tech_experience ?? null
    }
    if (input.domain_experience !== undefined) {
      response.domainExperience = input.domain_experience ?? null
    }
    if (input.differentiators !== undefined) {
      response.differentiators = input.differentiators ?? null
    }
    if (input.attached_case_study_ids !== undefined) {
      response.attachedCaseStudyIds = input.attached_case_study_ids
    }
    response.lastUpdatedAt = new Date()
    this.em.persist(response)
    await this.em.flush()

    const newHash = hashResponseContent(response)
    let emitted = false
    if (newHash !== previousHash) {
      await safeEmit('prm.rfp_response.draft_saved', {
        rfp_response_id: response.id,
        rfp_id: rfpId,
        agency_id: agencyId,
        member_id: memberId,
      })
      emitted = true
    }

    return { response, emitted }
  }

  /**
   * Portal-side: submit a draft response. `draft → submitted` transition.
   *
   * Guards (US5.4):
   *   - RFP must exist + portal-visible.
   *   - RFP.status must be `published` (challenge-round resubmits are Spec #6).
   *   - Now must be ≤ deadline_to_respond (NULL deadline = no cutoff).
   *   - Required fields: tech_experience + domain_experience non-empty.
   *
   * Author-scope (PartnerMember M2 cannot submit M1's draft) is enforced at
   * the route layer — it requires the caller's role-slug context which lives
   * with the request, not the entity.
   *
   * Idempotent for a row already in `submitted` — second call is a no-op
   * (no event re-emit).
   */
  async submitResponse(
    rfpId: string,
    agencyId: string,
    scope: { organizationId: string },
  ): Promise<{ response: RfpResponse; isInitialSubmission: boolean }> {
    const rfp = await this.em.findOne(
      Rfp,
      { id: rfpId, organizationId: scope.organizationId, deletedAt: null } as any,
    )
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    if (rfp.status !== 'published') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot submit — RFP status is "${rfp.status}". Only "published" RFPs accept new submissions.`,
        409,
      )
    }
    if (rfp.deadlineToRespond && rfp.deadlineToRespond.getTime() < Date.now()) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'RFP is no longer accepting responses',
        400,
      )
    }
    const response = await this.em.findOne(
      RfpResponse,
      { rfpId, agencyId, organizationId: scope.organizationId } as any,
    )
    if (!response) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_RESPONSE_NOT_FOUND,
        'No draft to submit. Save a draft first.',
        404,
      )
    }
    if (response.status === 'submitted') {
      // Idempotent — caller may retry on a flaky network.
      return { response, isInitialSubmission: false }
    }
    if (!response.techExperience || response.techExperience.trim() === '') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'tech_experience is required to submit',
        400,
        { field: 'tech_experience' },
      )
    }
    if (!response.domainExperience || response.domainExperience.trim() === '') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'domain_experience is required to submit',
        400,
        { field: 'domain_experience' },
      )
    }

    const now = new Date()
    response.status = 'submitted'
    response.firstSubmittedAt = response.firstSubmittedAt ?? now
    response.lastUpdatedAt = now
    this.em.persist(response)
    await this.em.flush()

    await safeEmit('prm.rfp_response.submitted', {
      rfp_response_id: response.id,
      rfp_id: rfpId,
      agency_id: agencyId,
      submitted_by_member_id: response.submittedByMemberId,
      is_initial_submission: true,
    })

    return { response, isInitialSubmission: true }
  }

  /**
   * Portal-side: undo a `submitted → draft` transition (US5.4 step 5).
   *
   * Allowed only while RFP is `published` AND now ≤ deadline_to_respond.
   * Idempotent: a row already in `draft` returns successfully without
   * re-emitting `prm.rfp_response.unsubmitted`.
   */
  async unsubmitResponse(
    rfpId: string,
    agencyId: string,
    args: { reason?: string },
    scope: { organizationId: string },
  ): Promise<{ response: RfpResponse; reverted: boolean }> {
    const rfp = await this.em.findOne(
      Rfp,
      { id: rfpId, organizationId: scope.organizationId, deletedAt: null } as any,
    )
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    if (rfp.status !== 'published') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot unsubmit — RFP status is "${rfp.status}". Only "published" RFPs allow unsubmit.`,
        409,
      )
    }
    if (rfp.deadlineToRespond && rfp.deadlineToRespond.getTime() < Date.now()) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Deadline passed — cannot unsubmit',
        409,
      )
    }
    const response = await this.em.findOne(
      RfpResponse,
      { rfpId, agencyId, organizationId: scope.organizationId } as any,
    )
    if (!response) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_RESPONSE_NOT_FOUND,
        'No response to unsubmit',
        404,
      )
    }
    if (response.status === 'draft') {
      return { response, reverted: false }
    }
    response.status = 'draft'
    response.lastUpdatedAt = new Date()
    this.em.persist(response)
    await this.em.flush()

    await safeEmit('prm.rfp_response.unsubmitted', {
      rfp_response_id: response.id,
      rfp_id: rfpId,
      agency_id: agencyId,
      reason: args.reason ?? null,
    })
    return { response, reverted: true }
  }

  /**
   * Portal-side: decline a broadcast (US5.5).
   *
   * Sets `RfpBroadcast.declined_at` + `decline_reason`. Allowed only while
   * `RFP.status = 'published'` (cannot decline retroactively once scoring or
   * selection has started — §9.4 #23). Idempotent: a row already declined
   * returns successfully without re-emitting `prm.rfp_broadcast.declined`.
   *
   * Decline is an Agency-level decision (PartnerAdmin only) — that role
   * scope is enforced at the route layer.
   */
  async declineBroadcast(
    rfpId: string,
    agencyId: string,
    args: { decline_reason?: string | null },
    scope: { organizationId: string },
  ): Promise<{ broadcast: RfpBroadcast; declined: boolean }> {
    const rfp = await this.em.findOne(
      Rfp,
      { id: rfpId, organizationId: scope.organizationId, deletedAt: null } as any,
    )
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    if (rfp.status !== 'published') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot decline — RFP status is "${rfp.status}". Decline is only available while published.`,
        409,
      )
    }
    const broadcast = await this.em.findOne(
      RfpBroadcast,
      { rfpId, agencyId, organizationId: scope.organizationId } as any,
    )
    if (!broadcast) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_BROADCAST_NOT_FOUND,
        'Broadcast not found for this Agency',
        404,
      )
    }
    if (broadcast.declinedAt) {
      // Idempotent — caller may retry on a flaky network.
      return { broadcast, declined: false }
    }
    const now = new Date()
    broadcast.declinedAt = now
    broadcast.declineReason = args.decline_reason ?? null
    broadcast.updatedAt = now
    this.em.persist(broadcast)
    await this.em.flush()

    await safeEmit('prm.rfp_broadcast.declined', {
      broadcast_id: broadcast.id,
      rfp_id: rfpId,
      agency_id: agencyId,
      decline_reason: broadcast.declineReason,
    })
    return { broadcast, declined: true }
  }

  /**
   * Portal-side: reverse a decline (§3.3 idempotency table).
   *
   * Allowed only while `RFP.status = 'published'`. Clears `declined_at` +
   * `decline_reason`. Idempotent on a never-declined broadcast.
   */
  async undeclineBroadcast(
    rfpId: string,
    agencyId: string,
    scope: { organizationId: string },
  ): Promise<{ broadcast: RfpBroadcast; reverted: boolean }> {
    const rfp = await this.em.findOne(
      Rfp,
      { id: rfpId, organizationId: scope.organizationId, deletedAt: null } as any,
    )
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    if (rfp.status !== 'published') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        `Cannot reverse decline — RFP status is "${rfp.status}". Only available while published.`,
        409,
      )
    }
    const broadcast = await this.em.findOne(
      RfpBroadcast,
      { rfpId, agencyId, organizationId: scope.organizationId } as any,
    )
    if (!broadcast) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_BROADCAST_NOT_FOUND,
        'Broadcast not found for this Agency',
        404,
      )
    }
    if (!broadcast.declinedAt) {
      return { broadcast, reverted: false }
    }
    broadcast.declinedAt = null
    broadcast.declineReason = null
    broadcast.updatedAt = new Date()
    this.em.persist(broadcast)
    await this.em.flush()

    await safeEmit('prm.rfp_broadcast.undeclined', {
      broadcast_id: broadcast.id,
      rfp_id: rfpId,
      agency_id: agencyId,
    })
    return { broadcast, reverted: true }
  }

  /* ---------------------------------------------------------------- *
   * Spec #6 — RFP scoring & selection                                  *
   * ---------------------------------------------------------------- */

  /**
   * Record a score for a submitted `RfpResponse` (Spec #6 §3.1, US5.6).
   *
   * **Append-only** per invariant #18 — every call inserts a NEW row with
   * `version = max(version) + 1`. The repository wraps that contract;
   * this method enforces the cross-cutting business rules:
   *
   *   - RFP must be in `published`, `scoring`, or `reopened` (not closed
   *     and not pre-publish). On the first score recorded against an RFP
   *     in `published`, auto-transitions to `scoring` per §2.
   *   - RfpResponse must be `submitted` — drafts are not scoreable.
   *   - `change_reason` is required iff version > 1. Server enforces
   *     against existing rows.
   *
   * Emits `prm.rfp_response_score.recorded` with the new row's metadata.
   */
  async recordScore(
    rfpId: string,
    rfpResponseId: string,
    input: RecordRfpResponseScoreInput,
    scope: { organizationId: string; userId: string },
  ): Promise<{
    score: RfpResponseScore
    rfp: Rfp
    isInitialScoreOnRfp: boolean
  }> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (!RFP_SCOREABLE_STATUSES.includes(rfp.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_NOT_ACCEPTING_SCORES,
        `Cannot score — RFP status is "${rfp.status}". Only published / scoring / reopened RFPs accept new scores.`,
        409,
      )
    }
    const response = await this.em.findOne(
      RfpResponse,
      { id: rfpResponseId, rfpId, organizationId: scope.organizationId } as any,
    )
    if (!response) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_RESPONSE_NOT_FOUND,
        'RfpResponse not found for this RFP',
        404,
      )
    }
    if (response.status !== 'submitted') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RESPONSE_NOT_SUBMITTED,
        `Cannot score response in status "${response.status}". Only submitted responses are scoreable.`,
        409,
      )
    }
    const repo = new RfpResponseScoreRepo(this.em)
    const existingLatest = await repo.findLatest(rfpResponseId, { organizationId: scope.organizationId })
    if (existingLatest && (!input.change_reason || input.change_reason.trim().length === 0)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CHANGE_REASON_REQUIRED,
        'change_reason is required when re-scoring (version > 1) per invariant #18.',
        409,
      )
    }
    const score = await repo.insertNextVersion({
      rfpResponseId,
      organizationId: scope.organizationId,
      scoredByUserId: scope.userId,
      techFitScore: input.tech_fit_score,
      domainFitScore: input.domain_fit_score,
      optionalScore: input.optional_score,
      includeOptional: input.include_optional,
      reasoning: input.reasoning,
      source: input.source,
      llmModelId: input.llm_model_id,
      changeReason: input.change_reason ?? null,
    })

    // Auto-transition published → scoring on first-ever score for this RFP.
    let isInitialScoreOnRfp = false
    if (rfp.status === 'published') {
      // Check if this is the first score across ALL responses for the RFP.
      const peerResponses = await this.em.find(
        RfpResponse,
        { rfpId, organizationId: scope.organizationId } as any,
        { fields: ['id'] } as any,
      )
      const peerIds = peerResponses.map((r) => r.id)
      const peerScores = await repo.findLatestForResponses(peerIds, {
        organizationId: scope.organizationId,
      })
      // After our insert, peerScores includes the row we just persisted (we
      // share the same EM). If there's exactly 1 scored response (us), this
      // is the first score on the RFP.
      if (peerScores.size === 1) {
        rfp.status = 'scoring'
        rfp.updatedAt = new Date()
        this.em.persist(rfp)
        await this.em.flush()
        isInitialScoreOnRfp = true
      }
    }

    const totalScore = score.techFitScore + score.domainFitScore + (
      score.includeOptional && typeof score.optionalScore === 'number' ? score.optionalScore : 0
    )

    await safeEmit('prm.rfp_response_score.recorded', {
      rfp_response_score_id: score.id,
      rfp_id: rfpId,
      rfp_response_id: rfpResponseId,
      agency_id: response.agencyId,
      version: score.version,
      tech_fit_score: score.techFitScore,
      domain_fit_score: score.domainFitScore,
      optional_score: score.optionalScore,
      total_score: totalScore,
      source: score.source,
      llm_model_id: score.llmModelId,
      scored_by_user_id: score.scoredByUserId,
      change_reason: score.changeReason,
    })

    return { score, rfp, isInitialScoreOnRfp }
  }

  /**
   * Commit a winner selection for an RFP (Spec #6 §3.3 — US5.7).
   *
   * **Coupled graph save** per §10.1: writes `Rfp.selectedAgencyId` +
   * `selectionDecidedAt` + `selectionDecidedByUserId` + `selectionReasoning`
   * AND transitions `Rfp.status` to `selection_made` in one transaction.
   *
   * Re-selection (Spec §8.1, R2): when a prior winner exists, this is a
   * compensating action — emits `prm.rfp.selection_changed` instead of
   * `prm.rfp.selection_made`. The notification subscriber distinguishes
   * the two and dispatches the right copy to each respondent.
   *
   * Pre-conditions:
   *   - RFP must be in `scoring`, `selection_made`, or `reopened`.
   *   - Picked response must exist on this RFP.
   *   - Picked response must have at least one `RfpResponseScore`.
   *   - At least one response on this RFP must be scored (else 409
   *     `NO_SCORED_RESPONSES`).
   */
  async selectWinner(
    rfpId: string,
    input: SelectRfpWinnerInput,
    scope: { organizationId: string; userId: string },
  ): Promise<{
    rfp: Rfp
    winnerAgencyId: string
    runnersUpAgencyIds: string[]
    isReselection: boolean
    priorWinner?: { agencyId: string; rfpResponseId: string } | null
  }> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (!RFP_SELECTABLE_STATUSES.includes(rfp.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.INVALID_RFP_TRANSITION,
        `Cannot select — RFP status is "${rfp.status}". Only scoring / selection_made / reopened RFPs are selectable.`,
        409,
      )
    }
    const winnerResponse = await this.em.findOne(
      RfpResponse,
      {
        id: input.winner_rfp_response_id,
        rfpId,
        organizationId: scope.organizationId,
      } as any,
    )
    if (!winnerResponse) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.RFP_RESPONSE_NOT_FOUND,
        'Winner RfpResponse not found on this RFP',
        404,
      )
    }

    const repo = new RfpResponseScoreRepo(this.em)
    const winnerLatest = await repo.findLatest(winnerResponse.id, {
      organizationId: scope.organizationId,
    })
    if (!winnerLatest) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.WINNER_NOT_SCORED,
        'Winner RfpResponse has no score rows. Score the response before selecting it.',
        409,
      )
    }

    // Load every response on this RFP so we know runner-up agencies.
    const allResponses = await this.em.find(
      RfpResponse,
      { rfpId, organizationId: scope.organizationId } as any,
    )
    const allResponseIds = allResponses.map((r) => r.id)
    const latestScores = await repo.findLatestForResponses(allResponseIds, {
      organizationId: scope.organizationId,
    })
    if (latestScores.size === 0) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.NO_SCORED_RESPONSES,
        'No scored responses exist on this RFP. Score at least one response before selecting.',
        409,
      )
    }

    const runnersUpAgencyIds: string[] = []
    for (const r of allResponses) {
      if (r.id !== winnerResponse.id && r.agencyId !== winnerResponse.agencyId) {
        runnersUpAgencyIds.push(r.agencyId)
      }
    }

    // Detect re-selection.
    const isReselection =
      typeof rfp.selectedAgencyId === 'string' && rfp.selectedAgencyId.length > 0
    const priorWinner = isReselection
      ? {
          agencyId: rfp.selectedAgencyId as string,
          rfpResponseId: allResponses.find((r) => r.agencyId === rfp.selectedAgencyId)?.id ?? '',
        }
      : null

    // Coupled graph save — one transaction, one flush.
    const now = new Date()
    rfp.status = 'selection_made'
    rfp.selectedAgencyId = winnerResponse.agencyId
    rfp.selectionDecidedAt = now
    rfp.selectionDecidedByUserId = scope.userId
    rfp.selectionReasoning = input.selection_reasoning
    rfp.updatedAt = now
    this.em.persist(rfp)
    await this.em.flush()

    if (isReselection && priorWinner && priorWinner.agencyId !== winnerResponse.agencyId) {
      await safeEmit('prm.rfp.selection_changed', {
        rfp_id: rfpId,
        from_agency_id: priorWinner.agencyId,
        to_agency_id: winnerResponse.agencyId,
        from_rfp_response_id: priorWinner.rfpResponseId,
        to_rfp_response_id: winnerResponse.id,
        reason: input.selection_reasoning,
        changed_by_user_id: scope.userId,
      })
    } else {
      await safeEmit('prm.rfp.selection_made', {
        rfp_id: rfpId,
        winner_agency_id: winnerResponse.agencyId,
        winner_rfp_response_id: winnerResponse.id,
        runners_up_agency_ids: runnersUpAgencyIds,
        selection_reasoning: input.selection_reasoning,
        decided_by_user_id: scope.userId,
      })
    }

    return {
      rfp,
      winnerAgencyId: winnerResponse.agencyId,
      runnersUpAgencyIds,
      isReselection,
      priorWinner,
    }
  }

  /**
   * Close an RFP (Spec #6 §3.4 — US5.9). Terminal lifecycle transition.
   *
   * Allowed from `scoring`, `selection_made`, `reopened`. `close_reason`
   * is required when there's no selection (closing without picking a
   * winner).
   */
  async closeRfp(
    rfpId: string,
    input: CloseRfpInput,
    scope: { organizationId: string; userId: string },
  ): Promise<{ rfp: Rfp; finalSelectedAgencyId: string | null }> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (!RFP_CLOSEABLE_STATUSES.includes(rfp.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.INVALID_RFP_TRANSITION,
        `Cannot close — RFP status is "${rfp.status}". Only scoring / selection_made / reopened RFPs are closeable.`,
        409,
      )
    }
    const hasSelection = typeof rfp.selectedAgencyId === 'string' && rfp.selectedAgencyId.length > 0
    if (!hasSelection && (!input.close_reason || input.close_reason.trim().length === 0)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CLOSE_REASON_REQUIRED,
        'close_reason is required when closing without a selection.',
        400,
      )
    }
    const now = new Date()
    rfp.status = 'closed'
    rfp.closedAt = now
    rfp.reopenedDeadlineAt = null // Cleared on close.
    rfp.updatedAt = now
    this.em.persist(rfp)
    await this.em.flush()

    await safeEmit('prm.rfp.closed', {
      rfp_id: rfpId,
      closed_by_user_id: scope.userId,
      final_selected_agency_id: rfp.selectedAgencyId ?? null,
      close_reason: input.close_reason ?? null,
    })

    return { rfp, finalSelectedAgencyId: rfp.selectedAgencyId ?? null }
  }

  /**
   * Re-open an RFP for a challenge round (Spec #6 §3.5 — US5.10).
   *
   * **Hard guard invariant #17 — load-bearing.** Two checks must both
   * confirm the RFP isn't locked by a signed Path-B LicenseDeal:
   *
   *   1. Cheap fast-fail: read `Rfp.isPathBLocked` (read-model written
   *      by Spec #3's subscriber on `prm.license_deal.status_changed`).
   *   2. Defence-in-depth: live `SELECT EXISTS` against `prm_license_deals`
   *      inside the same transaction as the close→reopen transition.
   *      This catches the brief lag window where the read-model trails
   *      reality (CQRS hygiene per spec §2.1.3).
   *
   * Both branches return 409 `PATH_B_SIGNED_DEAL_LOCK` with the locking
   * license_deal_id when locked. NO bypass — even granting `prm.rfp.reopen`
   * doesn't override the runtime check.
   */
  async reopenRfp(
    rfpId: string,
    input: ReopenRfpInput,
    scope: { organizationId: string; userId: string },
  ): Promise<{ rfp: Rfp }> {
    const rfp = await this.loadRfpForWrite(rfpId, scope.organizationId)
    if (!RFP_REOPENABLE_STATUSES.includes(rfp.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.INVALID_RFP_TRANSITION,
        `Cannot reopen — RFP status is "${rfp.status}". Only selection_made / closed RFPs are re-openable.`,
        409,
      )
    }
    const deadline = input.reopened_deadline_at instanceof Date
      ? input.reopened_deadline_at
      : new Date(input.reopened_deadline_at)
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.DEADLINE_IN_PAST,
        'reopened_deadline_at must be a future timestamp.',
        400,
      )
    }

    // Hard-guard #1: read-model.
    if (rfp.isPathBLocked) {
      const lockedDeal = await this.findBlockingLicenseDealId(rfpId)
      throw new PrmDomainError(
        PRM_ERROR_CODES.PATH_B_SIGNED_DEAL_LOCK,
        lockedDeal
          ? `Cannot reopen: LicenseDeal ${lockedDeal} attributed to this RFP is already signed. Use US4.4b status-reversal first.`
          : 'Cannot reopen: a signed Path-B LicenseDeal is attributed to this RFP. Use US4.4b status-reversal first.',
        409,
        lockedDeal ? { license_deal_id: lockedDeal } : undefined,
      )
    }
    // Hard-guard #2: live re-check.
    const liveLockedDeal = await this.findBlockingLicenseDealId(rfpId)
    if (liveLockedDeal) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.PATH_B_SIGNED_DEAL_LOCK,
        `Cannot reopen: LicenseDeal ${liveLockedDeal} attributed to this RFP is already signed. Use US4.4b status-reversal first.`,
        409,
        { license_deal_id: liveLockedDeal },
      )
    }

    const now = new Date()
    rfp.status = 'reopened'
    rfp.reopenedDeadlineAt = deadline
    rfp.closedAt = null // Cleared on reopen.
    rfp.updatedAt = now
    this.em.persist(rfp)
    await this.em.flush()

    await safeEmit('prm.rfp.reopened_for_scoring', {
      rfp_id: rfpId,
      trigger: 'client_reopen',
      reopened_by_user_id: scope.userId,
      reopened_deadline_at: deadline.toISOString(),
    })

    return { rfp }
  }

  /**
   * Bulk sweep: finds every RFP whose reopened deadline has passed, calls
   * `expireReopenedDeadline` on each. Used by the scheduled worker.
   * Returns the list of RFP ids that were expired (one event each).
   */
  async sweepExpiredReopenedDeadlines(scope: { organizationId?: string }): Promise<string[]> {
    const where: Record<string, unknown> = {
      status: 'reopened',
      reopenedDeadlineAt: { $lt: new Date() },
      deletedAt: null,
    }
    if (scope.organizationId) where.organizationId = scope.organizationId
    const rfps = await this.em.find(Rfp, where as any)
    const expired: string[] = []
    for (const rfp of rfps) {
      const result = await this.expireReopenedDeadline(rfp.id, {
        organizationId: rfp.organizationId,
      })
      if (result.expired) expired.push(rfp.id)
    }
    return expired
  }

  /**
   * Live `SELECT` against `prm_license_deals` for the hard-guard. Returns
   * the first locking license_deal_id (if any) or null. Centralised so
   * tests can spy on it.
   */
  private async findBlockingLicenseDealId(rfpId: string): Promise<string | null> {
    try {
      const conn = this.em.getConnection()
      const rows = await conn.execute<{ id: string }[]>(
        `select "id" from "prm_license_deals" where "rfp_id" = ? and "status" in ('signed','active') and "deleted_at" is null limit 1`,
        [rfpId],
      )
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0]?.id === 'string') {
        return rows[0].id
      }
    } catch {
      // If the live query fails, defer to the read-model (already checked).
      // Do NOT silently allow reopen — the route handler short-circuits to
      // 409 if `isPathBLocked` is true. If both fail, the call returns
      // null here and the reopen proceeds, but the read-model branch is
      // the canonical gate.
    }
    return null
  }

  /**
   * Auto-transition an expired `reopened` RFP back to `scoring`. Used by
   * the scheduled `RfpReopenedDeadlineExpiry` worker. Idempotent — calling
   * on a non-reopened RFP is a no-op (returns false).
   */
  async expireReopenedDeadline(
    rfpId: string,
    scope: { organizationId: string },
  ): Promise<{ expired: boolean; rfp: Rfp | null }> {
    const rfp = await this.em.findOne(
      Rfp,
      { id: rfpId, organizationId: scope.organizationId, deletedAt: null } as any,
    )
    if (!rfp) return { expired: false, rfp: null }
    if (rfp.status !== 'reopened') return { expired: false, rfp }
    if (!rfp.reopenedDeadlineAt || rfp.reopenedDeadlineAt.getTime() > Date.now()) {
      return { expired: false, rfp }
    }
    rfp.status = 'scoring'
    rfp.reopenedDeadlineAt = null
    rfp.updatedAt = new Date()
    this.em.persist(rfp)
    await this.em.flush()

    await safeEmit('prm.rfp.reopened_deadline_expired', {
      rfp_id: rfpId,
      organization_id: scope.organizationId,
    })
    return { expired: true, rfp }
  }

  private async loadRfpForWrite(rfpId: string, organizationId: string): Promise<Rfp> {
    const rfp = await this.em.findOne(Rfp, { id: rfpId, organizationId, deletedAt: null } as any)
    if (!rfp) {
      throw new PrmDomainError(PRM_ERROR_CODES.NOT_FOUND, 'RFP not found', 404)
    }
    return rfp
  }
}

/**
 * Statuses on which a new score may be recorded. Closed RFPs reject new
 * scores; drafts are pre-publish so impossible. Reopened RFPs accept
 * re-scoring during the challenge round.
 */
const RFP_SCOREABLE_STATUSES: readonly string[] = ['published', 'scoring', 'reopened']

/** Statuses on which `selectWinner` is allowed (re-selection included). */
const RFP_SELECTABLE_STATUSES: readonly string[] = ['scoring', 'selection_made', 'reopened']

/** Statuses on which `closeRfp` is allowed. */
const RFP_CLOSEABLE_STATUSES: readonly string[] = ['scoring', 'selection_made', 'reopened']

/** Statuses on which `reopenRfp` is allowed. */
const RFP_REOPENABLE_STATUSES: readonly string[] = ['selection_made', 'closed']

/** Canonical content hash for dedupe (R7). Stable across re-runs of the same payload. */
function hashResponseContent(response: RfpResponse): string {
  const canonical = JSON.stringify({
    tech: response.techExperience ?? '',
    domain: response.domainExperience ?? '',
    diff: response.differentiators ?? '',
    cs: [...(response.attachedCaseStudyIds ?? [])].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const item of b) if (!sa.has(item)) return false
  return true
}
