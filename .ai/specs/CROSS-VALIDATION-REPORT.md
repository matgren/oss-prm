# Cross-Validation Report — PRM Functional Specs

Author: Piotr (om-cto Spec Orchestrator)
Date: 2026-04-23
Scope: 7 functional specs decomposed from `app-spec/app-spec.md` (WF1–WF6)

This is Step 3 of the Spec Orchestrator flow. I reviewed the seven specs for: (a) contradictions between specs, (b) coverage gaps, (c) circular dependencies, (d) ordering validity. Findings are categorized and each includes a canonical decision.

---

## 1. Canonical decisions (apply during implementation)

### 1.1 Entity & field naming

| Item | App Spec says | Spec says | Canonical |
|---|---|---|---|
| Prospect FK to AgencyMember | `registered_by_member_id` (§1.4.1) | `registered_by_agency_member_id` (Spec #2) | **Spec** — explicit FK naming (`*_agency_member_id`) aligns with Spec #1's `agency_member` table and is self-documenting. **App Spec §1.4.1 to be corrected post-v1.** |
| CaseStudy client name | `client_public_name` + `client_anonymous_label` (§1.4.1) | `client_name` single column (Spec #7) | **Spec** — two-field representation is premature optimization for anonymization; single field covers 95% cases, anonymization is a v2 concern. App Spec §1.4.1 to be corrected. |
| CaseStudy hero image | `hero_image_url text` (§1.4.1) | `hero_image_attachment_id FK` (Spec #7) | **Spec** — FK to `attachments` enables partition/org/tenant segmentation + route ACL per OQ-011. App Spec §1.4.1 to be corrected. |
| MarketingMaterial field: `type` | `type` (§1.4.1) | `material_type` (Spec #7) | **Spec** — `type` is a reserved-word risk in many ORMs. App Spec §1.4.1 to be corrected. |
| MarketingMaterial visibility values | `all_agencies` / `by_min_tier` (§1.4.1) | `all_partners` / `tier_gated` (Spec #7) | **Spec** — the ubiquitous language in the rest of the App Spec uses "partner" (§1.3) not "agency" for the program-facing term. Consistency win. App Spec §1.4.1 to be corrected. |
| MarketingMaterial publish state | `is_published boolean` (§1.4.1) | `published_at` / `unpublished_at` timestamp pair (Spec #7) | **Spec** — timestamps are auditable, boolean is not. App Spec §1.4.1 to be corrected. |
| MarketingMaterial audiences | `target_audience` string (§1.4.1) | `audiences[]` array (Spec #7) | **Spec** — stories require multi-audience targeting (a material can be for both `new_partner` and `tier_progressing`). App Spec §1.4.1 to be corrected. |

### 1.2 Event naming

| Item | App Spec says | Spec says | Canonical |
|---|---|---|---|
| RFPResponse scored event | `prm.rfp_response.scored` (§1.4.5 line 538) | `prm.rfp_response_score.recorded` (Spec #6) | **Spec** — per Piotr Decision Pattern #9 + AGENTS.md convention `module.singularEntity.whatHappened`, the event names the aggregate that changed. A score row is a `RFPResponseScore`, not a `RFPResponse`. App Spec §1.4.5 line 538 to be corrected. Spec #6 ships both names as aliases for v1; new subscribers bind to `prm.rfp_response_score.recorded`. |
| CaseStudy created event | `prm.case_study.submitted` (§1.4.5) | `prm.case_study.created` (Spec #7) | **Spec** — "created" matches the entity lifecycle verb used uniformly across PRM (`prm.agency.created`, `prm.prospect.registered`, etc.). App Spec §1.4.5 to be corrected. |
| CaseStudy flag event | `prm.case_study.publish_flag_changed` (§1.4.5) | `prm.case_study.publication_flag_changed` (Spec #7) | **Spec** — full-word. App Spec §1.4.5 to be corrected (minor). |

### 1.3 API URL conventions

| Item | App Spec says | Spec says | Canonical |
|---|---|---|---|
| WIC n8n service routes | `/api/prm/wic/github-profiles`, `/api/prm/wic/import` (§1.4.6) | `/api/service/prm/wic/profiles`, `/api/service/prm/wic/imports/{batch_id}` (Spec #4) | **Spec** — Spec #4 introduces a useful three-way convention: `/api/portal/*` (CustomerUser session), `/api/backend/*` (User session), `/api/service/*` (service-identity headers, no session). Batch-id in URL makes idempotency URL-addressable. App Spec §1.4.6 to be corrected to use the `/api/service/prm/wic/*` scheme. |
| WIC rejection enum `profile_not_found` | `unknown_github_profile` (§1.4.6) | Spec #4 deferred to App Spec in persisted enum, uses `profile_not_found` in prose | **App Spec** — persisted enum wins. Spec #4 §1.4.6 test fixture already asserts this. |

### 1.4 Access control (feature) naming

| Item | App Spec says | Spec says | Canonical |
|---|---|---|---|
| Agency admin read/edit features | §1.4.4 uses `prm.agency.read_admin_fields` / `prm.agency.edit_admin_fields`; §2.3 uses `prm.agency.read` / `prm.agency.update` / `prm.agency.update_all` | Spec #1 kept both with aliases | **App Spec needs reconciliation.** Piotr canonical: **use §1.4.4 forms** (`prm.agency.read_admin_fields`, `prm.agency.edit_admin_fields`). They name the specific capability rather than the object + verb. App Spec §2.3 to be corrected post-v1. |

### 1.5 State machines

| Item | Drift | Canonical |
|---|---|---|
| Prospect states | Brief said 4 states (`new`/`qualified`/`won`/`lost`); App Spec §1.4.2 invariant #12 has 6 states (`new`/`qualified`/`contacted`/`won`/`lost`/`dormant`) | **App Spec** — Spec #2 honored App Spec. No edit needed. |
| WIP calculation | Brief said "qualified only"; App Spec §1.4.3 says "NOT IN ('lost')" | **App Spec** — Spec #2 honored App Spec. No edit needed. |
| RFPResponse.status | Brief had 5 values; App Spec uses 2 persisted (`draft`/`submitted`) + 3 derived at query time (`scored`/`selected`/`not_selected`) | **App Spec** — Spec #5 honored App Spec. No edit needed. |
| LicenseDeal status | Brief had `pending/active/signed/invalidated`; App Spec has `pending/signed/active/churned` | **App Spec** — Spec #3 honored App Spec. `invalidated` expressed as `pending + audit event`. No edit needed. |

---

## 2. Cross-spec contracts (must be mirrored)

These items span two or more specs. If they drift, integration fails at merge.

### 2.1 `RFP.is_path_b_locked` read-model field

| Aspect | Owner |
|---|---|
| **Entity & migration** | Spec #5 (`rfp-broadcast-response`) — column is additive on the `rfp` table. |
| **Writer (subscriber)** | Spec #3 (`attribution-loop`) — subscribes to `prm.license_deal.status_changed`; writes `true` when any LicenseDeal with `attribution_path = 'B' AND rfp_id = X AND status = 'signed'` exists; writes `false` otherwise. |
| **Reader & guard** | Spec #6 (`rfp-scoring-selection`) — re-open precondition checks the flag + performs a live defence-in-depth SQL query before committing the transition. |

**Contract assertion text to appear verbatim in §8 of Specs #3, #5, #6:**
> `RFP.is_path_b_locked` (boolean, nullable default NULL, treated as FALSE) is owned by Spec #5's migration. Spec #3's subscriber on `prm.license_deal.status_changed` is the sole writer. Spec #6's re-open action reads the flag AND performs a live defence-in-depth query against `license_deals` before the transition. Contract violations = implementation bug.

### 2.2 `RFP.reopened_deadline_at` column

| Aspect | Owner |
|---|---|
| **Entity & migration** | Spec #6 — additive migration to Spec #5's `rfp` table (nullable column, default NULL). |
| **Writer** | Spec #6 — US5.10 re-open action sets this when transitioning `selected → reopened`. |
| **Reader** | Spec #6 — scheduled job closes challenge round when deadline passes. Spec #5's P10 reads via Spec #6's exposed read contract for UX timing. |

Convention: additive columns from later specs land in later specs' migrations. No reach-back into frozen earlier migrations.

### 2.3 CaseStudy → RFPResponse attachment contract

| Aspect | Source |
|---|---|
| **Picker filter** | Spec #5's P10 (RFPResponse form) queries CaseStudies where `agency_id = current_agency_id AND deleted_at IS NULL`. |
| **Published exclusion** | **NOT applied.** A published CaseStudy is prime evidence for an RFP response. Flagged by Spec #7 as a potential gate question — Piotr decision: **include published case studies in the picker.** Documented in this report. |

### 2.4 Challenge-round event timing

| Aspect | Owner |
|---|---|
| **Trigger** | Spec #6 emits `prm.rfp_response.available_for_revision` when Spec #6's subscriber on `prm.rfp.reopened_for_scoring` resets `RFPResponse.status`. |
| **UX rendering** | Spec #5's P10 renders revise CTA based on this state. |

Integration test coordinated across Specs #5 + #6 — fixture defined once in Spec #5's test suite and reused in Spec #6.

---

## 3. Coverage check

Every App Spec §4 user story maps to exactly one spec:

| Story | Spec |
|---|---|
| US1.1, US1.2, US1.3, US1.4, US1.5, US1.6, US1.7 | #1 agency-foundation |
| US2.1 | #1 agency-foundation |
| US2.2, US2.3, US2.4 | #7 case-studies-marketing |
| US3.1, US3.2, US3.3 | #2 wip-scoreboard |
| US4.1, US4.2, US4.3, US4.4, US4.4b, US4.5 | #3 attribution-loop |
| US5.1, US5.2, US5.3, US5.4, US5.5 | #5 rfp-broadcast-response |
| US5.6, US5.7, US5.8, US5.9, US5.10 | #6 rfp-scoring-selection |
| US6.1, US6.2, US6.4 | #4 wic-ingestion |
| US6.3 | #2 wip-scoreboard |
| US7.1, US7.2 | #7 case-studies-marketing |

**Result:** 36 stories, 36 mappings. No orphans. No duplicates.

Backend pages:

| Page | Spec |
|---|---|
| B1 Agencies list | #1 |
| B2 Agency detail + invite | #1 |
| B3 Cross-agency members read-only | #1 |
| B4 Prospects cross-agency | #2 |
| B5 LicenseDeals + attribution picker | #3 |
| B6 RFPs list | #5 |
| B7 RFP detail — create/publish | #5 |
| B7 RFP detail — scoring widget + selection | #6 |
| B8 CaseStudies with Marketing toggle | #7 |
| B9 MarketingMaterials | #7 |
| B10 WIC Import Issues | #4 |
| B11 RFP Broadcasts audit | #6 |

**Result:** B7 is the only page co-owned by two specs (Spec #5 owns creation-side UI, Spec #6 owns scoring + selection widgets). Clean seam at state transition `published → scoring`.

Portal pages:

| Page | Spec |
|---|---|
| P1 Auth | stock `customer_accounts` (not in any PRM spec) |
| P2 Dashboard | #2 (layout + WIC/WIP/tier widgets) + #3 (MIN widget card contributed to same P2) |
| P3 Agency profile | #1 |
| P4 Members | #1 |
| P5 Prospect list | #2 |
| P6 Prospect detail | #2 |
| P7 Case Studies list | #7 |
| P8 Case Study detail | #7 |
| P9 RFP inbox | #5 |
| P10 RFP response | #5 (read/write draft/submit) + #6 (read challenge-round state) |
| P11 Marketing Library | #7 |
| P12 Notifications | **NOT IN ANY SPEC** — see §4 Gap. |

### Gap: P12 (Notifications portal page)

App Spec §3.5.1 P12 is a thin page (`/{slug}/portal/notifications`) that assembles the shipped `PortalNotificationPanel` + `PortalNotificationBell` primitives (OQ-016 — portal-themed components ship, only page-level route + layout slot is missing). Size: 1 commit.

**Decision:** Add to Spec #1 (agency-foundation) as a Phase-1 addition — the notifications surface is needed from the first CustomerUser session forward (invite acceptance + onboarding notifications surface here). Adjust Spec #1 commit estimate: **8–10 → 9–11** (single commit added).

Alternatively, could land in Spec #5 since most notification types are RFP-related. Rationale for Spec #1: it's identity + portal-shell scoped, ships before notifications have content but must exist as empty-state UX.

**Recommended: ship in Spec #1.** Adjust EXECUTION-PLAN.md accordingly.

---

## 4. Dependency graph validity

```
  #1 agency-foundation (no deps)
      ├── #2 wip-scoreboard          (needs Agency + AgencyMember)
      │     └── #3 attribution-loop  (needs Prospect + ProspectCandidateIndex)
      │           └── #6 rfp-scoring-selection (needs RFP lock flag + LicenseDeal state)
      ├── #4 wic-ingestion           (needs AgencyMember; parallel-safe with #3)
      ├── #5 rfp-broadcast-response  (needs Agency)
      │     └── #6 rfp-scoring-selection (needs RFP/RFPBroadcast/RFPResponse entities)
      └── #7 case-studies-marketing  (needs Agency; soft-dep on #5 for RFP evidence picker)
```

**Ordering validity:** No circular dependencies. Sequential order `1 → 2 → 3 → 4 → 5 → 6 → 7` respects every edge.

**Parallel windows:**
- #3 and #4 are independent after #2 ships.
- #5 can start after #1 (does not wait for #2/#3/#4).
- #7 can start after #1 (soft-dep on #5 only for picker behavior — can ship `agency_id + deleted_at IS NULL` filter first, then add published-or-not refinement when #5's picker lands).

---

## 5. Proxy-gate items (ALL RESOLVED from OM source — see `PROXY-GATE-RESOLUTIONS.md`)

All 5 items verified by OM source read at `/Users/maciejgren/Documents/OM/`. Zero escalations to Mat.

1. **Markdown editor primitive** → **YES ships** at `packages/ui/src/backend/inputs/SwitchableMarkdownInput.tsx`. Specs #5 + #7 import directly.
2. **`createInvitation` transactional participation** → **YES** — `CustomerInvitationService` takes `EntityManager` via constructor DI; PRM can wrap both inserts in one tx. Spec #1 confirmed.
3. **`CustomerUserInvitation.metadata` field** → **NOT NEEDED**. `createInvitation(options: { roleIds: string[] })` stores `roleIdsJson` on the invitation; `acceptInvitation` assigns roles automatically. Spec #1 simplified — subscriber no longer assigns roles.
4. **`customer_accounts` reusable `CustomerUserRole` CrudForm** → **NO** shipped component; APIs ship. Spec #1 keeps the thin wrapper form on B2 (already allocated).
5. **Re-invite cooldown** → **USE `@open-mercato/shared/lib/ratelimit`** (`RateLimiterService.consume`). Spec #1 `last_invite_sent_at` column dropped.

Spec #1 edited inline on 2026-04-23 to reflect Q2/Q3/Q5.

---

## 6. Sizing impact of cross-validation findings

| Finding | Delta |
|---|---|
| P12 added to Spec #1 | +1 commit |
| Markdown editor ships in `packages/ui` (Q1 resolved) | −1 commit on worst-case estimate |
| All other findings | +0 (naming reconciliation or source-verified, no functional change) |

**Revised total sizing:** ~35–43 atomic commits. MVP (Phases 1–3) = ~19–24.

---

## 7. Summary

- **No circular dependencies.**
- **No contradictions left unreconciled** — either the spec deferred to App Spec (good), or Piotr picked the refinement (documented above) and flagged App Spec for correction post-v1.
- **One coverage gap** — P12 portal notifications page; add to Spec #1.
- **5 proxy-gate candidates** — see `PROXY-GATE.md`.
- **App Spec post-v1 correction list** — entity/event naming items in §1.1, §1.2, §1.3, §1.4. None block Patryk's implementation of the specs, because the specs are the contract.
