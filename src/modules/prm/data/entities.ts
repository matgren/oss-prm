import { Entity, PrimaryKey, Property, Index, Unique } from '@mikro-orm/core'

/**
 * PRM `Agency` aggregate.
 *
 * 1:1 with `directory.organization` (invariant #4 — enforced via UNIQUE on `organization_id`).
 * Admin-only fields (`tier`, `status`, `contract_signed`, `nda_signed`, `onboarded`) are
 * write-guarded at the application layer (invariant #6 — backend ACL + portal ApiInterceptor).
 *
 * **Cross-spec contract:** every downstream PRM aggregate (Prospect, LicenseDeal, RFP, CaseStudy,
 * MarketingMaterial, WicContribution) FK-references `agency.id`. This schema is FROZEN.
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

  /**
   * Optimistic-concurrency token — bumped on every aggregate write. Mirrors the
   * `LicenseDeal.version` reference implementation. Backend + portal PATCH
   * routes accept an optional `ifMatchVersion` token; mismatches raise
   * `STATUS_CONFLICT` (409). Default `1` so existing rows backfill safely.
   */
  @Property({ type: 'integer', default: 1 })
  version: number = 1
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

  /**
   * Synthetic mirror of `prospect_id`. NOT the PK — frozen cross-spec contract still
   * names `prospect_id` as PK (T1 spec §11; T2 Golden Rule picker reads it directly).
   *
   * Exists ONLY to satisfy `@open-mercato/core` query_index reindexer, which hardcodes
   * `b.id` as the partition / pagination column (`reindexer.ts:179,332,336`). Without
   * this column, `yarn mercato init --reinstall` fails on the reindex pass with
   * `column b.id does not exist`. Maintained server-side by the
   * `GENERATED ALWAYS AS (prospect_id) STORED` clause — zero application code.
   */
  @Property({ name: 'id', type: 'uuid', generated: '(prospect_id) stored' })
  id!: string

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

/**
 * PRM `LicenseDeal` aggregate (Spec #3 — attribution-loop).
 *
 * Three mutually-exclusive attribution paths:
 *   - Path A — Prospect attribution (set `prospect_id`; saga snapshots `attributed_agency_id`
 *     from Prospect.agency_id and transitions Prospect → won via system actor).
 *   - Path B — RFP attribution (set `rfp_id`; saga snapshots winner agency from RFP).
 *   - Path C — Direct sale (set `attributed_agency_id` directly; reasoning required).
 *   - `none` — `pending` deal pre-attribution.
 *
 * Lifecycle: `pending` → `signed` → `active` (terminal-ish), `churned` (terminal).
 *
 * Invariant #7 (FROZEN): once `status >= active`, attribution fields are FROZEN.
 * Reverse requires `/unreverse-status` (US4.4b — scoped bypass) first. Enforced both
 * in the `LicenseDealService` and via a defence-in-depth DB trigger.
 *
 * Cross-spec contract (FROZEN — Specs #5/#6 read these):
 *   - Table: `prm_license_deals`.
 *   - Status enum: `pending` / `signed` / `active` / `churned`.
 *   - Attribution path enum: `A` / `B` / `C` / `none`.
 *   - Attribution source enum: `prospect` / `rfp` / `direct`.
 *   - Saga `correlationKey = license_deal_id + ':' + attribution_source`.
 */
@Entity({ tableName: 'prm_license_deals' })
@Unique({ properties: ['tenantId', 'licenseIdentifier'], name: 'prm_license_deals_tenant_identifier_uniq' })
export class LicenseDeal {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Human-readable license identifier (e.g. "OM-2026-0042"). Unique per tenant. */
  @Property({ name: 'license_identifier', type: 'text' })
  licenseIdentifier!: string

  /** v1: free text. v2 will replace with FK to a Client aggregate. */
  @Index()
  @Property({ name: 'client_company_name', type: 'text' })
  clientCompanyName!: string

  @Property({ name: 'client_industry', type: 'text', nullable: true })
  clientIndustry?: string | null

  /** Enum check (DB-side): 'enterprise'. Future v2: trial / smb. */
  @Property({ type: 'text', default: 'enterprise' })
  type: string = 'enterprise'

  /** Enum check (DB-side): 'pending' | 'signed' | 'active' | 'churned'. */
  @Index()
  @Property({ type: 'text', default: 'pending' })
  status: string = 'pending'

  @Property({ name: 'is_renewal', type: 'boolean', default: false })
  isRenewal: boolean = false

  @Property({ name: 'previous_license_deal_id', type: 'uuid', nullable: true })
  previousLicenseDealId?: string | null

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  @Property({ name: 'signed_at', type: Date, nullable: true })
  signedAt?: Date | null

  /**
   * Stored as decimal-string in the DB (numeric(12,2)). MikroORM marshals to string
   * to preserve precision; service-layer code re-parses to `number` for math.
   */
  @Property({ name: 'annual_value_usd', type: 'decimal', nullable: true, precision: 12, scale: 2 })
  annualValueUsd?: string | null

  @Property({ name: 'monthly_license_amount', type: 'decimal', nullable: true, precision: 12, scale: 2 })
  monthlyLicenseAmount?: string | null

  /** Enum check (DB-side): 'A' | 'B' | 'C' | 'none'. */
  @Index()
  @Property({ name: 'attribution_path', type: 'text', default: 'none' })
  attributionPath: string = 'none'

  /** Enum check (DB-side): 'prospect' | 'rfp' | 'direct'. */
  @Property({ name: 'attribution_source', type: 'text', default: 'direct' })
  attributionSource: string = 'direct'

  /** Path A: FK to `prm_prospects`. Set during saga snapshot. */
  @Index()
  @Property({ name: 'prospect_id', type: 'uuid', nullable: true })
  prospectId?: string | null

  /** Path B: FK to `prm_rfps` table (Spec #5). Nullable + no FK constraint in v1 (table not yet migrated). */
  @Index()
  @Property({ name: 'rfp_id', type: 'uuid', nullable: true })
  rfpId?: string | null

  /** Denormalised snapshot — stays stable even if Prospect.agency_id later changes. */
  @Index()
  @Property({ name: 'attributed_agency_id', type: 'uuid', nullable: true })
  attributedAgencyId?: string | null

  /** Required when overriding Golden Rule (Path A) or selecting Path C. */
  @Property({ name: 'attribution_reasoning', type: 'text', nullable: true })
  attributionReasoning?: string | null

  /** Frozen alongside attribution snapshot (invariant #7). */
  @Property({ name: 'attributed_at', type: Date, nullable: true })
  attributedAt?: Date | null

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  /** Optimistic-concurrency token — bumped on every aggregate write. */
  @Property({ type: 'integer', default: 1 })
  version: number = 1
}

/**
 * PRM `Rfp` aggregate (Spec #5 — rfp-broadcast-response).
 *
 * State machine (invariant #16, FROZEN):
 *   `draft → published → scoring → (selection_made | closed)`.
 *   Spec #6 owns the `scoring → selection_made → closed` transitions.
 *
 * Cross-spec contract (FROZEN):
 *   - Table: `prm_rfps`.
 *   - Status enum: `draft` / `published` / `scoring` / `selection_made` / `closed`.
 *   - `is_path_b_locked` is a read-model column; this spec declares + defaults
 *     it `false`. Spec #3 writes via `RfpPathBLockSubscriber` on
 *     `prm.license_deal.status_changed`. Spec #6 reads it for the re-open guard.
 *   - `eligibility_filter` enum: `all_active` / `by_min_tier` / `explicit`,
 *     companion columns `min_tier` (text) and `explicit_agency_ids` (uuid[]).
 *
 * App-Spec column names win over the Technical Approach's tri-field shape
 * (per spec §2.1). Hence `tech_requirements` / `domain_requirements` here
 * (RFP authoring), and `tech_experience` / `domain_experience` /
 * `differentiators` on RfpResponse (agency response). The naming matches
 * the scoring rubric's "named-client evidence > generic claims" lens.
 */
@Entity({ tableName: 'prm_rfps' })
export class Rfp {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  title!: string

  @Property({ name: 'received_from', type: 'text' })
  receivedFrom!: string

  @Property({ name: 'received_at', type: Date })
  receivedAt!: Date

  /** Markdown. */
  @Property({ type: 'text' })
  description!: string

  /** Markdown. */
  @Property({ name: 'tech_requirements', type: 'text' })
  techRequirements!: string

  /** Markdown. */
  @Property({ name: 'domain_requirements', type: 'text' })
  domainRequirements!: string

  /** Dictionary slug. NULL for "no specific industry" RFPs. */
  @Property({ type: 'text', nullable: true })
  industry?: string | null

  /** Enum check (DB-side): '<50k' / '50k-250k' / '250k-1m' / '1m+' / 'unknown'. */
  @Property({ name: 'budget_bucket', type: 'text', nullable: true })
  budgetBucket?: string | null

  /** Enum check (DB-side): '0-3m' / '3-6m' / '6-12m' / '12m+' / 'unknown'. */
  @Property({ name: 'timeline_bucket', type: 'text', nullable: true })
  timelineBucket?: string | null

  /** Dictionary slugs (technologies). */
  @Property({ name: 'required_capabilities', type: 'json', nullable: false, default: '[]' })
  requiredCapabilities: string[] = []

  @Property({ name: 'additional_criterion_name', type: 'text', nullable: true })
  additionalCriterionName?: string | null

  @Property({ name: 'deadline_to_respond', type: Date, nullable: true })
  deadlineToRespond?: Date | null

  /**
   * Enum check (DB-side): 'all_active' / 'by_min_tier' / 'explicit'. Companion
   * columns `min_tier` and `explicit_agency_ids` are app-level required iff
   * filter is `by_min_tier` / `explicit` respectively.
   */
  @Property({ name: 'eligibility_filter', type: 'text' })
  eligibilityFilter!: string

  /** Required iff `eligibility_filter = 'by_min_tier'`. */
  @Property({ name: 'min_tier', type: 'text', nullable: true })
  minTier?: string | null

  /** Required iff `eligibility_filter = 'explicit'`. UUIDs of explicitly-targeted Agencies. */
  @Property({ name: 'explicit_agency_ids', type: 'json', nullable: true })
  explicitAgencyIds?: string[] | null

  /** Enum check (DB-side): 'draft' / 'published' / 'scoring' / 'selection_made' / 'closed'. */
  @Index()
  @Property({ type: 'text', default: 'draft' })
  status: string = 'draft'

  /** Set by Spec #6's selection action. */
  @Property({ name: 'selected_agency_id', type: 'uuid', nullable: true })
  selectedAgencyId?: string | null

  @Property({ name: 'selection_decided_at', type: Date, nullable: true })
  selectionDecidedAt?: Date | null

  @Property({ name: 'selection_decided_by_user_id', type: 'uuid', nullable: true })
  selectionDecidedByUserId?: string | null

  @Property({ name: 'selection_reasoning', type: 'text', nullable: true })
  selectionReasoning?: string | null

  /**
   * Read-model column. WRITTEN by Spec #3's `RfpPathBLockSubscriber` on
   * `prm.license_deal.status_changed`. READ by Spec #6's re-open guard
   * (invariant #17). Default `false` is the safe-pre-Spec-#3 state.
   */
  @Property({ name: 'is_path_b_locked', type: 'boolean', default: false })
  isPathBLocked: boolean = false

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'published_at', type: Date, nullable: true })
  publishedAt?: Date | null

  /** Stamped by Spec #6 on `closed` transition. */
  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  /**
   * Spec #6 — challenge round / re-open deadline (US5.10).
   *
   * Set by `RfpService.reopenRfp` to a future timestamp; cleared by close
   * or by the `RfpReopenedDeadlineExpiry` worker when it expires (auto-
   * transitions the RFP back to `scoring`). Always NULL when status is
   * not `reopened`.
   */
  @Property({ name: 'reopened_deadline_at', type: Date, nullable: true })
  reopenedDeadlineAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * PRM `RfpBroadcast` (Spec #5).
 *
 * One row per (RFP, Agency) eligible at publish time. UNIQUE `(rfp_id, agency_id)`
 * is invariant #15's source of truth for the visibility gate (silent 404).
 *
 * Lifecycle:
 *   - Created by `RfpService.publish` for every Agency the eligibility evaluator returns.
 *   - `first_opened_at` stamped exactly once on first portal P10 GET. Side effect emits
 *     `prm.rfp_broadcast.first_opened`.
 *   - `declined_at` + `decline_reason` set by `DeclineRFPBroadcastCommand`
 *     (cleared by `Undecline` while RFP is still `published`).
 */
@Entity({ tableName: 'prm_rfp_broadcasts' })
@Unique({ properties: ['rfpId', 'agencyId'], name: 'prm_rfp_broadcasts_rfp_agency_uniq' })
export class RfpBroadcast {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Index()
  @Property({ name: 'rfp_id', type: 'uuid' })
  rfpId!: string

  @Index()
  @Property({ name: 'agency_id', type: 'uuid' })
  agencyId!: string

  @Property({ name: 'broadcast_at', type: Date, onCreate: () => new Date() })
  broadcastAt: Date = new Date()

  @Property({ name: 'first_opened_at', type: Date, nullable: true })
  firstOpenedAt?: Date | null

  @Property({ name: 'declined_at', type: Date, nullable: true })
  declinedAt?: Date | null

  @Property({ name: 'decline_reason', type: 'text', nullable: true })
  declineReason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * PRM `RfpResponse` (Spec #5).
 *
 * One agency's response to one RFP. Lifecycle: `draft → submitted` (this spec).
 * Spec #6 derives `scored / selected / not_selected` as views over
 * `RfpResponseScore` + `Rfp.selected_agency_id`; those values are NOT persisted
 * here.
 *
 * Authoring rules (per §6.2):
 *   - PartnerAdmin: any draft in the Agency.
 *   - PartnerMember: only own draft (`submitted_by_member_id = self`).
 *   - Decline is an Agency-level decision (PartnerAdmin only) — see RfpBroadcast.
 *
 * `submitted_by_member_id` is stamped on first draft save with the creating
 * AgencyMember; reused at submit time.
 */
@Entity({ tableName: 'prm_rfp_responses' })
@Unique({ properties: ['rfpId', 'agencyId'], name: 'prm_rfp_responses_rfp_agency_uniq' })
export class RfpResponse {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Index()
  @Property({ name: 'rfp_id', type: 'uuid' })
  rfpId!: string

  @Index()
  @Property({ name: 'agency_id', type: 'uuid' })
  agencyId!: string

  @Property({ name: 'submitted_by_member_id', type: 'uuid' })
  submittedByMemberId!: string

  /** Enum check (DB-side): 'draft' / 'submitted'. */
  @Property({ type: 'text', default: 'draft' })
  status: string = 'draft'

  /** Markdown. NULL while in `draft` is allowed; required at submit time (app-level). */
  @Property({ name: 'tech_experience', type: 'text', nullable: true })
  techExperience?: string | null

  /** Markdown. */
  @Property({ name: 'domain_experience', type: 'text', nullable: true })
  domainExperience?: string | null

  /** Markdown. Optional even at submit time (per §3.2). */
  @Property({ type: 'text', nullable: true })
  differentiators?: string | null

  @Property({ name: 'attached_case_study_ids', type: 'json', nullable: false, default: '[]' })
  attachedCaseStudyIds: string[] = []

  /** Stamped on first `draft → submitted`. */
  @Property({ name: 'first_submitted_at', type: Date, nullable: true })
  firstSubmittedAt?: Date | null

  @Property({ name: 'last_updated_at', type: Date, onUpdate: () => new Date() })
  lastUpdatedAt: Date = new Date()

  /** Stamped by Spec #6 on challenge-round resubmits (out of scope here). */
  @Property({ name: 'challenge_round_updated_at', type: Date, nullable: true })
  challengeRoundUpdatedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * PRM `RfpResponseScore` aggregate (Spec #6 — rfp-scoring-selection).
 *
 * **APPEND-ONLY** per invariant #18. Each re-score inserts a new row with
 * `version = max(version) + 1` for the same `rfp_response_id`. Rows are
 * NEVER updated and NEVER deleted. The application-layer repository
 * (`RfpResponseScoreRepo`) exposes only `insertNextVersion()`; all reads
 * surface latest-version-by-default with optional history. Cross-spec
 * contract — Spec #6 owns the entity end-to-end.
 *
 * Source enum (`manual` / `llm_assisted`) telemeters human-vs-LLM scoring
 * mix per OQ-009. `llm_model_id` is required iff `source = 'llm_assisted'`
 * (Zod refine + DB CHECK as defence-in-depth).
 *
 * `change_reason` is application-required iff `version > 1` (the
 * "undo via v+1 insert" pattern documented in spec §10.1). Enforced at
 * the command layer, not the DB — keeps the invariant in the language
 * the team lives in.
 *
 * Score values are integer 0..5 (DB CHECK). `optional_score` is nullable
 * for RFPs that have no third dimension.
 */
@Entity({ tableName: 'prm_rfp_response_scores' })
@Unique({ properties: ['rfpResponseId', 'version'], name: 'prm_rfp_response_scores_response_version_uniq' })
export class RfpResponseScore {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Index()
  @Property({ name: 'rfp_response_id', type: 'uuid' })
  rfpResponseId!: string

  /** 1, 2, 3, … per `rfp_response_id`. UNIQUE `(rfp_response_id, version)`. */
  @Property({ name: 'version', type: 'integer' })
  version!: number

  /** OM staff `user_id` who recorded the score. */
  @Property({ name: 'scored_by_user_id', type: 'uuid' })
  scoredByUserId!: string

  /** 0..5 — DB CHECK enforced. */
  @Property({ name: 'tech_fit_score', type: 'smallint' })
  techFitScore!: number

  /** 0..5 — DB CHECK enforced. */
  @Property({ name: 'domain_fit_score', type: 'smallint' })
  domainFitScore!: number

  /** 0..5 — nullable. NULL when the rubric has no third dimension. */
  @Property({ name: 'optional_score', type: 'smallint', nullable: true })
  optionalScore?: number | null

  @Property({ name: 'include_optional', type: 'boolean', default: false })
  includeOptional: boolean = false

  /** Required (min 10 chars at the validator level). */
  @Property({ type: 'text' })
  reasoning!: string

  /** Enum CHECK (DB-side): `manual` / `llm_assisted`. */
  @Property({ type: 'text' })
  source!: string

  /** Required iff `source = 'llm_assisted'`. */
  @Property({ name: 'llm_model_id', type: 'text', nullable: true })
  llmModelId?: string | null

  /** Required iff `version > 1` (app-level — see spec §10.1). */
  @Property({ name: 'change_reason', type: 'text', nullable: true })
  changeReason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * PRM `WicContribution` aggregate (Spec #4 — wic-ingestion).
 *
 * One row per `(agency_member_id, contribution_month)` accepted import. Supersession is
 * idempotent (invariant #3): re-importing the same member-month flips the previous row's
 * `superseded_by_id` + `archived_at` and inserts a new active row. Attribution is snapshotted
 * at import time (invariant #13): both `agency_id` and `github_profile` are frozen on the row.
 *
 * Cross-spec contract (Spec #2 portal dashboard reads):
 *   - Table: `prm_wic_contributions`.
 *   - Active-row predicate: `superseded_by_id IS NULL AND archived_at IS NULL`.
 *   - Sum-by-(agency_id, month) is the WIC widget's read shape.
 *
 * `wic_level` is L-002: stored & displayed only. PRM never branches business logic on it.
 *
 * Note: spec §5.1 names the table `wic_contributions` (no prefix); we use the `prm_` prefix
 * to match the existing PRM module convention (every other table — `prm_agencies`,
 * `prm_prospects`, `prm_license_deals` — already does so).
 */
@Entity({ tableName: 'prm_wic_contributions' })
@Unique({
  properties: ['importBatchId', 'rowIndex'],
  name: 'prm_wic_contributions_batch_row_uniq',
})
export class WicContribution {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** SNAPSHOT — invariant #13. Frozen at import; survives future GH-profile reassignment. */
  @Index()
  @Property({ name: 'agency_id', type: 'uuid' })
  agencyId!: string

  @Index()
  @Property({ name: 'agency_member_id', type: 'uuid' })
  agencyMemberId!: string

  /** SNAPSHOT — invariant #13. Stored as the GitHub handle (no leading `@`). */
  @Property({ name: 'github_profile', type: 'text' })
  githubProfile!: string

  /** Normalized YYYY-MM-01 (first-of-month). DB CHECK enforces day = 1. */
  @Index()
  @Property({ name: 'contribution_month', type: 'date' })
  contributionMonth!: Date

  /** Enum check (DB-side): 'L1' | 'L2' | 'L3' | 'L4'. NULL legal for zero-score months. */
  @Property({ name: 'wic_level', type: 'text', nullable: true })
  wicLevel?: string | null

  /** Decimal-string in DB (numeric(12,4)). Service-layer parses to number for math. */
  @Property({ name: 'wic_score', type: 'decimal', precision: 12, scale: 4 })
  wicScore!: string

  @Property({ name: 'contribution_count', type: 'integer', default: 0 })
  contributionCount: number = 0

  @Property({ name: 'bounty_bonus', type: 'decimal', precision: 12, scale: 4, default: '0' })
  bountyBonus: string = '0'

  @Property({ name: 'why_bonus', type: 'text', nullable: true })
  whyBonus?: string | null

  @Property({ name: 'what_included', type: 'text', nullable: true })
  whatIncluded?: string | null

  @Property({ name: 'what_excluded', type: 'text', nullable: true })
  whatExcluded?: string | null

  @Property({ name: 'script_version', type: 'text' })
  scriptVersion!: string

  @Index()
  @Property({ name: 'import_batch_id', type: 'uuid' })
  importBatchId!: string

  @Property({ name: 'row_index', type: 'integer' })
  rowIndex!: number

  @Property({ name: 'computed_at', type: Date })
  computedAt!: Date

  @Property({ name: 'imported_at', type: Date, onCreate: () => new Date() })
  importedAt: Date = new Date()

  /** When set, this row has been superseded by a newer import for the same member-month. */
  @Index()
  @Property({ name: 'superseded_by_id', type: 'uuid', nullable: true })
  supersededById?: string | null

  /** Set alongside `superseded_by_id`. Indexed-where on the active-row predicate (see migration). */
  @Property({ name: 'archived_at', type: Date, nullable: true })
  archivedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * PRM `WicImportAuditLog` (Spec #4 — wic-ingestion).
 *
 * One row per rejected import row. Resolved by OM PartnerOps via B10. Resolution lifecycle
 * is captured on the same row (no separate resolution events table). The row is never deleted;
 * `resolved_at` flips when an action is taken.
 *
 * Note on rejection_reason enum: spec §10.5 records that the App Spec §1.4.6 form
 * (`unknown_github_profile`) is the persisted value, while the Technical Approach prose
 * uses `profile_not_found` as the human-facing alias surfaced in B10 copy.
 */
@Entity({ tableName: 'prm_wic_import_audit_log' })
@Unique({
  properties: ['importBatchId', 'rowIndex'],
  name: 'prm_wic_import_audit_log_batch_row_uniq',
})
export class WicImportAuditLog {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Index()
  @Property({ name: 'import_batch_id', type: 'uuid' })
  importBatchId!: string

  @Property({ name: 'row_index', type: 'integer' })
  rowIndex!: number

  /** Original n8n row, verbatim. */
  @Property({ name: 'raw_payload', type: 'json' })
  rawPayload!: Record<string, unknown>

  /**
   * Enum check (DB-side):
   *   'unknown_github_profile' | 'ambiguous_github_profile' | 'malformed_month' |
   *   'unknown_level' | 'invalid_payload'.
   */
  @Index()
  @Property({ name: 'rejection_reason', type: 'text' })
  rejectionReason!: string

  @Property({ name: 'rejection_detail', type: 'text', nullable: true })
  rejectionDetail?: string | null

  /** Best-effort agency resolution at import time. NULL if profile was unresolvable. */
  @Index()
  @Property({ name: 'resolved_agency_id', type: 'uuid', nullable: true })
  resolvedAgencyId?: string | null

  @Property({ name: 'script_version', type: 'text' })
  scriptVersion!: string

  /** YYYY-MM (envelope month — for quick filtering). */
  @Property({ name: 'month', type: 'text' })
  month!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /** Set when an OM PartnerOps user clicks one of the three resolve actions on B10. */
  @Index()
  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  @Property({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId?: string | null

  /** Enum check (DB-side): 'accepted_after_fix' | 'rolled_back' | 'ignored'. */
  @Property({ name: 'resolution_action', type: 'text', nullable: true })
  resolutionAction?: string | null

  @Property({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote?: string | null
}

/**
 * PRM `ServiceIdempotencyKey` — auth infrastructure side table for `ServiceAuthMiddleware`.
 *
 * NOT a PRM domain entity. Lives here in v1 because PRM is the only consumer; lift to a
 * shared module when a second service-identity surface adopts the pattern.
 *
 * The natural key is `(endpoint, idempotency_key)` — exposed as a composite UNIQUE.
 * The PK is a synthetic UUID `id` because the OM core query_index reindexer hardcodes
 * `b.id` as the partition / pagination column (`reindexer.ts:179,332,336`); without an
 * `id` column `yarn initialize` fails on the reindex pass. Same workaround pattern as
 * `ProspectCandidateIndex` (T1 spec §11).
 *
 * Tenant context is the singleton PRM tenant resolved from env config (spec §6.1) with
 * runtime fallback to the first PRM Agency. Service requests have no tenant in the
 * request itself.
 */
@Entity({ tableName: 'prm_service_idempotency_key' })
@Unique({
  properties: ['tenantId', 'endpoint', 'idempotencyKey'],
  name: 'prm_service_idempotency_key_tenant_endpoint_key_uniq',
})
export class ServiceIdempotencyKey {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'endpoint', type: 'text' })
  endpoint!: string

  @Property({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string

  @Index()
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Index()
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** sha256 of canonical request body. Used for "same key + same payload → replay". */
  @Property({ name: 'payload_hash', type: 'text' })
  payloadHash!: string

  /** sha256 of response body. Tracked for invariant: response was deterministic at first commit. */
  @Property({ name: 'response_hash', type: 'text' })
  responseHash!: string

  @Property({ name: 'response_status', type: 'integer' })
  responseStatus!: number

  /** Replayed verbatim on idempotent retry. */
  @Property({ name: 'response_body', type: 'json' })
  responseBody!: Record<string, unknown>

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}
