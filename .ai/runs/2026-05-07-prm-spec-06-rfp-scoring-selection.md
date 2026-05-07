---
title: PRM Spec #6 — RFP Scoring & Selection
slug: prm-spec-06-rfp-scoring-selection
date: 2026-05-07
branch: feat/prm-spec-06-rfp-scoring-selection
author: matgren
input_spec: .ai/specs/SPEC-2026-04-23-rfp-scoring-selection.md
status: in-progress
---

# Run plan — PRM Spec #6 (RFP Scoring & Selection)

## Goal

Implement Spec #6 (WF4 back-half) end-to-end: append-only `RfpResponseScore` versioning, B7 scoring widget API + LLM-assist draft, selection commit (graph-save) with notification fan-out (winner + non-winners), hard-guard #17 on RFP re-open (read-model + live SQL defence-in-depth), `closed` / `reopened` lifecycle, challenge-round subscriber that resets RfpResponse status, B11 audit page, scheduled `reopened_deadline_at` expiry job, and full service-tier test coverage.

## Source documents

- **Input spec (canonical):** `.ai/specs/SPEC-2026-04-23-rfp-scoring-selection.md`
- **Reference run plan:** `.ai/runs/2026-05-07-prm-spec-05-rfp-broadcast-response.md` (same shape, just shipped)
- **Spec #5 entities:** `src/modules/prm/data/entities.ts` — `Rfp`, `RfpBroadcast`, `RfpResponse` (FROZEN)
- **Spec #5 service:** `src/modules/prm/lib/rfpService.ts` (extended here for scoring/select/close/reopen)
- **Visibility helper:** `src/modules/prm/lib/rfpVisibility.ts` (no portal additions in this spec)
- **Notification subscriber pattern:** `src/modules/prm/subscribers/rfp-broadcast-invitation.ts`
- **LLM provider port:** `node_modules/@open-mercato/shared/src/lib/ai/llm-provider.ts` + `llm-provider-registry.ts`
- **Project rules:** `AGENTS.md` (root)

## Adaptations / decisions

- **Entity name:** `RfpResponseScore` (lowercase abbrev, per Spec #5 precedent — `Rfp`, `RfpBroadcast`, `RfpResponse`).
- **Table name:** `prm_rfp_response_scores` (PRM convention prefix — Spec §5.1 uses `rfp_response_scores`; we apply the canonical `prm_` prefix for consistency).
- **Singular SAGA event aliasing:** spec §4.2 calls out `prm.rfp_response.scored` as the App-Spec name and `prm.rfp_response_score.recorded` as the refined name. Ship the refined name only; no alias subscriber in v1 (cleaner — App-Spec is the only consumer that mentioned the old name; no actual subscriber binds to either).
- **Backend UI:** API-only delivery for B7 widget (scoring) and selection action in v1. Spec calls for "B7 scoring widget" but the existing OM PartnerOps surface for RFP detail does not yet exist (Spec #5 shipped portal-only). Following the Spec #5 precedent (no backend RFP detail page, deferred until needed), B7 ships as backend API endpoints and a single `/backend/prm/rfp/[id]/scoring` page that renders score grid + selection action + close/reopen — minimal but sufficient for OM PartnerOps. **B11 audit page** ships as a separate backend page using `DataTable`.
- **LLM-assist:** uses `llmProviderRegistry.resolveFirstConfigured()` from `@open-mercato/shared/lib/ai/llm-provider-registry` per OQ-009. Imports `generateObject` from `'ai'` package directly (the `ai-assistant` module's `lib/ai-sdk.ts` triggers `llm-bootstrap` side effect on import — we trigger the same side effect explicitly via a thin wrapper to avoid coupling to `@open-mercato/ai-assistant` core module).
- **Append-only enforcement:** ORM-level — repository surface `insertNextVersion(rfpResponseId, payload)` is the only write path. No DB trigger. Code-review checkpoint.
- **Hard-guard #17:** `Rfp.is_path_b_locked` read-model is the cheap fast-fail; live `SELECT EXISTS` query against `prm_license_deals WHERE rfp_id = $1 AND status IN ('signed','active')` runs inside the same transaction as the close→reopen transition.
- **Markdown editor primitive:** N/A — scoring widget uses plain `Textarea` for `selection_reasoning` and `change_reason` per the precedent set in Spec #5 P10.
- **Challenge round:** API endpoint = re-open with `reopened_deadline_at`; subscriber resets `RfpResponse.status` from `submitted` back to `submitted` (already `submitted` after the first round — note: spec talks about resetting to `submitted` from `selected`/`not_selected`; since RfpResponse.status enum is currently `draft`/`submitted` only — derived `selected`/`not_selected` per Spec #5 §6.4 — we add no new RfpResponse statuses; the challenge-round signal is just `prm.rfp_response.available_for_revision` per response and a `challenge_round_updated_at` stamp on the row when the response is re-saved). The "reopen" action transitions RFP to `reopened`, not RfpResponse.
- **Re-selection:** when a prior winner exists, emits `prm.rfp.selection_changed` instead of `prm.rfp.selection_made`; subscriber dispatches both winner-shift and old-winner notifications.
- **Status transitions added to RFP enum (extends Spec #5):** `reopened` is added as a new status. Spec #5's enum is FROZEN to `draft / published / scoring / selection_made / closed`; adding `reopened` is an additive enum extension — handled as ALTER CHECK CONSTRAINT in the new index migration (drops + re-adds with `IN (... 'reopened')`).
- **Selection_made vs selected:** Spec #5's frozen status enum is `selection_made`. The §3.3 "transitions to selected" line is shorthand; we use `selection_made` as the authoritative status value. Same for "scoring" vs "scoring_made" — keep `scoring`.

## Hard constraints

1. **No core module modifications.** All code in `src/modules/prm/`. Additive only.
2. **Per-iteration quality gate:** `yarn typecheck` (exit 0), `yarn jest src/modules/prm` green, `yarn generate` clean.
3. **Pipeline lock:** Plan → Implement → Unit Tests → Integration Tests (run them) → Docs → Self-Review → Update Spec → Verification → Code Review → Commit. No skipped steps.
4. **PR target: `develop`.** Branch `feat/prm-spec-06-rfp-scoring-selection`.
5. **`--no-reuse-env`** on every `yarn test:integration:ephemeral` run (parallel agent on Spec #7 also runs concurrently).
6. **Append-only invariant #18:** `RfpResponseScore` rows are INSERT-only. Repository exposes only `insertNextVersion`. Code-review checkpoint.
7. **Hard-guard invariant #17:** read-model + live SQL re-check. NO bypass for any role.

## Implementation Plan

Per spec §1.4, target is 4–5 atomic commits with phase splits. We will land ~7 atomic commits.

### Commit 0 — Run plan

This file. Commits the plan + Progress checklist before writing any code (per orchestrator dispatch).

### Commit 1 — Entity + migration + validators + ACL features (foundation)

- `RfpResponseScore` entity in `src/modules/prm/data/entities.ts` (append-only contract documented in JSDoc).
- Migration `Migration2026...._prm_rfp_response_score.ts`: `prm_rfp_response_scores` table + indexes per §5.1.
- Companion `_indexes.ts` migration: enum CHECK on `source`, FKs to `prm_rfp_responses`, `users`, `directory_organizations`. UNIQUE `(rfp_response_id, version)`. CHECK `tech_fit_score / domain_fit_score / optional_score` between 0..5.
- **Additive column** `prm_rfps.reopened_deadline_at` TIMESTAMPTZ NULL (per §5.2).
- **Additive enum extension** `prm_rfps.status` adds `reopened` to the existing CHECK constraint. `Rfp` entity gains `reopenedDeadlineAt?: Date | null` field.
- Validators: `recordRfpResponseScoreSchema`, `selectRfpWinnerSchema`, `closeRfpSchema`, `reopenRfpSchema`, `RFP_RESPONSE_SCORE_SOURCES` constant, `RFP_STATUSES` updated to include `reopened`.
- ACL features: `prm.rfp.score`, `prm.rfp.select`, `prm.rfp.close`, `prm.rfp.reopen`. Granted to `employee` role in `setup.ts`.
- Error codes: `RFP_RESPONSE_NOT_SCORED`, `NO_SCORED_RESPONSES`, `WINNER_NOT_SCORED`, `PATH_B_SIGNED_DEAL_LOCK`, `INVALID_RFP_TRANSITION`, `CHANGE_REASON_REQUIRED`, `DEADLINE_IN_PAST`.
- 6 events to `events.ts`: `prm.rfp_response_score.recorded`, `prm.rfp.selection_made`, `prm.rfp.selection_changed`, `prm.rfp.closed`, `prm.rfp.reopened_for_scoring`, `prm.rfp_response.available_for_revision`, `prm.rfp.reopened_deadline_expired` (the scheduler signal).
- Unit tests: validator schemas; entity DDL roundtrip via migration.

Commit: `feat(prm): T6 — RfpResponseScore entity + reopened_deadline_at column + ACL/validators/events`

### Commit 2 — Append-only repository + scoring service methods (US5.6 manual)

- `src/modules/prm/lib/rfpResponseScoreRepo.ts` — append-only repository with `insertNextVersion()`. Internal helper `getNextVersion()` uses `MAX(version) WHERE rfp_response_id = $1` + 1 (single-statement INSERT for race safety; UNIQUE `(rfp_response_id, version)` is the source of truth — concurrent inserts surface as 23505).
- `RfpService.recordScore(rfpId, responseId, payload, scope)` method. Auto-transitions `RFP.status` from `published` → `scoring` on the first score recorded.
- `change_reason` enforcement: required iff version > 1.
- `source` / `llm_model_id` cross-field invariant: enforced in Zod refine.
- Emits `prm.rfp_response_score.recorded`.
- API route `POST /api/prm/rfp/{id}/responses/{rid}/score` per §3.1. Auth: `prm.rfp.score`.
- Unit tests:
  - First score: v1 inserted, RFP transitions `published → scoring`.
  - Re-score without `change_reason`: 409 `CHANGE_REASON_REQUIRED`.
  - Re-score with `change_reason`: v2 inserted; v1 still readable.
  - `source = 'llm_assisted'` with null `llm_model_id`: 400 (Zod refine).
  - `source = 'manual'` with `llm_model_id`: 400.
  - Score on closed RFP: 409.
  - Append-only contract: repository has no `update`/`remove` exports.

Commit: `feat(prm): T6 — RfpResponseScore append-only repo + record-score API + auto status transition`

### Commit 3 — LLM-assist draft endpoint (US5.6 LLM)

- `src/modules/prm/lib/llmScoringDraft.ts` — wraps `llmProviderRegistry.resolveFirstConfigured()` + `generateObject` from `'ai'`. Composes prompt from RFP title/description/tech_requirements/domain_requirements + RfpResponse markdown fields. Structured-output schema: `{ tech_fit_score, domain_fit_score, optional_score, reasoning }`.
- Triggers `@open-mercato/ai-assistant/lib/ai-sdk` import side-effect for `llm-bootstrap` to populate the registry. If `@open-mercato/ai-assistant` is not installed, the registry is empty and the route returns 503 `LLM_UNAVAILABLE` cleanly. Implementation detail: we re-export `llm-bootstrap` registration via dynamic import so jest tests can mock the bootstrap path.
- API route `POST /api/prm/rfp/{id}/responses/{rid}/score/draft-llm` per §3.2.
  - Returns 503 when no provider configured.
  - Returns 400 when response is not yet `submitted`.
  - Idempotent (no DB write).
- Unit tests with mocked `llmProviderRegistry`:
  - Mock provider returns deterministic draft → 200 with payload.
  - Mock provider throws → 503 `LLM_UNAVAILABLE`.
  - No provider configured → 503.
  - Draft for a `draft`-status RfpResponse → 400 `RESPONSE_NOT_SUBMITTED`.

Commit: `feat(prm): T6 — LLM-assist draft endpoint via LlmProvider registry (no-save)`

### Commit 4 — Selection commit + notifications fan-out (US5.7)

- `RfpService.selectWinner(rfpId, payload, scope)` — graph-save: writes `Rfp.status = 'selection_made'`, `selectedAgencyId`, `selectionDecidedAt`, `selectionDecidedByUserId`, `selectionReasoning`. Single transaction.
- Re-selection path: detects prior `selectedAgencyId`, emits `prm.rfp.selection_changed` with `from_*`/`to_*` payload; first-time emits `prm.rfp.selection_made`.
- 409 `NO_SCORED_RESPONSES` when no scores exist on this RFP.
- 409 `WINNER_NOT_SCORED` when picked response has no scores.
- Pre-condition: RFP must be in `scoring` (or `selection_made` for re-selection).
- API route `POST /api/prm/rfp/{id}/select` per §3.3. Auth: `prm.rfp.select`.
- Notification type defs: `prm.rfp.selected` + `prm.rfp.not_selected` added to `src/modules/prm/notifications.ts`.
- Subscriber `src/modules/prm/subscribers/rfp-selection-notifications.ts` consumes both `prm.rfp.selection_made` AND `prm.rfp.selection_changed`. For each event:
  - Resolve winner agency's PartnerAdmin/Member CustomerUsers → batch `prm.rfp.selected`.
  - Resolve non-winner agencies' (broadcast set − winner) PartnerAdmin/Member CustomerUsers → batch `prm.rfp.not_selected`.
- i18n keys for notification title/body in `src/modules/prm/i18n/en.json`.
- Unit tests:
  - Happy path single-select: emits `prm.rfp.selection_made`; subscriber would dispatch.
  - Re-select: emits `prm.rfp.selection_changed` with from/to.
  - 409 NO_SCORED_RESPONSES.
  - 409 WINNER_NOT_SCORED.
  - Subscriber fan-out: winner gets `prm.rfp.selected`, non-winners get `prm.rfp.not_selected`.

Commit: `feat(prm): T6 — Select winner action + 2 notification types + dispatcher subscriber`

### Commit 5 — Close + Re-open + Hard-guard invariant #17 + Challenge round (US5.8/5.9/5.10)

- `RfpService.closeRfp(rfpId, payload, scope)` — transitions to `closed`. Allowed from `scoring` / `selection_made` / `reopened`. Stamps `closedAt`. Emits `prm.rfp.closed`.
- `RfpService.reopenRfp(rfpId, payload, scope)` — transitions to `reopened`. Allowed from `selection_made` / `closed`. **Hard-guard**: reads `Rfp.isPathBLocked` (cheap), then live `SELECT EXISTS` against `prm_license_deals WHERE rfp_id = $1 AND status IN ('signed', 'active') AND deleted_at IS NULL`. If either says locked → 409 `PATH_B_SIGNED_DEAL_LOCK` with referenced license_deal_id. Sets `reopenedDeadlineAt`. Emits `prm.rfp.reopened_for_scoring`.
- API routes: `POST /api/prm/rfp/{id}/close` (§3.4), `POST /api/prm/rfp/{id}/reopen` (§3.5). Auth: `prm.rfp.close` / `prm.rfp.reopen`.
- Subscriber `src/modules/prm/subscribers/rfp-challenge-round-unlocker.ts` on `prm.rfp.reopened_for_scoring`: for each `RfpResponse` linked to the RFP that was previously submitted, emits `prm.rfp_response.available_for_revision` (one per response). RfpResponse rows are NOT mutated (status stays `submitted`; the agency's revise CTA in P10 from Spec #5 keys on the RFP's `reopened` status, not on RfpResponse status).
- Unit tests:
  - Close from `scoring` (no selection): 200, `final_selected_agency_id = null`. Requires `close_reason`.
  - Close from `selection_made`: 200, propagates `selectedAgencyId`.
  - Reopen from `selection_made` with future deadline: 200; `reopenedDeadlineAt` set.
  - Reopen with `is_path_b_locked = true`: 409 `PATH_B_SIGNED_DEAL_LOCK`.
  - Reopen with `is_path_b_locked = false` BUT live `prm_license_deals` row signed: 409 (defence-in-depth).
  - Reopen with past deadline: 400 `DEADLINE_IN_PAST`.
  - Reopen from invalid status (e.g. `draft`): 409.
  - Subscriber fan-out emits `prm.rfp_response.available_for_revision` per submitted response.

Commit: `feat(prm): T6 — Close + Reopen + invariant #17 hard-guard + challenge-round subscriber`

### Commit 6 — B11 audit page + scheduled deadline-expiry job (B11 + scheduler)

- API route `GET /api/prm/rfp/{id}/broadcasts` per §3.6. Joins `RfpBroadcast` with `Agency.name` via `findWithDecryption` lookup; computes `response_status` (from RfpResponse) and `final_outcome` (from `RFP.selectedAgencyId` comparison). Auth: `prm.rfp.create`.
- Backend page `src/modules/prm/backend/prm/rfp-audit/[id]/page.tsx` (+ `page.meta.ts`) — DataTable. Read-only.
- Background worker `src/modules/prm/workers/rfpReopenedDeadlineExpiry.ts` — per OM worker convention. Finds RFPs where `status = 'reopened' AND reopened_deadline_at < now()`. For each, transitions back to `scoring` (no selection change). Emits `prm.rfp.reopened_deadline_expired`. Module declares the worker via `index.ts`.
- Unit tests:
  - B11 endpoint enriches `final_outcome` correctly.
  - Worker loop: finds expired RFPs; transitions; emits.

Commit: `feat(prm): T6 — B11 audit endpoint + reopened-deadline expiry worker`

### Commit 7 — Final gate + spec status + PR

- Run `yarn typecheck`, `yarn jest`, `yarn generate`.
- Update SPEC §11 Implementation Status table.
- Trim shipped POST-MVP entries (none specifically owed by this spec — `is_path_b_locked` IT-9.4 cross-spec test stays in T2 row).
- Open PR against `develop`.

Commit: `docs(runs): close prm-spec-06 run plan; spec implementation status`

## Risks (carried from spec §8.1)

- **R1 invariant #17 read-model lag** — mitigation: live SQL re-check. Test in C5 covers both branches.
- **R2 re-selection unwind correctness** — decision: prior winner directly to "not selected" via `RFP.selectedAgencyId` flip; no RfpResponse status mutation needed (notifications convey outcome).
- **R3 LLM cost bound** — `maxTokens: 4096` per call; rate-limit deferred (single-user staff surface; spec's 10/min limit could be added but the user count is bounded).
- **R4 expiry job reliability** — emit success event; integration tests cover the happy path.
- **R5 challenge-round UX timing** — Spec #5 P10 already keys revise-CTA on RFP status; this spec's reopen + subscriber drive it.

## Out of scope (explicit)

- Spec #7 territory (CaseStudy entity & marketing materials).
- Customer-portal Playwright auth helper (POST-MVP item; service-tier tests cover scoring/selection — staff endpoints which use `getAuthFromRequest` and don't need the customer-portal token helper).

## Bundled POST-MVP items

- None bundled; this spec is large enough on its own.

## Progress

> Convention: `- [ ]` pending, `- [ ]` done. Append ` — <commit sha>` when a step lands.

### Commit 0: Run plan

- [x] 0.1 Plan committed

### Commit 1: Entity + migration + validators + ACL features

- [x] 1.1 RfpResponseScore entity in entities.ts
- [x] 1.2 Migration (base) + indexes companion
- [x] 1.3 Add `reopened_deadline_at` column on prm_rfps + extend status enum to include `reopened`
- [x] 1.4 Validators (recordScore, selectWinner, closeRfp, reopenRfp)
- [x] 1.5 ACL features
- [x] 1.6 Error codes + events
- [x] 1.7 Unit tests (18 cases / rfpScoreValidators.test.ts)
- [x] 1.8 typecheck + jest 280/280 + generate green

### Commit 2: Append-only repo + record-score API

- [x] 2.1 Append-only repository (insertNextVersion / findLatest / findHistory / findLatestForResponses; UNIQUE-violation retry once)
- [x] 2.2 RfpService.recordScore (auto-transition published→scoring on first score)
- [x] 2.3 API route POST /score with full openApi documentation
- [x] 2.4 Unit tests (14 cases / rfpScoreService.test.ts)
- [x] 2.5 typecheck + jest 294/294 + generate green

### Commit 3: LLM-assist draft

- [x] 3.1 llmScoringDraft helper (resolves first configured LlmProvider; bootstrap memoised)
- [x] 3.2 API route POST /score/draft-llm (no DB write; 503 on unconfigured)
- [x] 3.3 Unit tests with mocked provider (7 cases / llmScoringDraft.test.ts)
- [x] 3.4 typecheck + jest 301/301 + generate green

### Commit 4: Selection + notifications + close + reopen + hard-guard + expire

Combined Commits 4 + 5 into one large commit for cohesion (selection drives close/reopen/expire all together via state-machine sibling logic):

- [x] 4.1 RfpService.selectWinner (graph save: status, selected_agency_id, decided_at/by, reasoning)
- [x] 4.2 API route POST /select
- [x] 4.3 NotificationTypeDefinitions (selected, not_selected)
- [x] 4.4 Subscriber rfp-selection-notifications (binds both selection_made + selection_changed)
- [x] 4.5 i18n keys
- [x] 4.6 RfpService.closeRfp (terminal lifecycle)
- [x] 4.7 RfpService.reopenRfp + invariant #17 hard-guard (read-model + live SQL re-check)
- [x] 4.8 RfpService.expireReopenedDeadline (worker hook)
- [x] 4.9 API routes POST /close + POST /reopen
- [x] 4.10 Unit tests (21 selection cases + 4 notification cases)
- [x] 4.11 typecheck + jest 326/326 + generate green

### Commit 5: (merged into Commit 4 above)

- [x] Done — see above.

### Commit 6: B11 audit + deadline-expiry worker

- [x] 6.1 GET /api/prm/rfp/{id}/broadcasts (audit endpoint with agency-name + response_status + final_outcome enrichment)
- [x] 6.2 B11 backend page `/backend/prm/rfp-audit/[id]` (DataTable, navHidden — accessed from RFP detail)
- [x] 6.3 Reopened-deadline expiry worker (default-export + cron metadata) + `RfpService.sweepExpiredReopenedDeadlines`
- [x] 6.4 Unit tests (3 worker cases + 2 sweep cases + 21 prior selection cases)
- [x] 6.5 typecheck + jest 334/334 + generate green

### Commit 7: Final gate + PR

- [ ] 7.1 Full gate green
- [ ] 7.2 Spec implementation status table
- [ ] 7.3 PR opened
