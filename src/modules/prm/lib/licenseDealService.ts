import type { EntityManager } from '@mikro-orm/postgresql'
import {
  findAndCountWithDecryption,
  findOneWithDecryption,
  findWithDecryption,
} from '@open-mercato/shared/lib/encryption/find'
import { Agency, LicenseDeal, Prospect, ProspectCandidateIndex } from '../data/entities'
import {
  LICENSE_DEAL_TRANSITIONS,
  type AttributeLicenseDealInput,
  type CreateLicenseDealInput,
  type LicenseDealAttributionPath,
  type LicenseDealAttributionSource,
  type LicenseDealStatus,
  type ListLicenseDealsBackendInput,
  type ReverseLicenseDealInput,
  type TransitionLicenseDealStatusInput,
  type UnreverseLicenseDealStatusInput,
  type UpdateLicenseDealInput,
  isAttributionFrozen,
  licenseDealCorrelationKey,
  normalizeCompanyName,
  pathToAttributionSource,
} from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError } from './errors'
import { safeEmit } from './safeEmit'

/**
 * Actor performing a LicenseDeal mutation.
 *
 * `system` is reserved for the saga compensation handlers — they invoke
 * `transitionStatus` with `actor: { type: 'system', reason: '...' }`.
 */
export type LicenseDealActor =
  | { type: 'user'; userId: string }
  | { type: 'system'; reason: string }

export type AttributionResult = {
  licenseDeal: LicenseDeal
  correlationKey: string
  emittedEvents: string[]
}

/** Snapshot returned by the Golden Rule helper for B5's picker UX. */
export type GoldenRuleCandidate = {
  prospectId: string
  agencyId: string
  organizationId: string
  companyName: string
  contactName: string
  contactEmail: string
  status: string
  registeredAt: string
  registeredByAgencyMemberId: string
  isDefaultPick: boolean
}

/**
 * Domain helper for the `LicenseDeal` aggregate (Spec #3 — attribution-loop).
 *
 * Conventions (mirrors `ProspectService`):
 *   - Request-scoped EM (transactional with the request).
 *   - All find/findOne paths use the encryption helpers (T0 lesson H3).
 *   - All event emissions go through `safeEmit` (T0 lesson M1).
 *   - Cross-module references use FK IDs, never `@ManyToOne` relations.
 *
 * Invariant #7 is enforced here (application layer) and via a DB trigger
 * (defence-in-depth) installed by the indexes migration.
 */
export class LicenseDealService {
  constructor(private readonly em: EntityManager) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findById(id: string, scope: { tenantId: string }): Promise<LicenseDeal | null> {
    return findOneWithDecryption(
      this.em,
      LicenseDeal,
      { id, tenantId: scope.tenantId, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
  }

  async list(
    input: ListLicenseDealsBackendInput,
    scope: { tenantId: string },
  ): Promise<{ items: LicenseDeal[]; total: number }> {
    const where: Record<string, unknown> = {
      tenantId: scope.tenantId,
      deletedAt: null,
    }
    if (input.status) where.status = input.status
    if (input.attributionPath) where.attributionPath = input.attributionPath
    if (input.agencyId) where.attributedAgencyId = input.agencyId
    if (input.q) {
      where.$or = [
        { clientCompanyName: { $ilike: `%${input.q.replace(/[%_]/g, (c) => `\\${c}`)}%` } },
        { licenseIdentifier: { $ilike: `%${input.q.replace(/[%_]/g, (c) => `\\${c}`)}%` } },
      ]
    }
    const [items, total] = await findAndCountWithDecryption(
      this.em,
      LicenseDeal,
      where as any,
      {
        orderBy: { createdAt: 'desc' as const, id: 'desc' as const },
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      },
      { tenantId: scope.tenantId },
    )
    return { items, total }
  }

  /**
   * Aggregate sum of MIN contribution for an agency.
   * Counts deals where attribution snapshot points to the given agency AND status is
   * in the MIN-counting set (`active`, `signed`). Each deal contributes
   * `monthly_license_amount * 12` for the yearly view (App Spec §1.4.4 / L-011).
   */
  async listForMinWidget(
    scope: { tenantId: string; agencyId: string },
    options: { yearStart: Date; yearEnd: Date },
  ): Promise<LicenseDeal[]> {
    return findWithDecryption(
      this.em,
      LicenseDeal,
      {
        tenantId: scope.tenantId,
        attributedAgencyId: scope.agencyId,
        status: { $in: ['signed', 'active'] },
        deletedAt: null,
        // Count deals signed within the year window (MIN attribution year).
        $or: [
          { signedAt: { $gte: options.yearStart, $lt: options.yearEnd } },
          {
            signedAt: null,
            attributedAt: { $gte: options.yearStart, $lt: options.yearEnd },
          },
        ],
      } as any,
      { orderBy: { signedAt: 'desc' as const, attributedAt: 'desc' as const, id: 'desc' as const } },
      { tenantId: scope.tenantId },
    )
  }

  // -------------------------------------------------------------------------
  // Golden Rule candidate picker (invariant #14)
  // -------------------------------------------------------------------------

  /**
   * Return the Golden Rule candidate set for an attribution decision.
   * Matches Prospects in `prm_prospect_candidate_index` whose normalized company name
   * (or contact email when provided) matches the LicenseDeal client. ALL statuses
   * are returned — including `lost` per W12 — so the B5 picker can flag them with
   * a badge. Default pick = oldest non-lost `registered_at`.
   */
  async findGoldenRuleCandidates(
    input: { clientCompanyName: string; contactEmail?: string | null; limit?: number },
    scope: { tenantId: string },
  ): Promise<GoldenRuleCandidate[]> {
    const knex = this.em.getKnex()
    const normalizedKey = normalizeCompanyName(input.clientCompanyName)
    if (!normalizedKey) return []

    const query = knex('prm_prospect_candidate_index as ix')
      .join('prm_prospects as p', 'p.id', 'ix.prospect_id')
      .where('p.tenant_id', scope.tenantId)
      .whereNull('p.deleted_at')
      .where('ix.normalized_company_name', normalizedKey)
      .orderBy('ix.registered_at', 'asc')
      .limit(input.limit ?? 50)
      .select(
        'p.id as prospect_id',
        'p.agency_id',
        'p.organization_id',
        'p.company_name',
        'p.contact_name',
        'p.contact_email',
        'p.status',
        'p.registered_at',
        'p.registered_by_agency_member_id',
      )
    if (input.contactEmail && input.contactEmail.trim().length > 0) {
      query.orWhere(function () {
        this.where('p.tenant_id', scope.tenantId)
          .whereNull('p.deleted_at')
          .where('ix.lowercased_contact_email', input.contactEmail!.trim().toLowerCase())
      })
    }
    const rows = (await query) as Array<{
      prospect_id: string
      agency_id: string
      organization_id: string
      company_name: string
      contact_name: string
      contact_email: string
      status: string
      registered_at: Date | string
      registered_by_agency_member_id: string
    }>

    if (rows.length === 0) return []

    // Default pick = oldest non-lost row. If all are lost, default to oldest overall.
    const nonLost = rows.filter((r) => r.status !== 'lost')
    const defaultId = (nonLost[0] ?? rows[0]).prospect_id

    return rows.map((r) => ({
      prospectId: r.prospect_id,
      agencyId: r.agency_id,
      organizationId: r.organization_id,
      companyName: r.company_name,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      status: r.status,
      registeredAt:
        r.registered_at instanceof Date
          ? r.registered_at.toISOString()
          : new Date(r.registered_at).toISOString(),
      registeredByAgencyMemberId: r.registered_by_agency_member_id,
      isDefaultPick: r.prospect_id === defaultId,
    }))
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Generate the next `OM-YYYY-NNNN` identifier for the tenant. Scans existing
   * identifiers for the current year (including soft-deleted rows — the unique
   * index is not filtered by `deleted_at`) and returns `max+1` zero-padded to 4
   * digits. Returns `OM-YYYY-0001` when no prior identifier exists for the year.
   */
  async generateNextIdentifier(tenantId: string, asOf: Date = new Date()): Promise<string> {
    const year = asOf.getUTCFullYear()
    const prefix = `OM-${year}-`
    const knex = this.em.getKnex()
    const row = await knex('prm_license_deals')
      .where('tenant_id', tenantId)
      .where('license_identifier', 'like', `${prefix}%`)
      .max({ last: 'license_identifier' })
      .first()
    const last = (row?.last as string | null | undefined) ?? null
    let next = 1
    if (last) {
      const m = last.match(/^OM-\d{4}-(\d+)$/)
      if (m) next = Number(m[1]) + 1
    }
    return `${prefix}${String(next).padStart(4, '0')}`
  }

  /**
   * Create a `pending` LicenseDeal. NEVER auto-attributes — every attribution is
   * an explicit OM PartnerOps decision via `attribute()`.
   *
   * When `input.licenseIdentifier` is omitted, the server generates the next
   * `OM-YYYY-NNNN` and retries on race (up to 3 attempts) so concurrent creates
   * stay safe even without a SERIALIZABLE transaction.
   */
  async create(
    input: CreateLicenseDealInput,
    scope: { tenantId: string; organizationId: string; actor: LicenseDealActor },
  ): Promise<LicenseDeal> {
    const autoIdentifier = input.licenseIdentifier === undefined
    const maxAttempts = autoIdentifier ? 3 : 1
    let lastErr: unknown = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const licenseIdentifier = autoIdentifier
        ? await this.generateNextIdentifier(scope.tenantId)
        : (input.licenseIdentifier as string)
      try {
        return await this.createWithIdentifier(licenseIdentifier, input, scope)
      } catch (err) {
        lastErr = err
        if (
          autoIdentifier &&
          err instanceof PrmDomainError &&
          err.code === PRM_ERROR_CODES.LICENSE_IDENTIFIER_TAKEN
        ) {
          // Race with a concurrent create — recompute and retry.
          continue
        }
        throw err
      }
    }
    throw lastErr ?? new Error('Failed to allocate a license identifier after retries')
  }

  private async createWithIdentifier(
    licenseIdentifier: string,
    input: CreateLicenseDealInput,
    scope: { tenantId: string; organizationId: string; actor: LicenseDealActor },
  ): Promise<LicenseDeal> {
    // Uniqueness pre-check on the (tenant, license_identifier) UNIQUE.
    const existing = await findOneWithDecryption(
      this.em,
      LicenseDeal,
      { tenantId: scope.tenantId, licenseIdentifier, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
    if (existing) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LICENSE_IDENTIFIER_TAKEN,
        'A license deal with this identifier already exists.',
        409,
      )
    }

    const now = new Date()
    const deal = this.em.create(LicenseDeal, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      licenseIdentifier,
      clientCompanyName: input.clientCompanyName,
      clientIndustry: input.clientIndustry ?? null,
      type: input.type ?? 'enterprise',
      status: 'pending',
      isRenewal: input.isRenewal ?? false,
      previousLicenseDealId: input.previousLicenseDealId ?? null,
      annualValueUsd: stringifyDecimal(input.annualValueUsd ?? null),
      monthlyLicenseAmount: stringifyDecimal(input.monthlyLicenseAmount ?? null),
      attributionPath: 'none',
      attributionSource: 'direct',
      prospectId: null,
      rfpId: null,
      attributedAgencyId: null,
      attributionReasoning: null,
      attributedAt: null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    } as any)
    this.em.persist(deal)
    await this.em.flush()

    await safeEmit(
      'prm.license_deal.created',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        clientCompanyName: deal.clientCompanyName,
        isRenewal: deal.isRenewal,
        previousLicenseDealId: deal.previousLicenseDealId ?? null,
        status: deal.status,
      },
      { context: { licenseDealId: deal.id, actorType: scope.actor.type } },
    )

    return deal
  }

  async update(
    id: string,
    patch: UpdateLicenseDealInput,
    scope: { tenantId: string; actor: LicenseDealActor },
  ): Promise<LicenseDeal> {
    const deal = await this.findById(id, scope)
    if (!deal) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LICENSE_DEAL_NOT_FOUND,
        'License deal not found',
        404,
      )
    }
    if (patch.ifMatchVersion !== undefined && patch.ifMatchVersion !== deal.version) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CONFLICT,
        'License deal was modified by another user — refresh and retry',
        409,
      )
    }
    if (patch.licenseIdentifier !== undefined && patch.licenseIdentifier !== deal.licenseIdentifier) {
      // Uniqueness pre-check.
      const dup = await findOneWithDecryption(
        this.em,
        LicenseDeal,
        {
          tenantId: scope.tenantId,
          licenseIdentifier: patch.licenseIdentifier,
          deletedAt: null,
          id: { $ne: deal.id },
        } as any,
        undefined,
        { tenantId: scope.tenantId },
      )
      if (dup) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.LICENSE_IDENTIFIER_TAKEN,
          'A license deal with this identifier already exists.',
          409,
        )
      }
      deal.licenseIdentifier = patch.licenseIdentifier
    }
    if (patch.clientCompanyName !== undefined) deal.clientCompanyName = patch.clientCompanyName
    if (patch.clientIndustry !== undefined) deal.clientIndustry = patch.clientIndustry ?? null
    if (patch.type !== undefined) deal.type = patch.type
    if (patch.isRenewal !== undefined) deal.isRenewal = patch.isRenewal
    if (patch.previousLicenseDealId !== undefined)
      deal.previousLicenseDealId = patch.previousLicenseDealId ?? null
    if (patch.annualValueUsd !== undefined)
      deal.annualValueUsd = stringifyDecimal(patch.annualValueUsd ?? null)
    if (patch.monthlyLicenseAmount !== undefined)
      deal.monthlyLicenseAmount = stringifyDecimal(patch.monthlyLicenseAmount ?? null)
    if (patch.notes !== undefined) deal.notes = patch.notes ?? null

    deal.updatedAt = new Date()
    deal.version += 1
    await this.em.flush()
    return deal
  }

  /**
   * Soft-delete — only allowed while `status === 'pending'`.
   */
  async softDelete(
    id: string,
    scope: { tenantId: string; actor: LicenseDealActor },
  ): Promise<void> {
    const deal = await this.findById(id, scope)
    if (!deal) return
    if (deal.status !== 'pending') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CHANGE_NOT_ALLOWED,
        'Only pending license deals may be deleted.',
        409,
      )
    }
    deal.deletedAt = new Date()
    deal.updatedAt = new Date()
    await this.em.flush()
  }

  // -------------------------------------------------------------------------
  // Attribution
  // -------------------------------------------------------------------------

  /**
   * Apply attribution + transition `pending → signed`. Emits
   * `prm.license_deal.attributed` (drives the saga) and, when override is detected
   * for Path A, also `prm.license_deal.attribution_overridden`.
   */
  async attribute(
    id: string,
    input: AttributeLicenseDealInput,
    scope: { tenantId: string; actor: LicenseDealActor },
  ): Promise<AttributionResult> {
    const deal = await this.findById(id, scope)
    if (!deal) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LICENSE_DEAL_NOT_FOUND,
        'License deal not found',
        404,
      )
    }
    if (isAttributionFrozen(deal.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.ATTRIBUTION_FROZEN,
        "License deal is in a frozen state ('active'/'churned'). Use /unreverse-status first.",
        409,
      )
    }

    const path = input.attribution_path
    const source = pathToAttributionSource(path as LicenseDealAttributionPath)
    const emitted: string[] = []
    const now = new Date()
    let overrideEvent: {
      default: string
      selected: string
      fromAgencyId: string | null
      toAgencyId: string | null
      reason: string | null
    } | null = null

    if (path === 'A') {
      const prospect = await findOneWithDecryption(
        this.em,
        Prospect,
        { id: input.prospect_id, tenantId: scope.tenantId, deletedAt: null },
        undefined,
        { tenantId: scope.tenantId },
      )
      if (!prospect) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.PROSPECT_NOT_FOUND,
          'Prospect not found',
          404,
        )
      }
      // Server-side override detection: when the picked Prospect ≠ the default,
      // require `attribution_reasoning`.
      const isOverride = input.prospect_id !== input.golden_rule_default_prospect_id
      if (isOverride) {
        if (!input.attribution_reasoning || input.attribution_reasoning.trim().length === 0) {
          throw new PrmDomainError(
            PRM_ERROR_CODES.ATTRIBUTION_REASONING_REQUIRED,
            'attribution_reasoning is required when overriding the Golden Rule default.',
            422,
            { field: 'attribution_reasoning' },
          )
        }
        // Look up the default Prospect's agency to surface in the override event.
        const defaultProspect = await findOneWithDecryption(
          this.em,
          Prospect,
          {
            id: input.golden_rule_default_prospect_id,
            tenantId: scope.tenantId,
            deletedAt: null,
          },
          undefined,
          { tenantId: scope.tenantId },
        )
        overrideEvent = {
          default: input.golden_rule_default_prospect_id,
          selected: input.prospect_id,
          fromAgencyId: defaultProspect?.agencyId ?? null,
          toAgencyId: prospect.agencyId,
          reason: input.attribution_reasoning ?? null,
        }
      }

      deal.attributionPath = 'A'
      deal.attributionSource = 'prospect'
      deal.prospectId = prospect.id
      deal.rfpId = null
      deal.attributedAgencyId = prospect.agencyId
      deal.attributionReasoning = input.attribution_reasoning ?? null
    } else if (path === 'B') {
      // RFP table is owned by Spec #5 and may not yet exist. Best-effort lookup
      // via raw SQL with introspection — when the table is missing we simply
      // record the FK and let the saga snapshot when Spec #5 lands. Until then
      // the attribution writer is a placeholder.
      const rfpInfo = await tryLookupRfp(this.em, input.rfp_id, scope.tenantId)
      if (rfpInfo === 'table-missing') {
        // Best-effort placeholder: accept the rfp_id, defer agency snapshot until
        // Spec #5 ships and the saga re-fires.
        deal.attributionPath = 'B'
        deal.attributionSource = 'rfp'
        deal.rfpId = input.rfp_id
        deal.prospectId = null
        deal.attributedAgencyId = null
        deal.attributionReasoning = deal.attributionReasoning ?? null
      } else if (rfpInfo === null) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.RFP_NOT_AVAILABLE,
          'RFP not found or not selectable',
          404,
        )
      } else {
        deal.attributionPath = 'B'
        deal.attributionSource = 'rfp'
        deal.rfpId = rfpInfo.id
        deal.prospectId = null
        deal.attributedAgencyId = rfpInfo.selectedAgencyId
        deal.attributionReasoning = deal.attributionReasoning ?? null
      }
    } else if (path === 'C') {
      // Validate target agency exists + is active.
      const agency = await findOneWithDecryption(
        this.em,
        Agency,
        { id: input.attributed_agency_id, tenantId: scope.tenantId, deletedAt: null },
        undefined,
        { tenantId: scope.tenantId },
      )
      if (!agency) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.AGENCY_NOT_FOUND,
          'Agency not found',
          404,
        )
      }
      deal.attributionPath = 'C'
      deal.attributionSource = 'direct'
      deal.attributedAgencyId = agency.id
      deal.prospectId = null
      deal.rfpId = null
      deal.attributionReasoning = input.attribution_reasoning
    }

    // Transition pending → signed alongside attribution.
    const fromStatus = deal.status as LicenseDealStatus
    const toStatus: LicenseDealStatus = 'signed'
    if (fromStatus !== 'pending') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CHANGE_NOT_ALLOWED,
        'Only pending license deals may be attributed. Use /reverse for already-attributed deals.',
        409,
      )
    }
    deal.status = toStatus
    deal.signedAt = now
    deal.attributedAt = now
    deal.updatedAt = now
    deal.version += 1
    await this.em.flush()

    const correlationKey = licenseDealCorrelationKey(deal.id, source)

    await safeEmit(
      'prm.license_deal.attributed',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        attributionPath: path,
        attributionSource: source,
        attributedAgencyId: deal.attributedAgencyId ?? null,
        prospectId: deal.prospectId ?? null,
        rfpId: deal.rfpId ?? null,
        competingProspectIdsToRetire:
          path === 'A' ? input.competing_prospect_ids_to_retire : [],
        correlationKey,
        attributedAt: now.toISOString(),
      },
      { context: { licenseDealId: deal.id, attributionPath: path } },
    )
    emitted.push('prm.license_deal.attributed')

    if (overrideEvent) {
      await safeEmit(
        'prm.license_deal.attribution_overridden',
        {
          licenseDealId: deal.id,
          tenantId: deal.tenantId,
          organizationId: deal.organizationId,
          defaultProspectId: overrideEvent.default,
          selectedProspectId: overrideEvent.selected,
          fromAgencyId: overrideEvent.fromAgencyId,
          toAgencyId: overrideEvent.toAgencyId,
          reason: overrideEvent.reason,
          byActorType: scope.actor.type,
          byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
        },
        { context: { licenseDealId: deal.id } },
      )
      emitted.push('prm.license_deal.attribution_overridden')
    }

    await safeEmit(
      'prm.license_deal.status_changed',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        attributionPath: deal.attributionPath,
        attributionSource: deal.attributionSource,
        rfpId: deal.rfpId ?? null,
        attributedAgencyId: deal.attributedAgencyId ?? null,
        fromStatus,
        toStatus,
        byActorType: scope.actor.type,
        byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
        reason: null,
        changedAt: now.toISOString(),
      },
      { context: { licenseDealId: deal.id, fromStatus, toStatus } },
    )
    emitted.push('prm.license_deal.status_changed')

    return { licenseDeal: deal, correlationKey, emittedEvents: emitted }
  }

  // -------------------------------------------------------------------------
  // Reverse + unreverse-status (US4.4 / US4.4b)
  // -------------------------------------------------------------------------

  /**
   * Reverse attribution. Pre-condition: `status < active` (the caller must run
   * `/unreverse-status` first when status is active).
   *
   * Emits `prm.license_deal.reversal_started` first (drives the reverse saga's
   * compensation handlers via the workflows module wildcard subscriber); then
   * resets the aggregate to the new attribution (or to `pending` + `none` when
   * `newAttribution` is omitted).
   */
  async reverse(
    id: string,
    input: ReverseLicenseDealInput,
    scope: { tenantId: string; actor: LicenseDealActor },
  ): Promise<{ licenseDeal: LicenseDeal; emittedEvents: string[] }> {
    const deal = await this.findById(id, scope)
    if (!deal) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LICENSE_DEAL_NOT_FOUND,
        'License deal not found',
        404,
      )
    }
    if (isAttributionFrozen(deal.status)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.ATTRIBUTION_FROZEN,
        "License deal is in a frozen state ('active'/'churned'). Use /unreverse-status first.",
        409,
      )
    }

    const previousAttribution = {
      path: deal.attributionPath as LicenseDealAttributionPath,
      source: deal.attributionSource as LicenseDealAttributionSource,
      prospectId: deal.prospectId ?? null,
      rfpId: deal.rfpId ?? null,
      attributedAgencyId: deal.attributedAgencyId ?? null,
    }

    const emitted: string[] = []
    const now = new Date()

    // Phase 1: emit reversal_started so the reverse saga / compensation runs.
    await safeEmit(
      'prm.license_deal.reversal_started',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        previousAttribution,
        reason: input.reason,
        byActorType: scope.actor.type,
        byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
      },
      { context: { licenseDealId: deal.id } },
    )
    emitted.push('prm.license_deal.reversal_started')

    // Phase 2: reset the aggregate. The compensation handlers (subscribers) take
    // care of Prospect→qualified rollback for previous Path A attributions.
    const fromStatus = deal.status as LicenseDealStatus
    deal.attributionPath = 'none'
    deal.attributionSource = 'direct'
    deal.prospectId = null
    deal.rfpId = null
    deal.attributedAgencyId = null
    deal.attributionReasoning = null
    deal.attributedAt = null
    deal.signedAt = null
    deal.status = 'pending'
    deal.updatedAt = now
    deal.version += 1
    await this.em.flush()

    await safeEmit(
      'prm.license_deal.reversed',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        previousAttribution,
        reason: input.reason,
        byActorType: scope.actor.type,
        byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
      },
      { context: { licenseDealId: deal.id } },
    )
    emitted.push('prm.license_deal.reversed')

    if (fromStatus !== 'pending') {
      await safeEmit(
        'prm.license_deal.status_changed',
        {
          licenseDealId: deal.id,
          tenantId: deal.tenantId,
          organizationId: deal.organizationId,
          attributionPath: deal.attributionPath,
          attributionSource: deal.attributionSource,
          rfpId: deal.rfpId ?? null,
          attributedAgencyId: deal.attributedAgencyId ?? null,
          fromStatus,
          toStatus: 'pending',
          byActorType: scope.actor.type,
          byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
          reason: input.reason,
          changedAt: now.toISOString(),
        },
        { context: { licenseDealId: deal.id, fromStatus, toStatus: 'pending' } },
      )
      emitted.push('prm.license_deal.status_changed')
    }

    // Phase 3: replay attribution if the caller specified a new target.
    if (input.newAttribution) {
      const replay = await this.attribute(deal.id, input.newAttribution, scope)
      emitted.push(...replay.emittedEvents)
    }

    return { licenseDeal: deal, emittedEvents: emitted }
  }

  /**
   * Forward status transition (`pending → signed → active → churned`).
   * Used by OM PartnerOps from B5 once the attribution has stabilised.
   */
  async transitionStatus(
    id: string,
    input: TransitionLicenseDealStatusInput,
    scope: { tenantId: string; actor: LicenseDealActor },
  ): Promise<LicenseDeal> {
    const deal = await this.findById(id, scope)
    if (!deal) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LICENSE_DEAL_NOT_FOUND,
        'License deal not found',
        404,
      )
    }
    if (input.ifMatchVersion !== undefined && input.ifMatchVersion !== deal.version) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CONFLICT,
        'License deal was modified by another user — refresh and retry',
        409,
      )
    }

    const fromStatus = deal.status as LicenseDealStatus
    const toStatus = input.toStatus
    if (fromStatus === toStatus) return deal

    const allowed = LICENSE_DEAL_TRANSITIONS[fromStatus] ?? []
    if (!allowed.includes(toStatus)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CHANGE_NOT_ALLOWED,
        `License deal status cannot move from ${fromStatus} to ${toStatus}.`,
        409,
        { fromStatus, toStatus },
      )
    }

    const now = new Date()
    deal.status = toStatus
    if (toStatus === 'active') deal.attributedAt = deal.attributedAt ?? now
    if (toStatus === 'signed' && !deal.signedAt) deal.signedAt = now
    if (toStatus === 'churned') deal.closedAt = now
    deal.updatedAt = now
    deal.version += 1
    await this.em.flush()

    await safeEmit(
      'prm.license_deal.status_changed',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        attributionPath: deal.attributionPath,
        attributionSource: deal.attributionSource,
        rfpId: deal.rfpId ?? null,
        attributedAgencyId: deal.attributedAgencyId ?? null,
        fromStatus,
        toStatus,
        byActorType: scope.actor.type,
        byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
        reason: input.reason ?? null,
        changedAt: now.toISOString(),
      },
      { context: { licenseDealId: deal.id, fromStatus, toStatus } },
    )

    return deal
  }

  /**
   * US4.4b — scoped bypass of invariant #7. Allowed transitions:
   *   - `active → signed` (e.g. contract correction; lock stays — see §8.6).
   *   - `signed → pending` (releases lock; reassignment becomes legal).
   *   - `churned → *` is REJECTED (terminal).
   *
   * Emits `prm.license_deal.status_unreversed` paired with `prm.license_deal.status_changed`.
   */
  async unreverseStatus(
    id: string,
    input: UnreverseLicenseDealStatusInput,
    scope: { tenantId: string; actor: LicenseDealActor },
  ): Promise<LicenseDeal> {
    const deal = await this.findById(id, scope)
    if (!deal) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.LICENSE_DEAL_NOT_FOUND,
        'License deal not found',
        404,
      )
    }
    if (deal.status === 'churned') {
      throw new PrmDomainError(
        PRM_ERROR_CODES.CHURNED_IS_TERMINAL,
        'churned is terminal — create a new license deal to record a successor.',
        409,
      )
    }
    const fromStatus = deal.status as LicenseDealStatus
    const toStatus = input.toStatus

    // Permitted backward-only paths.
    const allowed: Record<typeof fromStatus, ReadonlyArray<typeof toStatus>> = {
      pending: [],
      signed: ['pending'],
      active: ['signed'],
      churned: [],
    }
    if (!(allowed[fromStatus] ?? []).includes(toStatus)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CHANGE_NOT_ALLOWED,
        `unreverse-status from ${fromStatus} to ${toStatus} is not permitted.`,
        409,
        { fromStatus, toStatus },
      )
    }

    const now = new Date()
    deal.status = toStatus
    if (toStatus === 'pending') {
      // Release attribution snapshot when going all the way back to pending.
      // Application choice (§8.6 lock semantics): pending = reassignment legal.
      deal.attributedAt = null
    }
    deal.updatedAt = now
    deal.version += 1
    await this.em.flush()

    await safeEmit(
      'prm.license_deal.status_unreversed',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        fromStatus,
        toStatus,
        reason: input.reason,
        byActorType: scope.actor.type,
        byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
      },
      { context: { licenseDealId: deal.id } },
    )
    await safeEmit(
      'prm.license_deal.status_changed',
      {
        licenseDealId: deal.id,
        tenantId: deal.tenantId,
        organizationId: deal.organizationId,
        attributionPath: deal.attributionPath,
        attributionSource: deal.attributionSource,
        rfpId: deal.rfpId ?? null,
        attributedAgencyId: deal.attributedAgencyId ?? null,
        fromStatus,
        toStatus,
        byActorType: scope.actor.type,
        byUserId: scope.actor.type === 'user' ? scope.actor.userId : null,
        reason: input.reason,
        changedAt: now.toISOString(),
      },
      { context: { licenseDealId: deal.id, fromStatus, toStatus } },
    )

    return deal
  }

  // -------------------------------------------------------------------------
  // Saga helpers (idempotent — invoked by activity handlers + reverse saga)
  // -------------------------------------------------------------------------

  /**
   * Path A snapshot helper (idempotent). Re-snapshots `attributedAgencyId` from the
   * referenced Prospect — safe to re-run on saga retries; no-op if already set.
   */
  async snapshotProspectAgency(
    licenseDealId: string,
    scope: { tenantId: string },
  ): Promise<void> {
    const deal = await this.findById(licenseDealId, scope)
    if (!deal) return
    if (deal.attributionPath !== 'A' || !deal.prospectId) return
    if (deal.attributedAgencyId) return
    const prospect = await findOneWithDecryption(
      this.em,
      Prospect,
      { id: deal.prospectId, tenantId: scope.tenantId, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
    if (!prospect) return
    deal.attributedAgencyId = prospect.agencyId
    deal.updatedAt = new Date()
    deal.version += 1
    await this.em.flush()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyDecimal(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value.toFixed(2)
  return value
}

/**
 * Best-effort lookup of an RFP row. The `prm_rfps` table is owned by Spec #5
 * (rfp-broadcast-response) and is NOT migrated as part of this spec. While Spec #5
 * is in flight we use a runtime introspection guard mirroring the T1 dashboard
 * pattern (see `api/portal/dashboard/route.ts`):
 *   - `'table-missing'` → table not yet migrated; caller treats as a placeholder.
 *   - `null` → table exists but RFP not found / not selectable.
 *   - object → row found with `selected_agency_id`.
 */
async function tryLookupRfp(
  em: EntityManager,
  rfpId: string,
  tenantId: string,
): Promise<'table-missing' | null | { id: string; selectedAgencyId: string | null }> {
  try {
    const knex = em.getKnex()
    const reg = (await knex.raw(`select to_regclass('public.prm_rfps') as oid`)) as {
      rows: Array<{ oid: string | null }>
    }
    if (!reg.rows?.[0]?.oid) return 'table-missing'
    const rows = (await knex('prm_rfps')
      .where('id', rfpId)
      .where('tenant_id', tenantId)
      .first()) as { id: string; selected_agency_id: string | null } | undefined
    if (!rows) return null
    return { id: rows.id, selectedAgencyId: rows.selected_agency_id ?? null }
  } catch {
    return 'table-missing'
  }
}

export default LicenseDealService

// Tree-shaker keepalive for ProspectCandidateIndex (re-exported by service callers
// that walk the projection table directly).
const _CANDIDATE_INDEX_GUARD: typeof ProspectCandidateIndex = ProspectCandidateIndex
void _CANDIDATE_INDEX_GUARD
