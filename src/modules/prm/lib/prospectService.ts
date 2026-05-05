import type { EntityManager } from '@mikro-orm/postgresql'
import {
  findAndCountWithDecryption,
  findOneWithDecryption,
  findWithDecryption,
} from '@open-mercato/shared/lib/encryption/find'
import { Agency, AgencyMember, Prospect } from '../data/entities'
import {
  PROSPECT_TRANSITIONS,
  PROSPECT_PORTAL_TRANSITIONS,
  type ListProspectsBackendInput,
  type ListProspectsPortalInput,
  type ProspectSource,
  type ProspectStatus,
  type RegisterProspectInput,
  type UpdateProspectEditInput,
  normalizeCompanyName,
  normalizeContactEmail,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'

export type ProspectActor =
  | { type: 'customer_user'; agencyMemberId: string; isPartnerAdmin: boolean; customerUserId: string }
  | { type: 'user'; userId: string }
  | { type: 'system'; reason: string }

/** Type-narrowing helper — `Array.prototype.includes` widens past `ProspectPortalTransition`. */
function isPortalAllowedTransition(target: ProspectStatus): boolean {
  return (PROSPECT_PORTAL_TRANSITIONS as readonly string[]).includes(target)
}

/**
 * Domain helper for the `Prospect` aggregate (Spec #2 — wip-scoreboard).
 *
 * Conventions (mirrors `AgencyService`):
 *   - Request-scoped EM (transactional with the request).
 *   - All find/findOne paths use the encryption helpers (T0 lesson H3).
 *   - All event emissions go through `safeEmit` (T0 lesson M1).
 *   - Cross-module references use FK IDs, never `@ManyToOne` relations.
 *
 * State machine (invariant #12) is enforced via `PROSPECT_TRANSITIONS` map plus the
 * additional `won` actor guard (`won` is reachable only by `actor.type = 'system'`).
 */
export class ProspectService {
  constructor(private readonly em: EntityManager) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findById(id: string, scope: { tenantId: string }): Promise<Prospect | null> {
    return findOneWithDecryption(
      this.em,
      Prospect,
      { id, tenantId: scope.tenantId, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
  }

  async listForAgency(
    input: ListProspectsPortalInput,
    scope: { tenantId: string; agencyId: string },
  ): Promise<{ items: Prospect[]; total: number }> {
    const where: Record<string, unknown> = {
      tenantId: scope.tenantId,
      agencyId: scope.agencyId,
      deletedAt: null,
    }
    if (input.status) where.status = input.status
    if (input.source) where.source = input.source
    if (input.registeredMonth) {
      const [year, month] = input.registeredMonth.split('-').map(Number)
      const start = new Date(Date.UTC(year, month - 1, 1))
      const end = new Date(Date.UTC(year, month, 1))
      where.registeredAt = { $gte: start, $lt: end }
    }
    const [items, total] = await findAndCountWithDecryption(
      this.em,
      Prospect,
      where as any,
      {
        orderBy: { registeredAt: 'desc' as const, id: 'desc' as const },
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      },
      { tenantId: scope.tenantId },
    )
    return { items, total }
  }

  async listCrossAgency(
    input: ListProspectsBackendInput,
    scope: { tenantId: string },
  ): Promise<{ items: Prospect[]; total: number }> {
    const where: Record<string, unknown> = {
      tenantId: scope.tenantId,
      deletedAt: null,
    }
    if (input.agencyId) where.agencyId = input.agencyId
    if (input.status) where.status = input.status
    // Note: normalizedCompanyName / lowercasedContactEmail filters are applied at the
    // route level via the projection table join (B4 read path). The service-layer
    // helper covers the simple agency/status filters; the projection join is built
    // separately in the API route using a raw query against `prm_prospect_candidate_index`.
    const [items, total] = await findAndCountWithDecryption(
      this.em,
      Prospect,
      where as any,
      {
        orderBy: { registeredAt: 'asc' as const, id: 'asc' as const }, // Golden-rule oldest-first
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      },
      { tenantId: scope.tenantId },
    )
    return { items, total }
  }

  /**
   * Compute the set of statuses an actor may transition the given Prospect to.
   * Used by API routes to populate `can_transition_to` in responses.
   */
  computeAllowedTransitions(prospect: Prospect, actor: ProspectActor): ProspectStatus[] {
    const allowed = PROSPECT_TRANSITIONS[prospect.status as ProspectStatus] ?? []
    return allowed.filter((next) => this.actorCanReach(prospect, actor, next))
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Register a new Prospect (US3.1). Aggregate precondition: owning Agency must be `active`.
   * Emits `prm.prospect.registered` on success with the normalized keys derived inline.
   */
  async register(
    input: RegisterProspectInput,
    scope: {
      tenantId: string
      organizationId: string
      agencyId: string
      registeredByAgencyMemberId: string
    },
  ): Promise<Prospect> {
    const agency = await findOneWithDecryption(
      this.em,
      Agency,
      { id: scope.agencyId, tenantId: scope.tenantId, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
    if (!agency) {
      throw new PrmDomainError(PRM_ERROR_CODES.AGENCY_NOT_FOUND, 'Agency not found', 404)
    }
    if (agency.status !== 'active') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.AGENCY_HISTORICAL,
        'Your Agency is historical — contact OM PartnerOps',
        409,
      )
    }

    // Defence-in-depth: the registering member must belong to the agency.
    const member = await findOneWithDecryption(
      this.em,
      AgencyMember,
      {
        id: scope.registeredByAgencyMemberId,
        agencyId: scope.agencyId,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
      undefined,
      { tenantId: scope.tenantId },
    )
    if (!member) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.AGENCY_MEMBER_NOT_FOUND,
        'Agency member not found in this agency',
        403,
      )
    }

    const now = new Date()
    const prospect = this.em.create(Prospect, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      agencyId: scope.agencyId,
      registeredByAgencyMemberId: scope.registeredByAgencyMemberId,
      companyName: input.companyName,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      source: input.source,
      status: 'new',
      lostReason: null,
      notes: input.notes ?? null,
      registeredAt: now,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    } as any)
    this.em.persist(prospect)
    await this.em.flush()

    await safeEmit(
      'prm.prospect.registered',
      {
        prospectId: prospect.id,
        agencyId: prospect.agencyId,
        organizationId: prospect.organizationId,
        tenantId: prospect.tenantId,
        registeredAt: prospect.registeredAt.toISOString(),
        source: prospect.source,
        normalizedCompanyName: normalizeCompanyName(prospect.companyName),
        lowercasedContactEmail: normalizeContactEmail(prospect.contactEmail),
        registeredByAgencyMemberId: prospect.registeredByAgencyMemberId,
        status: prospect.status,
      },
      { context: { prospectId: prospect.id, agencyId: prospect.agencyId } },
    )

    return prospect
  }

  /**
   * Apply an editable patch (US3.2). `registered_at` and `status` are intentionally
   * absent from the editable surface — invariant #1 + state-machine integrity.
   *
   * Returns `{ changedFields }` so the caller can surface only the actual diff in
   * the API response. Emits `prm.prospect.updated` only when at least one field changed.
   */
  async update(
    id: string,
    patch: Omit<UpdateProspectEditInput, 'kind'>,
    scope: { tenantId: string; actor: ProspectActor },
  ): Promise<{ prospect: Prospect; changedFields: string[] }> {
    const prospect = await this.findById(id, scope)
    if (!prospect) {
      throw new PrmDomainError(PRM_ERROR_CODES.PROSPECT_NOT_FOUND, 'Prospect not found', 404)
    }

    // Author-scope check for partner_member (invariant #12 C4).
    if (
      scope.actor.type === 'customer_user' &&
      !scope.actor.isPartnerAdmin &&
      prospect.registeredByAgencyMemberId !== scope.actor.agencyMemberId
    ) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.NOT_AUTHOR_OR_ADMIN,
        'Only the author or your PartnerAdmin can edit this Prospect',
        403,
      )
    }

    const changedFields: string[] = []
    if (typeof patch.companyName === 'string' && patch.companyName !== prospect.companyName) {
      prospect.companyName = patch.companyName
      changedFields.push('companyName')
    }
    if (typeof patch.contactName === 'string' && patch.contactName !== prospect.contactName) {
      prospect.contactName = patch.contactName
      changedFields.push('contactName')
    }
    if (typeof patch.contactEmail === 'string' && patch.contactEmail !== prospect.contactEmail) {
      prospect.contactEmail = patch.contactEmail
      changedFields.push('contactEmail')
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
      const next = patch.notes ?? null
      if (next !== (prospect.notes ?? null)) {
        prospect.notes = next
        changedFields.push('notes')
      }
    }

    if (changedFields.length === 0) {
      return { prospect, changedFields }
    }

    prospect.updatedAt = new Date()
    await this.em.flush()

    await safeEmit(
      'prm.prospect.updated',
      {
        prospectId: prospect.id,
        agencyId: prospect.agencyId,
        organizationId: prospect.organizationId,
        tenantId: prospect.tenantId,
        changedFields,
        changedAt: prospect.updatedAt.toISOString(),
        // Always include normalized keys so the projection subscriber can recompute
        // even when only contactEmail or companyName changed (idempotent UPSERT).
        normalizedCompanyName: normalizeCompanyName(prospect.companyName),
        lowercasedContactEmail: normalizeContactEmail(prospect.contactEmail),
      },
      { context: { prospectId: prospect.id } },
    )

    return { prospect, changedFields }
  }

  /**
   * Transition a Prospect's status (US3.2). Enforces invariant #12 + the `won`
   * system-actor carve-out + author-scope (C4) + optimistic concurrency on
   * `status_changed_at`.
   */
  async transitionStatus(
    id: string,
    input: {
      toStatus: ProspectStatus
      lostReason?: string | null
      ifMatchStatusChangedAt?: string | null
      reason?: string | null
    },
    scope: { tenantId: string; actor: ProspectActor },
  ): Promise<Prospect> {
    const prospect = await this.findById(id, scope)
    if (!prospect) {
      throw new PrmDomainError(PRM_ERROR_CODES.PROSPECT_NOT_FOUND, 'Prospect not found', 404)
    }

    // Optimistic concurrency.
    if (
      input.ifMatchStatusChangedAt &&
      input.ifMatchStatusChangedAt !== prospect.statusChangedAt.toISOString()
    ) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CONFLICT,
        'Prospect was modified by another user — refresh and retry',
        409,
      )
    }

    const fromStatus = prospect.status as ProspectStatus
    const toStatus = input.toStatus

    // No-op same-status protection.
    if (fromStatus === toStatus) {
      return prospect
    }

    // Author-scope check (invariant #12 C4) — applies to all customer_user transitions.
    if (
      scope.actor.type === 'customer_user' &&
      !scope.actor.isPartnerAdmin &&
      prospect.registeredByAgencyMemberId !== scope.actor.agencyMemberId
    ) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.NOT_AUTHOR_OR_ADMIN,
        'Only the author or your PartnerAdmin can transition this Prospect',
        403,
      )
    }

    // `won` is system-only.
    if (toStatus === 'won' && scope.actor.type !== 'system') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.WON_IS_OM_ONLY,
        "'won' is assigned by OM Partner Operations at license attribution.",
        403,
      )
    }

    // Reachability per state-machine (invariant #12).
    const allowed = PROSPECT_TRANSITIONS[fromStatus] ?? []
    if (!allowed.includes(toStatus)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.INVALID_TRANSITION,
        'Prospect status transition not allowed',
        409,
        { fromStatus, toStatus },
      )
    }

    // Customer users may only target the portal-allowed subset.
    if (scope.actor.type === 'customer_user' && !isPortalAllowedTransition(toStatus)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.INVALID_TRANSITION,
        'Portal users cannot perform this transition',
        409,
      )
    }

    // `lost_reason` is required iff target is `lost`.
    if (toStatus === 'lost') {
      const reasonText = (input.lostReason ?? '').trim()
      if (reasonText.length < 10) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.LOST_REASON_REQUIRED,
          'A lost_reason of at least 10 characters is required when marking a Prospect as lost.',
          400,
          { field: 'lost_reason' },
        )
      }
      prospect.lostReason = reasonText
    }

    const now = new Date()
    prospect.status = toStatus
    prospect.statusChangedAt = now
    prospect.updatedAt = now
    await this.em.flush()

    const actorMeta = this.actorPayload(scope.actor)
    await safeEmit(
      'prm.prospect.status_changed',
      {
        prospectId: prospect.id,
        agencyId: prospect.agencyId,
        organizationId: prospect.organizationId,
        tenantId: prospect.tenantId,
        fromStatus,
        toStatus,
        byActorType: actorMeta.byActorType,
        byActorId: actorMeta.byActorId,
        reason: input.reason ?? null,
        changedAt: now.toISOString(),
      },
      { context: { prospectId: prospect.id, fromStatus, toStatus } },
    )

    return prospect
  }

  /**
   * Soft-delete (undo of `register`). Used when a registered Prospect must be reverted
   * (e.g., the saga determined it was a duplicate). Emits the compensating event so the
   * projection subscriber removes the candidate-index row.
   */
  async revertRegistration(
    id: string,
    scope: { tenantId: string },
  ): Promise<Prospect | null> {
    const prospect = await this.findById(id, scope)
    if (!prospect) return null
    prospect.deletedAt = new Date()
    prospect.updatedAt = new Date()
    await this.em.flush()
    await safeEmit(
      'prm.prospect.registration_reverted',
      {
        prospectId: prospect.id,
        agencyId: prospect.agencyId,
        organizationId: prospect.organizationId,
        tenantId: prospect.tenantId,
      },
      { context: { prospectId: prospect.id } },
    )
    return prospect
  }

  /**
   * Cross-agency candidate lookup (B4 / Spec #3 attribution-loop).
   * Reads against the projection table to leverage the normalized keys.
   *
   * Spec calls this out as a B4 join, but to keep the `prm_prospect_candidate_index`
   * table the single source of truth for candidate ordering we use it directly.
   */
  async findCandidatesByNormalizedKey(
    input: { normalizedCompanyName?: string; lowercasedContactEmail?: string; agencyId?: string; limit: number },
    scope: { tenantId: string },
  ): Promise<Prospect[]> {
    const knex = this.em.getKnex()
    const query = knex('prm_prospect_candidate_index as ix')
      .join('prm_prospects as p', 'p.id', 'ix.prospect_id')
      .where('p.tenant_id', scope.tenantId)
      .whereNull('p.deleted_at')
      .orderBy('ix.registered_at', 'asc')
      .limit(input.limit)
      .select('p.id')
    if (input.normalizedCompanyName) {
      query.where('ix.normalized_company_name', input.normalizedCompanyName)
    }
    if (input.lowercasedContactEmail) {
      query.where('ix.lowercased_contact_email', input.lowercasedContactEmail)
    }
    if (input.agencyId) {
      query.where('ix.agency_id', input.agencyId)
    }
    const rows = (await query) as Array<{ id: string }>
    if (rows.length === 0) return []
    return findWithDecryption(
      this.em,
      Prospect,
      { id: { $in: rows.map((r) => r.id) }, tenantId: scope.tenantId, deletedAt: null } as any,
      undefined,
      { tenantId: scope.tenantId },
    )
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private actorCanReach(
    prospect: Prospect,
    actor: ProspectActor,
    target: ProspectStatus,
  ): boolean {
    if (target === 'won' && actor.type !== 'system') return false
    if (actor.type === 'customer_user' && !isPortalAllowedTransition(target)) {
      return false
    }
    if (
      actor.type === 'customer_user' &&
      !actor.isPartnerAdmin &&
      prospect.registeredByAgencyMemberId !== actor.agencyMemberId
    ) {
      return false
    }
    return true
  }

  private actorPayload(actor: ProspectActor): { byActorType: string; byActorId: string | null } {
    switch (actor.type) {
      case 'customer_user':
        return { byActorType: 'customer_user', byActorId: actor.customerUserId }
      case 'user':
        return { byActorType: 'user', byActorId: actor.userId }
      case 'system':
      default:
        return { byActorType: 'system', byActorId: null }
    }
  }
}

export default ProspectService

// Touch import to keep tree-shaker happy for shared array.
const _PROSPECT_SOURCE_GUARD: ProspectSource = 'agency_owned'
void _PROSPECT_SOURCE_GUARD
