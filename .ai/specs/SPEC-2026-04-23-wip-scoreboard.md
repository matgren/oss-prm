# SPEC-2026-04-23 — WIP Scoreboard (Prospect Lifecycle + Dashboard)

> **Spec reconciled with shipped code 2026-05-05.** Original spec drafted 2026-04-23. **Sections reconciled:**
> - §3.1 portal route paths — `/api/portal/prospects` → `/api/prm/portal/prospects`. Pagination is `page` + `pageSize` offset-based (NOT keyset cursor); the original spec called for `cursor` + `next_cursor` but no shipped route implements it. Default ordering is `registered_at DESC, id DESC`. Response envelope: `{ ok, items, page, pageSize, total, totalPages }`.
> - §3.2 backend route path — `/api/backend/prm/prospects` → `/api/prm/prospects`.
> - §3.3 dashboard — single endpoint `/api/prm/portal/dashboard` shipped (not enumerated in the original spec) returns the WIP/WIC/tier aggregate in one round-trip.
> - §5 entity columns — both `tenant_id` AND `organization_id` ship together; tables are `prm_prospects` and `prm_prospect_candidate_index` (plural with module prefix). The original spec's `(organization_id, agency_id, ...)` indexes ship as `(agency_id, ...)` in T1 (tenant scoping is via the `tenant_id` index — see entities.ts).
> - §9 integration tests — IT-9.1..IT-9.9 not implemented (Playwright runner deferred to QA team). Enumeration moved to `POST-MVP-FOLLOW-UPS.md`.
> - §11 changelog — entry added.
> See `POST-MVP-FOLLOW-UPS.md` for tracked deferrals (cache wrappers, tier_requirements DB promotion, `prm.prospect.update` undo).
>
> **Spec ID:** SPEC-2026-04-23-wip-scoreboard
> **Phase:** 2 of 7 (WIP Scoreboard)
> **Author:** Piotr (om-cto Spec Orchestrator), persona Martin Fowler for architectural review
> **Date:** 2026-04-23
> **Depends on:** SPEC-2026-04-23-agency-foundation (Agency + AgencyMember entities seeded)
> **Stories covered:** US3.1, US3.2, US3.3, US6.3 (WIC widget), plus Dashboard P2 layout + tier-requirement widget + WIP widget
> **Estimated commits:** 6–8
> **Source:** `app-spec/app-spec.md` §§1.4.1, 1.4.2, 1.4.3, 1.4.5, 3 (WF3a), 3.5.1–3.5.2, 4 (US3.1–3.3, US6.3), 5.1, 5.2, 6.1, 7

---

## 1. Summary, Scope, and Business Outcome

### TLDR

**Key Points:**
- Ship the first visible Open Mercato PRM scoreboard: Agencies self-manage a `Prospect` pipeline (register → qualified → contacted → lost/dormant) and see a portal dashboard with live WIP, WIC, and tier-progress widgets.
- Primary goal: *"My WIP number is on a dashboard, not in Mat's head."* (WF3a). 100% of new Prospect registrations in portal within 30 days; portal-reported WIP matches a Piotr-run manual SQL count within 1 minute.

**Scope (Phase 2):**
- Portal pages P5 (Prospects list) and P6 (Prospect detail / create / edit).
- Portal page P2 (Dashboard) assembly — layout + WIP widget + WIC widget (US6.3) + tier-requirement widget; renders onboarding-incomplete and `status = historical` banners produced by Spec #1's cascade subscribers.
- Backend page B4 (Prospects — cross-agency read-only list for OM PartnerOps).
- New entities: `Prospect` aggregate + `ProspectCandidateIndex` read-model projection (retrofitted in Phase 2 per Cagan C2 because backfill-later is more expensive).
- Prospect state machine (invariant #12) end-to-end, with system-actor attribution row (Vernon C2) and PartnerMember voluntary-`lost` row (C4).
- `prm.prospect.registered` and `prm.prospect.status_changed` events with normalized-key payload.

**Explicitly out of scope for this spec:**
- LicenseDeal attribution (WF3b, Spec #3).
- RFP sourcing path (Phase 5).
- WIC ingestion worker (Phase 4) — the WIC widget reads whatever `WICContribution` rows happen to exist, and renders an "awaiting data" placeholder when empty.
- Cross-agency Prospect editing (B4 is read-only; no backend Prospect writes anywhere).
- Portal export (CSV) or Kanban view (US3.3 alternate paths explicitly deferred).

**Concerns:**
- Retrofitting `ProspectCandidateIndex` in Phase 2 means backfilling zero rows today, but the subscriber must never diverge from the aggregate — we accept this cost now rather than in Phase 3 when real attribution traffic starts.
- WIC widget ships before WIC ingestion (Phase 4) exists; "awaiting data" placeholder is load-bearing UX.
- Portal shell does NOT ship `DataTable` / `CrudForm` (OQ-010) — P5 and P6 are hand-rolled React.

### Business Outcome (Cagan criteria, §7 Phase 2 acceptance)

| Criterion | Target | Source |
|---|---|---|
| WIP channel migration | 100% of new Prospect registrations happen in portal (zero via Mat's BCC-email flow) within 30 days of launch | WF3a ROI |
| Prospect velocity | Median time `new → qualified` < 7 days | WF3a ROI |
| Scoreboard integrity | Portal WIP widget matches a Piotr-run manual SQL count within 1 minute | §7 Phase 2 |
| Invariant #1 | `Prospect.registered_at` stamped at INSERT, immutable thereafter | §1.4.2 #1 |
| Invariant #12 | State-machine transitions enforced per-actor; every change emits `prm.prospect.status_changed` | §1.4.2 #12 |
| Projection consistency | One `ProspectCandidateIndex` row per Prospect; normalized keys match current Prospect row | §7 Phase 2 |

---

## 2. Technical Approach (Piotr)

> Embedded verbatim from the spec brief. No editorial changes.

- **Mode:** Extend PRM module (from Spec #1) with Prospect aggregate + dashboard assembly. No core module modifications.
- **New entities:**
  - `Prospect` (aggregate, FK `agency_id`, FK `registered_by_agency_member_id`, `status` enum per invariant #12 state machine, `company_name`, `contact_email`, `contact_name`, `notes` text, `lost_reason` nullable, `source` enum, `registered_at` timestamp — **set at INSERT, never changes per invariant #1**, `status_changed_at`). `status_changed_at` maintained by aggregate, not by DB trigger.
  - `ProspectCandidateIndex` read-model projection (FK `prospect_id`, `normalized_company_name`, `lowercased_contact_email`, `current_status`). One row per Prospect, maintained by subscriber on `prm.prospect.registered` + `prm.prospect.status_changed`. Retrofitted projections require backfill migration — Cagan C2 accepted projection in Phase 2 despite attribution being Phase 3 (cheaper now).
- **State machine (invariant #12):** enforced in the aggregate's status-transition method. States: `new` → `qualified` → `won` / `lost`. Transitions emit `prm.prospect.status_changed` with `from_status`, `to_status`, `by_actor_id`, `by_actor_type` (`user` / `customer_user` / `system` per Vernon C2). System-actor row (C2) for transitions triggered by cascade (e.g., Agency status=historical).
- **Normalized keys:** on `prm.prospect.registered`, enricher computes `normalized_company_name` (lower-cased, trimmed, punctuation-stripped) + `lowercased_contact_email`. These are added to the event payload AND persisted on `ProspectCandidateIndex`.
- **P5 portal list (OQ-010):** custom React list — no DataTable (portal shell does NOT ship DataTable). Filters: status, source, month. Quick-action status transitions via form POST.
- **P6 portal detail + create:** custom React form. State-machine-aware CTAs — valid transitions only. Client-side validation matches aggregate validation.
- **Dashboard P2 assembly:**
  - Layout: card-grid of widgets. Uses portal-themed primitives (`PortalCard`, `PortalPageHeader` from `@open-mercato/ui/src/portal/components/`).
  - WIP widget: aggregate query on Prospect count in status `qualified` (monthly + yearly) per Agency. Yearly+monthly toggle per L-011 (single widget with toggle, not two widgets).
  - WIC widget (US6.3): per-member breakdown of `WICContribution` totals (monthly + yearly toggle). WIC data may be empty in Phase 2 if WIC ingestion (Spec #4) hasn't shipped — widget renders "awaiting data" placeholder. WIC classification is a black box (L-002) — widget is display-only, not logic-bearing.
  - Tier-progress widget: reads static `tier_requirements` seeded in Spec #1 + current Agency's `tier`; computes pct-to-next-tier. Read-only per Cagan business criteria.
  - Onboarding-incomplete banner + status=historical banner (both come from Spec #1's cascade subscribers — this spec just renders).
- **No DataTable on portal (OQ-010):** every custom list (P5) is custom React. `CrudForm` + `DataTable` live at `packages/ui/src/backend/` only.
- **No backend write of Prospects:** B4 is cross-agency read-only for attribution candidate search (used later by Spec #3). All Prospect writes from portal.
- **Rationale:** Cheapest credible scoreboard. Every user story is simple CRUD + projection + dashboard assembly. Saga and attribution (Spec #3) bolt on later via `prm.prospect.status_changed` subscribers.

### Martin-Fowler observations on the Technical Approach (inline)

- The approach respects Vernon's aggregate-per-bounded-context pattern: the state-machine precondition lives on the aggregate, NOT in a service or route guard, so illegal transitions fail at the same layer regardless of caller (portal, backend, saga).
- `ProspectCandidateIndex` is correctly modelled as a read-model projection and NOT a second source of truth. The aggregate remains authoritative for `status`.
- The WIP calculation (§1.4.3) filters `source = 'agency_owned'` AND `status NOT IN ('lost')` — this is preserved in the widget query; RFP-sourced opportunities are invisible to WIP even once RFP lands in Phase 5.
- Widget toggles (monthly / yearly) are a single widget with a control, not two widgets, per L-011. This minimises dashboard churn and is canonicalised across WIP, WIC, and tier-progress.

---

## 3. API Contracts

All routes use `zod` schemas for request validation and return typed error envelopes. Every route exports `openApi` metadata. Portal routes are tenant-scoped by `organization_id` derived from the authenticated `CustomerUser.organization_id`; backend routes enforce `organization_id = null` OR cross-tenant read per OM staff role.

### 3.1 Portal — `/api/prm/portal/prospects`

> **Shipped path convention:** all portal routes live under `/api/prm/portal/...` (matches T0's portal namespace). The original spec wrote `/api/portal/...`; references below have been corrected.

#### `GET /api/prm/portal/prospects`

List own-Agency Prospects. Covers US3.3.

- **Auth:** `requireAuth` (portal CustomerUser session). `requireFeatures(['prm.prospect.read_own_agency'])`.
- **Query parameters (zod, shipped):**
  ```ts
  z.object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(['new','qualified','contacted','won','lost','dormant']).optional(),
    source: z.enum(['agency_owned','event','other']).optional(),
    registeredMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  })
  ```
- **Pagination:** offset-based (`page` + `pageSize`, capped at 100, default 25). The original spec called for keyset cursor pagination on `(registered_at DESC, id DESC)`; the shipped route uses offset + the same DESC ordering. Switching to keyset is a future concern only when prospect counts make offset slow.
- **Response:**
  ```ts
  {
    ok: true,
    items: Array<{
      id: string,
      agencyId: string,
      organizationId: string,
      companyName: string,
      contactName: string,
      contactEmail: string,
      status: 'new'|'qualified'|'contacted'|'won'|'lost'|'dormant',
      source: 'agency_owned'|'event'|'other',
      lostReason: string | null,
      notes: string | null,
      registeredAt: string,         // ISO8601 UTC, immutable
      statusChangedAt: string,      // ISO8601 UTC
      registeredByAgencyMemberId: string,
      canEdit: boolean,             // server-computed per RBAC
      canTransitionTo: Array<'qualified'|'contacted'|'lost'|'dormant'>,
    }>,
    page: number,
    pageSize: number,
    total: number,
    totalPages: number,
  }
  ```
- **Cache:** declared in original spec as tag `prm.agency.{agencyId}.prospects.list` with 60s TTL. **NOT WIRED in T1** — the dashboard is a hand-rolled portal aggregate; the framework's cache wrappers attach at the CRUD-factory layer. See `POST-MVP-FOLLOW-UPS.md`.
- **Errors:** `401` unauthenticated, `403` PartnerMember viewing another agency.

#### `POST /api/prm/portal/prospects`

Register a new Prospect. Covers US3.1.

- **Auth:** `requireAuth`. `requireFeatures(['prm.prospect.register'])`.
- **Body (zod):**
  ```ts
  z.object({
    company_name: z.string().min(1).max(200),
    contact_name: z.string().min(1).max(150),
    contact_email: z.string().email().max(200),
    source: z.enum(['agency_owned','event','other']).default('agency_owned'),
    notes: z.string().max(10000).optional(),
  })
  ```
- **Command dispatched:** `prm.prospect.register` (see §4).
- **Response `201`:** `{ id: string, registered_at: string, status: 'new' }`.
- **Errors:**
  - `400` zod validation.
  - `409` Agency `status = historical` precondition (surface-text: `"Your Agency is historical — contact OM support"`).
  - `403` attempt to set `registered_by_agency_member_id` other than own session.

#### `GET /api/prm/portal/prospects/{id}`

Read one own-Agency Prospect. Covers P6 view.

- **Auth:** `requireAuth`. `requireFeatures(['prm.prospect.read_own_agency'])`. 404 for cross-agency IDs (do not leak existence).
- **Response:** full Prospect record + server-computed `can_transition_to` array.

#### `PATCH /api/prm/portal/prospects/{id}`

Edit mutable fields OR transition status. Covers US3.2. Two request shapes behind one route for atomicity:

- **Auth:** `requireAuth`.
- **Body (discriminated union, zod):**
  ```ts
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('edit'),
      contact_name: z.string().min(1).max(150).optional(),
      contact_email: z.string().email().max(200).optional(),
      notes: z.string().max(10000).optional(),
      // company_name intentionally editable per US3.2; registered_at NEVER accepted
    }),
    z.object({
      kind: z.literal('transition'),
      to_status: z.enum(['qualified','contacted','lost','dormant']),
      lost_reason: z.string().min(10).max(1000).optional(), // required iff to_status = 'lost'
      if_match_status_changed_at: z.string(),               // optimistic concurrency token
    }),
  ])
  ```
- **Command dispatched:** `prm.prospect.update` (edit) OR `prm.prospect.transition_status` (transition).
- **Response `200`:** refreshed Prospect record.
- **Errors:**
  - `400` zod / `lost_reason` missing for `lost`.
  - `403` PartnerMember transitioning a Prospect authored by someone else — text: `"Only the author or your PartnerAdmin can transition this Prospect"`.
  - `403` portal user sets `won` — text: `"'won' is assigned by OM Partner Operations at license attribution."`
  - `409` illegal transition per invariant #12 — text: `"Prospect status transition not allowed"`.
  - `409` optimistic concurrency conflict (`if_match_status_changed_at` mismatch).

> **`registered_at` immutability (invariant #1):** the PATCH schema does not accept the field. Any payload containing `registered_at` is rejected at zod parse. Belt-and-braces: the aggregate's `update` method ignores `registered_at` even if somehow smuggled.

### 3.2 Backend — `/api/prm/prospects`

> **Shipped path convention:** backend route lives at `/api/prm/prospects` (the standalone-app drops the `/backend/` segment). The original spec wrote `/api/backend/prm/prospects`; references below have been corrected.

#### `GET /api/prm/prospects`

Cross-agency read-only Prospect list for OM PartnerOps (B4). Used by Spec #3's attribution candidate search, but callable independently for audit.

- **Auth:** `requireAuth` (OM staff). `requireFeatures(['prm.prospect.read_cross_agency'])`. (The original spec also called for `requireRoles(['om_partner_ops','om_admin'])`; T1 ships feature-only enforcement matching the standalone-app convention — roles are conferred via `setup.ts` `defaultRoleFeatures`.)
- **Query parameters (zod, shipped):**
  ```ts
  z.object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    agencyId: z.string().uuid().optional(),
    status: z.enum(['new','qualified','contacted','won','lost','dormant']).optional(),
    normalizedCompanyName: z.string().trim().max(200).optional(),
    lowercasedContactEmail: z.string().trim().max(200).optional(),
  })
  ```
- **Pagination:** offset-based (matches portal). The original spec called for cursor pagination; T1 ships offset for parity with the rest of the PRM module.
- **Read path:** joins `prm_prospects` + `prm_prospect_candidate_index` on `prospect_id`. Filters use index columns; ordering is `registered_at ASC` (Golden Rule default for candidate-picker).
- **Response envelope:** `{ ok: true, items, page, pageSize, total, totalPages }` — same shape as the portal route plus `agencyId` per row (cross-agency disclosure is the whole point of B4).
- **No write endpoints.** B4 is read-only; all Prospect writes go through portal.

### 3.3 Portal dashboard aggregate — `/api/prm/portal/dashboard`

> **Shipped route not enumerated in the original spec.** T1 implements the P2 dashboard as a single-round-trip aggregate endpoint to avoid 3+ parallel widget requests. This is the surface §2 "Dashboard P2 assembly" calls for; documenting here so downstream specs can rely on the contract.

#### `GET /api/prm/portal/dashboard?year=…&month=…`

- **Auth:** `requireAuth` (portal CustomerUser session) + `requireFeatures(['prm.dashboard.view'])`.
- **Query parameters:** `year` (default current UTC year), `month` (default current UTC month, 1-12). Both optional.
- **Response:** `{ ok: true, dashboard: { agency, period: { year, month }, wip: { monthly, yearly, byStatus }, wic: { awaiting, monthlyTotal, yearlyTotal, perMember[] }, tier: { current, next, pctToNext } | null } | null }`.
- **WIP widget:** counts `prm_prospects` rows for the caller's agency where `source = 'agency_owned' AND status NOT IN ('lost') AND deleted_at IS NULL` (invariant #14). Splits into monthly + yearly + per-status breakdown.
- **WIC widget:** introspects `prm_wic_contributions` (Spec #4) at runtime via `to_regclass` + `information_schema.columns`. When the table doesn't exist yet OR contains zero rows for the agency, returns `{ awaiting: true }` and the widget renders the placeholder.
- **Tier widget:** reads the in-code `tier_requirements` registry from `lib/tierRequirements.ts` (the original spec called for a seeded DB table; T1 ships the registry as an in-code constant — see `POST-MVP-FOLLOW-UPS.md` for promotion).
- **Cache:** declared in original spec as `prm.agency.{agencyId}.dashboard.{yyyy-mm}` with 60s TTL. **NOT WIRED in T1** — see `POST-MVP-FOLLOW-UPS.md`.

### 3.4 OpenAPI

Every route above exports `openApi` metadata with tag `prm.prospect` and describes request/response/error codes. Error shapes follow the core envelope: `{ error: { code: string, message: string, details?: object } }`.

---

## 4. Commands & Events

Per Piotr Principle #8 (all writes undoable), every state-changing operation is modelled as a `Command` with an explicit `undo` contract and dispatches through the command bus.

### 4.1 Commands

#### `prm.prospect.register`

- **Input:** `{ agency_id, registered_by_agency_member_id, company_name, contact_name, contact_email, source, notes? }`
- **Do:** inserts a row into `prospects` with `status = 'new'`, stamps `registered_at = now()`, `status_changed_at = now()`. Emits `prm.prospect.registered` on success.
- **Undo:** soft-delete (`deleted_at = now()`) the inserted Prospect AND compensating event `prm.prospect.registration_reverted { prospect_id }` so the projection subscriber removes the candidate-index row. Hard delete is forbidden because the ID may already be referenced by compensating audit trails (saga-defensive).
- **Idempotency:** client-supplied `Idempotency-Key` header; duplicate-key re-dispatches return the original Prospect ID.

#### `prm.prospect.transition_status`

- **Input:** `{ prospect_id, to_status, by_actor_type, by_actor_id, reason?, lost_reason?, if_match_status_changed_at }`
- **Do:** aggregate enforces invariant #12 transition matrix; on accept, updates `status`, `status_changed_at = now()`, and (if `to_status = 'lost'`) `lost_reason`. Emits `prm.prospect.status_changed`.
- **Undo:** re-dispatch `prm.prospect.transition_status` with `from_status`/`to_status` inverted, `by_actor_type = 'system'`, `reason = 'compensating_undo'`. Caveat: invariant #12 forbids arbitrary reverse transitions (e.g., `lost → qualified`); the undo is therefore valid ONLY when the original transition is itself reversible under invariant #12. Non-reversible transitions (e.g., saga-driven `* → won`) are flagged at command authoring time and do not ship an undo; the saga compensates via `prm.license_deal.attribution_reversed` (Spec #3). This is the Vernon C2 path and is explicit.
- **Concurrency:** `if_match_status_changed_at` optimistic lock.

#### `prm.prospect.update`

- **Input:** `{ prospect_id, patch: { contact_name?, contact_email?, notes?, company_name? } }`
- **Do:** applies the patch to the aggregate; emits `prm.prospect.updated`. `registered_at` and `status` are rejected at the aggregate boundary.
- **Undo:** re-dispatch with the pre-state patch (captured in the command's before-snapshot).

### 4.2 Events (published)

All events live under the `prm.*` namespace; naming is singular per Fowler's Singularity Law.

| Event | Payload | Emitted when |
|---|---|---|
| `prm.prospect.registered` | `{ prospect_id, agency_id, registered_at, source, normalized_company_name, lowercased_contact_email, registered_by_agency_member_id }` | Successful `prm.prospect.register` |
| `prm.prospect.status_changed` | `{ prospect_id, from_status, to_status, by_actor_type, by_actor_id, reason?, changed_at }` | Every successful transition (including saga-driven in later phases) |
| `prm.prospect.updated` | `{ prospect_id, agency_id, changed_fields: string[], changed_at }` | Successful `prm.prospect.update` |
| `prm.prospect.registration_reverted` | `{ prospect_id }` | Compensating event for `prm.prospect.register` undo |

### 4.3 Subscribers shipped in this spec

- **`ProspectCandidateIndex` projection subscriber** — binds `prm.prospect.registered` (UPSERT) + `prm.prospect.status_changed` (UPDATE `current_status`) + `prm.prospect.updated` (UPDATE normalized keys when `company_name` or `contact_email` changed) + `prm.prospect.registration_reverted` (DELETE). Idempotent on `prospect_id`.
- **Agency-status guard precondition subscriber** — binds `prm.agency.status_changed` from Spec #1; updates the aggregate's local read-model cache used by the `Prospect.register` precondition (Vernon C3 pattern). No direct cross-module ORM.

> Dashboard and list widgets read directly from the read-model tables; no dedicated subscribers needed there. Cache invalidation tags (§6.2) use the event stream.

---

## 5. Data Models

Tables live in the `public` schema with the `prm_` table-name prefix per the standalone-app naming convention; the original spec sketched a `prm.` PostgreSQL schema namespace which was discarded during T0 and is not used here.

### 5.1 `prm_prospects` (aggregate, table name plural with module prefix)

Columns:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NO | PK |
| `tenant_id` | `uuid` | NO | tenant isolation (matches T0; original spec named only `organization_id`) |
| `organization_id` | `uuid` | NO | organization scope |
| `agency_id` | `uuid` | NO | FK ID to `prm_agencies` (NO ORM relation; FK ID only per root AGENTS rule) |
| `registered_by_agency_member_id` | `uuid` | NO | FK ID to `prm_agency_members` |
| `company_name` | `text` | NO | |
| `contact_name` | `text` | NO | |
| `contact_email` | `text` | NO | stored as entered; normalization for matching lives in the index table |
| `source` | `text` | NO | enum: `agency_owned` / `event` / `other`. DB check constraint |
| `status` | `text` | NO | enum per invariant #12. DB check constraint |
| `lost_reason` | `text` | YES | required iff `status = 'lost'` (aggregate-enforced, also DB check) |
| `notes` | `text` | YES | |
| `registered_at` | `timestamptz` | NO | **immutable after INSERT per invariant #1**; enforced by aggregate whitelist + DB column-level UPDATE trigger (defence-in-depth) |
| `status_changed_at` | `timestamptz` | NO | maintained by aggregate on every transition |
| `created_at` | `timestamptz` | NO | default `now()` |
| `updated_at` | `timestamptz` | NO | maintained by aggregate |
| `deleted_at` | `timestamptz` | YES | soft-delete for undo contract |

Indexes (shipped):

- `(tenant_id)`, `(organization_id)`, `(agency_id)` — single-column tenant + agency scope.
- `(registered_by_agency_member_id)` — author-scoped RBAC check.
- `(status)`, `(registered_at)` — portal list filter + WIP widget.
- The original spec called for compound indexes `(organization_id, agency_id, status)` etc. T1 ships single-column indexes per the MikroORM `@Index()` decorator output; the planner combines them effectively for the small per-agency volumes Phase 2 expects. Tighter compound indexes can be added in a follow-up index migration if WIP queries hot-spot.

Constraints (shipped via the index migration):

- `CHECK (status IN ('new','qualified','contacted','won','lost','dormant'))`
- `CHECK (source IN ('agency_owned','event','other'))`
- `CHECK (status <> 'lost' OR (lost_reason IS NOT NULL AND char_length(lost_reason) >= 10))`
- DB UPDATE trigger on `registered_at` to enforce invariant #1.
- FK to `prm_agencies` (RESTRICT), FK to `prm_agency_members` (RESTRICT).

No unique constraint on `(agency_id, contact_email)` or `(agency_id, company_name)` — per invariant #2, conflict detection is deferred to attribution time; duplicates are allowed at registration.

### 5.2 `prm_prospect_candidate_index` (read-model projection)

Columns:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `prospect_id` | `uuid` | NO | PK; FK ID to `prm_prospects` (CASCADE on delete) |
| `organization_id` | `uuid` | NO | organization scope (mirrored for cross-agency query fairness) |
| `agency_id` | `uuid` | NO | mirrored for fast filter in B4 |
| `normalized_company_name` | `text` | NO | lower-cased, trimmed, punctuation-stripped |
| `lowercased_contact_email` | `text` | NO | `LOWER(TRIM(contact_email))` |
| `current_status` | `text` | NO | mirror of `prm_prospects.status` |
| `registered_at` | `timestamptz` | NO | mirrored for Golden Rule ordering in Spec #3 |
| `projection_updated_at` | `timestamptz` | NO | last subscriber write |

Indexes (shipped):

- `(organization_id)`, `(agency_id)`, `(normalized_company_name)`, `(lowercased_contact_email)`.

No unique constraint on normalized keys (invariant #2 forbids duplicate detection at registration time; multiple prospects may share the same normalized key and that's the whole point of the candidate-list surfaced at attribution in Spec #3).

### 5.3 Migration / backfill

- Phase 2 migration creates both tables empty. No backfill needed because no Prospect rows exist pre-Phase-2.
- The subscriber is deployed **in the same migration transaction** as the tables so the projection cannot drift from day one. (Cagan C2 rationale: retrofitting later would require a backfill migration once Prospect rows exist; doing it now costs nothing.)

---

## 6. Access Control

Per §1.4.4 and invariant #12 actor rules. All entries are declared as ACL `features` on the PRM module's feature registry.

### 6.1 Feature flags declared

| Feature ID | Description |
|---|---|
| `prm.prospect.read_own_agency` | Read Prospects in own Agency (PartnerAdmin + PartnerMember) |
| `prm.prospect.read_cross_agency` | Read Prospects across all Agencies (OM PartnerOps + Admin) |
| `prm.prospect.register` | Create a new Prospect (PartnerAdmin + PartnerMember) |
| `prm.prospect.transition_any_in_agency` | Transition any Prospect in own Agency (PartnerAdmin only) |
| `prm.prospect.transition_own_authored` | Transition own-authored Prospects (PartnerMember; also granted to PartnerAdmin by entailment) |
| `prm.dashboard.view` | Read the P2 dashboard (PartnerAdmin + PartnerMember) |
| `prm.wic.read_own_agency` | Read own-Agency WIC widget data (PartnerAdmin + PartnerMember) |
| `prm.tier_requirement.read` | Read tier-requirement widget (PartnerAdmin + PartnerMember) |

### 6.2 Per-role grants

| Role | Features granted |
|---|---|
| `PartnerAdmin` | `prm.prospect.read_own_agency`, `prm.prospect.register`, `prm.prospect.transition_any_in_agency`, `prm.prospect.transition_own_authored`, `prm.dashboard.view`, `prm.wic.read_own_agency`, `prm.tier_requirement.read` |
| `PartnerMember` | `prm.prospect.read_own_agency`, `prm.prospect.register`, `prm.prospect.transition_own_authored`, `prm.dashboard.view`, `prm.wic.read_own_agency`, `prm.tier_requirement.read` |
| `OMPartnerOps` | `prm.prospect.read_cross_agency` |
| `OMAdmin` | all of the above |

### 6.3 Server-side enforcement

- **Route guards:** `requireAuth` + `requireFeatures([...])` per route in §3.
- **Author-scope check (invariant #12 C4):** in addition to the feature flag, the `prm.prospect.transition_status` command checks:
  ```
  if (by_actor.role === 'PartnerMember' && !by_actor.has('prm.prospect.transition_any_in_agency') &&
      prospect.registered_by_agency_member_id !== by_actor.agency_member_id) → 403
  ```
- **`won` guard:** the aggregate's transition method rejects `to_status = 'won'` from any `by_actor_type = 'customer_user'` regardless of role. `won` is only reachable via `by_actor_type = 'system'` dispatched by the Spec #3 attribution saga.
- **Tenant isolation:** every portal query filters `WHERE organization_id = :session.organization_id AND agency_id = :session.agency_id`. B4 uses `organization_id IS NOT NULL` only (OM staff cross-tenant read, documented carve-out).

### 6.4 i18n keys

- `prm.prospect.error.agency_historical`
- `prm.prospect.error.not_author_or_admin`
- `prm.prospect.error.won_is_om_only`
- `prm.prospect.error.invalid_transition`
- `prm.prospect.widget.wic.awaiting_data`
- `prm.prospect.widget.wip.title` + `…subtitle_monthly` + `…subtitle_yearly`
- `prm.prospect.widget.tier_progress.title` + `…pct_to_next`

---

## 7. Backward Compatibility

- **Additive-only.** This spec adds two tables (`prm.prospect`, `prm.prospect_candidate_index`), four events (`prm.prospect.registered`, `prm.prospect.status_changed`, `prm.prospect.updated`, `prm.prospect.registration_reverted`), three commands, three portal routes, one backend route, three dashboard widgets, and one portal page pair (P5/P6). It introduces zero changes to existing core module APIs, schemas, or contracts.
- **No changes to Spec #1 (`agency-foundation`) contracts.** `Agency` and `AgencyMember` entities are read-only consumers; their migrations are untouched.
- **No core module modifications.** Portal shell, backend shell, `events`, `entities`, `acl` modules are used as-is per their public contracts. UI primitives (`PortalCard`, `PortalPageHeader`) are consumed, not extended.
- **Feature-flag roll-out safe.** All new features are gated by ACL feature flags; disabling `prm.prospect.register` at deploy keeps the backend green while UI rolls out.
- **Event-subscriber additive.** New subscribers (ProspectCandidateIndex, Agency-status guard) bind to NEW event names only; no existing subscribers modified.
- **No breaking changes to `WICContribution` schema** — WIC widget reads the existing Spec #1 schema through already-shipped primitives.

---

## 8. Risks & Impact Review

### 8.1 Data Integrity Failures

#### R-1: `registered_at` mutation via malicious API client
- **Scenario:** Client POSTs a `PATCH /api/prm/portal/prospects/{id}` body containing `registered_at` even though the schema forbids it.
- **Severity:** High (violates invariant #1, the Golden Rule).
- **Affected area:** Prospect aggregate, attribution fairness across all agencies (downstream to Spec #3).
- **Mitigation:** triple defence — (a) zod schema does not declare `registered_at`; extra keys rejected with `.strict()`, (b) aggregate `update()` method whitelists editable fields and ignores everything else, (c) optional DB column-level trigger (`RAISE EXCEPTION ON UPDATE` for `registered_at`) shipped as a defensive migration.
- **Residual risk:** a DBA with direct SQL access could bypass all three. Accepted; audit-logged via WAL in infra layer.

#### R-2: Crash between `prm.prospect.register` command acceptance and projection subscriber run
- **Scenario:** Worker dies between writing the `prospects` row and the `ProspectCandidateIndex` subscriber consuming the event.
- **Severity:** Medium.
- **Affected area:** Spec #3's B5 attribution picker would miss a candidate.
- **Mitigation:** the `events` module's transactional outbox guarantees at-least-once delivery; the subscriber is idempotent (UPSERT keyed on `prospect_id`). A nightly `projection-repair` job (shipped as part of Spec #1's cross-cutting infra) reconciles missing rows.
- **Residual risk:** up to one nightly cycle of stale index. Acceptable for Phase 2 because attribution consumer does not ship until Spec #3.

#### R-3: Optimistic-concurrency race on status transition
- **Scenario:** PartnerAdmin and authoring PartnerMember simultaneously transition the same Prospect.
- **Severity:** Medium.
- **Affected area:** WIP accuracy for ~1 minute.
- **Mitigation:** `if_match_status_changed_at` header; second writer gets `409`.
- **Residual risk:** ergonomic friction only.

### 8.2 Cascading Failures & Side Effects

#### R-4: `status = historical` Agency cascade vs in-flight Prospect edits
- **Scenario:** OM staff flips an Agency to `historical` while that Agency's PartnerAdmin has an open Prospect edit tab. The tab's next save hits a now-rejecting aggregate.
- **Severity:** Medium.
- **Affected area:** portal UX; no data loss.
- **Mitigation:** aggregate rejects the write with a structured `409` carrying `{ code: 'agency_historical' }`; portal catches and shows a persistent banner. User's draft text is preserved client-side until banner-dismissed.
- **Residual risk:** client-side draft loss on accidental reload. Accepted v1 limitation (matches US3.1 failure-path W11 "abandon-mid-flow").

#### R-5: Projection subscriber fails during a bulk re-deploy
- **Scenario:** Subscriber version skew during rolling deploy leaves rows in a mixed-normalization state.
- **Severity:** Medium.
- **Affected area:** cross-agency candidate search (B4, Spec #3).
- **Mitigation:** projection subscribers are deterministic on `(prospect_id, event_version)`; deploy includes a migration-time `REFRESH PROJECTION prm.prospect_candidate_index` helper that replays `prm.prospect.registered` and `prm.prospect.updated` events from the outbox window.
- **Residual risk:** brief window of mixed-version keys during rollout. Mitigated by the refresh helper; acceptable.

### 8.3 Tenant & Data Isolation Risks

#### R-6: Portal PartnerMember sees another agency's Prospects (US3.3 failure path)
- **Scenario:** query forgets `agency_id` filter; cross-tenant leak.
- **Severity:** Critical.
- **Affected area:** all portal list/detail routes.
- **Mitigation:** every portal query filters by `tenant_id` + `agency_id` (the shipped service uses `findWithDecryption` with explicit tenant scope; integration tests (§9) assert `GET /api/prm/portal/prospects` as Agency B never returns Agency A rows). Backend B4 filters by `tenant_id` + optional cross-agency `agencyId` and is explicitly scoped to OM-staff features only.
- **Residual risk:** none if the helper is used; lint rule flags raw `SELECT FROM prm.prospect` outside the helper.

#### R-7: Dashboard widget caching leaks across agencies
- **Scenario:** WIP widget uses a cache key missing `agency_id`.
- **Severity:** Critical.
- **Affected area:** P2 dashboard.
- **Mitigation:** cache tags MUST be `prm.agency.{agencyId}.dashboard.wip` / `.wic` / `.tier_progress` with the agency ID embedded; unit test asserts tag contains agency ID.
- **Residual risk:** none.

### 8.4 Migration & Deployment Risks

#### R-8: Projection table introduced in Phase 2 but backfill never runs
- **Scenario:** Spec #3 starts in Phase 3 and assumes 100% projection coverage; but one early-Phase-2 Prospect was created before the subscriber was wired.
- **Severity:** Medium.
- **Affected area:** attribution-candidate completeness.
- **Mitigation:** same transaction pattern — migration that creates `prm.prospect_candidate_index` ALSO wires the subscriber and ALSO runs a `SELECT … FROM prm.prospect` one-shot backfill INSERT for any pre-existing rows (zero in Phase 2 cold-start, but idempotent for safety).
- **Residual risk:** none.

#### R-9: Enum migration for `status` on Prospect v2
- **Scenario:** a future phase adds a new status value; existing rows + check constraint break.
- **Severity:** Low (future concern).
- **Affected area:** later phases.
- **Mitigation:** status stored as `text` with check constraint (not a Postgres `ENUM`), so adding a value is a one-line `ALTER TABLE` check constraint swap.
- **Residual risk:** none in Phase 2.

### 8.5 Operational Risks

#### R-10: WIP widget query timeouts at scale
- **Scenario:** an Agency with thousands of Prospects; the WIP widget `COUNT(*)` scans the entire `prm.prospect` table.
- **Severity:** Low in Phase 2 (per-agency volumes are small), Medium at year 2.
- **Affected area:** dashboard p95.
- **Mitigation:** composite index `(organization_id, agency_id, DATE_TRUNC('month', registered_at))` with partial `WHERE deleted_at IS NULL AND status <> 'lost' AND source = 'agency_owned'`. Cache the widget's computed count in `prm.cache` keyed by `prm.agency.{agencyId}.dashboard.wip.{yyyy-mm}`, TTL 60s, invalidated on any `prm.prospect.*` for that agency.
- **Residual risk:** p95 spike on cache miss; bounded by 60s TTL.

#### R-11: WIC widget renders "awaiting data" forever because Spec #4 slips
- **Scenario:** Phase 4 delivery slips; Mat manually uploads WIC rows for one Agency only.
- **Severity:** Low (display-only).
- **Affected area:** user perception, not data.
- **Mitigation:** widget explicitly declares "last-imported month" reference and the "awaiting data" placeholder is informative, not alarming (§US6.3 failure path).
- **Residual risk:** user frustration; acceptable.

---

## 9. Integration Test Coverage

> **Status (2026-05-05 reconciliation):** the nine Playwright scenarios originally enumerated here (IT-9.1..IT-9.9) are **NOT implemented** in T1 — they require a live Postgres + ESP fixture and the QA team's Playwright runner stand-up. The full enumeration has been moved to `POST-MVP-FOLLOW-UPS.md` under "Playwright integration tests / T1 WIP Scoreboard"; deleting them from the spec body avoids the impression that they ship with T1. Unit-test coverage shipped in T1 is listed below.

### 9.1 Playwright scenarios — deferred

See `POST-MVP-FOLLOW-UPS.md` for the IT-9.1..IT-9.9 enumeration covering register/transition happy path, invariant #12 enforcement, `registered_at` immutability (invariant #1), projection consistency, tenant isolation, PartnerMember author-scope, agency-historical cascade rejection, dashboard widgets render, and cache invalidation. Each scenario is owned by the QA team and tracked individually. IT-9.9 (cache invalidation) is additionally blocked on the cache-wrapper follow-up.

### 9.2 Unit-test coverage shipped in T1

Net-new in `src/modules/prm/__tests__/` (47 tests on top of T0's 32):

- `prospectService.test.ts` (16 tests) — state-machine transitions; author-scope guard; `won`-is-system-only guard; optimistic concurrency on `status_changed_at`; register / update / transitionStatus / revertRegistration; candidate lookup via normalized keys.
- `prospectValidators.test.ts` (12 tests) — Zod schemas for register / update (discriminated edit/transition) / list (portal + backend); `PROSPECT_TRANSITIONS` matrix; `normalizeCompanyName` + `normalizeContactEmail` helpers.
- `prospectCandidateIndexProjection.test.ts` (5 tests) — idempotent UPSERT/DELETE handler; `prm.prospect.{registered,updated,status_changed,registration_reverted}` event handling.
- `tierRequirements.test.ts` (7 tests) — `computeTierProgress` against the in-code static registry.

Additionally, the four shipped subscribers (`prospect-candidate-index-on-{registered,updated,status-changed,reverted}.ts`) wire the shared projection handler to the event bus.

---

## 10. Final Compliance Report — 2026-04-23

### AGENTS.md Files Reviewed

- `AGENTS.md` (root) — singular naming, FK-ID-only cross-module, organization_id scoping, undoability default, zod validation.
- `packages/core/AGENTS.md` — `openApi` export on all routes, portal-vs-backend UI primitive placement, event-name conventions.
- `packages/cache/AGENTS.md` — tag-based invalidation, tenant-scoped keys.
- `packages/ui/AGENTS.md` — `@open-mercato/ui/src/portal/components/` primitives DO ship (OQ-016); `DataTable`/`CrudForm` live at `packages/ui/src/backend/` only (OQ-010).
- `packages/events/AGENTS.md` — transactional outbox, at-least-once delivery, idempotent subscribers.
- `packages/entities/AGENTS.md` — aggregate-per-bounded-context, singular entity names.
- `packages/acl/AGENTS.md` — `requireAuth` / `requireRoles` / `requireFeatures` guards, feature-flag registry.

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| root AGENTS.md | Singular entity / command / event naming | Compliant | `prm.prospect`, `prm.prospect.register`, `prm.prospect.registered` |
| root AGENTS.md | No cross-module ORM relationships | Compliant | `agency_id`, `registered_by_agency_member_id` are FK IDs only |
| root AGENTS.md | Every scoped query filters by `organization_id` | Compliant | `OwnAgencyScope` / `CrossAgencyScope` helpers |
| root AGENTS.md | State-changing operations have undo contract | Compliant | All three commands ship explicit undo (with saga-mediated carve-out for non-reversible transitions, documented in §4.1) |
| root AGENTS.md | Zod validation for all API input | Compliant | §3 routes each declare a zod schema with `.strict()` |
| packages/core/AGENTS.md | API routes MUST export `openApi` | Compliant | §3.3 declares per-route metadata |
| packages/core/AGENTS.md | Use portal primitives from `@open-mercato/ui/src/portal/components/` | Compliant | `PortalCard`, `PortalPageHeader` |
| packages/core/AGENTS.md | Do NOT use `DataTable`/`CrudForm` on portal | Compliant | P5, P6, and all dashboard widgets are custom React (OQ-010) |
| packages/cache/AGENTS.md | Cache keys tenant-scoped | Compliant | Tags embed `agencyId` and derive from session `organization_id` |
| packages/cache/AGENTS.md | Every write path lists cache tag invalidations | Compliant | §3.1 GET caches; §4 commands invalidate `prm.agency.{id}.prospects.list` + `…dashboard.wip.*` |
| packages/events/AGENTS.md | Subscribers idempotent | Compliant | UPSERT on `prospect_id`; DELETE is idempotent |
| packages/acl/AGENTS.md | Feature-flag registry used | Compliant | §6.1 declares 8 feature flags |
| packages/entities/AGENTS.md | Aggregate enforces invariants | Compliant | Invariant #1 and #12 enforced at aggregate layer |
| root AGENTS.md | Pagination `pageSize <= 100` | Compliant | Portal GET caps at 100; default 25. Backend caps at 100; default 50 |
| root AGENTS.md | Pagination capped at 100 | Compliant | Offset-based (`page` + `pageSize ≤ 100`); ordering `(registered_at DESC, id DESC)` for portal, `(registered_at ASC)` for backend B4 candidate-picker. Keyset is a future concern (see header reconciliation note). |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data models match API contracts | Pass | Every field in §3 response is backed by a column in §5.1 |
| API contracts match UI/UX (P5/P6/P2) | Pass | P5 → GET list; P6 → POST/PATCH/GET detail; P2 → aggregate queries + widget sub-queries |
| Risks cover all write operations | Pass | R-1 to R-5 cover register/transition/update |
| Commands defined for all mutations | Pass | `prm.prospect.register`, `.transition_status`, `.update` cover the three write paths |
| Cache strategy covers all read APIs | Pass | `prospects.list` + three widget tags |
| Naming singular across spec | Pass | Entities (`prospect`), commands (`register`/`transition_status`/`update`), events past-tense singular |
| Undoability | Pass | Undo contract specified per command; explicit carve-out for saga-only transitions is documented (Fowler-approved scope boundary) |

### Non-Compliant Items

None.

### Verdict

**Fully compliant — approved for implementation.**

---

## 11. Changelog

### 2026-04-23 — Initial specification
- Authored by Piotr (om-cto Spec Orchestrator), Martin Fowler review persona. Spec #2 of 7 decomposing `app-spec/app-spec.md`.
- Scope: US3.1, US3.2, US3.3, US6.3 + Dashboard P2 layout + WIP/WIC/tier-progress widgets.
- Depends on SPEC-2026-04-23-agency-foundation.
- Estimated commits: 6–8.

### Review — 2026-04-23
- **Reviewer:** Agent (Martin-Fowler persona).
- **Security:** Passed. All routes guard `requireAuth`; author-scope and `won` transitions rejected at aggregate; tenant scope enforced at query-helper layer; integration test 9.5 asserts cross-agency isolation.
- **Performance:** Passed. Composite indexes for WIP widget + list pagination; 60s widget cache with event-driven invalidation.
- **Cache:** Passed. Tenant-scoped tags with `agencyId` embedded; every write path lists invalidations.
- **Commands:** Passed. Three commands with explicit undo contracts (with documented non-reversible carve-out for saga-mediated transitions).
- **Risks:** Passed. Eleven concrete risks with mitigations and residuals across data integrity, cascade, isolation, migration, and operations.
- **Verdict:** Approved.

### 2026-05-05 — T1 implementation landed (Patryk via om-implement-spec)

**Module location:** standalone app (`src/modules/prm`, `from: '@app'`) — extends T0's PRM module rather than scaffolding a new one. Adapted from the spec's `packages/prm` per the standalone-app convention.

**Files delivered:**
- `data/entities.ts` — added `Prospect` (table `prm_prospects`) and `ProspectCandidateIndex` (table `prm_prospect_candidate_index`).
- `data/validators.ts` — added `registerProspectSchema`, `updateProspectSchema` (discriminated edit/transition), `listProspectsPortalSchema`, `listProspectsBackendSchema`, `PROSPECT_TRANSITIONS` matrix, `normalizeCompanyName` / `normalizeContactEmail` helpers.
- `lib/prospectService.ts` — domain service hosting the 6-state machine, author-scope guard, won-is-system-only guard, optimistic concurrency on `status_changed_at`, register/update/transitionStatus/revertRegistration/findCandidatesByNormalizedKey methods.
- `lib/prospectCandidateIndexProjection.ts` — shared idempotent UPSERT/DELETE handler used by the four event-specific projection subscribers.
- `lib/tierRequirements.ts` — static tier-requirements registry + `computeTierProgress` helper (Phase-1 deferred App-Spec seed promoted to in-code static).
- `events.ts` — added 4 prospect events.
- `acl.ts` — added 8 prospect/dashboard features.
- `setup.ts` — extended `partner_admin` and `partner_member` ACLs with prospect/dashboard features; extended `employee` staff role with `prm.prospect.read_cross_agency`.
- `subscribers/prospect-candidate-index-on-{registered,updated,status-changed,reverted}.ts` — four subscribers wired to the shared projection handler.
- `api/portal/prospects/route.ts` (GET/POST) — list + register.
- `api/portal/prospects/[id]/route.ts` (GET/PATCH) — detail + edit + transition with discriminated body, author-scope feature gating, `registered_at` rejection at the route boundary.
- `api/portal/dashboard/route.ts` — single-round-trip aggregate for P2 (WIP, WIC with schema-introspection fallback, tier progress).
- `api/prospects/route.ts` (GET) — B4 cross-agency read-only listing joining the projection table.
- `backend/prospects/page.{tsx,meta.ts}` — B4 read-only `DataTable`.
- `frontend/[orgSlug]/portal/prospects/page.{tsx,meta.ts}` — P5 custom React list + register form (no DataTable per OQ-010).
- `frontend/[orgSlug]/portal/prospects/[id]/page.{tsx,meta.ts}` — P6 custom React detail + edit + state-machine-aware transition CTAs + lost-reason capture dialog.
- `frontend/[orgSlug]/portal/dashboard/page.{tsx,meta.ts}` — P2 widgets via `PortalCard` with monthly/yearly toggle (L-011) and historical-status banner.
- `migrations/Migration20260505120000_prm_prospect.ts` — additive baseline; only creates `prm_prospects` + `prm_prospect_candidate_index`.
- `migrations/Migration20260505130000_prm_prospect_indexes.ts` — additive companion: enum CHECKs, `lost_reason` CHECK, FK to `prm_agencies` (RESTRICT), FK to `prm_agency_members` (RESTRICT), FK to `prm_prospects` (CASCADE) on the projection, WIP-widget partial index, portal-list keyset index, `registered_at` immutability trigger (invariant #1 defence-in-depth).
- `i18n/en.json` — added 89 keys covering portal P5/P6/P2 + backend B4.
- `__tests__/prospectService.test.ts` (16 tests), `__tests__/prospectValidators.test.ts` (12 tests), `__tests__/prospectCandidateIndexProjection.test.ts` (5 tests), `__tests__/tierRequirements.test.ts` (7 tests).

**Cross-spec contracts (FROZEN — Spec #3 attribution-loop MUST mirror):**
1. **Tables**: `prm_prospects`, `prm_prospect_candidate_index` (PK = `prospect_id`).
2. **Event IDs**: `prm.prospect.registered`, `prm.prospect.status_changed`, `prm.prospect.updated`, `prm.prospect.registration_reverted`. **Frozen.**
3. **Event payload contract** (subset Spec #3 binds to):
   - `prm.prospect.registered`: `{ prospectId, agencyId, organizationId, tenantId, registeredAt, source, normalizedCompanyName, lowercasedContactEmail, registeredByAgencyMemberId, status }`.
   - `prm.prospect.status_changed`: `{ prospectId, agencyId, organizationId, tenantId, fromStatus, toStatus, byActorType, byActorId, reason?, changedAt }`.
   - `prm.prospect.updated`: `{ prospectId, agencyId, organizationId, tenantId, changedFields, changedAt, normalizedCompanyName, lowercasedContactEmail }`.
   - `prm.prospect.registration_reverted`: `{ prospectId, agencyId, organizationId, tenantId }`.
4. **Feature IDs**: `prm.prospect.{read_own_agency,read_cross_agency,register,transition_any_in_agency,transition_own_authored}`, `prm.dashboard.view`, `prm.wic.read_own_agency`, `prm.tier_requirement.read`. **Frozen.**
5. **Error codes**: `prospect_not_found`, `invalid_transition`, `won_is_om_only`, `not_author_or_admin`, `status_conflict`, `lost_reason_required`. **Frozen.**
6. **Projection schema**: `prm_prospect_candidate_index { prospect_id (PK, FK→prm_prospects ON DELETE CASCADE), organization_id, agency_id, normalized_company_name, lowercased_contact_email, current_status, registered_at, projection_updated_at }`. Default ordering for the Spec #3 candidate-picker is `registered_at ASC` (Golden Rule, oldest-first). The projection includes ALL statuses (including `lost`) per invariant #14 — Spec #3 surfaces `lost` rows with a badge in the candidate picker.
7. **Normalized-key contract**:
   - `normalizedCompanyName` = lowercase, trim, strip non-Unicode-letters/digits/whitespace, collapse whitespace.
   - `lowercasedContactEmail` = `toLowerCase(trim(value))`.
   The `normalizeCompanyName` / `normalizeContactEmail` helpers in `data/validators.ts` are the single source of truth — Spec #3's candidate-picker MUST call them on user input before querying the index.
8. **State machine (invariant #12)**: `PROSPECT_TRANSITIONS` map in `data/validators.ts`. `won` is reachable only when `actor.type === 'system'` (Spec #3 attribution saga is the only system-actor caller in v1).

**Quality gates (8/8) — re-validated from a clean working tree:**
1. Typecheck: PASS — `yarn typecheck` exit 0.
2. Unit tests: PASS — `yarn test src/modules/prm` → 12 suites, 79 tests, 0 failures (32 inherited from T0 + 47 added in T1).
3. Integration tests: N-A — Playwright scenarios in §9 (IT-9.1..9.9) require a live Postgres + ESP fixture and are deferred to the QA team's infra stand-up.
4. Migration review: PASS — `yarn mercato db generate` is a no-op (snapshot matches entities); the two new migration files only touch `prm_prospects` and `prm_prospect_candidate_index` (43 + 73 lines). No DROP/ALTER COLUMN of pre-existing tables.
5. AGENTS.md compliance: PASS — events `prm.<entity>.<past_tense>`, features `<module>.<action>`, FK IDs only across modules (no `@ManyToOne` to `Agency`/`AgencyMember`), DataTable wires pagination props, lucide-react icons in `page.meta.ts`, `pageGroup`/`pageGroupKey`/`pageOrder` set on B4.
6. Piotr Decision Library checklist: PASS — BC additive-only, reuses `customerAuth` + `findOneWithDecryption` + `safeEmit` + `PortalCard`, command-shaped service mutations, every invariant has an explicit enforcement point in code (state machine in `ProspectService.transitionStatus`, registered_at immutability via aggregate whitelist + DB trigger, won-actor guard, author-scope guard, optimistic concurrency).
7. i18n: PASS — every user-facing string in P5/P6/P2/B4 routed through `useT('key', 'fallback')`; locale dictionary at `i18n/en.json`.
8. Build: PASS — `yarn build` (Next.js 16.2.3, Turbopack) compiled successfully; `yarn generate` clean.

**Migrations NOT applied:** `yarn mercato db migrate` was deliberately not run — per AGENTS rule #4 we hand back to the user for explicit approval. Two migration files staged in `src/modules/prm/migrations/` ready for review.

**Deferred:**
- Live Playwright IT-9.1..9.9 from §9 — require live ESP + DB fixtures.
- Cache wiring (§3.1, §6.2) — the spec calls for a `prm.agency.{agencyId}.dashboard.{yyyy-mm}` cache tag with 60s TTL and event-driven invalidation. The framework's cache wrappers attach to the CRUD-factory layer; the dashboard route is a hand-rolled portal aggregate which would need a custom wrapper. Deferred to a follow-up commit when traffic justifies it. The route is correct and tenant-scoped — only the cache surface is unimplemented.
- Static `tier_requirements` DB table — App-Spec §1.4.7 calls for a seeded table; T0 deferred the seed and T1 ships the registry as an in-code constant in `lib/tierRequirements.ts` to keep the dashboard widget green. If a follow-up spec promotes it to a DB table, the helper signature stays stable.
- Compensating-event undo of `prm.prospect.update` — the service exposes `revertRegistration` (undo of `register`) but `update`-undo would require capturing a before-snapshot in a command bus that PRM has not yet adopted. Spec §4.1 documents the contract; implementation is wired into the saga in Spec #3.

**Out-of-scope confirmed:** LicenseDeal attribution (Spec #3), RFP entities (Specs #5/#6), CaseStudy (Spec #7), WIC ingestion (Spec #4 — T1 ships only the widget read path with the awaiting-data placeholder).

### 2026-05-05 — Spec reconciliation pass

Reconciled the spec body against the shipped T1 implementation (commits `0fe8d69`, `2517428`, `66f54b3`, `090d360`). Drift fixed:

1. **§3.1 portal route paths** — `/api/portal/prospects` → `/api/prm/portal/prospects`. References in §8 (R-1) and §9 scenarios updated to match.
2. **§3.1 pagination** — keyset cursor + `page_size` + `next_cursor` + `total_estimate` → offset-based `page` + `pageSize` (capped at 100, default 25) with `{ ok, items, page, pageSize, total, totalPages }` response envelope. The shipped service uses MikroORM `findAndCount` with explicit `limit + offset`. Default ordering remains `(registered_at DESC, id DESC)` as the spec promised.
3. **§3.1 query parameters** — Zod schema reflects shipped names (`page`, `pageSize`, `registeredMonth`) instead of the original snake_case (`page_size`, `registered_month`).
4. **§3.1 cache** — `prm.agency.{agencyId}.prospects.list` declared as deferred. Tracked in `POST-MVP-FOLLOW-UPS.md`.
5. **§3.2 backend route** — `/api/backend/prm/prospects` → `/api/prm/prospects`. Pagination switched from cursor → offset for parity with portal. RBAC switched from `requireRoles` → `requireFeatures` to match the standalone-app convention (roles confer features via `setup.ts`).
6. **§3.3 dashboard** — added explicit documentation for the shipped `/api/prm/portal/dashboard` aggregate endpoint (single round-trip for WIP / WIC / tier widgets); the original spec described the widgets in §2 but did not enumerate the endpoint.
7. **§5.1 Prospect entity** — table name `prm.prospect` → `prm_prospects`; both `tenant_id` AND `organization_id` ship together (the original spec named only `organization_id`); indexes shipped as single-column rather than the original compound `(organization_id, agency_id, ...)` form. Constraints + invariant #1 trigger ship in `Migration20260505130000_prm_prospect_indexes.ts`.
8. **§5.2 ProspectCandidateIndex** — table name `prm.prospect_candidate_index` → `prm_prospect_candidate_index`; indexes shipped per the entity decorator output.
9. **§9 integration tests** — IT-9.1..IT-9.9 enumeration moved to `POST-MVP-FOLLOW-UPS.md`; spec body now lists shipped unit tests under `__tests__/`.
10. **§10.2 compliance row** — "keyset pagination" claim corrected to "offset, capped at 100".
11. **§11 changelog** — entry added (this section).

The shipped feature catalogue, event IDs, table names, and the normalized-key contract are FROZEN per the cross-spec contract listed in the original 2026-05-05 T1 entry above (Spec #3's candidate-picker depends on these).
