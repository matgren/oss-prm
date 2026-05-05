import { Entity, PrimaryKey, Property, Index, Unique } from '@mikro-orm/core'

/**
 * PRM `Agency` aggregate.
 *
 * 1:1 with `directory.organization` (invariant #4 — enforced via UNIQUE on `organization_id`).
 * Admin-only fields (`tier`, `status`, `contract_signed`, `nda_signed`, `onboarded`) are
 * write-guarded at the application layer (invariant #6 — backend ACL + portal ApiInterceptor).
 *
 * **Cross-spec contract:** every downstream PRM aggregate (Prospect, LicenseDeal, RFP, CaseStudy,
 * MarketingMaterial, WICContribution) FK-references `agency.id`. This schema is FROZEN.
 */
@Entity({ tableName: 'prm_agencies' })
@Unique({ properties: ['organizationId'], name: 'prm_agencies_organization_uniq' })
@Unique({ properties: ['tenantId', 'slug'], name: 'prm_agencies_tenant_slug_uniq' })
export class Agency {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text' })
  slug!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'website_url', type: 'text', nullable: true })
  websiteUrl?: string | null

  @Property({ name: 'logo_url', type: 'text', nullable: true })
  logoUrl?: string | null

  @Property({ name: 'headquarters_country', type: 'text' })
  headquartersCountry!: string

  @Property({ name: 'headquarters_city', type: 'text', nullable: true })
  headquartersCity?: string | null

  /** Enum check (DB-side): '1-5' | '6-20' | '21-50' | '51-100' | '100+'. */
  @Property({ name: 'team_size_bucket', type: 'text', nullable: true })
  teamSizeBucket?: string | null

  /** Dictionary entry IDs (`dictionaries` module). Stored as text[] for jsonb-free portability. */
  @Property({ type: 'json', nullable: false, default: '[]' })
  industries: string[] = []

  @Property({ type: 'json', nullable: false, default: '[]' })
  services: string[] = []

  @Property({ name: 'tech_capabilities', type: 'json', nullable: false, default: '[]' })
  techCapabilities: string[] = []

  /**
   * Admin-only field. Enum check (DB-side):
   * 'om_agency' | 'ai_native' | 'ai_native_expert' | 'ai_native_core'.
   */
  @Index()
  @Property({ type: 'text', default: 'om_agency' })
  tier: string = 'om_agency'

  /**
   * Admin-only field. Enum check (DB-side): 'active' | 'historical'.
   */
  @Index()
  @Property({ type: 'text', default: 'active' })
  status: string = 'active'

  @Property({ name: 'contract_signed', type: 'boolean', default: false })
  contractSigned: boolean = false

  @Property({ name: 'nda_signed', type: 'boolean', default: false })
  ndaSigned: boolean = false

  @Property({ type: 'boolean', default: false })
  onboarded: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * PRM `AgencyMember` aggregate.
 *
 * 1:1 with `customer_accounts.customer_user` (invariant #5 — `UNIQUE (customer_user_id) WHERE NOT NULL`).
 * The `customer_user_id` column is NULL between invite creation and acceptance — Vernon C6 placeholder
 * pattern. The GH-profile lock is acquired immediately at placeholder insert (`is_active = true` from
 * invite time, partial unique on `LOWER(github_profile)`).
 *
 * Naming: FK to this entity from downstream specs uses `*_agency_member_id` (CROSS-VALIDATION-REPORT §1.1).
 */
@Entity({ tableName: 'prm_agency_members' })
@Unique({ properties: ['agencyId', 'emailLookup'], name: 'prm_agency_members_agency_email_uniq' })
export class AgencyMember {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Index()
  @Property({ name: 'agency_id', type: 'uuid' })
  agencyId!: string

  /** NULL between invite and acceptance — set by `PrmInvitationAcceptedSubscriber`. Immutable once set. */
  @Property({ name: 'customer_user_id', type: 'uuid', nullable: true })
  customerUserId?: string | null

  /** NULL until invite created — set at placeholder insert. Cleared (NULL) after cancel/expire if needed. */
  @Property({ name: 'invitation_id', type: 'uuid', nullable: true })
  invitationId?: string | null

  @Property({ type: 'text' })
  email!: string

  /**
   * Lowercased `email` mirror used for the `(agency_id, email_lookup)` UNIQUE constraint.
   * Maintained by the application — DB-side enforcement only.
   */
  @Property({ name: 'email_lookup', type: 'text' })
  emailLookup!: string

  @Property({ name: 'first_name', type: 'text' })
  firstName!: string

  @Property({ name: 'last_name', type: 'text' })
  lastName!: string

  /** Free-text "role in agency" — e.g. "Lead Engineer". NOT the RBAC role. */
  @Property({ name: 'role_in_agency', type: 'text', nullable: true })
  roleInAgency?: string | null

  /**
   * Stored as the GitHub handle (no leading `@`). Lock is acquired via
   * `UNIQUE INDEX (LOWER(github_profile)) WHERE is_active = true AND github_profile IS NOT NULL`.
   * Globally unique across the entire partner network (deliberate per business rule, L-010).
   */
  @Property({ name: 'github_profile', type: 'text', nullable: true })
  githubProfile?: string | null

  /** True from invite creation (Vernon C6). Setting `false` releases the GH-profile lock. */
  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'invited_at', type: Date, onCreate: () => new Date() })
  invitedAt: Date = new Date()

  @Property({ name: 'activated_at', type: Date, nullable: true })
  activatedAt?: Date | null

  /**
   * Read-model column denormalised from `prm.agency.status`. Maintained by
   * `AgencyMemberStatusReadModelSubscriber` on `prm.agency.status_changed`.
   * Allows the aggregate to reject writes without a join (Vernon C3).
   */
  @Property({ name: 'agency_status', type: 'text', default: 'active' })
  agencyStatus: string = 'active'

  /**
   * Slug of the seeded `customer_accounts.customer_role` assigned at invite time
   * (`partner_admin` | `partner_member`). Read-only mirror — the canonical source
   * is `customer_user_role` once the invite is accepted.
   */
  @Property({ name: 'role_slug', type: 'text' })
  roleSlug!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
