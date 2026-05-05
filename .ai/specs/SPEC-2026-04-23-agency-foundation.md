# SPEC-2026-04-23-agency-foundation — PRM Phase 1: Agency Foundation

> **Spec reconciled with shipped code 2026-05-05 — partial pass (in progress).**
> Original spec drafted 2026-04-23. **Sections reconciled in this pass:**
> §3.1 backend routes (path base is `/api/prm/...` not `/api/backend/prm/...`; pagination is `page` + `pageSize` offset-based, not `cursor`/keyset; response envelope is `{ ok, items, page, pageSize, total, totalPages }` not `{ items, nextCursor }`; cache invalidator subscribers flagged as deferred per `POST-MVP-FOLLOW-UPS.md`; optimistic concurrency on Agency PATCH flagged as not-implemented).
> **Sections still to reconcile** (pending follow-up): §3.2 portal route paths, §5 entity columns (`tenant_id` + `organization_id` shipped together; soft-delete via `deleted_at`; jsonb dictionary arrays not uuid[]; AgencyMember additional shipped columns), §9 integration test status, §11 changelog accuracy.
> See git blame for the diff and `POST-MVP-FOLLOW-UPS.md` (TBD) for tracked deferrals.
>
> **Spec ID:** SPEC-2026-04-23-agency-foundation
> **Spec #:** 1 of 7 (WF1 decomposition of `app-spec/app-spec.md` by Piotr, om-cto Spec Orchestrator, 2026-04-23)
> **Workflow:** WF1 — Agency Lifecycle (onboard → active → historical)
> **Stories covered:** US1.1, US1.2, US1.3, US1.4, US1.5, US1.6, US1.7, US2.1
> **Phase:** 1 (MUST ship first; every other phase FK-references Agency)
> **Estimated commits:** 8–10
> **Persona (review lens):** Martin Fowler staff-engineer for architectural purity
> **Open Questions gate:** skipped — 18 OQs resolved in `app-spec/decisions-log.md`, 3 deferred to v2

---

## 1. Summary, Scope & Business Outcome

### 1.1 TLDR

**What is being built.** A new `packages/prm` module that stands up the two foundational aggregates of the Partner Relationship Management app — `Agency` (1:1 with `directory.Organization`) and `AgencyMember` (1:1 with `customer_accounts.CustomerUser`) — plus the portal invite lifecycle, the admin-only-field dual-enforcement pattern, the global-unique `github_profile` lock (held from invite creation), and the `status = historical` cascade. No core-module source changes; the module extends `customer_accounts` strictly through UMES primitives (subscribers, response enrichers, API interceptors) and seeds two portal roles (`partner_admin`, `partner_member`) + two backend roles (`OMPartnerOps`, `OMMarketing`) through PRM's `setup.ts`.

**Primary value proposition.** Replace Mat's email-chain-based partner onboarding with a portal-backed flow: OM PartnerOps clicks *Create Agency* → *Invite PartnerAdmin*, the invitee clicks the email link, sets a password, completes their profile — total human time ≤ 15 minutes. Every downstream PRM aggregate (Prospect, LicenseDeal, RFP, CaseStudy, MarketingMaterial) FKs into `Agency`; Phase 1 is the platform prerequisite for Phases 2–6.

### 1.2 Scope (in)

- `Agency` entity (1:1 `directory.Organization`) with admin-only and agency-editable fields partitioned by invariant #6.
- `AgencyMember` entity with the pre-accept placeholder pattern (`customer_user_id` nullable; `is_active = true` from invite creation — Vernon C6).
- PRM-owned invite email (`prm/emails/PartnerInviteEmail.tsx`) + re-invite cooldown (10-minute window, per-email).
- PRM subscriber on `customer_accounts.invitation.accepted` that links the placeholder row + assigns the seeded portal role + emits `prm.agency_member.activated`.
- Admin-only-field dual enforcement (backend `acl` features on CrudForm + portal `ApiInterceptor` route-level write guard + diagnostic event on rejection).
- Admin-only-read-display on portal via a single `ResponseEnricher` gated on `prm.agency.read_admin_fields`, namespaced `_prm` (OQ-020).
- DB-level unique constraint on `agency_member.github_profile` with L-010 privacy-preserving rejection UX.
- `status = historical` cascade via `prm.agency.status_changed` event + per-aggregate subscribers that maintain local `agency_status` read-model values (Vernon C3).
- Lockout recovery (US1.6) via the existing `customer_accounts.CustomerUserRole` CrudForm on B2's Members tab — zero new UI.
- Portal pages P1 (auth — stock from `customer_accounts`), P2 (dashboard shell only; widgets are Phase 2), P3 (Agency profile), P4 (Members).
- Backend pages B1 (Agencies list), B2 (Agency detail + Invite action + Members tab + Admin-only fields), B3 (cross-agency Members read-only).
- `setup.ts` seeds: the four roles above, `industries` / `services` / `technologies` dictionaries, the static tier-requirement table (read-only; used by Phase 2 widgets).

### 1.3 Scope (out — deferred to later phases or v2)

- Dashboard widgets (WIC / WIP / MIN / tier-progress) → Phase 2.
- `Prospect`, `LicenseDeal`, `RFP*`, `CaseStudy`, `MarketingMaterial`, `WICContribution`, `WICImportAuditLog` entities and their UI → Phases 2–6.
- Bounce-webhook integration for invite emails — v1 relies on sender seeing delivery failure in the transactional-email provider log and manually re-inviting on B2 (OQ-014).
- Automated tier transitions from WIC / WIP / MIN scores — v2 (L-001).
- Split-attribution GitHub-profile variants — v2 (OQ-006-v2).
- Agency merges, reactivation workflows beyond the simple `historical → active` toggle — v2 (OQ-007).

### 1.4 Business Outcome (from §7 Phase 1 Cagan criteria)

**Phase 1 clients can say:** *"I can onboard a partner in a day instead of a week. My partners have accounts and can edit their own profiles."*

Measurable:
- OM PartnerOps creates 1 Agency + invites 1 PartnerAdmin + invitee accepts + fills profile in **≤ 15 minutes human time**.
- OM PartnerOps promotes a PartnerMember to PartnerAdmin (US1.6) in **≤ 1 minute**.
- Zero "where do I stand" Mat-to-AgencyAdmin emails in a Phase 1 pilot month (presupposes Phase 2 dashboards; Phase 1 ships the plumbing).

Strategic (L-009): the bottleneck being dissolved is Mat's per-agency admin time. Phase 1 is the single highest-leverage intervention against that cost curve.

---

## 2. Technical Approach (Piotr)

> **The following section is embedded verbatim from the decomposition brief provided by Piotr (om-cto Spec Orchestrator, 2026-04-23). It is the authoritative technical direction for this spec.**

- **Mode:** New PRM module (`packages/prm`) + UMES extension of `customer_accounts`. No core module modifications.
- **New module scaffold:** bootstrap via `om-module-scaffold` conventions — `data/entities.ts`, `migrations/`, `api/` routes, `backend/` pages, `frontend/` portal pages, `setup.ts`, `di.ts`, `events/`, `subscribers/`, `i18n/`.
- **New entities:**
  - `Agency` (1:1 `directory.Organization`; admin-only fields `tier`, `status`, `contract_signed`, `nda_signed`, `onboarded`; editable fields `name`, `description`, `industries[]`, `services[]`, `technologies[]`, `countries[]`, `website`, `logo`; fields `created_at`, `updated_at`, `status` default `active`).
  - `AgencyMember` (FK `agency_id`, FK `customer_user_id` nullable until invite accepted, `github_profile` — **globally unique** per invariant #5, `first_name`, `last_name`, `role_in_agency`, `is_active` boolean — true from invite creation per Vernon C6, `invited_at`, `activated_at`).
- **Extends `customer_accounts` via UMES:**
  - **Invite handler** resolves the seeded role ID (`PartnerAdmin` or `PartnerMember` — looked up by slug from PRM's `setup.ts`-seeded `CustomerRole` rows) and calls `CustomerInvitationService.createInvitation(email, scope, { roleIds: [resolvedRoleId], ... })`. Role assignment is handled by `customer_accounts.acceptInvitation` automatically (PROXY-GATE-RESOLUTIONS.md §Q3). In the same transaction, the handler creates the pre-accept placeholder `AgencyMember` (GH-profile lock held from invite creation per L-013), rejecting duplicates with L-010 privacy-preserving error. Transactional participation confirmed by DI-injected `EntityManager` (PROXY-GATE-RESOLUTIONS.md §Q2).
  - **Subscriber on `customer_accounts.invitation.accepted`** (`PrmInvitationAcceptedSubscriber`) links the placeholder `AgencyMember` to the new `CustomerUser`, sets `activated_at = now()`, and emits `prm.agency_member.activated`. Does **not** re-assign roles — already handled by `acceptInvitation`.
- **PRM invite email:** PRM ships `emails/PartnerInviteEmail.tsx` + send call on invite creation (OQ-014 — `customer_accounts` ships token lifecycle + accept event, but NOT invite email / re-invite cooldown / bounce webhook). **Re-invite cooldown uses `@open-mercato/shared/lib/ratelimit`** — `RateLimiterService.consume('invite:' + email + ':' + agency_id, { points: 1, duration: 24*60*60 })` — per PROXY-GATE-RESOLUTIONS.md §Q5. No PRM-owned cooldown column.
- **Admin-only field dual enforcement (invariant #6):**
  - Backend: `acl` features on CrudForm (`prm.agency.edit_admin_fields`) restrict B2 field visibility.
  - Portal: route-level `ApiInterceptor` on portal `PUT /api/portal/agency/{id}` rejects writes to `tier`, `status`, `contract_signed`, `nda_signed`, `onboarded` regardless of CustomerUser role. ~20 lines / entity.
  - **Admin-only read-display on portal (OQ-020):** one `ResponseEnricher` gated on `prm.agency.read_admin_fields` feature, namespaced `_prm` — NOT per-field. Gap 0.
- **GH-profile global unique (invariant #5):** DB-level unique index on `agency_member.github_profile`. Held from invite creation (C6 `is_active = true` from invite time). L-010 rejection UX: "A profile with this GitHub handle is already active in our partner network. Please contact OM PartnerOps if you believe this is in error." No reveal of conflicting Agency name.
- **Seeded roles (via `setup.ts`):**
  - CustomerUser roles: `PartnerAdmin`, `PartnerMember` (portal-scoped, in `customer_accounts` role catalog).
  - User backend roles: `OMPartnerOps`, `OMMarketing` (per OQ-005 — new roles separate from tenant admin).
- **Seeded dictionaries (via `setup.ts`):** `industries`, `services`, `technologies` seeded into `dictionaries` module. Countries list already ships in `packages/shared/src/lib/location/countries.ts`.
- **Seeded tier-requirement static table:** v1 tier is admin-set (L-001); tier-requirement table is read-only data used by WIP/tier-progress widgets in Phase 2.
- **Cascade on agency status change (Vernon C3):** per-aggregate subscribers on `prm.agency.status_changed` maintain a local `agency_status` read-model value on Prospect / CaseStudy / AgencyMember; aggregates reject new writes based on their own pre-committed state. Portal-level subscriber shows "Your partnership is inactive" banner.
- **Lockout recovery (US1.6):** reuse existing `customer_accounts.CustomerUserRole` CrudForm on B2's Members tab. No new UI. Emits `prm.agency_member.role_changed`.
- **Invariant #4 (one Organization per Agency):** delete-blocked-with-dependents enforced at aggregate level, not DB CASCADE.
- **Rationale:** Foundation layer. Everything downstream (Prospect, LicenseDeal, RFP, CaseStudy, MarketingMaterial) FK-references Agency. No shortcuts.

---

## 3. API Contracts

> **Shared auth.** Portal routes (`/api/prm/portal/*`) use the session cookie issued by `customer_accounts`' isolated JWT pipeline; backend routes (`/api/prm/*`) use the staff User session cookie from `auth`. **No service-account routes in this spec** — WIC import routes are Phase 4 scope. All request/response bodies validated with `zod`; all error responses use the platform-standard `{ ok: false, error: <string | { code, message, details? }> }` envelope. All routes export `openApi` metadata per `packages/core` convention. **Pagination is `page` + `pageSize ≤ 100` offset-based** (the shipped routes use `findAndCountWithDecryption(em, ..., { limit, offset })`); the original spec called for cursor/keyset but no shipped route implements it. Response envelope: `{ ok: true, items, page, pageSize, total, totalPages }`.

### 3.1 Backend routes (OM staff / User session)

> **Shipped path convention:** all backend routes live under `/api/prm/...` (singular module name, no `/backend/` prefix). The original spec wrote `/api/backend/prm/...`; references below have been corrected.

#### 3.1.1 `POST /api/prm/agency`
- **Purpose:** US1.1 — Create Agency (and its paired `directory.Organization`) in one transaction.
- **Auth:** `requireAuth` + `requireFeatures(['prm.agency.create'])` (OMPartnerOps, OMAdmin).
- **Request:**
  ```json
  {
    "name": "string (1..120)",
    "slug": "string (kebab, globally unique)",
    "tier": "om_agency | ai_native | ai_native_expert | ai_native_core",
    "headquarters_country": "ISO-3166 alpha-2 code"
  }
  ```
- **Response 201:**
  ```json
  {
    "agency": { "id": "uuid", "organization_id": "uuid", "slug": "...", "tier": "...", "status": "active", "contract_signed": false, "nda_signed": false, "onboarded": false, "created_at": "..." }
  }
  ```
- **Errors:** `409 slug_already_taken`; `400 validation_failed`; `403 forbidden`.
- **Idempotency:** not idempotent (creation is a naturally unique act; slug uniqueness provides the conflict guard). No `Idempotency-Key` header.
- **Emits:** `prm.agency.created`. If `tier != 'om_agency'` default, also `prm.agency.tier_changed`.
- **Transaction boundary:** single DB transaction across `directory.organization`, `prm.agency`, plus event outbox insert. Partial failure → full rollback (invariant #4).

#### 3.1.2 `GET /api/prm/agency?page=…&pageSize=…&tier=…&status=…&q=…`
- **Purpose:** B1 DataTable list (cross-agency).
- **Auth:** `requireFeatures(['prm.agency.read'])`.
- **Response 200:** `{ ok: true, items: Agency[], page, pageSize, total, totalPages }` (offset-based, `pageSize ≤ 100`, default 50).
- **Cache:** declared in original spec as tag `prm:agency:list:tenant:{tenant_id}` invalidated on `prm.agency.*` events. **NOT WIRED in T0** — the cache invalidator subscribers were deferred (see `POST-MVP-FOLLOW-UPS.md`).

#### 3.1.3 `GET /api/prm/agency/{id}`
- **Purpose:** B2 detail load.
- **Auth:** `requireFeatures(['prm.agency.read'])`.
- **Response 200:** full `Agency` projection including admin-only fields (backend is trusted; no enricher stripping).
- **Cache:** declared in original spec as tag `prm:agency:{id}`. **NOT WIRED in T0** (deferred — see `POST-MVP-FOLLOW-UPS.md`).

#### 3.1.4 `PATCH /api/prm/agency/{id}`
- **Purpose:** US1.1 post-create edits; US1.3 flag toggles; US1.7 status transition; OM staff name edits.
- **Auth:** `requireFeatures(['prm.agency.update_all'])` (OMPartnerOps, OMAdmin). Admin-only fields require the same feature; no separate gate here — the portal route is the guarded surface (§3.2.3).
- **Request:** partial `Agency` — any writable field. `slug` is immutable post-create (rejected 400).
- **Response 200:** `{ agency: Agency }` with updated timestamps.
- **Errors:** `400 slug_is_immutable`; `403 forbidden`. Optimistic concurrency via `updated_at` If-Match was specified but **NOT IMPLEMENTED** in shipped T0 — last-writer-wins is the current behaviour for Agency PATCH (see `POST-MVP-FOLLOW-UPS.md`). LicenseDeal in T2 ships the version-token pattern that this spec promised.
- **Emits:** per field delta — `prm.agency.tier_changed` (tier), `prm.agency.status_changed` (status), `prm.agency.onboarding_state_changed` (any of the three booleans).
- **Cache invalidation:** declared in the original spec; **NOT WIRED in T0** (deferred — see `POST-MVP-FOLLOW-UPS.md`).

#### 3.1.5 `POST /api/prm/agency/{id}/invite`
- **Purpose:** US1.2 — Invite first PartnerAdmin; also US1.5 OM-staff path for subsequent members; reused for re-invite.
- **Auth:** `requireFeatures(['prm.agency.invite_admin'])` (OMPartnerOps, OMAdmin).
- **Request:**
  ```json
  {
    "first_name": "string",
    "last_name": "string",
    "email": "email",
    "github_profile": "string?",
    "role_slug": "partner_admin | partner_member"
  }
  ```
- **Behavior (transactional):**
  1. Call `customer_accounts.createInvitation({ organization_id, email, role_slug, ttl: '72h' })`.
  2. Insert placeholder `AgencyMember { agency_id, customer_user_id: NULL, email, first_name, last_name, github_profile, is_active: true, invited_at: now() }` — reserves the `github_profile` global-unique lock (invariant #5, Vernon C6, L-013).
  3. Enqueue PRM `PartnerInviteEmail` send.
  4. Emit `prm.agency_member.added`.
- **Re-invite cooldown:** if an outstanding invite for the same email on the same agency was sent < 10 minutes ago, return `429 invite_cooldown_active` with `{ retry_after_seconds }`. Implemented via `@open-mercato/shared/lib/ratelimit` keyed by `(agency_id, lower(email))`.
- **Response 201:** `{ agency_member_id, invitation_id, expires_at }`.
- **Errors:** `400 email_invalid`; `409 email_already_customer_user` (generic — L-010 privacy mirror, does not reveal other Agency); `409 github_profile_conflict` (L-010 message); `429 invite_cooldown_active`; `403 forbidden`.
- **Emits:** `prm.agency_member.added` on success; `prm.agency_member.github_profile_conflict_attempted` on GH conflict.
- **Idempotency:** not idempotent across calls (each call produces a new invitation token); client-side debounced via the cooldown.

#### 3.1.6 `GET /api/prm/agency/{id}/member?page=…&pageSize=…`
- **Purpose:** B2 Members tab (scoped to one Agency).
- **Auth:** `requireFeatures(['prm.agency_member.read_all'])`.
- **Response 200:** `{ ok: true, items: AgencyMember[], page, pageSize, total, totalPages }` (offset-based).

#### 3.1.7 `PATCH /api/prm/agency-member/{id}`
- **Purpose:** US1.6 lockout recovery via role reassignment; OM-staff edits of cross-agency member personal fields if needed.
- **Auth:** `requireFeatures(['prm.agency_member.write_all'])`.
- **Request:**
  ```json
  {
    "role_slug": "partner_admin | partner_member",
    "is_active": true | false,
    "first_name": "string?",
    "last_name": "string?",
    "role_in_agency": "string?",
    "github_profile": "string?"
  }
  ```
- **Behavior:** Role change calls `customer_accounts.assignRole(customerUserId, roleSlug)` — the `customer_assignable: false` flag on `partner_admin` is enforced against portal callers only; backend User sessions bypass that gate (see §2.4 decision log). Deactivation (`is_active = false`) frees the `github_profile` lock immediately (W7; no grace period in v1).
- **Response 200:** `{ agency_member: AgencyMember }`.
- **Emits:** `prm.agency_member.role_changed` (on role change) or `prm.agency_member.removed` (on deactivation).

#### 3.1.8 `GET /api/prm/agency-member?page=…&pageSize=…&q=…&github_profile=…`
- **Purpose:** B3 cross-agency read-only list (github_profile conflict search surface).
- **Auth:** `requireFeatures(['prm.agency_member.read_all'])`.
- **Response 200:** `{ ok: true, items: AgencyMember[] (with agency_name joined), page, pageSize, total, totalPages }` (offset-based).
- **Read-only:** no write endpoints under this path (§3.1.7 operates via `agency-member/{id}`, which is routed off the Agency aggregate in the UI).

### 3.2 Portal routes (CustomerUser session)

#### 3.2.1 `GET /api/portal/agency/{id}`
- **Purpose:** P3 profile load; also hydrates P2 dashboard Agency context.
- **Auth:** `requireAuth` (portal session) + `requireFeatures(['prm.agency.read'])` + tenant-scope guard (`CustomerUser.organization_id === agency.organization_id`).
- **Response 200:**
  ```json
  {
    "agency": {
      "id": "uuid",
      "name": "...",
      "slug": "...",
      "description": "...",
      "website_url": "...",
      "logo_url": "...",
      "headquarters_country": "...",
      "headquarters_city": "...",
      "team_size_bucket": "...",
      "industries": ["..."],
      "services": ["..."],
      "tech_capabilities": ["..."],
      "_prm": { "tier": "...", "status": "...", "contract_signed": true, "nda_signed": true, "onboarded": true }
    }
  }
  ```
- **Enricher:** the `_prm` block is added by a single `ResponseEnricher` gated on `prm.agency.read_admin_fields` (OQ-020). Absent block ⇒ caller lacks the feature; portal UI degrades to hiding admin badges. Never per-field.
- **Cache:** tag `prm:portal:agency:{id}`; invalidated on `prm.agency.*` events for that id.

#### 3.2.2 `PATCH /api/portal/agency/{id}`
- **Purpose:** US2.1 — PartnerAdmin edits editable profile fields.
- **Auth:** `requireAuth` + `requireFeatures(['prm.agency.update'])` + tenant-scope guard.
- **Guarded fields (route-level `ApiInterceptor`, invariant #6):** writes to `tier`, `status`, `contract_signed`, `nda_signed`, `onboarded` rejected with `403 admin_only_field`. Emits `prm.agency.admin_field_access_rejected { agency_id, field_name, customer_user_id, attempted_at, attempted_value? }`. Per Piotr's brief: *~20 lines / entity*.
- **Request:** partial of the editable field set only: `{ name?, description?, website_url?, logo_url?, headquarters_city?, team_size_bucket?, industries?, services?, tech_capabilities? }`. `slug` is immutable.
- **Response 200:** `{ agency: <enriched projection> }`.
- **Emits:** no domain event (profile edits are agency-local display data; no downstream subscriber depends on them).
- **Cache invalidation:** `prm:portal:agency:{id}`.

#### 3.2.3 `GET /api/portal/agency/{id}/member?cursor=…&pageSize=…`
- **Purpose:** P4 member list.
- **Auth:** `requireFeatures(['prm.agency_member.read'])` + tenant-scope.
- **Response 200:** `{ items: AgencyMember[], nextCursor?: string }`.

#### 3.2.4 `POST /api/portal/agency/{id}/member/invite`
- **Purpose:** US1.5 — PartnerAdmin invites a `partner_member`. **Role is implicit `partner_member`** — no role parameter; UI never exposes it.
- **Auth:** `requireFeatures(['prm.agency_member.write'])` + tenant-scope + verify caller is `partner_admin`.
- **Guard:** request is rejected if a caller attempts to pass `role_slug: 'partner_admin'` — the `customer_assignable: false` gate in `customer_accounts` would reject it anyway, but PRM fails earlier with `403 role_not_self_assignable` for a clearer UX (decisions log OQ-005 + §2.4 addendum #3).
- **Request:** same shape as §3.1.5 minus `role_slug` (implicit `partner_member`).
- **Behavior:** identical to §3.1.5 — invitation + placeholder + email + cooldown, keyed to the portal session's `organization_id`.
- **Response 201:** `{ agency_member_id, invitation_id, expires_at }`.
- **Emits:** `prm.agency_member.added`; `prm.agency_member.github_profile_conflict_attempted` on GH conflict.

#### 3.2.5 `PATCH /api/portal/agency/{id}/member/{member_id}`
- **Purpose:** US1.5 — edit personal fields or deactivate a `partner_member`; US1.4 — self-profile edit (member edits own row).
- **Auth:** `requireFeatures(['prm.agency_member.write'])` OR `requireFeatures(['prm.agency_member.self_edit'])` when `member.customer_user_id === session.customer_user_id`.
- **Guards:**
  - PartnerAdmin cannot deactivate themselves (`403 cannot_deactivate_self`).
  - PartnerAdmin cannot change another member's role to `partner_admin` (`403 role_not_self_assignable`).
  - Self-edit cannot change `is_active` or `role_slug`.
- **Request:** `{ first_name?, last_name?, role_in_agency?, github_profile?, is_active? }`.
- **Response 200:** `{ agency_member: AgencyMember }`.
- **Emits:** on deactivation `prm.agency_member.removed`; on `github_profile` conflict `prm.agency_member.github_profile_conflict_attempted`.

#### 3.2.6 Stock `customer_accounts` routes (unchanged, consumed by PRM)
- `POST /api/portal/invitation/accept` — invite acceptance. **PRM does not own or modify this route.** PRM reacts via the `customer_accounts.invitation.accepted` event.
- `POST /api/portal/auth/login`, `/logout`, `/password-reset` — P1 surface (stock).

### 3.3 OpenAPI & validation checklist

- All routes export `openApi` metadata (request/response zod schemas + examples + error codes).
- All request bodies validated with `zod` before business logic.
- All error responses use `{ error: { code, message, details? } }`.
- All 2xx responses use camelCase inside entity bodies but `snake_case` for DB-backed field names (matching OM convention — FK fields like `organization_id` stay snake).

---

## 4. Commands & Events

### 4.1 Commands (undoable per Piotr Principle #8)

> **Naming:** `module.entity.action`, singular, present-tense imperative. Every mutation is a command; every command defines its undo. Compound commands orchestrate multi-step flows as a single undo unit.

| Command | Purpose | Triggered by | Undo |
|---|---|---|---|
| `prm.agency.create` | US1.1. Compound: creates `directory.organization` + `prm.agency` + seeds default admin-only flag values. | `POST /api/backend/prm/agency` | `prm.agency.delete` — rejected if dependents exist (invariant #4). Safe to run until first child aggregate attaches. Compensating event `prm.agency.created_reverted` (internal, not in public §1.4.5 list — observability only). |
| `prm.agency.update` | US1.1 post-create edits, US1.3 flag toggles, US1.7 status transition, US2.1 portal edits. Field-diff-aware: emits the matching domain event(s). | `PATCH /api/backend/prm/agency/{id}`, `PATCH /api/portal/agency/{id}` | `prm.agency.update` replayed with the pre-image. Optimistic concurrency via `updated_at` If-Match; on 409 the caller re-reads. Banner/portal cache-tag invalidation is the observable side effect — reversed by the next `prm.agency.update` carrying the prior values. |
| `prm.agency.invite_member` | US1.2, US1.5 (portal), US1.5 (backend staff path). Compound across `customer_accounts.createInvitation` + `prm.agency_member` placeholder insert + email enqueue. | `POST /api/backend/prm/agency/{id}/invite`, `POST /api/portal/agency/{id}/member/invite` | `prm.agency.cancel_invite` — deactivates the placeholder (`is_active = false`) and revokes the `CustomerUserInvitation` token via `customer_accounts.revokeInvitation`. Frees the `github_profile` lock. Email is not recallable — acceptable residual side effect (documented in §8). |
| `prm.agency.cancel_invite` | Explicit cancel action (rare; same as deactivating an `Invited` member). | Portal Members UI "Cancel invite", backend B2 Members tab. | Forward-only. Re-invite via `prm.agency.invite_member` (subject to cooldown). |
| `prm.agency_member.update` | US1.4 self-profile complete, US1.5 edits, US1.6 role reassignment (backend). Field-diff-aware. | `PATCH /api/portal/agency/{id}/member/{member_id}`, `PATCH /api/backend/prm/agency-member/{id}` | `prm.agency_member.update` replayed with pre-image. Role change reversible via another role-change command. |
| `prm.agency_member.activate` | Internal — fired by the PRM subscriber on `customer_accounts.invitation.accepted`. Links `customer_user_id`, sets `activated_at`, assigns seeded role. | Subscriber `PrmInvitationAcceptedSubscriber`. | Forward-only in v1 (acceptance is a user-driven commitment). Reverse by calling `prm.agency_member.update { is_active: false }` — deactivation path. |

Compound-command boundaries:

- `prm.agency.create` is a **graph save** (Organization + Agency + default flags are inherently coupled; partial state violates invariant #4).
- `prm.agency.invite_member` is a **compound command** — three independent steps (invitation, placeholder, email) bound by a single undo contract. Email enqueue is reversed only by the not-yet-sent queue entry being removed; once sent, it is an accepted non-reversible side effect.

### 4.2 Domain events published

> All events use the IDs and payloads from **app-spec §1.4.5**. Reproduced below for this spec's coverage only (Phase 1 scope).

| Event ID | Payload | Emitted by | Subscribers (Phase 1) | Subscribers (later phases) |
|---|---|---|---|---|
| `prm.agency.created` | `{ agency_id, slug, tier, created_by_user_id }` | `prm.agency.create` command handler (backend). | None in Phase 1 (the B1 cache invalidator reacts to this tag indirectly via the write path). | Phase 2+ Prospect/CaseStudy aggregates use this for cross-aggregate FK bootstrapping. |
| `prm.agency.tier_changed` | `{ agency_id, from_tier, to_tier, changed_by_user_id, reason }` | `prm.agency.update` command handler when `tier` differs. | `PortalAgencyCacheInvalidator` (tag `prm:portal:agency:{id}`). `AgencyListBackendCacheInvalidator` (tag `prm:agency:list:tenant:{tid}`). | Phase 6 Marketing visibility filter; Phase 5 RFP eligibility. |
| `prm.agency.status_changed` | `{ agency_id, from_status, to_status, changed_by_user_id, reason }` | `prm.agency.update` command handler when `status` differs. | `PortalAgencyCacheInvalidator`; `AgencyListBackendCacheInvalidator`; **per-aggregate `AgencyStatusReadModelSubscriber`** — but the downstream aggregates (Prospect, CaseStudy, etc.) don't exist in Phase 1, so the subscriber contract is authored here and wired in when those aggregates land. Phase 1 ships `AgencyMemberStatusReadModelSubscriber` (updates member row's `agency_status` read-model column). `PortalStatusBannerSubscriber` updates the banner cache tag. | Phase 2+ per-aggregate subscribers. |
| `prm.agency.onboarding_state_changed` | `{ agency_id, contract_signed, nda_signed, onboarded }` | `prm.agency.update` when any of the three booleans toggle. | `PortalAgencyCacheInvalidator`. P2 dashboard banner subscriber (refreshes "Welcome" / "partial onboarding" banner). | None downstream. |
| `prm.agency_member.added` | `{ agency_id, agency_member_id, github_profile }` | `prm.agency.invite_member` command handler (both backend and portal invocations). Also emitted by the backend staff-direct-add path (§3.1.7 if that path ever creates a member without invite — not in Phase 1 scope). | `BackendMemberListCacheInvalidator` (tag `prm:agency:{id}:members`). | Phase 5 RFP response author eligibility. |
| `prm.agency_member.activated` | `{ agency_id, agency_member_id, customer_user_id }` | `PrmInvitationAcceptedSubscriber` after it links the placeholder + assigns role. | `BackendMemberListCacheInvalidator`; `PortalMemberListCacheInvalidator` (P4). | Phase 2+ WIC ingest eligibility. |
| `prm.agency_member.removed` | `{ agency_id, agency_member_id }` | `prm.agency_member.update` command handler when `is_active` flips true→false, or explicit deactivation. | Cache invalidators as above. | Phase 4 WIC ingest ACL resolution (active-only). |
| `prm.agency_member.role_changed` | `{ agency_id, agency_member_id, from_role, to_role, changed_by_user_id, changed_at }` | `prm.agency_member.update` command handler when `role_slug` changes (backend only — portal path never reaches here due to `customer_assignable: false`). | Cache invalidators. | None downstream. |
| `prm.agency_member.github_profile_conflict_attempted` *(telemetry)* | `{ attempted_github_profile, attempted_by_agency_id, attempted_by_customer_user_id, existing_owner_agency_id, attempted_at }` | `prm.agency.invite_member` and `prm.agency_member.update` handlers on UNIQUE-violation catch. Observability-only; does not alter state. | OM staff dashboard (informational); no state subscriber. | None. |
| `prm.agency.admin_field_access_rejected` *(telemetry)* | `{ agency_id, field_name, customer_user_id, attempted_at, attempted_value? }` | Portal `ApiInterceptor` on `PATCH /api/portal/agency/{id}` when a guarded field is in the request body. Observability-only; does not alter state. | OM staff audit dashboard (informational). | None. |

### 4.3 Events consumed

| Event consumed | Owner module | Consumer | Purpose |
|---|---|---|---|
| `customer_accounts.invitation.accepted` | `customer_accounts` | `PrmInvitationAcceptedSubscriber` (new) | Link the pre-accept placeholder `AgencyMember` row (looked up by `invitation_id`) to the new `CustomerUser`, set `activated_at = now()`, emit `prm.agency_member.activated`. **Does NOT re-assign roles** — `customer_accounts.acceptInvitation` already creates `CustomerUserRole` rows from `invitation.roleIdsJson` (PROXY-GATE-RESOLUTIONS.md §Q3). Idempotent via `(invitation_id, agency_member_id)` uniqueness — double-delivery is a no-op. |

---

## 5. Data Models

> **Conventions.** All tables live under the `prm` schema (PostgreSQL). All entities include `id uuid PK DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`. All scoped tables include `tenant_id uuid NOT NULL` and `organization_id uuid NOT NULL` — mandatory tenant isolation per root AGENTS.md. Foreign keys to other modules use **FK IDs only** (no direct ORM relations across module boundaries; queries are composed at the service layer). Singular table names (`agency`, `agency_member`), singular entity class names (`Agency`, `AgencyMember`).

### 5.1 `prm.agency`

| Column | Type | Null | Default | Notes / invariant enforcement |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK. |
| `tenant_id` | `uuid` | no | — | Tenant isolation. Indexed. |
| `organization_id` | `uuid` | no | — | FK → `directory.organization.id`. **UNIQUE** — enforces invariant #4 (one Organization per Agency). Composite index with `tenant_id`. |
| `name` | `text` | no | — | Org display name. |
| `slug` | `text` | no | — | URL-safe. **UNIQUE (tenant_id, slug)**. Immutable post-create (API-enforced). |
| `description` | `text` | yes | `NULL` | Markdown-supported. |
| `website_url` | `text` | yes | `NULL` | |
| `logo_url` | `text` | yes | `NULL` | Populated via `media` module; regular URL (no signed URLs in v1 per OQ-011). |
| `headquarters_country` | `text` | no | — | ISO-3166-alpha-2. Seeded from `packages/shared/src/lib/location/countries.ts`. |
| `headquarters_city` | `text` | yes | `NULL` | |
| `team_size_bucket` | `text` | yes | `NULL` | Enum check: `'1-5','6-20','21-50','51-100','100+'`. |
| `industries` | `uuid[]` | no | `'{}'` | Dictionary entry FKs (`dictionaries` module). |
| `services` | `uuid[]` | no | `'{}'` | Dictionary entry FKs. |
| `tech_capabilities` | `uuid[]` | no | `'{}'` | Dictionary entry FKs. |
| `tier` | `text` | no | `'om_agency'` | Enum check: `'om_agency','ai_native','ai_native_expert','ai_native_core'`. **Admin-only (invariant #6).** |
| `status` | `text` | no | `'active'` | Enum check: `'active','historical'`. **Admin-only (invariant #6).** |
| `contract_signed` | `boolean` | no | `false` | **Admin-only (invariant #6).** |
| `nda_signed` | `boolean` | no | `false` | **Admin-only (invariant #6).** |
| `onboarded` | `boolean` | no | `false` | **Admin-only (invariant #6).** |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | Used as optimistic concurrency token (If-Match). |

**Indexes:**
- `UNIQUE (organization_id)` — invariant #4.
- `UNIQUE (tenant_id, slug)` — URL uniqueness.
- `INDEX (tenant_id, status)` — B1 list filter; `historical` sweep.
- `INDEX (tenant_id, tier)` — B1 list filter.
- GIN indexes on `industries`, `services`, `tech_capabilities` for Phase 5 RFP matching (added here to avoid later backfill; invariant: indexes are additive).

**Invariant enforcement points:**
- #4 (one Org per Agency): the `UNIQUE (organization_id)` constraint + the command handler's transactional create. Delete blocked at the aggregate level (§5.4).
- #6 (admin-only): **DB does not enforce** — enforcement is at the application layer in two places: backend CrudForm ACL (feature `prm.agency.edit_admin_fields`) and the portal `ApiInterceptor` on `PATCH /api/portal/agency/{id}`. Rationale: the column must remain writable from backend; enforcement is contextual (who is writing), not structural.

### 5.2 `prm.agency_member`

| Column | Type | Null | Default | Notes / invariant enforcement |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK. |
| `tenant_id` | `uuid` | no | — | Tenant isolation. |
| `agency_id` | `uuid` | no | — | FK → `prm.agency.id`. Indexed. |
| `customer_user_id` | `uuid` | **yes** | `NULL` | FK → `customer_accounts.customer_user.id`. **NULL between invite and acceptance** (placeholder row, invariant #5 + C6 + L-013). Populated by `PrmInvitationAcceptedSubscriber`. Immutable once set. |
| `email` | `text` | no | — | Lowercased; the natural key the invitation is sent to. |
| `first_name` | `text` | no | — | |
| `last_name` | `text` | no | — | |
| `role_in_agency` | `text` | yes | `NULL` | Free-text (e.g. "Lead Engineer"). Not the RBAC role. |
| `github_profile` | `text` | yes | `NULL` | **GLOBAL UNIQUE where `is_active = true AND github_profile IS NOT NULL`** — partial unique index. Invariant #5. Case-insensitive via `LOWER(github_profile)`. |
| `is_active` | `boolean` | no | `true` | Set to `true` at invite creation (Vernon C6). Deactivation (`false`) frees the GH lock. |
| `invited_at` | `timestamptz` | no | `now()` | |
| `activated_at` | `timestamptz` | yes | `NULL` | Stamped by `PrmInvitationAcceptedSubscriber`. |
| `agency_status` | `text` | no | `'active'` | Read-model column, denormalized from `prm.agency.status`. Maintained by `AgencyMemberStatusReadModelSubscriber` on `prm.agency.status_changed`. Allows the aggregate to reject new writes without cross-aggregate joins (Vernon C3). |

> **Removed:** the `last_invite_sent_at` column. Re-invite cooldown is enforced via `@open-mercato/shared/lib/ratelimit` (`RateLimiterService.consume`) per PROXY-GATE-RESOLUTIONS.md §Q5 — no PRM-owned schema for this concern.
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | |

**Indexes:**
- `UNIQUE INDEX (LOWER(github_profile)) WHERE is_active = true AND github_profile IS NOT NULL` — invariant #5, **global** (no tenant scoping — deliberate; the unique is across the entire partner network, as the business rule requires).
- `UNIQUE (customer_user_id) WHERE customer_user_id IS NOT NULL` — invariant #5 (1:1 CustomerUser ↔ AgencyMember).
- `UNIQUE (agency_id, LOWER(email))` — no two members of the same Agency share an email.
- `INDEX (tenant_id, agency_id)` — P4 / B2 Members tab primary access pattern.
- `INDEX (tenant_id, is_active)` — operational filters.

**Invariant enforcement points:**
- #5 (GH global unique, 1:1 CustomerUser, 1:1 Agency): the three UNIQUE indexes. Constraint violations surface as `UniqueViolationError` caught in the command handler → translated to the L-010 user-visible message without revealing the other Agency.
- C6 (GH lock from invite time): `is_active` defaults to `true` at placeholder insert; the partial UNIQUE includes the `is_active = true` predicate, so the lock is acquired immediately.

### 5.3 Cross-module FK references

No direct ORM relations are declared across module boundaries. Instead:

- `prm.agency.organization_id` → `directory.organization.id` (FK at DB level; queries compose via a service helper `directoryGateway.getOrganization(id)` that returns a DTO, not an ORM entity).
- `prm.agency_member.customer_user_id` → `customer_accounts.customer_user.id` (FK at DB level; resolved via `customerAccountsGateway.getCustomerUser(id)`).

### 5.4 Aggregate-level delete guard (invariant #4)

`prm.agency.delete` is rejected when any of the following row counts > 0 (queried within the command transaction):

- `prm.agency_member WHERE agency_id = $id`
- Phase 2+: `prm.prospect`, `prm.case_study`, `prm.license_deal`, `prm.wic_contribution`.

Phase 1 ships only the `agency_member` check — Phase 2+ specs augment the guard. Delete is always a hard DB delete once guard passes (no soft-delete on Agency in v1; `status = historical` is the soft-retire path per US1.7).

### 5.5 Migrations

Three Mikro-ORM migrations ship in Phase 1:

| # | File | Action |
|---|---|---|
| M1 | `packages/prm/migrations/20260423000001-create-agency.ts` | `CREATE TABLE prm.agency`; indexes; enum constraints. **Additive only.** |
| M2 | `packages/prm/migrations/20260423000002-create-agency-member.ts` | `CREATE TABLE prm.agency_member`; indexes (including the partial unique on `LOWER(github_profile)`); FK to `prm.agency`. |
| M3 | `packages/prm/migrations/20260423000003-seed-prm-roles-and-dictionaries.ts` | Invokes `setup.ts`-equivalent seed: creates `CustomerRole` rows for `partner_admin` (`customer_assignable = false`) and `partner_member` (`customer_assignable = true`), their `CustomerRoleAcl` rows; creates User roles `OMPartnerOps` and `OMMarketing`; seeds the `industries`, `services`, `technologies` dictionaries; inserts the static tier-requirement table rows. Idempotent (upsert by slug). |

All three are additive (create-only — no drops, no renames, no column removals). Safely re-runnable.

---

## 6. Access Control

### 6.1 New feature flags (registered by PRM `setup.ts`)

> Naming follows the convention from app-spec §2.3: `prm.*` for domain permissions, `portal.partner.*` for portal-shell gates.

**Portal-side (granted to `partner_admin` / `partner_member`):**

| Feature | partner_admin | partner_member | Notes |
|---|---|---|---|
| `portal.partner.access` | ✓ | ✓ | Top-level portal shell gate (from `customer_accounts` SPEC-060). |
| `prm.agency.view` | ✓ | ✓ | Aliased to `prm.agency.read` per app-spec §2.3. Used by `GET /api/portal/agency/{id}`. |
| `prm.agency.edit` | ✓ | — | Aliased to `prm.agency.update`. Used by `PATCH /api/portal/agency/{id}` for the editable field set. |
| `prm.agency.read_admin_fields` | ✓ | ✓ | Enricher gate for the `_prm` block (OQ-020). |
| `prm.agency_member.read` | ✓ | ✓ | Scoped to own Agency. |
| `prm.agency_member.manage_partner_member` | ✓ | — | Portal-side write: add, edit, deactivate `partner_member` rows only. Scope boundary enforced by `customer_assignable: false` on `partner_admin` + PRM API guard (§3.2.4). |
| `prm.agency_member.self_edit` | ✓ | ✓ | Edit own row (first name, last name, role-in-agency, github_profile). |

**Explicitly not a portal feature (per app-spec §2.4 + this spec):**

- `prm.agency_member.manage_partner_admin` — **does not exist as a CustomerUser feature.** Promoting / demoting / first-admin-inviting at the `partner_admin` role is a **User-backend-only** operation (OMPartnerOps, OMAdmin). PRM does not ship a portal surface for it; a portal caller attempting `role_slug: 'partner_admin'` is rejected by `customer_assignable: false` and by the PRM portal route guard (§3.2.4).

**Backend-side (granted to `OMPartnerOps`, `OMMarketing`, `OMAdmin`):**

| Feature | OMPartnerOps | OMMarketing | OMAdmin | Routes |
|---|---|---|---|---|
| `prm.agency.read` | ✓ | ✓ | ✓ | B1, B2 (GET). |
| `prm.agency.create` | ✓ | — | ✓ | `POST /api/backend/prm/agency`. |
| `prm.agency.update_all` | ✓ | — | ✓ | `PATCH /api/backend/prm/agency/{id}` — including admin-only fields. |
| `prm.agency.edit_admin_fields` | ✓ | — | ✓ | CrudForm ACL on B2 admin-only field region. |
| `prm.agency.invite_admin` | ✓ | — | ✓ | `POST /api/backend/prm/agency/{id}/invite`. |
| `prm.agency_member.read_all` | ✓ | — | ✓ | B2 Members tab, B3. |
| `prm.agency_member.write_all` | ✓ | — | ✓ | `PATCH /api/backend/prm/agency-member/{id}`; includes `partner_admin` role changes (US1.6). |

### 6.2 Persona-to-route map (Phase 1 surfaces)

| Route | PartnerAdmin | PartnerMember | OMPartnerOps | OMMarketing | OMAdmin |
|---|---|---|---|---|---|
| `POST /api/backend/prm/agency` | — | — | ✓ | — | ✓ |
| `GET /api/backend/prm/agency` | — | — | ✓ | ✓ | ✓ |
| `PATCH /api/backend/prm/agency/{id}` | — | — | ✓ | — | ✓ |
| `POST /api/backend/prm/agency/{id}/invite` | — | — | ✓ | — | ✓ |
| `PATCH /api/backend/prm/agency-member/{id}` | — | — | ✓ | — | ✓ |
| `GET /api/portal/agency/{id}` | ✓ (own) | ✓ (own) | — | — | — |
| `PATCH /api/portal/agency/{id}` | ✓ (own, editable fields) | — | — | — | — |
| `POST /api/portal/agency/{id}/member/invite` | ✓ (own, `partner_member` role only) | — | — | — | — |
| `PATCH /api/portal/agency/{id}/member/{member_id}` | ✓ (own) | ✓ (self only) | — | — | — |

### 6.3 Tenant & organization scoping

Every portal route filters by `CustomerUser.organization_id === agency.organization_id` (tenant-scope guard wraps the feature check). Every backend route filters by `tenant_id` from the User session. No route exposes cross-tenant reads.

---

## 7. Backward Compatibility

**BC category checklist (13 categories per `BACKWARD_COMPATIBILITY.md`):**

| # | Category | Status | Notes |
|---|---|---|---|
| 1 | Database schema (tables) | **Compliant — additive only.** | Two new tables (`prm.agency`, `prm.agency_member`) in a new schema namespace. Zero changes to existing tables. |
| 2 | Database columns | **Compliant — additive only.** | No columns added/renamed/removed on existing tables. |
| 3 | Database indexes | **Compliant — additive only.** | All indexes on new tables. No changes to existing indexes. |
| 4 | DB triggers / stored procs | **Compliant — N/A.** | None used. |
| 5 | API routes (URL shape) | **Compliant — additive only.** | All `/api/*/prm/*` routes are new paths. Zero existing routes changed. |
| 6 | API request/response schemas | **Compliant — additive only.** | `ResponseEnricher` adds the `_prm` block to `agency` responses; that field namespace was reserved by this spec and is not used by any existing enricher. Existing consumers are unaffected because they don't know to read it. |
| 7 | Events (IDs + payloads) | **Compliant — additive only.** | All `prm.agency.*` and `prm.agency_member.*` event IDs are new. PRM subscribes to the existing `customer_accounts.invitation.accepted` event without altering its contract. |
| 8 | Commands | **Compliant — additive only.** | All new commands are in the `prm.*` namespace. |
| 9 | Feature flags / ACL features | **Compliant — additive only.** | All new features are in `prm.*` and `portal.partner.*`. `partner_admin` / `partner_member` are new roles (not shipped stock in `customer_accounts`). |
| 10 | i18n keys | **Compliant — additive only.** | All new keys under `prm.*` namespace. |
| 11 | Config / env vars | **Compliant — none added.** | Uses existing `CACHE_*`, `DB_*`, email-provider env vars. |
| 12 | Email templates | **Compliant — additive only.** | `PartnerInviteEmail.tsx` is a new template in `packages/prm/emails/`. |
| 13 | CLI / scripts | **Compliant — none added.** | `setup.ts` seed is platform-standard module wiring, not a new CLI. |

**Renames / removals:** zero.

**Deprecations:** zero.

**Verdict:** This spec is fully additive. Deploying it to an environment with existing OM core modules requires only running the three PRM migrations; no data backfill, no traffic coordination.

---

## 8. Risks & Impact Review

### 8.1 Data Integrity Failures

#### R1 — Partial Agency create (Organization created, Agency fails)
- **Scenario:** Mid-transaction network failure or DB error between `directory.organization` insert and `prm.agency` insert in `prm.agency.create`. Could leave an orphaned Organization → invariant #4 violation on retry.
- **Severity:** High.
- **Affected:** `prm.agency.create`, US1.1.
- **Mitigation:** Single DB transaction wraps both inserts + the outbox event write. All-or-nothing rollback. Integration test asserts orphan-Organization count remains 0 across induced mid-transaction failures.
- **Residual:** A crash between transaction commit and outbox dispatcher would drop the `prm.agency.created` event. The event is emitted inside the transaction via the standard outbox pattern, so this is already handled by the outbox worker's at-least-once delivery.

#### R2 — Race condition on placeholder-AgencyMember creation (concurrent GH-profile claims)
- **Scenario:** Two OM PartnerOps invite two different emails with the same `github_profile` simultaneously. Both requests pass the pre-check but only one UNIQUE-partial-index insert succeeds.
- **Severity:** Medium.
- **Affected:** `prm.agency.invite_member`.
- **Mitigation:** The partial UNIQUE index (`LOWER(github_profile) WHERE is_active = true`) is the authoritative gate. The `UniqueViolationError` is caught in the handler → the transaction rolls back (no invitation token, no placeholder) → the user sees the L-010 privacy-preserving message. `prm.agency_member.github_profile_conflict_attempted` is emitted for telemetry.
- **Residual:** None — the DB constraint is the source of truth.

#### R3 — Rollback of invitation token on DB failure
- **Scenario:** `customer_accounts.createInvitation` succeeds (token row inserted), then the placeholder `prm.agency_member` insert fails (e.g., the DB-level UNIQUE for `github_profile` trips). Without rollback coordination, an orphan invitation token exists with no lock-holder.
- **Severity:** High — if unhandled, the orphan token can be accepted and there is no `AgencyMember` row for the subscriber to link to.
- **Affected:** `prm.agency.invite_member`.
- **Mitigation:** The command handler opens a single DB transaction that wraps BOTH the `customer_user_invitation` insert and the `agency_member` insert. `customer_accounts.createInvitation` is refactored (UMES extension, not a core modification — the service is passed the existing `EntityManager` via DI) to participate in the caller's transaction. Email enqueue is deferred to an outbox row committed inside the same transaction; if the tx rolls back, no email is ever sent.
- **Residual:** Low. If the outbox worker crashes after sending the email but before marking the outbox row done, a duplicate email might be sent on retry — accepted; the invite link is idempotent (same token).

#### R4 — `customer_user_id` populated twice (double-delivery of `customer_accounts.invitation.accepted`)
- **Scenario:** The `customer_accounts.invitation.accepted` event is delivered twice to `PrmInvitationAcceptedSubscriber`.
- **Severity:** Low.
- **Affected:** subscriber.
- **Mitigation:** Subscriber's update statement is `UPDATE prm.agency_member SET customer_user_id = ?, activated_at = now() WHERE id = ? AND customer_user_id IS NULL`. Second invocation matches zero rows → no-op. `prm.agency_member.activated` is emitted only when rowcount = 1, so the downstream event is also deduplicated.
- **Residual:** None.

### 8.2 Cascading Failures & Side Effects

#### R5 — `status = historical` transition with in-flight writes
- **Scenario:** OM PartnerOps flips `status: active → historical` while a PartnerAdmin is mid-save on a profile edit. The read-model column on downstream aggregates is updated asynchronously by the subscriber, so a racing write can still succeed.
- **Severity:** Medium.
- **Affected:** US1.7, Phase 2+ aggregates (Prospect, CaseStudy).
- **Mitigation:** Phase 1 ships the subscriber contract (`AgencyMemberStatusReadModelSubscriber`) and the portal banner subscriber; Phase 2+ specs each wire their aggregate's own subscriber. Each aggregate rejects new writes based on its own pre-committed `agency_status` read-model — per Vernon C3, a mid-flight write completes with the prior status, which is acceptable (not a data-integrity failure; at most a race of one write).
- **Residual:** One-write-through-the-window. Documented as expected.

#### R6 — Invite email bounces (no webhook in v1)
- **Scenario:** Invite email to an invalid address silently bounces at the ESP. The PartnerAdmin never arrives; the placeholder sits in `Invited, awaiting acceptance` forever, holding a GH-profile lock.
- **Severity:** Medium.
- **Affected:** US1.2, invariant #5.
- **Mitigation:** `customer_accounts` invitation TTL is 72h. After expiry, the invitation token is unusable and the placeholder must be re-invited — PRM surfaces a "Delivery failed — check with support" badge on B2 driven by TTL expiry, not bounce webhook. The 72h TTL bounds the orphan-lock window. v2 may add a bounce webhook subscriber (OQ-014 deferred).
- **Residual:** Up to 72h of spurious GH-profile lock per bounced invite. Accepted (OQ-014).

#### R7 — Subscriber lag on `prm.agency.status_changed`
- **Scenario:** Event is published but the `AgencyMemberStatusReadModelSubscriber` lags → the `agency_status` read-model column is stale → aggregates accept writes they should reject.
- **Severity:** Low.
- **Affected:** US1.7.
- **Mitigation:** The event bus uses at-least-once delivery; catch-up is automatic. A staleness monitor (Phase 2 scope) alerts if subscriber lag > 1 minute. The Phase 1 impact is bounded — only the `AgencyMember` aggregate is wired; no Prospect writes exist yet.
- **Residual:** Sub-minute staleness on P4 banner updates during normal operation.

### 8.3 Tenant & Data Isolation Risks

#### R8 — Cross-tenant read via B3 Members DataTable
- **Scenario:** B3 is cross-agency by design but must stay within the User's tenant. A bug in the query could leak across tenants.
- **Severity:** Critical if it occurs.
- **Affected:** B3.
- **Mitigation:** B3's query mandatorily filters `WHERE tenant_id = $user.tenant_id`. Integration test asserts a two-tenant fixture returns only the caller's tenant's rows.
- **Residual:** None.

#### R9 — GH-profile global unique crosses tenants (intentional)
- **Scenario:** The `github_profile` UNIQUE is global (not tenant-scoped) — this is **deliberate** per the business rule (one human → one agency across the entire partner network). Concern: does this leak existence of another tenant's member?
- **Severity:** Low (by design).
- **Affected:** Invariant #5.
- **Mitigation:** The L-010 error message is privacy-preserving: it does not reveal the other Agency's name. The diagnostic event `prm.agency_member.github_profile_conflict_attempted` is OM-staff-visible only. No portal-side surface exposes cross-tenant data.
- **Residual:** An attacker can probe existence (not identity) of GH-profile registrations via the error. Acceptable per L-010.

### 8.4 Migration & Deployment Risks

#### R10 — Three-migration deploy with partial failure
- **Scenario:** M1 succeeds, M2 fails → partial schema state.
- **Severity:** Medium.
- **Affected:** Deployment.
- **Mitigation:** Each migration is wrapped in a single transaction. Mikro-ORM migration runner halts on first failure; re-running from M2 is safe (idempotent — `IF NOT EXISTS` guards).
- **Residual:** M3 (seed) is the only migration that upserts data; rerun is safe.

### 8.5 Operational Risks

#### R11 — L-010 UX polish (message clarity vs. privacy)
- **Scenario:** The L-010 error message is ambiguous to a non-technical PartnerAdmin, leading to support-ticket volume.
- **Severity:** Low.
- **Affected:** P4, US1.5.
- **Mitigation:** The message text is reviewed with Mat before Phase 1 ships; a "Contact OM PartnerOps" CTA is rendered next to the error, wiring to a mailto link.
- **Residual:** Some ticket volume expected; tracked via OM PartnerOps runbook.

#### R12 — Rate-limit abuse on re-invite endpoint
- **Scenario:** Attacker bombards the re-invite endpoint to probe email existence.
- **Severity:** Low.
- **Affected:** `POST /api/backend/prm/agency/{id}/invite`, `POST /api/portal/agency/{id}/member/invite`.
- **Mitigation:** Cooldown is enforced per `(agency_id, lower(email))` at 10 minutes via `@open-mercato/shared/lib/ratelimit`. Backend route additionally requires session + feature.
- **Residual:** None.

---

## 9. Integration Test Coverage

> Playwright scenarios (TypeScript) live under `packages/prm/tests/integration/`. Each scenario is a black-box end-to-end test that spins up the full stack.

### 9.1 Required scenarios

| # | Scenario | Stories | Success criteria |
|---|---|---|---|
| IT-1 | **Happy path onboarding.** OMPartnerOps logs into backend → B1 → Create Agency (name, slug, tier, country) → B2 → Invite AgencyAdmin (first, last, email, gh_profile) → assert invitation email intercepted → open invite link in a second browser context → set password → P2 dashboard loads with "Welcome! Complete your profile" banner → P3 → edit `website_url`, `description`, `industries`, `services` → save → reload → fields persist; admin-only badges visible as read-only. | US1.1, US1.2, US1.4, US2.1 | All events asserted: `prm.agency.created`, `prm.agency_member.added`, `prm.agency_member.activated` (after accept). Total wall time ≤ 15 min human simulation (scripted ≤ 30 s). |
| IT-2 | **Duplicate GH-profile rejection (L-010).** Seed: Agency A has an active AgencyMember with `github_profile = 'alice'`. Test: OMPartnerOps invites a new member on Agency B with `github_profile = 'alice'`. Assert: 409 response with the L-010 message; response body does NOT contain "Agency A" or its id; `prm.agency_member.github_profile_conflict_attempted` emitted; no placeholder row inserted on Agency B. | US1.2, US1.5, invariant #5 | Error envelope exact match; OM-staff dashboard shows the diagnostic event. |
| IT-3 | **Admin-only field 403 from portal.** PartnerAdmin authenticated. Attempt `PATCH /api/portal/agency/{id}` with body `{ tier: 'ai_native_core' }`. Assert: 403 `admin_only_field`; `prm.agency.admin_field_access_rejected` emitted; no DB write; the backend retains the prior tier. | US1.3, US2.1, invariant #6 | 403 with structured error; audit event captured. |
| IT-4 | **Lockout recovery (US1.6).** Seed: Agency with one `partner_member` only (last PartnerAdmin was deactivated). Test: OMPartnerOps opens B2 Members tab → picks the PartnerMember → changes role to `partner_admin` via CrudForm → save. Assert: `prm.agency_member.role_changed` emitted; the portal P4 member list shows the updated role badge on next load; the portal can now execute `PATCH /api/portal/agency/{id}/member/{id}` as the promoted user. | US1.6 | Recovery completes in ≤ 1 minute scripted. |
| IT-5 | **status = historical cascade banner.** Seed: Agency in `active` with a PartnerAdmin and a PartnerMember. Test: OMPartnerOps flips `status: historical`. Assert: `prm.agency.status_changed` emitted; `AgencyMemberStatusReadModelSubscriber` updates both members' `agency_status = 'historical'` within 1 s; P2 dashboard loaded by either member shows the "Your partnership is historical — contact OM Partner Operations" banner; no Phase-2 aggregates exist yet so no further cascade to assert. | US1.7, Vernon C3 | Read-model consistency within 1 s; banner rendered. |
| IT-6 | **Re-invite cooldown.** OMPartnerOps invites a PartnerAdmin; immediately re-invites the same email. Assert: second call returns 429 `invite_cooldown_active` with `retry_after_seconds > 0`. Advance wall clock 11 minutes → re-invite succeeds. | US1.2 | 429 emitted exactly when expected. |

### 9.2 Supporting unit-test coverage (non-exhaustive)

- `Agency` aggregate delete guard: rejected when AgencyMember exists.
- Partial UNIQUE index on `github_profile`: case-insensitivity (`'Alice'` vs `'alice'`) rejected.
- Command replay (update → undo): pre-image restoration yields identical record.
- `PrmInvitationAcceptedSubscriber` idempotency on double-delivery.

---

## 10. Final Compliance Report — 2026-04-23

### 10.1 Standards Checklist (caller's guidelines + Piotr Decision Library)

| Standard | Status | Notes |
|---|---|---|
| **Backward Compatibility** (13 categories, `BACKWARD_COMPATIBILITY.md`) | **Fully compliant** | Spec is strictly additive — new module, new tables, new routes, new events, new features, new email template. Zero renames, removals, or signature changes. See §7. |
| **Reuse over create** (Piotr #1) | **Compliant** | Consumes `customer_accounts` (invitation + role + event), `directory` (Organization), `dictionaries` (industry/service/tech seeds), `cache` (tag-based invalidation), `acl` (feature registry), `events`, `entities`, `media`, shared ratelimit. No duplication of core primitives. |
| **Tests first / TDD** (Piotr #2) | **Compliant** | §9 defines six Playwright scenarios covering all user stories before implementation. Unit-test skeleton noted. |
| **Decentralization** (Piotr #3) | **Compliant** | Per-aggregate subscribers maintain their own `agency_status` read-model (Vernon C3). No god-service; no centralized cascade handler. Cache invalidation is per-feature (OQ-019). |
| **Security-first** (Piotr #4) | **Compliant** | Dual enforcement of invariant #6 (backend ACL + portal ApiInterceptor). Tenant-scope guards on every route. L-010 privacy-preserving error. zod validation on every input. No secrets in logs. Diagnostic events for admin-field-access attempts and GH-profile conflicts. |
| **Scope discipline** (Piotr #5) | **Compliant** | §1.3 explicitly lists out-of-scope items. No speculative Phase-2 widgets, no v2 tier automation, no bounce webhook. |
| **Extract when ripe** (Piotr #6) | **Compliant** | PRM is the new package being extracted as the "ripe" partner-management concept. No premature sub-extraction within PRM. |
| **Command pattern** (Piotr #7, #8) | **Compliant** | §4.1 defines six commands, each with its undo contract. Compound commands (`prm.agency.create`, `prm.agency.invite_member`) marked. Field-diff-aware `update` commands route to the correct domain event. |
| **Platform convention over invention** (Piotr #9) | **Compliant** | Module scaffold follows `om-module-scaffold`. Naming follows `module.entity.action` singular. Feature flags follow `{module}.{resource}.{action}`. ACL via existing `acl` module. Cache via existing `cache.deleteByTags`. |
| **Necessity test** (Piotr #10) | **Compliant** | Every entity, route, event, feature, and seed listed here is referenced by ≥1 of the 8 stories in scope. No gold-plating. |

### 10.2 Compliance Matrix (spec-checklist.md MUST rules)

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| root AGENTS.md | No direct ORM relationships between modules | **Compliant** | Cross-module refs use FK IDs only; gateway helpers return DTOs (§5.3). |
| root AGENTS.md | Filter by `organization_id` | **Compliant** | Every scoped route applies tenant-scope + organization-scope guards (§3, §6.3). |
| root AGENTS.md | Singular naming | **Compliant** | `agency`, `agency_member`; events `prm.agency.created` not `.agencies.`; commands singular. |
| root AGENTS.md | All mutations are commands | **Compliant** | Six commands cover all writes (§4.1). |
| root AGENTS.md | Undo contracts specified | **Compliant** | §4.1 has an Undo column for every command. |
| packages/core/AGENTS.md | API routes MUST export openApi | **Compliant** | §3.3 asserts every route exports `openApi`. |
| packages/core/AGENTS.md | zod validation on all inputs | **Compliant** | §3.3. |
| packages/cache/AGENTS.md | Tag-based invalidation, tenant-scoped | **Compliant** | Tags declared in §3 per route; invalidation hooks in §4.2. |
| packages/events/AGENTS.md | Event IDs match published contract | **Compliant** | All event IDs drawn verbatim from app-spec §1.4.5. |
| packages/acl/AGENTS.md | New features registered via `setup.ts` | **Compliant** | §6.1 + M3 migration. |
| `BACKWARD_COMPATIBILITY.md` | Additive-only migrations | **Compliant** | §7, §5.5. |
| Piotr Decision Library | Undoability default | **Compliant** | §4.1. |
| Piotr Decision Library | Event-bus side effects (no cross-module imports) | **Compliant** | `AgencyStatusReadModelSubscriber` pattern is event-driven (§4.2, §4.3). |

### 10.3 Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data models match API contracts | **Pass** | Every field in §5 appears in the matching request/response in §3 or is explicitly admin-only. |
| API contracts match UI/UX expectations | **Pass** | P3 / P4 / B1 / B2 / B3 surfaces map to the routes listed. |
| Risks cover all write operations | **Pass** | R1–R6 cover the six write paths. |
| Commands defined for all mutations | **Pass** | Six commands cover every PATCH / POST mutation in §3. |
| Cache strategy covers all read APIs | **Pass** | Each GET route declares a cache tag; each event in §4.2 lists its invalidations. |
| Events listed in §4.2 match IDs from app-spec §1.4.5 | **Pass** | Zero drift. |

### 10.4 Non-Compliant Items

**None.** Spec is fully compliant with root AGENTS, module AGENTS, `BACKWARD_COMPATIBILITY.md`, and the Piotr Decision Library.

### 10.5 Verdict

**Fully compliant — Approved for implementation.**

---

## Changelog

### 2026-04-23
- Initial specification authored by om-spec-writing skill (Martin Fowler persona) per Piotr's decomposition brief. Open Questions gate skipped — all 18 v1 OQs resolved in `app-spec/decisions-log.md`, 3 deferred to v2.
- Technical Approach (§2) embedded verbatim from Piotr's brief.
- Six Playwright scenarios enumerated.
- Spec declared additive-only — no backward-compatibility concerns.

### 2026-05-05 — T0 implementation landed (Patryk via om-implement-spec)

**Module location:** standalone app (`src/modules/prm`, `from: '@app'`) — adapted from the spec's `packages/prm` per the standalone-app convention.

**Files delivered:**
- `data/entities.ts` — `Agency`, `AgencyMember` (table names `prm_agencies`, `prm_agency_members`).
- `data/validators.ts` — zod schemas for create / update (backend + portal) + `ADMIN_ONLY_AGENCY_FIELDS` constant.
- `data/enrichers.ts` — `prm.portal-agency-admin-fields` enricher (gated on `prm.agency.read_admin_fields`).
- `lib/agencyService.ts`, `lib/agencyMemberService.ts`, `lib/reinviteCooldownService.ts`, `lib/errors.ts`.
- `events.ts` — 11 events (5 agency, 6 member, 2 telemetry — categorized as `system` per platform `EventCategory` whitelist).
- `subscribers/prm-invitation-accepted.ts` (links placeholder + emits `prm.agency_member.activated`).
- `subscribers/agency-member-status-readmodel.ts` (Vernon C3 read-model maintainer).
- `api/interceptors.ts` — portal admin-field guard (defence-in-depth alongside route-level zod check).
- `api/agency/route.ts` + `[id]/route.ts` + `[id]/invite/route.ts` + `[id]/member/route.ts`.
- `api/agency-member/route.ts` + `[id]/route.ts` (B3 + lockout-recovery PATCH that syncs `CustomerUserRole`).
- `api/portal/agency/[id]/route.ts` + `[id]/member/route.ts` + `[id]/member/[memberId]/route.ts` + `me/route.ts`.
- `backend/page.{tsx,meta.ts}` (B1), `backend/new/`, `backend/[id]/` (B2 + Members tab), `backend/agency-members/`, `backend/agency-members/[id]/` (B3 + lockout recovery).
- `frontend/[orgSlug]/portal/agency/`, `frontend/.../portal/members/`, `frontend/.../portal/notifications/` (P3, P4, P12 — P12 is a thin wrapper over `PortalNotificationPanel` + `usePortalNotifications` per OQ-010).
- `emails/PartnerInviteEmail.tsx` + `emails/sendPartnerInviteEmail.ts` (best-effort dispatch via DI-resolved `emailService`, structured-log fallback per OQ-014).
- `setup.ts` — seeds `partner_admin` (customer_assignable=false) and `partner_member` `CustomerRole` rows + ACLs on tenant create; declares `defaultRoleFeatures` for staff roles (`prm.*` to admin/superadmin, `prm.agency.read` + `prm.agency_member.read_all` to employee).
- `acl.ts` — 16 features under `prm.*` and `portal.partner.*`.
- `di.ts` — registers `agencyService`, `agencyMemberService`, `reinviteCooldownService`, plus `prmAdminOnlyAgencyFields` value.
- `i18n/en.json` — every user-facing string keyed.
- `migrations/Migration20260505090240_prm.ts` (clean baseline that creates only `prm_agencies` and `prm_agency_members` — see Post-merge notes below for why this was hand-extracted from the original generator output) + `migrations/Migration20260505100000_prm_indexes.ts` (additive: partial-unique GH index, FK, enum CHECKs — non-decorator-expressible structures).
- 8 `__tests__/*.test.ts` covering: validators, errors, ratelimit cooldown, agency service create/conflict paths, invitation-accepted subscriber idempotency, agency-status read-model subscriber, admin-field interceptor, and `safeEmit` helper (added during the post-merge fix pass for M1).
- `lib/safeEmit.ts` — non-throwing wrapper around `emitPrmEvent` that routes emission failures through the DI-resolved logger; replaces 14 silent `.catch(() => undefined)` swallows on event emissions.

**Cross-spec contract decisions (downstream specs MUST mirror):**
1. **Tables**: `prm_agencies`, `prm_agency_members` (snake_case, plural — followed `<module>_<entity>` prefix per AGENTS).
2. **Event IDs**: `prm.agency.created`, `prm.agency.tier_changed`, `prm.agency.status_changed`, `prm.agency.onboarding_state_changed`, `prm.agency.deleted`, `prm.agency_member.added`, `prm.agency_member.activated`, `prm.agency_member.removed`, `prm.agency_member.role_changed`, `prm.agency_member.updated`, `prm.agency_member.github_profile_conflict_attempted`, `prm.agency.admin_field_access_rejected`. **Frozen.**
3. **Feature IDs**: `prm.agency.{read,create,update_all,edit_admin_fields,read_admin_fields,delete,invite_admin}`, `prm.agency_member.{read_all,write_all,read,manage_partner_member,self_edit}`, `prm.agency.{view,edit}`, `portal.partner.{access,notifications.view}`. **Frozen.**
4. **Role slugs**: `partner_admin` (customer_assignable=false), `partner_member` (customer_assignable=true). **Frozen.**
5. **Index name**: `prm_agency_members_github_profile_active_uniq` (partial UNIQUE on `lower(github_profile) where is_active`). **Frozen** for FK references and downstream test fixtures.
6. **Invitation linkage**: PRM places `invitation_id` on the placeholder `AgencyMember` row. The acceptance subscriber finds the placeholder by `invitation_id` (matching the `customer_accounts.invitation.accepted` payload's `invitationId`).
7. **Email accept link**: `/{orgSlug}/portal/invitations/accept?token=…` is the canonical accept URL (consumed by stock `customer_accounts.acceptInvitation`).

**Quality gates (8/8) — re-validated after the post-merge fix pass:**
1. Typecheck: PASS — `yarn typecheck` exit 0.
2. Unit tests: PASS — `yarn test src/modules/prm` → 8 suites, 32 tests, 0 failures.
3. Integration tests: N-A — Playwright scenarios in §9 require a live Postgres + ESP fixture and are deferred to the QA team's infra-stand-up; spec ships with unit + service-layer coverage that exercises every invariant gate.
4. Migration review: PASS — `yarn mercato db generate` is a no-op (snapshot matches entities); migration files only touch `prm_agencies` / `prm_agency_members` (43 + 56 lines, 12 + 16 statements). The original auto-generated migration was discarded and replaced with a hand-extracted clean baseline — see Post-merge notes.
5. AGENTS.md compliance: PASS — module IDs plural snake_case, events `prm.<entity>.<past_tense>`, features `<module>.<action>`, FK IDs only across modules, lucide-react icons in `page.meta.ts`, `pageGroup`/`pageGroupKey`/`pageOrder` set on B1 + B3 list pages.
6. Piotr Decision Library checklist: PASS — BC additive-only, reuses `customer_accounts.CustomerInvitationService` + `customer_accounts.acceptInvitation` + `@open-mercato/shared/lib/ratelimit` + `PortalNotificationPanel`, command-shaped service mutations, every invariant has an explicit enforcement point in code.
7. i18n: PASS — every user-facing string in pages routed through `useT('key', 'fallback')`; locale dictionary lives at `i18n/en.json`. Notification copy delegated to `PortalNotificationPanel`'s built-in keys.
8. Build: PASS — `yarn build` (Next.js 16.2.3, Turbopack) compiled successfully; openapi.generated.json indexes 319 paths including all PRM routes; `yarn generate` and `yarn mercato db generate` both clean.

**Migrations NOT applied:** `yarn mercato db migrate` was deliberately not run — per AGENTS rule #4 we hand back to the user for explicit approval. Two migration files are staged in `src/modules/prm/migrations/` ready for review.

**Deferred:**
- Live Playwright IT-1..IT-6 from §9 — require live ESP + DB fixtures (spec §9 expects Playwright runner stand-up).
- Bounce-webhook handler — per OQ-014, deferred to v2.
- Static tier-requirement table seed — Phase 1 scope per spec, but Phase 2 widgets consume it; tier values are enum-checked in DB and a no-op in Phase 1 read paths.

**Out-of-scope confirmed:** dashboard widgets (Phase 2), Prospect/LicenseDeal/RFP/CaseStudy entities (Phases 2–7).

### 2026-05-05 — T0 post-merge fix pass

After dual review the T0 commit was blocked on five issues. All are now fixed in three follow-up commits on `main`:

1. **C2 — destructive migration.** The originally generated `Migration20260505090240.ts` was 1221 lines / 824 statements and dropped/recreated ~80 unrelated tables across the entire schema. Root cause: when `yarn mercato db generate` first ran for PRM there was no `.snapshot-open-mercato.json` for the module yet, so MikroORM diffed PRM's (2-entity) target schema against the live database — every non-PRM table looked "extra" → drop, "missing" → recreate. The accompanying snapshot that landed alongside was already correct (only the 2 PRM tables). Fix: replaced the contaminated migration with a clean `Migration20260505090240_prm.ts` (43 lines, 12 statements) that only creates `prm_agencies` and `prm_agency_members`. The companion `Migration20260505100000_prm_indexes.ts` and the snapshot are unchanged. `yarn mercato db generate` is now a no-op for all three @app modules.

2. **C1 — module `data/` directories silently gitignored.** `.gitignore:75` was `data/` (no leading slash) which matched every nested `data/` directory in the tree, so `src/modules/*/data/*.ts` were untracked. Fix: anchored the rule to repo root (`/data/`) so the runtime cache directory at the project root stays ignored while module-level `data/` dirs become trackable. Then committed every previously-invisible file under `src/modules/<id>/data/` for all three @app modules (PRM, example, example_customers_sync). This was a pre-existing project-level bug that T0 inherited.

3. **H3 — raw `em.find` / `em.findOne` on tenant-scoped tables.** Replaced 17 calls in PRM lib services, subscribers, and API routes with `findOneWithDecryption` / `findWithDecryption` / `findAndCountWithDecryption` from `@open-mercato/shared/lib/encryption/find`. `setup.ts` is intentionally left on raw `em.findOne` to match the framework convention seen in `@open-mercato/core/customer_accounts/setup.ts` (setup hooks run before tenant encryption keys exist).

4. **M1 — silent `.catch(() => undefined)` on event emissions.** Added `lib/safeEmit.ts` — a non-throwing wrapper around `emitPrmEvent` that resolves a logger from the request container (falling back to `console.warn`) and routes emission failures through it. Replaced all 14 silent swallows. Added 5 unit tests for safeEmit (happy path, transport failure, container-resolved logger, container without logger, error vs warn level). The two non-event silent catches on `sendPartnerInviteEmail` are preserved (best-effort by design per OQ-014) but now log via `console.warn` with the failed `agencyMemberId`.

5. **H2 (partial) — `as any` casts in backend pages.** Typed the `DataTable` column arrays in `backend/page.tsx` and `backend/agency-members/page.tsx` as `ColumnDef<RowType>[]` from `@tanstack/react-table` and the `CrudForm` `initialValues` in `backend/[id]/page.tsx` against the zod-derived `UpdateValues` — removing 7 casts. Left `em.create({...} as any)` and `em.persistAndFlush(...)` chains for a future cleanup pass; they don't block merge and chasing them risks regressions in the MikroORM DI integration.

**Quality gates (post-fix, from a clean working tree):** `yarn typecheck` PASS, `yarn test src/modules/prm` PASS (32 tests), `yarn mercato db generate` clean, `yarn generate` clean, `yarn build` PASS.
