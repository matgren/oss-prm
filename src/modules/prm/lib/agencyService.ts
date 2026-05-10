import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { Agency } from '../data/entities'
import { AGENCY_TIERS, type AgencyTier, type CreateAgencyInput } from '../data/validators'
import { PRM_ERROR_CODES, PrmDomainError, isUniqueViolation } from './errors'
import { safeEmit } from './safeEmit'
import { withAtomicFlush } from './atomicFlush'

/**
 * Domain helper for the `Agency` aggregate.
 *
 * - All writes happen on the request-scoped EM (transactional with `customer_accounts`).
 * - Cross-module FKs use the IDs only — no `@ManyToOne` to Organization (per AGENTS.md).
 * - All side-effect events are emitted only after the persistence completes.
 */
export class AgencyService {
  constructor(private readonly em: EntityManager) {}

  async createAgencyWithOrganization(
    input: CreateAgencyInput,
    scope: { tenantId: string; userId?: string | null },
  ): Promise<Agency> {
    if (!AGENCY_TIERS.includes(input.tier as AgencyTier)) {
      throw new PrmDomainError(PRM_ERROR_CODES.VALIDATION_FAILED, 'Invalid tier', 400)
    }
    const tenant = await findOneWithDecryption(
      this.em,
      Tenant,
      { id: scope.tenantId, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
    if (!tenant) {
      throw new PrmDomainError(PRM_ERROR_CODES.FORBIDDEN, 'Tenant not found', 403)
    }

    const existing = await findOneWithDecryption(
      this.em,
      Agency,
      {
        tenantId: scope.tenantId,
        slug: input.slug,
        deletedAt: null,
      },
      undefined,
      { tenantId: scope.tenantId },
    )
    if (existing) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.AGENCY_SLUG_TAKEN,
        `Slug "${input.slug}" is already taken in this tenant`,
        409,
        { field: 'slug' },
      )
    }

    // Create paired Organization. Slug is mirrored from Agency for human-friendly URLs.
    // Pre-generate the Organization UUID in-process so the Agency insert in the same
    // flush has a non-null organizationId. The Organization PK uses
    // `defaultRaw: 'gen_random_uuid()'` (DB-side default), so MikroORM does not
    // populate `organization.id` until after flush — reading it before flush yields
    // `undefined`, and MikroORM rejects the Agency insert with
    // `Value for Agency.organizationId is required, 'undefined' found`. The HTTP
    // contract is unchanged (POST /api/prm/agency body still does not carry an
    // organizationId); this UUID never leaves the service.
    const organizationId = randomUUID()
    let agency!: Agency

    // Atomicity (POST-MVP fix, PR #1 review Medium #1): wrap the Organization +
    // Agency inserts in a single DB transaction. If the Agency insert is rejected
    // after the Organization is persisted (e.g. unique-violation race on
    // `prm_agencies_tenant_slug_uniq` between the pre-check above and the actual
    // insert, or any future trigger), MikroORM 6.x does NOT auto-wrap a multi-
    // entity flush in a transaction — without this wrapper a partial commit is
    // theoretically possible (Organization row leaks without a matching Agency).
    // `withAtomicFlush(..., { transaction: true })` opens an explicit BEGIN/COMMIT
    // and rolls every change back on throw.
    try {
      await withAtomicFlush(
        this.em,
        [
          () => {
            const organization = this.em.create(Organization, {
              id: organizationId,
              tenant,
              name: input.name,
              slug: input.slug,
              isActive: true,
              createdAt: new Date(),
            } as any)
            this.em.persist(organization)
          },
          () => {
            agency = this.em.create(Agency, {
              tenantId: scope.tenantId,
              organizationId,
              name: input.name,
              slug: input.slug,
              headquartersCountry: null,
              tier: input.tier,
              status: input.status ?? 'active',
              industries: [],
              services: [],
              techCapabilities: [],
              contractSigned: input.contractSigned ?? false,
              ndaSigned: input.ndaSigned ?? false,
              onboarded: input.onboarded ?? false,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any)
            this.em.persist(agency)
          },
        ],
        { transaction: true },
      )
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new PrmDomainError(
          PRM_ERROR_CODES.AGENCY_SLUG_TAKEN,
          `Slug "${input.slug}" is already taken in this tenant`,
          409,
          { field: 'slug' },
        )
      }
      throw err
    }

    await safeEmit(
      'prm.agency.created',
      {
        agencyId: agency.id,
        organizationId: agency.organizationId,
        tenantId: agency.tenantId,
        slug: agency.slug,
        tier: agency.tier,
        createdByUserId: scope.userId ?? null,
      },
      { context: { agencyId: agency.id, tenantId: agency.tenantId } },
    )

    if (input.tier !== 'om_agency') {
      await safeEmit(
        'prm.agency.tier_changed',
        {
          agencyId: agency.id,
          tenantId: agency.tenantId,
          fromTier: 'om_agency',
          toTier: agency.tier,
          changedByUserId: scope.userId ?? null,
          reason: 'create_default',
        },
        { context: { agencyId: agency.id, tenantId: agency.tenantId } },
      )
    }

    return agency
  }

  async findById(id: string, scope: { tenantId: string }): Promise<Agency | null> {
    return findOneWithDecryption(
      this.em,
      Agency,
      { id, tenantId: scope.tenantId, deletedAt: null },
      undefined,
      { tenantId: scope.tenantId },
    )
  }

  async findByOrganizationId(
    organizationId: string,
    scope: { tenantId: string },
  ): Promise<Agency | null> {
    return findOneWithDecryption(
      this.em,
      Agency,
      {
        organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
      undefined,
      { tenantId: scope.tenantId },
    )
  }

  /**
   * Apply a partial update + emit field-diff events. Caller is responsible for
   * authorization (admin-only field guards live in the route layer).
   *
   * Optimistic concurrency: when `patch.ifMatchVersion` is provided, the service
   * compares it against the persisted `agency.version` and raises `STATUS_CONFLICT`
   * (409) on mismatch. The token is OPTIONAL for backwards-compat — clients that
   * don't send it still succeed. Every successful update bumps `version + 1`.
   * Mirrors the reference pattern in `licenseDealService` (POST-MVP follow-up).
   */
  async updateAgency(
    id: string,
    patch: Record<string, unknown>,
    scope: { tenantId: string; userId?: string | null; reason?: string | null },
  ): Promise<Agency> {
    const agency = await this.findById(id, scope)
    if (!agency) {
      throw new PrmDomainError(PRM_ERROR_CODES.AGENCY_NOT_FOUND, 'Agency not found', 404)
    }

    if (
      'ifMatchVersion' in patch &&
      typeof patch.ifMatchVersion === 'number' &&
      patch.ifMatchVersion !== agency.version
    ) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.STATUS_CONFLICT,
        'Agency was modified by another user — refresh and retry',
        409,
      )
    }

    const before = {
      tier: agency.tier,
      status: agency.status,
      contractSigned: agency.contractSigned,
      ndaSigned: agency.ndaSigned,
      onboarded: agency.onboarded,
    }

    if ('name' in patch && typeof patch.name === 'string') agency.name = patch.name
    if ('description' in patch) agency.description = (patch.description as string | null) ?? null
    if ('websiteUrl' in patch) agency.websiteUrl = (patch.websiteUrl as string | null) ?? null
    if ('logoUrl' in patch) agency.logoUrl = (patch.logoUrl as string | null) ?? null
    if ('headquartersCountry' in patch && typeof patch.headquartersCountry === 'string') {
      agency.headquartersCountry = patch.headquartersCountry
    }
    if ('headquartersCity' in patch) {
      agency.headquartersCity = (patch.headquartersCity as string | null) ?? null
    }
    if ('teamSizeBucket' in patch) {
      agency.teamSizeBucket = (patch.teamSizeBucket as string | null) ?? null
    }
    if ('industries' in patch && Array.isArray(patch.industries)) {
      agency.industries = patch.industries as string[]
    }
    if ('services' in patch && Array.isArray(patch.services)) {
      agency.services = patch.services as string[]
    }
    if ('techCapabilities' in patch && Array.isArray(patch.techCapabilities)) {
      agency.techCapabilities = patch.techCapabilities as string[]
    }
    if ('tier' in patch && typeof patch.tier === 'string') agency.tier = patch.tier
    if ('status' in patch && typeof patch.status === 'string') agency.status = patch.status
    if ('contractSigned' in patch) agency.contractSigned = !!patch.contractSigned
    if ('ndaSigned' in patch) agency.ndaSigned = !!patch.ndaSigned
    if ('onboarded' in patch) agency.onboarded = !!patch.onboarded
    agency.updatedAt = new Date()
    agency.version += 1

    await this.em.flush()

    if (before.tier !== agency.tier) {
      await safeEmit(
        'prm.agency.tier_changed',
        {
          agencyId: agency.id,
          tenantId: agency.tenantId,
          fromTier: before.tier,
          toTier: agency.tier,
          changedByUserId: scope.userId ?? null,
          reason: scope.reason ?? null,
        },
        { context: { agencyId: agency.id, tenantId: agency.tenantId } },
      )
    }
    if (before.status !== agency.status) {
      await safeEmit(
        'prm.agency.status_changed',
        {
          agencyId: agency.id,
          tenantId: agency.tenantId,
          fromStatus: before.status,
          toStatus: agency.status,
          changedByUserId: scope.userId ?? null,
          reason: scope.reason ?? null,
        },
        { context: { agencyId: agency.id, tenantId: agency.tenantId } },
      )
    }
    if (
      before.contractSigned !== agency.contractSigned ||
      before.ndaSigned !== agency.ndaSigned ||
      before.onboarded !== agency.onboarded
    ) {
      await safeEmit(
        'prm.agency.onboarding_state_changed',
        {
          agencyId: agency.id,
          tenantId: agency.tenantId,
          contractSigned: agency.contractSigned,
          ndaSigned: agency.ndaSigned,
          onboarded: agency.onboarded,
        },
        { context: { agencyId: agency.id, tenantId: agency.tenantId } },
      )
    }

    return agency
  }
}

export default AgencyService
