# SPEC-2026-05-08-agency-member-deactivation — PRM Agency Member Portal-Access Sync

**Date**: 2026-05-08
**Status**: Draft (Open Questions resolved 2026-05-08; implemented 2026-05-08)

## Progress
- [x] Phase 1 — Event vocabulary
- [x] Phase 2 — Service emit
- [x] Phase 3 — Sync subscribers + asymmetric ConfirmDialogs (backend + portal)
- [x] Phase 4 — Integration tests (TC-PRM-T0-007)
- [x] Phase 5 — UX polish (i18n keys + flash copy)
- [ ] Phase 6 — DEFERRED — retroactive reconciliation CLI (per Q3 (a))
**Spec #**: 8 of 8 (extension of WF1 — Agency Lifecycle)
**Estimated commits**: 5 (all `app` scope, no core/upstream changes)
**Persona (review lens)**: Piotr (om-cto) for architectural fit, Cagan (om-product-manager) for UX intent
**Parent spec**: `SPEC-2026-04-23-agency-foundation.md` (US1.6 lockout RECOVERY shipped; this spec adds lockout PREVENTION)

---

## TLDR

**Key Points:**
- Today, toggling **Active = false** on `AgencyMember` in `/backend/prm/agency-members/[id]` is **cosmetic only** — it sets `agency_members.is_active = false` and emits `prm.agency_member.removed`, but **does not block portal login or revoke access**. The user keeps their JWT, keeps their `CustomerUserRole` assignments, and continues using the portal.
- This spec wires the **AgencyMember.isActive flag to OM core's existing `CustomerUser.isActive` + session revocation primitives**, so deactivation actually disables portal access — and reactivation restores it.
- No new auth-gate code: `validateUserState` in `@open-mercato/core/modules/customer_accounts/lib/customerAuth.ts` already rejects requests when `CustomerUser.isActive=false` or `sessionsRevokedAt > jwt.iat`. We just need a subscriber that flips the flag.

**Scope (in):**
- New event `prm.agency_member.reactivated` (mirror of existing `prm.agency_member.removed`).
- `AgencyMemberService.update()` emits `reactivated` when `is_active` flips false → true.
- New persistent subscriber `agency-member-portal-access-sync.ts` that handles both `removed` and `reactivated` events.
  - On `removed`: set `CustomerUser.isActive = false` + call `customerSessionService.revokeAllUserSessions(userId)`.
  - On `reactivated`: set `CustomerUser.isActive = true`.
- Integration test (Playwright) covering the full deactivate → 401 → reactivate → restored flow.
- Backend UI copy update — make the "Active" checkbox tooltip + post-save flash explicit about portal access revocation.

**Scope (out):**
- Hard delete of `AgencyMember` rows — by design, attribution preserved (see SPEC-2026-04-23-agency-foundation §3 invariants on `AgencyMember.customer_user_id` + RFP / Prospect / LicenseDeal FKs).
- Retroactive enforcement for existing `is_active=false` rows in production data — forward-only by default; optional reconciliation CLI deferred to post-MVP unless Q3 says otherwise.
- Splitting `prm.agency_member.deactivate` out of `prm.agency_member.write_all` ACL feature — kept fused (Q4).
- New audit-log infrastructure — keep US1.6's pattern (event bus + `updated_at`).

---

## Resolved Decisions *(2026-05-08, accepted by user)*

| # | Decision | Resolution | Effect on spec |
|---|----------|-----------|----------------|
| Q1 | Reactivation UX | **(b) Asymmetric** — `ConfirmDialog` fires on `isActive` true→false ONLY; reactivation is one-click | Phase 3 promotes the micro-step to a required Step 4 (backend) and Step 5 (portal) — confirm copy mirrors `caseStudyService.softDelete` pattern at `backend/prm/case-studies/[id]/page.tsx:623` |
| Q2 | Partner-admin portal authority | **(a) Keep** — partner_admin retains ability to deactivate their partner_member rows from portal (gate `prm.agency_member.manage_partner_member` unchanged) | No code change vs today; portal Confirm dialog (Q1 b) provides the friction guardrail |
| Q3 | Retroactive enforcement | **(a) Forward-only** — no auto-reconciliation on deploy | Phase 6 (CLI) stays optional / explicit-opt-in; default = ops runs nothing. Spec's "Behavioral BC" note retained. |
| Q4 | ACL granularity | **(a) Keep fused** — `prm.agency_member.write_all` continues to cover deactivation; no new feature ID | No `acl.ts` change; no `setup.ts` re-seed |

---

## Overview

`AgencyMember.isActive` was originally introduced in SPEC-2026-04-23-agency-foundation as a domain attribute meaning *"this person is currently part of this agency"*. The shipped backend UI exposed it as a toggle in `/backend/prm/agency-members/[id]/page.tsx:90` (label: "Active"), with the implicit expectation that flipping it to false would offboard the member.

In practice the toggle is informational only — verified by tracing:
1. `agencyMemberService.update()` (`src/modules/prm/lib/agencyMemberService.ts:296-344`) flips the column and emits `prm.agency_member.removed`.
2. No subscriber in `src/modules/prm/subscribers/` consumes `prm.agency_member.removed` (verified by directory listing).
3. Portal frontend at `src/modules/prm/frontend/[orgSlug]/portal/members/page.tsx:188` uses the flag only for a "Deactivated" display label.
4. `requireCustomerAuth` in `@open-mercato/core/modules/customer_accounts/lib/customerAuth.ts` does **not** read `AgencyMember.isActive`; it reads `CustomerUser.isActive` (which stays true).
5. `CustomerUserRole` rows for `partner_admin` / `partner_member` remain intact after deactivation — RBAC gates pass, portal continues to function.

Result: a control labelled "Active" that does not control activity. This spec closes the loop by mapping the PRM domain event to OM core's existing portal-access primitive.

> **Market reference**: Standard pattern in B2B SaaS (Salesforce, HubSpot, Linear) is *"deactivate user"* = login blocked + active sessions revoked + entity preserved for audit. We adopt this directly.

## Problem Statement

1. **Security gap.** A revoked partner-side person — for example flagged for golden-rule violation per SPEC-2026-04-23-agency-foundation §3.1 invariants — keeps full portal access until their `CustomerUserRole` rows are manually deleted via `core.customer_accounts` admin pages. Two separate operator actions are required when one is intuitive.
2. **UX gap.** OM-staff click "Active = false" expecting offboarding; result is invisible. Partner_admin clicks the same toggle in portal expecting to remove a teammate; teammate keeps logging in.
3. **Lockout-prevention gap.** SPEC-2026-04-23-agency-foundation §US1.6 covers lockout *recovery* (promote a partner_member to partner_admin to unblock administration). It does not cover lockout *prevention* (block a member from the portal entirely). This spec closes that gap.

## Proposed Solution

Bridge `AgencyMember.isActive` → `CustomerUser.isActive` via a single persistent PRM subscriber that calls existing OM core primitives.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Use `CustomerUser.isActive` flip (not `CustomerUserRole` removal) as the access-control mechanism | Single source of truth. `validateUserState` in core already gates on this. RBAC role manipulation would fight the existing `syncCustomerRoleAssignment` helper used by US1.6 lockout recovery. |
| Use `customerSessionService.revokeAllUserSessions(userId)` on deactivation | Already shipped (used by `core/customer_accounts/api/admin/users/[id].ts`, password-change flows, TC-AUTH-024/025). Sets `sessionsRevokedAt` so existing JWTs are rejected next request — no waiting for token expiry. |
| Single subscriber handles both `removed` and `reactivated` events | Symmetric domain event pair; one subscriber file owns the full sync logic. |
| Subscriber is `persistent: true` | Aligns with PRM patterns (e.g., `agency-cache-on-status-changed.ts`, `prm-invitation-accepted.ts`) and ensures retry on transient DB / event-bus failure. Critical because the consequence of a missed event is a stale-access security gap. |
| No new ACL feature | `prm.agency_member.write_all` (backend) and `prm.agency_member.manage_partner_member` (portal) already gate the `is_active` PATCH. The subscriber is internal — no operator-facing surface. |
| No retroactive reconciliation by default | Spec ships forward-only. Optional CLI command (commit #6) added only if Q3 (a) is confirmed and business wants the option. |

### Architecture Diff vs `agency-foundation`

| Surface | agency-foundation (shipped) | This spec |
|---------|----------------------------|-----------|
| `prm.agency_member.removed` event | Emitted on `is_active` flip true→false | Unchanged |
| `prm.agency_member.reactivated` event | Did not exist | **New** — emitted on `is_active` flip false→true |
| Subscribers consuming `removed` / `reactivated` | None | **New** — `agency-member-portal-access-sync.ts` |
| `CustomerUser.isActive` linkage to `AgencyMember` | None | Subscriber-mediated |
| Auth gate at `validateUserState` | Already checks `CustomerUser.isActive` (since SPEC-060) | Unchanged — we make the flag move |

## User Stories

- **US8.1**: As OM PartnerOps, I want flipping "Active = false" on a partner member to immediately revoke their portal access, so that suspected fraud or golden-rule violations can be contained without a separate `customer_accounts` action.
- **US8.2**: As OM PartnerOps, I want flipping "Active = true" on a previously deactivated partner member to restore portal access, so that mistaken or temporary deactivations are easily reversible.
- **US8.3**: As a partner_admin, I want deactivating a partner_member from my agency portal to actually remove their access, so that I can manage offboarding without filing tickets to OM-staff.
- **US8.4**: As a deactivated partner member with an active session, I want my next request to be rejected with a clear authentication error, so that I'm not silently stuck on a UI that won't function.

### Failure paths

| Story | Failure | Behavior |
|-------|---------|----------|
| US8.1 | Subscriber DB write fails (e.g., transient connection error) | Persistent subscriber retries per OM event-bus retry policy. Backend save still succeeds (audit shows `removed` event was emitted). Operator sees success flash; system reconciles within retry window. |
| US8.2 | Subscriber tries to reactivate a `CustomerUser` that has been hard-deleted (`deletedAt` set) | Subscriber treats this as a no-op (logs warning); `validateUserState` would reject anyway. Member row's `is_active` stays true; data integrity preserved. |
| US8.3 | partner_admin tries to deactivate themselves | Existing portal route already blocks this (`api/portal/agency/[id]/member/[memberId]/route.ts:111` — `CANNOT_DEACTIVATE_SELF`). No change needed. |
| US8.4 | User has the deactivated portal page open, makes API call mid-deactivation | Request hits `validateUserState`, `CustomerUser.isActive=false` → 401. Frontend's `apiCall` wrapper redirects to login per existing customer-portal auth flow. |

## Data Models

**No schema changes.** All required columns already exist:

| Entity | Column | Source | Use |
|--------|--------|--------|-----|
| `AgencyMember` | `is_active` | `prm` | Domain flag — operator-facing |
| `AgencyMember` | `customer_user_id` | `prm` | Bridge to `CustomerUser` |
| `CustomerUser` | `is_active` | `core.customer_accounts` | Auth-layer flag — read by `validateUserState` |
| `CustomerUser` | `sessions_revoked_at` | `core.customer_accounts` | Set by `revokeAllUserSessions` |

## API Contracts

**No new endpoints.** Existing routes call into the same service path:

| Route | Method | Behavior change |
|-------|--------|----------------|
| `/api/prm/agency-member/[id]` | PATCH | Same. Service layer now emits `reactivated` event when applicable (existing emit of `removed` unchanged). |
| `/api/prm/portal/agency/[id]/member/[memberId]` | PATCH | Same. Same emit semantics. |

## Events

```typescript
// src/modules/prm/events.ts
prm.agency_member.removed:        // (existing — unchanged)
  { agencyId, tenantId, agencyMemberId }
prm.agency_member.reactivated:    // NEW
  { agencyId, tenantId, agencyMemberId, customerUserId | null }
```

Subscriber `agency-member-portal-access-sync.ts`:

```typescript
metadata = {
  events: ['prm.agency_member.removed', 'prm.agency_member.reactivated'],
  persistent: true,
  id: 'prm-agency-member-portal-access-sync',
}

handler(payload):
  if (event === 'prm.agency_member.removed') {
    member = findById(payload.agencyMemberId, scope: { tenantId })
    if (!member?.customerUserId) return  // pre-accept member, no CustomerUser yet
    user = findOneWithDecryption(em, CustomerUser, { id: member.customerUserId, tenantId, deletedAt: null })
    if (!user) return  // already hard-deleted upstream — nothing to do
    user.isActive = false
    em.persist(user); await em.flush()
    await customerSessionService.revokeAllUserSessions(user.id)
  } else if (event === 'prm.agency_member.reactivated') {
    member = findById(payload.agencyMemberId, scope: { tenantId })
    if (!member?.customerUserId) return
    user = findOneWithDecryption(em, CustomerUser, { id: member.customerUserId, tenantId, deletedAt: null })
    if (!user) return
    user.isActive = true
    em.persist(user); await em.flush()
    // Note: do NOT clear sessions_revoked_at — old JWTs stay invalidated by design
  }
```

## Implementation Plan

### Phase 1 — Event vocabulary (1 commit)

1. Declare `prm.agency_member.reactivated` in `src/modules/prm/events.ts` next to existing `removed` event. Same payload shape + `customerUserId | null`.
2. Update unit-test fixtures importing event IDs.

### Phase 2 — Service emit (1 commit)

1. In `agencyMemberService.update()` (`src/modules/prm/lib/agencyMemberService.ts:334-344`), add symmetric branch: when `before.isActive === false && member.isActive === true`, emit `prm.agency_member.reactivated`.
2. Unit test: verify both `removed` and `reactivated` are emitted with correct payloads on the relevant transitions.

### Phase 3 — Sync subscriber + asymmetric Confirm dialog (1 commit)

1. New file `src/modules/prm/subscribers/agency-member-portal-access-sync.ts` with the handler shown above.
2. DI dependencies via `createRequestContainer()` — `customerSessionService` resolved per-request.
3. Unit test (Jest, isolated):
   - `removed` event with valid `customerUserId` → `CustomerUser.isActive=false`, `revokeAllUserSessions` called once.
   - `removed` event with `customerUserId=null` (pre-accept member) → no-op, no service calls.
   - `reactivated` event with valid `customerUserId` → `CustomerUser.isActive=true`, `revokeAllUserSessions` NOT called.
   - Idempotency: re-firing same event yields same final state.
4. **Backend ConfirmDialog (Q1 b — required)**: in `src/modules/prm/backend/prm/agency-members/[id]/page.tsx`, intercept the `CrudForm` submit when `values.isActive === false && initialValues.isActive === true`. Show `ConfirmDialog` with copy: title *"Deactivate member?"*, body *"This will revoke their portal access immediately and sign them out of all sessions. They will not be able to log in until reactivated."*, confirm label *"Deactivate"*, cancel label *"Cancel"*. Reactivation (false→true) saves directly without confirm. Mirror dialog wiring from `caseStudyService` softDelete UX in `backend/prm/case-studies/[id]/page.tsx:623`.
5. **Portal ConfirmDialog (Q1 b — required)**: equivalent dialog on partner_admin's portal Members page (the page that issues PATCH to `/api/prm/portal/agency/[id]/member/[memberId]`). Same copy + behavior; same i18n key namespace.

### Phase 4 — Integration test (1 commit)

1. New Playwright spec under `tests/integration/` — DEFERRED. The entire PRM Playwright integration suite was deleted on 2026-05-09 pending the tenant-per-spec rebuild; see the abandoned predecessor at `.ai/specs/SPEC-2026-05-09-test-fixtures-refactor.md`.
2. Scenario: seed agency + partner_admin + partner_member → log in as partner_member → log in as partner_admin in second context → partner_admin deactivates partner_member → assert partner_member's next API call returns 401 → assert login attempt as partner_member returns generic auth error → partner_admin reactivates → partner_member can log in fresh and access portal.

### Phase 5 — UX polish (1 commit)

1. Backend `src/modules/prm/backend/prm/agency-members/[id]/page.tsx` — add `description` to the `isActive` field: *"Toggling off revokes portal access immediately and signs the member out of all sessions."*
2. Add new i18n key `prm.members.fields.active.help` in PRM translations.
3. Update post-save flash text to mention "Member deactivated — portal access revoked." vs "Member reactivated — portal access restored." vs "Member saved." (no isActive change).

### Phase 6 — Optional: retroactive reconciliation CLI (deferred, opt-in)

Per Q3 resolution: forward-only by default. This phase is **NOT shipped with the initial PR**. Tracked in `.ai/specs/POST-MVP-FOLLOW-UPS.md` so ops can request it later if production data shows pre-existing `is_active=false` rows that need reconciling.

When/if needed:
1. New `mercato` CLI command `prm:reconcile-deactivated-members` that iterates `agency_members WHERE is_active=false AND deleted_at IS NULL` and re-emits `prm.agency_member.removed` per row. Idempotent.
2. Add to `.ai/specs/POST-MVP-FOLLOW-UPS.md` with the production query gate (`SELECT COUNT(*) FROM agency_members WHERE is_active=false AND deleted_at IS NULL`).

## Integration Test Coverage

| ID | Path | Asserts |
|----|------|---------|
| IT-DEACT-1 | OM-staff backend deactivates → next portal API call as that user → 401 | Auth gate fires via `validateUserState` |
| IT-DEACT-2 | OM-staff backend deactivates → user attempts fresh login → generic "invalid credentials" (privacy preserved per customer_accounts MUST rule) | Login flow rejects on `isActive=false` |
| IT-DEACT-3 | partner_admin portal deactivates partner_member → same as IT-DEACT-1 | Portal-initiated path works identically |
| IT-DEACT-4 | OM-staff reactivates → user logs in fresh → portal works | `is_active=true` restores access |
| IT-REACT-5 | After deactivation, old JWT (issued before `sessionsRevokedAt`) is rejected even if `is_active` later flips back to true | `sessionsRevokedAt` semantics preserved per SPEC-060 |
| IT-DEACT-6 | partner_admin tries to deactivate self → 403 `CANNOT_DEACTIVATE_SELF` | Existing guard unchanged |
| IT-DEACT-7 | OM-staff deactivates a member whose invitation hasn't been accepted yet (`customerUserId=null`) → subscriber no-ops, no errors | Pre-accept safety |

All IT-* are DEFERRED — the PRM Playwright suite was deleted on 2026-05-09; rebuild pending tenant-per-spec architecture.

## Risks

| Risk | Severity | Mitigation | Residual |
|------|----------|------------|----------|
| Subscriber failure leaves user with stale portal access (security gap) | Medium | `persistent: true` + idempotent handler; OM event-bus retry policy | Brief window (seconds) between event emit and subscriber success; acceptable per existing OM patterns |
| Cross-tenant CustomerUser lookup leaks data | Low | `findOneWithDecryption` with `tenantId` scope on every query; payload carries `tenantId` | None |
| Reactivation of a hard-deleted CustomerUser silently fails | Low | Subscriber checks `deletedAt: null` before update; logs no-op | Operator must understand that hard-delete is one-way (existing OM behavior) |
| Existing `is_active=false` rows in production are not retroactively synced (Q3 default = a) | Medium | Documented in spec §Open Questions; optional Phase 6 CLI; pre-deploy DB query measures actual count | Operator awareness required |
| Partner_admin maliciously deactivates teammates | Low | Existing CANNOT_DEACTIVATE_SELF guard; `prm.agency_member.removed` event leaves audit trail; OM-staff can reactivate | Same threat surface as today's role-removal capability |
| Q1 (b) confirm dialog adds friction for legitimate fast-path use | Low | Only fires on destructive direction; one extra click | Acceptable per US1.6's softDelete UX pattern |

## Dependencies & Constraints

- Requires `@open-mercato/core` ≥ version that ships `validateUserState` (SPEC-060, present in this repo per `node_modules` inspection).
- Requires `customerSessionService.revokeAllUserSessions` (present, used in 5 core flows).
- No new packages, no migration, no env vars.
- `OM_PRM_WIC_IMPORT_SECRET` for IT runs (per `AGENTS.md` §"Integration test environment"). The `OM_PRM_TEST_FIXTURES_ENABLED` env var was deleted 2026-05-09 alongside the test-fixtures routes.

## Backwards Compatibility

| Surface (per BACKWARD_COMPATIBILITY.md categories) | Impact | Migration |
|---|---|---|
| 5 — Event IDs | **Additive** — new `prm.agency_member.reactivated` event | None — purely new addition |
| 8 — Database schema | None | No DDL |
| 10 — ACL feature IDs | None | `write_all` reused |
| All others | None | — |

**Behavioral BC:** existing `agency_members` with `is_active=false` in production data are NOT auto-reconciled. See Q3 + Phase 6 (optional).

## Final Compliance Report

Compliance gates run 2026-05-08:
- [x] `yarn typecheck` clean (exit 0)
- [x] `yarn test` passes — 68 suites, 656 tests, 0 failures
- [ ] `yarn test:integration:ephemeral` — DEFERRED. The PRM Playwright integration suite was deleted on 2026-05-09 (along with the env var that gated half of it); rebuild pending tenant-per-spec architecture.
- [x] i18n keys added (no hardcoded strings) — see `src/modules/prm/i18n/en.json` (additions for `prm.members.detail.deactivate.*`, `prm.members.fields.active.help`, `prm.members.detail.flash.{deactivated,reactivated}`, `prm.portal.members.action.*`, `prm.portal.members.deactivate.*`, `prm.portal.members.flash.{deactivated,reactivated,error}`, `prm.portal.members.col.*`, `prm.portal.members.state.*`)
- [x] `yarn build` clean (1 pre-existing `ai-assistant` dynamic-import warning unrelated to this change)
- [x] `yarn generate` ran (events registry refreshed; new `prm.agency_member.reactivated` registered)

### Files added / modified

| File | Change |
|------|--------|
| `src/modules/prm/events.ts` | + `prm.agency_member.reactivated` event declaration |
| `src/modules/prm/lib/agencyMemberService.ts` | + symmetric `reactivated` emit on `is_active` false→true; both events now carry `customerUserId` |
| `src/modules/prm/lib/portalAccessSync.ts` | NEW — shared `revokePortalAccess` / `restorePortalAccess` helpers calling `customerSessionService.revokeAllUserSessions` |
| `src/modules/prm/subscribers/agency-member-portal-access-revoke.ts` | NEW — persistent subscriber on `prm.agency_member.removed` |
| `src/modules/prm/subscribers/agency-member-portal-access-restore.ts` | NEW — persistent subscriber on `prm.agency_member.reactivated` |
| `src/modules/prm/__tests__/agencyMemberService.update.test.ts` | NEW — verifies emit symmetry on isActive transitions |
| `src/modules/prm/__tests__/portalAccessSync.test.ts` | NEW — covers revoke/restore happy paths + idempotency + tenant scope |
| `src/modules/prm/__tests__/portalAccessSubscribers.test.ts` | NEW — verifies subscriber metadata + payload routing |
| `src/modules/prm/backend/prm/agency-members/[id]/confirmDialog.tsx` | NEW — self-contained ConfirmDialog mirroring license-deals pattern |
| `src/modules/prm/backend/prm/agency-members/[id]/page.tsx` | + asymmetric ConfirmDialog gate (only on isActive true→false); + reactivation flash copy |
| `src/modules/prm/frontend/[orgSlug]/portal/members/page.tsx` | + Deactivate/Reactivate per-member buttons (partner_admin only, partner_member rows only); + asymmetric ConfirmDialog; + i18n migration of column headers and state labels |
| `src/modules/prm/i18n/en.json` | + ~20 new keys covering dialog copy, flash messages, action labels, column headers, state labels |
| `.ai/qa/tests/integration/TC-PRM-T0-007-agency-member-deactivation.spec.ts` | NEW — 7 Playwright test cases (IT-DEACT-1..7 + IT-REACT-5) |

## Changelog

| Date | Change |
|------|--------|
| 2026-05-08 | Initial skeleton spec (Open Questions block) |
| 2026-05-08 | Q1-Q4 resolved — accepted Piotr's recommendations: Q1 (b) asymmetric Confirm, Q2 (a) keep partner_admin authority, Q3 (a) forward-only, Q4 (a) keep ACL fused. Phase 3 expanded with mandatory Confirm dialog steps (backend + portal). Phase 6 marked deferred / opt-in. Open Questions section replaced with Resolved Decisions. |
| 2026-05-08 | Phases 1-5 implemented. During pre-flight, the portal members page was found to have no UI consuming the PATCH endpoint. User directed (option A) to add Deactivate/Reactivate per-member buttons, folded into Phase 3. Compliance gates run: typecheck + 656 unit tests + build all green; integration tests written but deferred to PR/QA stage. |
