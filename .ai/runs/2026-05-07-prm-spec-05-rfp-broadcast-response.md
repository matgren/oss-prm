---
title: PRM Spec #5 — RFP Broadcast & Response
slug: prm-spec-05-rfp-broadcast-response
date: 2026-05-07
branch: feat/prm-spec-05-rfp-broadcast-response
author: matgren
input_spec: .ai/specs/SPEC-2026-04-23-rfp-broadcast-response.md
status: in_progress
---

# Run plan — PRM Spec #5 (RFP Broadcast & Response)

## Goal

Implement Spec #5 (WF4 — RFP Broadcast & Response) end-to-end: backend B7 RFP create/edit/publish, `RFPBroadcast` fan-out via eligibility evaluator, ONE `NotificationTypeDefinition` + ONE subscriber for invitation, portal P9 inbox (custom list — no DataTable per OQ-010), portal P10 detail + draft + submit + decline (the largest single piece of UX in PRM), and full integration test coverage for §9.1–§9.5.

## Source documents

- **Input spec (canonical):** `.ai/specs/SPEC-2026-04-23-rfp-broadcast-response.md` (reconciled 2026-05-05)
- **Execution plan:** `.ai/specs/EXECUTION-PLAN.md` row #5 — depends only on Spec #1, parallelizable with #7.
- **Project rules:** `AGENTS.md` (root), `.ai/skills/implement-spec/SKILL.md`
- **Reference run plan (same shape):** `.ai/runs/2026-05-06-prm-spec-04-wic-ingestion.md` (Spec #4 — same iteration cadence, same test gate format)
- **Cross-spec contract:** `RFP.is_path_b_locked` is read-model; this spec declares the column with default `false`. Spec #3 (already shipped) writes via `RfpPathBLockSubscriber`. Spec #6 (not yet built) reads the value.

## External References

None — Piotr's dispatch passed no `--skill-url`.

## Hard constraints

1. **No core module modifications.** All code in `src/modules/prm/`. Additive only.
2. **Migration discipline:** PRM-scoped only; verify only `prm_rfps`, `prm_rfp_broadcasts`, `prm_rfp_responses` are touched. Companion `_indexes` migration for partial-uniques and CHECKs (mirrors Spec #4 pattern).
3. **Per-iteration quality gate:** `yarn typecheck` (exit 0), `yarn jest src/modules/prm` green, `yarn generate` clean. UI iterations also run `yarn build`.
4. **Pipeline lock (orchestrator dispatch):** Plan → Implement → Unit Tests → Integration Tests (run them) → Docs → Self-Review → Update Spec → Verification → Code Review → Commit. No skipped steps.
5. **PR target: `develop`.** Branch off `origin/develop` (not main). Spec #5's only dep (Spec #1) is already on develop.
6. **Visibility gate (invariant #15) is load-bearing.** All portal RFP routes call a shared `assertBroadcastedOrNotFound(rfpId, agencyId, em)` helper that throws `NotFoundError`, never `AccessDeniedError`. 404 body byte-identical to a fake-UUID 404. Code-review gate.

## Adaptations from spec text (will be documented inline as they land)

The spec §2.1 already captures most reconciliations (App-Spec column names win over the Technical Approach's tri-field shape: `tech_experience` / `domain_experience` / `differentiators`, `submitted_by_member_id`, `eligibility_filter` enum + companions). Only OM-convention deviations are documented inline:

- **Table prefix `prm_`** on all three tables (matches `prm_agencies` / `prm_prospects` / `prm_license_deals`).
- **Entity class names singular per OM Singularity Law:** `Rfp`, `RfpBroadcast`, `RfpResponse` (lowercase-after-prefix consistent with `Wic*` from Spec #4 to avoid query-index reindexer crashes).
- **`Wic*` casing precedent:** if the singular reads weirdly (e.g. `Rfp` is uppercase abbreviation by convention), prefer the lowercase form to match the precedent set in Spec #4 (`WicContribution` not `WICContribution`). Decision: ship as `Rfp` (PR-T3 used `Wic`; the same lowercase rule applies for both because the query-index uses snake_case-to-table-name lookups).

## Implementation Plan

Per spec §10, target is 4–5 commits with P10 split into 5 sub-commits, total ~10. Ordered for incremental verifiability (each commit ships a working slice).

### Commit 1 — Entities + backend B7 + publish handler + notification seed (US5.1 + US5.2)

- Migration `Migration2026...._prm_rfp.ts`: `prm_rfps`, `prm_rfp_broadcasts`, `prm_rfp_responses` per §5.1–5.3.
- Companion `_indexes.ts` migration: enum CHECKs (`status`, `eligibility_filter`); UNIQUE `(rfp_id, agency_id)` on broadcasts + responses; FKs to `prm_agencies`/`prm_agency_members`/`directory_organizations`; perf indexes per §5 footers.
- Entities `Rfp` / `RfpBroadcast` / `RfpResponse` in `src/modules/prm/data/entities.ts`.
- Validators (`createRfpDraftSchema`, `updateRfpDraftSchema`, `publishRfpSchema`, `draftRfpResponseSchema`) in `src/modules/prm/data/validators.ts` per §3.1 / §3.2.
- ACL features: `prm.rfp.create`, `prm.rfp.publish`. Granted to OM PartnerOps (`employee` + `admin`) in `setup.ts`.
- Service `RfpService` in `src/modules/prm/lib/rfpService.ts` (DI-registered with `.proxy()`):
  - `createDraft`, `updateDraft`, `publish`, `unpublish` methods.
  - Pure-function `evaluateEligibility(filter, agencies)` extracted as `lib/rfpEligibility.ts` for unit-testability + perf isolation per R2.
- Routes: `src/modules/prm/api/rfp/route.ts` (GET list + POST create), `[id]/route.ts` (GET detail + PATCH update), `[id]/publish/route.ts` + `[id]/unpublish/route.ts`. All require `prm.rfp.create` / `prm.rfp.publish` ACL.
- Notifications: `src/modules/prm/notifications.ts` declares `prm.rfp.broadcast_invitation` `NotificationTypeDefinition`. Subscriber at `src/modules/prm/subscribers/rfp-broadcast-invitation.ts` consumes `prm.rfp.published`, expands to PartnerAdmin + PartnerMember CustomerUsers, calls `buildBatchNotificationFromType`.
- 6 events added to `events.ts`: `prm.rfp.created`, `prm.rfp.updated`, `prm.rfp.published`, `prm.rfp.unpublished`, `prm.rfp_broadcast.created`, `prm.rfp_broadcast.first_opened` (used by C2 — declared here).
- Unit tests: eligibility evaluator (8+ cases), service-level happy paths, ACL guard rails.
- Integration tests §9.1 (#1–#6) — Playwright TC-PRM-T5-001-rfp-publish-happy-path.spec.ts.
- Bundled POST-MVP: **DI proxy guardrail test** — adds `src/modules/prm/__tests__/diProxyGuardrail.test.ts` scanning every `src/modules/*/di.ts` and asserting `asFunction(({ ... }) => ...)` chains `.proxy()`. Cite POST-MVP-FOLLOW-UPS Tracker entry.

Commit: `feat(prm): T5 — RFP entities, backend B7, publish handler, notification seed`

### Commit 2 — P9 portal inbox (US5.3)

- `src/modules/prm/api/portal/rfp/route.ts` (GET inbox list with tab filtering).
- `src/modules/prm/api/portal/rfp/[id]/route.ts` (GET detail — stamps `first_opened_at` side-effect on first call; emits `prm.rfp_broadcast.first_opened`).
- Shared visibility helper `src/modules/prm/lib/rfpVisibility.ts` exporting `assertBroadcastedOrNotFound`. **Code-review checkpoint:** every portal route MUST call this helper; static grep gate in the test suite.
- Portal page `src/modules/prm/frontend/[orgSlug]/portal/rfp/page.tsx` — custom React list (no DataTable), filter tabs (Unread/Responded/Declined/All), empty states.
- Side-effect: `first_opened_at` stamped exactly once per `(rfp_id, agency_id)`; second GET is a no-op (idempotent).
- Integration tests §9.2 (#7–#10) including byte-identical 404-body assertion (R3 mitigation).

Commit: `feat(prm): T5 — P9 portal inbox + visibility gate (silent 404)`

### Commit 3a — P10 scaffold + read brief + decline button stub (read-only slice)

- Portal page `src/modules/prm/frontend/[orgSlug]/portal/rfp/[id]/page.tsx` — initial scaffold:
  - Renders RFP title, received_from, received_at, description, requirements (tech/domain), budget/timeline buckets, capabilities, deadline.
  - Status-aware CTAs (no buttons enabled yet — wired in 3b/3c/3e).
  - Decline button visible but `onClick` is a stub (wired in C4).
- Integration test: "RFP brief renders; respond/decline CTAs disabled when status=scoring."

Commit: `feat(prm): T5 — P10 scaffold + read RFP brief (US5.4 step 1/5)`

### Commit 3b — P10 markdown editors + draft auto-save (US5.4)

- Three markdown editors for `tech_experience` / `domain_experience` / `differentiators`.
  - **R1 / Commit 5 decision:** check if `@open-mercato/ui` ships a markdown primitive. If yes (`Step 4.5 proxy gate`), use it. If no, ship a thin wrapper at `node_modules/@open-mercato/ui/...` is untouchable (we live in standalone-app); host the wrapper in `src/modules/prm/lib/markdownEditor.tsx` and document as deviation. (Spec's preferred location is `packages/ui` but we don't own that.)
- Draft POST `src/modules/prm/api/portal/rfp/[id]/response/draft/route.ts` — upsert by `(rfp_id, agency_id)`.
- Auto-save: 500ms debounce client-side; rate-limit 4 req/s server-side per CustomerUser (R7).
- Server emits `prm.rfp_response.draft_saved` only on content-hash change (R7 dedupe).
- Integration test §9.3 #11.

Commit: `feat(prm): T5 — P10 markdown editors + draft auto-save (US5.4 step 2/5)`

### Commit 3c — P10 CaseStudy picker + cross-Agency reject (US5.4)

- `GET /api/prm/portal/case-study` stub (Spec #7's surface — for v1, ship a v0 read-only that lists own-Agency CaseStudies if Spec #7 hasn't shipped yet; otherwise reuse Spec #7's route).
- Picker UI on P10: checkbox list of own-Agency CaseStudies, max 5 (per AppSpec).
- Server-side validation: every `attached_case_study_ids[i]` resolves to a CaseStudy with `agency_id = current_agency_id`; cross-Agency → 400.
- Integration test §9.3 #14.

**Open question for this commit:** Spec #7 (CaseStudy) hasn't shipped. Two options: (a) stub a `prm_case_studies` table with a placeholder for the picker; (b) defer the CaseStudy picker entirely to a follow-up bundled with Spec #7. Decision deferred to commit-3c-time pre-flight; default is (b) to keep this PR scoped.

Commit: `feat(prm): T5 — P10 CaseStudy picker + cross-Agency reject (US5.4 step 3/5)`

### Commit 3d — P10 submit + unsubmit (US5.4)

- `SubmitRFPResponseCommand` + `UnsubmitRFPResponseCommand` per §4.1.
- Routes: `[id]/response/submit/route.ts` + `[id]/response/unsubmit/route.ts`.
- Submit guards: required fields populated; `RFP.status = published` (not `scoring` — challenge round is Spec #6); not past deadline; PartnerMember author-scope check (M1's draft, M2's submit → 403).
- Unsubmit guards: `RFP.status = published` AND not past deadline.
- P10 form lock state machine (read-only after submit unless RFP.status = reopened — Spec #6).
- Integration tests §9.3 #12, #13, #15, #16, #17, #18.

Commit: `feat(prm): T5 — P10 submit + unsubmit + author-scope guards (US5.4 step 4/5)`

### Commit 4 — Decline flow (US5.5)

- `DeclineRFPBroadcastCommand` + `UndeclineRFPBroadcastCommand`.
- Routes `[id]/decline/route.ts` + `[id]/undecline/route.ts`.
- P10 decline panel: textarea (optional reason) + confirm button. After decline, P10 transitions to "You declined this RFP" state.
- ACL: PartnerAdmin only (per §6.2).
- Integration tests §9.4 #20–#23.
- **Bundled POST-MVP if applicable:** if Spec #6's `is_path_b_locked` reading is exercisable in #23 (decline-after-scoring 409), ensure the test stub mocks Spec #6's transition cleanly.

Commit: `feat(prm): T5 — P10 decline flow + PartnerAdmin-only gate (US5.5)`

### Commit 5 — Final verification + spec status + PR

- Run full gate: `yarn typecheck`, `yarn jest`, `yarn test:integration:ephemeral` (with `OM_PRM_WIC_IMPORT_SECRET` exported — leftover requirement from Spec #4 for the runner).
- Update SPEC §Implementation Status table.
- Trim shipped items from `POST-MVP-FOLLOW-UPS.md` (DI guardrail test).
- Open PR against `develop`.

Commit: `docs(runs): close prm-spec-05 run plan; spec implementation status; trim POST-MVP`

## Risks (carried from spec §8.1)

- **R1 markdown editor:** decided at C3b time per proxy gate — see notes above.
- **R2 eligibility evaluator perf:** pure function in `lib/rfpEligibility.ts`; perf smoke test §9.6 #27 in C1 (or deferred to C5 if it slows the iteration).
- **R3 visibility 404 leakage:** mandatory `assertBroadcastedOrNotFound` helper + byte-identical 404-body integration test.
- **R4 P10 size:** split into 5 sub-commits per spec §10.
- **R5 deactivated AgencyMember name:** UX-only — render with `(deactivated)` suffix; no migration.
- **R6 undo-publish with partial opens:** `UnpublishRFPCommand` refuses if any broadcast has `first_opened_at`/`declined_at` or any `RFPResponse`. Tested in §9.1 #6.
- **R7 auto-save storm:** 4 req/s rate limit + content-hash dedupe on `draft_saved` events.

## Out of scope (explicit)

- Spec #6 territory: `RFPResponseScore`, scoring widget, LLM-assist, selection action, challenge round, B11 audit, `closed`/`reopened` transitions.
- Spec #7 territory: full CaseStudy entity (this spec depends on a stub or defers the picker — see C3c).
- Markdown editor primitive in `@open-mercato/ui` itself (we live in standalone-app; can't modify node_modules).
- WIC-related work (PR #4 is in flight on a parallel branch).

## Bundled POST-MVP items (will trim from FOLLOW-UPS as they ship)

- **DI proxy guardrail test** (C1) — Effort=S; cheap; prevents PR #1 regression.
- **Cache invalidator subscribers (T0 Agency)** — only if RFP publish handler touches the agency cache or there's a natural overlap. Default: skip; document why if not bundled.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Commit 1: Entities + backend B7 + publish + notification seed

- [x] 1.1 Entities (Rfp, RfpBroadcast, RfpResponse) — foundation commit
- [x] 1.2 Migration (base + `_indexes` companion) — foundation commit
- [x] 1.3 Validators — foundation commit
- [x] 1.4 ACL features (prm.rfp.create, prm.rfp.publish) — foundation commit
- [x] 1.5 RfpService + eligibility evaluator (lib/rfpEligibility.ts pure-function)
- [x] 1.6 Backend routes (CRUD + publish/unpublish)
- [x] 1.7 NotificationTypeDefinition + subscriber (rfp-broadcast-invitation)
- [x] 1.8 11 events added to events.ts (over-delivered — includes broadcast.first_opened/declined/undeclined and rfp_response.* used in C2/C3/C4)
- [x] 1.9 Unit tests — rfpEligibility 14/14 + rfpService 12/12 (jest 161/161 across 20 suites)
- [x] 1.10 Integration tests §9.1 (Playwright) — TC-PRM-T5-001 covers #1, #2, #3, #5; #4 (DB-error injection) + #6 (needs C2 first_open stamp) deferred
- [x] 1.11 DI proxy guardrail test (POST-MVP bundled) — 8710362
- [x] 1.12 typecheck + jest 161/161 + generate green

### Commit 2: P9 portal inbox

- [x] 2.1 Visibility helper assertBroadcastedOrNotFound — silent-404 helper + RfpVisibilityNotFoundError + rfpNotFoundResponse
- [x] 2.2 Portal API routes (list + detail) — list with tab filter; detail stamps first_opened_at idempotently via RfpService.markBroadcastFirstOpened
- [ ] 2.3 Portal page (custom React list)
- [ ] 2.4 Integration tests §9.2 (byte-identical 404) — gated on customer-portal Playwright auth helper (carry-over from Spec #4 fixtures.ts comment)

### Commits 3a-3d: P10

- [ ] 3a Scaffold + read brief
- [ ] 3b Markdown editors + draft auto-save
- [ ] 3c CaseStudy picker (or defer if Spec #7 unshipped)
- [ ] 3d Submit + unsubmit

### Commit 4: Decline flow

- [ ] 4.1 Decline + undecline commands + routes
- [ ] 4.2 P10 decline panel
- [ ] 4.3 Integration tests §9.4

### Commit 5: Final gate + PR

- [ ] 5.1 Full gate green
- [ ] 5.2 Spec implementation status table
- [ ] 5.3 POST-MVP-FOLLOW-UPS trimmed
- [ ] 5.4 PR opened
