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
 * PRM `Prospect` aggregate (Spec #2 — wip-scoreboard).
 *
 * State machine (invariant #12):
 *   `new` → `qualified` | `lost`
 *   `qualified` → `contacted` | `won` | `lost`
 *   `contacted` → `won` | `lost` | `dormant`
 *   `dormant` → `qualified` | `lost`
 *   `won`, `lost` → terminal
 *
 * Authorities:
 *   - The aggregate (`ProspectService.transitionStatus`) is the sole authority on transitions.
 *   - `won` is reachable only via `by_actor_type = 'system'` (Spec #3 attribution saga).
 *
 * Cross-spec contract (FROZEN — downstream Spec #3 attribution-loop reads these):
 *   - Table name: `prm_prospects`.
 *   - Source enum: `agency_owned` / `event` / `other`.
 *   - Status enum: `new` / `qualified` / `contacted` / `won` / `lost` / `dormant`.
 *   - `registered_at` is IMMUTABLE after INSERT (invariant #1).
 *   - WIP filter (invariant #14): `status NOT IN ('lost')` — note `won`/`dormant` count as WIP.
 */
@Entity({ tableName: 'prm_prospects' })
export class Prospect {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Index()
  @Property({ name: 'agency_id', type: 'uuid' })
  agencyId!: string

  @Index()
  @Property({ name: 'registered_by_agency_member_id', type: 'uuid' })
  registeredByAgencyMemberId!: string

  @Property({ name: 'company_name', type: 'text' })
  companyName!: string

  @Property({ name: 'contact_name', type: 'text' })
  contactName!: string

  @Property({ name: 'contact_email', type: 'text' })
  contactEmail!: string

  /** Enum check (DB-side): 'agency_owned' | 'event' | 'other'. */
  @Property({ type: 'text', default: 'agency_owned' })
  source: string = 'agency_owned'

  /** Enum check (DB-side): 'new' | 'qualified' | 'contacted' | 'won' | 'lost' | 'dormant'. */
  @Index()
  @Property({ type: 'text', default: 'new' })
  status: string = 'new'

  /** Required iff status = 'lost' (aggregate-enforced; DB CHECK as defence-in-depth). */
  @Property({ name: 'lost_reason', type: 'text', nullable: true })
  lostReason?: string | null

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  /**
   * IMMUTABLE after INSERT per invariant #1. Belt-and-braces: aggregate `update()` whitelists
   * editable fields and never accepts `registered_at`. The follow-up indexes migration ships
   * a column-level UPDATE trigger as defence-in-depth.
   */
  @Index()
  @Property({ name: 'registered_at', type: Date })
  registeredAt: Date = new Date()

  @Property({ name: 'status_changed_at', type: Date })
  statusChangedAt: Date = new Date()

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * PRM `ProspectCandidateIndex` read-model projection (Spec #2 — wip-scoreboard).
 *
 * One row per `Prospect`. Maintained idempotently by `prospect-candidate-index` subscriber on:
 *   - `prm.prospect.registered`              (UPSERT)
 *   - `prm.prospect.updated`                 (re-compute normalized keys when company/email changed)
 *   - `prm.prospect.status_changed`          (UPDATE current_status)
 *   - `prm.prospect.registration_reverted`   (DELETE)
 *
 * Cross-spec contract (FROZEN — Spec #3 candidate-picker reads this):
 *   - Table: `prm_prospect_candidate_index`.
 *   - Normalization: `lower(trim(replace(<punct>, ' ', single-space-collapsed)))`.
 *   - PK: `prospect_id` (1:1 with Prospect aggregate).
 *   - Includes ALL statuses including `lost` (Spec #3 invariant #14 requires lost rows surfaced
 *     with badge in attribution candidate picker).
 */
@Entity({ tableName: 'prm_prospect_candidate_index' })
export class ProspectCandidateIndex {
  @PrimaryKey({ name: 'prospect_id', type: 'uuid' })
  prospectId!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Index()
  @Property({ name: 'agency_id', type: 'uuid' })
  agencyId!: string

  @Index()
  @Property({ name: 'normalized_company_name', type: 'text' })
  normalizedCompanyName!: string

  @Index()
  @Property({ name: 'lowercased_contact_email', type: 'text' })
  lowercasedContactEmail!: string

  /** Mirror of `prm_prospects.status` — written on every status_changed event. */
  @Property({ name: 'current_status', type: 'text' })
  currentStatus!: string

  /** Mirrored for default Golden Rule ordering (Spec #3 picks oldest first by registered_at). */
  @Property({ name: 'registered_at', type: Date })
  registeredAt!: Date

  @Property({ name: 'projection_updated_at', type: Date })
  projectionUpdatedAt!: Date
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
