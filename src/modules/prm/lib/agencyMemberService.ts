import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerUserInvitation,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CustomerInvitationService } from '@open-mercato/core/modules/customer_accounts/services/customerInvitationService'
import { Agency, AgencyMember } from '../data/entities'
import {
  AGENCY_TIERS,
  ROLE_SLUGS,
  type AgencyRoleSlug,
  type InviteAgencyMemberInput,
  type UpdateAgencyMemberBackendInput,
} from '../data/validators'
import {
  GITHUB_PROFILE_CONFLICT_MESSAGE,
  PRM_ERROR_CODES,
  PrmDomainError,
  isUniqueViolation,
} from './errors'
import { emitPrmEvent } from '../events'

const _AGENCY_TIER_GUARD = AGENCY_TIERS // touched to keep import for diagnostics if unused

export type AgencyMemberInviteResult = {
  member: AgencyMember
  invitation: CustomerUserInvitation
  rawToken: string
}

export class AgencyMemberService {
  constructor(private readonly em: EntityManager) {}

  async findByAgency(agencyId: string, scope: { tenantId: string }): Promise<AgencyMember[]> {
    return this.em.find(
      AgencyMember,
      { agencyId, tenantId: scope.tenantId, deletedAt: null },
      { orderBy: { createdAt: 'asc' } },
    )
  }

  async findById(id: string, scope: { tenantId: string }): Promise<AgencyMember | null> {
    return this.em.findOne(AgencyMember, { id, tenantId: scope.tenantId, deletedAt: null })
  }

  async findByInvitationId(
    invitationId: string,
    scope: { tenantId: string },
  ): Promise<AgencyMember | null> {
    return this.em.findOne(AgencyMember, {
      invitationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
  }

  async findByCustomerUserId(
    customerUserId: string,
    scope: { tenantId: string },
  ): Promise<AgencyMember | null> {
    return this.em.findOne(AgencyMember, {
      customerUserId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
  }

  /**
   * Compose `customer_accounts.createInvitation` + the PRM placeholder insert into a single
   * unit of work. Both rows participate in the same MikroORM transaction (PROXY-GATE-RESOLUTIONS §Q2).
   *
   * Caller (route handler) is responsible for:
   * - authorization (`prm.agency.invite_admin` for backend, `prm.agency_member.manage_partner_member`
   *   + role-self-assignability gate for portal),
   * - re-invite cooldown (`ReinviteCooldownService.consume`),
   * - committing the request transaction.
   *
   * On a unique violation surfacing from the partial UNIQUE on `LOWER(github_profile)`, this
   * method emits the diagnostic `prm.agency_member.github_profile_conflict_attempted` event and
   * throws a privacy-preserving `PrmDomainError` (L-010).
   */
  async invite(args: {
    agency: Agency
    input: InviteAgencyMemberInput
    invitedByUserId?: string | null
    invitedByCustomerUserId?: string | null
  }): Promise<AgencyMemberInviteResult> {
    const { agency, input } = args
    if (!ROLE_SLUGS.includes(input.roleSlug)) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.VALIDATION_FAILED,
        'Invalid role slug',
        400,
        { field: 'roleSlug' },
      )
    }

    const role = await this.em.findOne(CustomerRole, {
      tenantId: agency.tenantId,
      slug: input.roleSlug,
      deletedAt: null,
    })
    if (!role) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.ROLE_SLUG_NOT_SEEDED,
        `Role "${input.roleSlug}" is not seeded in this tenant. Run the PRM tenant setup first.`,
        500,
      )
    }

    const lowerEmail = input.email.trim().toLowerCase()

    // Detect duplicate within agency early — privacy-preserving, no cross-agency leak.
    const existingInAgency = await this.em.findOne(AgencyMember, {
      agencyId: agency.id,
      emailLookup: lowerEmail,
      deletedAt: null,
    })
    if (existingInAgency) {
      throw new PrmDomainError(
        PRM_ERROR_CODES.EMAIL_ALREADY_MEMBER,
        'A member with this email already exists in this agency.',
        409,
        { field: 'email' },
      )
    }

    // Pre-check GH conflict to short-circuit before invitation row is created.
    if (input.githubProfile) {
      const conflict = await this.em.findOne(AgencyMember, {
        githubProfile: input.githubProfile,
        isActive: true,
        deletedAt: null,
      })
      if (conflict) {
        await emitPrmEvent('prm.agency_member.github_profile_conflict_attempted', {
          attemptedGithubProfile: input.githubProfile,
          attemptedByAgencyId: agency.id,
          attemptedByCustomerUserId: args.invitedByCustomerUserId ?? null,
          existingOwnerAgencyId: conflict.agencyId,
          attemptedAt: new Date().toISOString(),
        } as any).catch(() => undefined)
        throw new PrmDomainError(
          PRM_ERROR_CODES.GITHUB_PROFILE_CONFLICT,
          GITHUB_PROFILE_CONFLICT_MESSAGE,
          409,
          { field: 'githubProfile' },
        )
      }
    }

    // 1. Create invitation row inside the same transaction.
    const invitationService = new CustomerInvitationService(this.em as any)
    const { invitation, rawToken } = await invitationService.createInvitation(
      lowerEmail,
      { tenantId: agency.tenantId, organizationId: agency.organizationId },
      {
        roleIds: [role.id],
        invitedByUserId: args.invitedByUserId ?? null,
        invitedByCustomerUserId: args.invitedByCustomerUserId ?? null,
        displayName: `${input.firstName} ${input.lastName}`.trim(),
      },
    )

    // 2. Insert PRM placeholder row in the same EM/UoW.
    const member = this.em.create(AgencyMember, {
      tenantId: agency.tenantId,
      agencyId: agency.id,
      customerUserId: null,
      invitationId: invitation.id,
      email: lowerEmail,
      emailLookup: lowerEmail,
      firstName: input.firstName,
      lastName: input.lastName,
      githubProfile: input.githubProfile ?? null,
      isActive: true,
      invitedAt: new Date(),
      activatedAt: null,
      agencyStatus: agency.status,
      roleSlug: input.roleSlug,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    this.em.persist(member)

    try {
      await this.em.flush()
    } catch (err) {
      if (isUniqueViolation(err)) {
        await emitPrmEvent('prm.agency_member.github_profile_conflict_attempted', {
          attemptedGithubProfile: input.githubProfile ?? null,
          attemptedByAgencyId: agency.id,
          attemptedByCustomerUserId: args.invitedByCustomerUserId ?? null,
          existingOwnerAgencyId: null,
          attemptedAt: new Date().toISOString(),
        } as any).catch(() => undefined)
        throw new PrmDomainError(
          PRM_ERROR_CODES.GITHUB_PROFILE_CONFLICT,
          GITHUB_PROFILE_CONFLICT_MESSAGE,
          409,
          { field: 'githubProfile' },
        )
      }
      throw err
    }

    await emitPrmEvent('prm.agency_member.added', {
      agencyId: agency.id,
      tenantId: agency.tenantId,
      agencyMemberId: member.id,
      githubProfile: member.githubProfile ?? null,
      roleSlug: member.roleSlug,
      invitationId: invitation.id,
    } as any).catch(() => undefined)

    return { member, invitation, rawToken }
  }

  /**
   * Update mutable fields on a member row; emits role/removal events as appropriate.
   * Caller authorizes self-vs-staff scope before calling.
   */
  async update(
    member: AgencyMember,
    patch: UpdateAgencyMemberBackendInput,
    scope: { allowRoleChange: boolean; changedByUserId?: string | null },
  ): Promise<AgencyMember> {
    const before = {
      isActive: member.isActive,
      roleSlug: member.roleSlug,
      githubProfile: member.githubProfile ?? null,
    }

    if ('firstName' in patch && typeof patch.firstName === 'string') member.firstName = patch.firstName
    if ('lastName' in patch && typeof patch.lastName === 'string') member.lastName = patch.lastName
    if ('roleInAgency' in patch) member.roleInAgency = (patch.roleInAgency as string | null) ?? null
    if ('githubProfile' in patch) {
      member.githubProfile = (patch.githubProfile as string | null) ?? null
    }
    if ('isActive' in patch && typeof patch.isActive === 'boolean') {
      member.isActive = patch.isActive
    }
    if (scope.allowRoleChange && 'roleSlug' in patch && typeof patch.roleSlug === 'string') {
      member.roleSlug = patch.roleSlug as AgencyRoleSlug
    }
    member.updatedAt = new Date()

    try {
      await this.em.flush()
    } catch (err) {
      if (isUniqueViolation(err)) {
        member.githubProfile = before.githubProfile
        throw new PrmDomainError(
          PRM_ERROR_CODES.GITHUB_PROFILE_CONFLICT,
          GITHUB_PROFILE_CONFLICT_MESSAGE,
          409,
          { field: 'githubProfile' },
        )
      }
      throw err
    }

    if (before.roleSlug !== member.roleSlug) {
      await emitPrmEvent('prm.agency_member.role_changed', {
        agencyId: member.agencyId,
        tenantId: member.tenantId,
        agencyMemberId: member.id,
        fromRole: before.roleSlug,
        toRole: member.roleSlug,
        changedByUserId: scope.changedByUserId ?? null,
        changedAt: new Date().toISOString(),
      } as any).catch(() => undefined)
    }
    if (before.isActive && !member.isActive) {
      await emitPrmEvent('prm.agency_member.removed', {
        agencyId: member.agencyId,
        tenantId: member.tenantId,
        agencyMemberId: member.id,
      } as any).catch(() => undefined)
    }
    await emitPrmEvent('prm.agency_member.updated', {
      agencyId: member.agencyId,
      tenantId: member.tenantId,
      agencyMemberId: member.id,
    } as any).catch(() => undefined)

    return member
  }
}

export default AgencyMemberService
