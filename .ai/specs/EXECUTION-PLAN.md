# PRM Implementation — Execution Plan

Author: Piotr (om-cto Spec Orchestrator)
Date: 2026-04-23
Source: `app-spec/app-spec.md` (decomposition-ready per Codex review 2026-04-23)

This is the authoritative implementation order for the 7 functional specs decomposed from the App Spec. If you're Patryk (or any implementer), read this first, then work spec-by-spec in the order below. After each spec: stop, verify, hand off to code-review, merge, next.

---

## Specs (in implementation order)

| # | Spec file | Feature | Depends on | Technical approach (Piotr) | Est. commits |
|---|-----------|---------|------------|---------------------------|--------------|
| 1 | `SPEC-2026-04-23-agency-foundation.md` | WF1: Agency lifecycle + onboarding + member invite + profile + P12 notifications page | — | New PRM module (`packages/prm`) scaffolded via `om-module-scaffold`. UMES-extends `customer_accounts` (invite subscriber, invite email template, ratelimit-backed re-invite cooldown). Dual admin-field enforcement (backend ACL + portal route interceptor). GH-profile global unique (partial index on `is_active`). Role IDs passed via `createInvitation({ roleIds: [...] })` — no metadata/hint table needed. P12 thin notifications page wrapping `PortalNotificationPanel` + `PortalNotificationBell`. | **9–11** |
| 2 | `SPEC-2026-04-23-wip-scoreboard.md` | WF3a: Prospect lifecycle + WIP/WIC/tier/MIN-placeholder dashboard | #1 | Prospect aggregate with 6-state machine (invariant #12) + `ProspectCandidateIndex` projection maintained by subscriber. Portal P5/P6 custom React (no DataTable per OQ-010). P2 dashboard assembles widgets: WIP (NOT IN('lost')), WIC per-member breakdown, tier-progress. Yearly+monthly toggle per L-011. | **6–8** |
| 3 | `SPEC-2026-04-23-attribution-loop.md` | WF3b: LicenseDeal attribution saga (Paths A/B/C + reverse + MIN widget) | #1, #2 | LicenseDeal aggregate + `workflows` module as full saga infrastructure (OQ-017 — largest single OQ win). JSON `WorkflowDefinition` + `WorkflowEventTrigger` + 2–3 activity handlers + LIFO compensation. `correlationKey = license_deal_id + attribution_path` for idempotency. Golden Rule candidate picker (invariant #14) includes `lost` Prospects with badge. Spec #3 subscriber maintains `RFP.is_path_b_locked` (read-model written by #3, migrated by #5, read by #6). | **4–5** |
| 4 | `SPEC-2026-04-23-wic-ingestion.md` | WF5: n8n → WIC import ACL + audit + B10 | #1 (parallelizable with #3) | `/api/service/prm/wic/*` convention (service-identity headers per SPEC-053b/OQ-018: `X-Om-Import-Secret` + `X-Om-Request-Timestamp` ±5min + `X-Om-Idempotency-Key` on POST). `WICContribution` + `WICImportAuditLog`. Anti-Corruption Layer per §1.4.6. Invariant #3 (idempotent supersession) + #13 (attribution snapshot at import). Standard `DataTable` on B10. | **5** |
| 5 | `SPEC-2026-04-23-rfp-broadcast-response.md` | WF4a: RFP create + publish + broadcast + portal inbox + respond + decline | #1 | `RFP` + `RFPBroadcast` + `RFPResponse` entities. State machine invariant #16. Visibility enforced via broadcast join + state gate (invariant #15 — silent 404). Publish handler runs eligibility evaluator → creates `RFPBroadcast` rows → `notifications` module `NotificationTypeDefinition` + subscriber calls `buildBatchNotificationFromType` (1 commit per OQ-015). P10 uses shipped `SwitchableMarkdownInput` (PROXY-GATE-RESOLUTIONS §Q1). Owns `is_path_b_locked` migration. | **3–5** |
| 6 | `SPEC-2026-04-23-rfp-scoring-selection.md` | WF4b: Score + LLM-assist + select + challenge round + close/re-open + B11 audit | #3, #5 | `RFPResponseScore` append-only versioning (invariant #18). B7 scoring widget + "Draft score with AI" button using `ai_assistant` adapter's `LlmProvider.createModel()` (OQ-009 resolved). Selection handler + 2 `NotificationTypeDefinition` seeds (selected/not-selected) + 1 dispatching subscriber. Hard guard invariant #17 on re-open (reads `is_path_b_locked` + live SQL defence-in-depth). `reopened_deadline_at` additive column on Spec #5's RFP table. Challenge-round subscriber resets RFPResponse status. | **4–5** |
| 7 | `SPEC-2026-04-23-case-studies-marketing.md` | WF6 + WF2 partial: CaseStudy + MarketingMaterial + Library + cache | #1, soft-#5 | `CaseStudy` (soft-delete + invariant #8 publish gate) + `MarketingMaterial` (visibility + tier gate). `attachments` module for media (OQ-011 — regular URLs + route ACL, no signed URLs). `dictionaries` module production-ready (OQ-012). P11 library custom React with facets + tier-gated visibility. Per-feature `cache.deleteByTags` subscribers on publish/unpublish/tier-changed (OQ-019). Shared `SwitchableMarkdownInput`. | **5** |

**Totals:** 7 specs · **~35–43 atomic commits** (post-cross-validation). MVP = Specs #1–#3 = **~19–24** commits.

---

## Parallel execution windows

```
          [#1 agency-foundation]
                 │
          ┌──────┼──────┬──────────────────────────┐
          ▼      ▼      ▼                          ▼
      [#2]     [#4]   [#5]                        [#7]
       │       (parallel-safe)                    (soft-dep on #5)
       ▼
      [#3]
       │
       └───► [#6] (also needs #5)
```

- **#3 ∥ #4:** after #2 ships, Patryk can split a team of two.
- **#5 ∥ #7:** after #1 ships, both start independently. #7 picks up CaseStudy→RFP evidence contract when #5 lands.
- **#6 is the last:** needs both #3 (lock writer) and #5 (RFP entity).

**Recommended sequence for a solo implementer (Patryk):** strict order 1 → 2 → 3 → 4 → 5 → 6 → 7. Each spec ships to merge before the next starts. Checkpoint between specs per Piotr's Implementation Orchestrator flow.

---

## Key technical decisions (Piotr)

1. **No core module modifications.** Every spec extends via UMES (subscribers, interceptors, enrichers, widgets). Zero patches to `customer_accounts`, `workflows`, `notifications`, `cache`, `attachments`, `dictionaries`, `auth`, `entities`.
2. **PRM is one module** (`packages/prm`) — not seven. All 12 entities + 39+ events + all backend/portal pages live in the same module. Decomposition into 7 specs is a delivery/review unit, not a module boundary.
3. **Saga = JSON `WorkflowDefinition`.** OQ-017 gives PRM full saga primitives out of the box. No custom orchestrator, no PRM-owned `processed_events` dedupe table.
4. **Notifications, not messages.** OQ-015 — use `NotificationTypeDefinition` + `buildBatchNotificationFromType` everywhere a notification fans out. Messages module is for something else.
5. **Portal pages are custom React.** OQ-010 confirmed — no `DataTable` / `CrudForm` in portal. Backend pages use standard `CrudForm` + `DataTable`.
6. **Invariants are contracts, not code style.** Every invariant (#1 through #18) has a specific enforcement point named in its owning spec. Cross-spec invariant contracts (#17, #8) are mirrored verbatim in all concerned specs — see `CROSS-VALIDATION-REPORT.md` §2.
7. **Append-only over undo** for score versioning (invariant #18). Commands + undo is the default (Piotr Principle #8), but scoring explicitly uses append-only because the business requires version audit history.
8. **BC contract non-negotiable.** No column renames, no event ID changes, no public export removal. Every spec's §7 Backward Compatibility confirms additive-only. App Spec naming drift (see CROSS-VALIDATION-REPORT §1) is an App-Spec-side correction — specs are canonical.

---

## Quality gates (per spec)

Every spec ships through this gate before merge — this is the `om-code-review` scope plus Piotr's standard checks:

1. **Typecheck** clean (`yarn workspace @open-mercato/prm typecheck`).
2. **Unit tests** for every command, subscriber, aggregate state transition, invariant enforcement point.
3. **Integration tests** (Playwright or API-level) per spec's §9 Integration Test Coverage list.
4. **Migration review** — additive only; no DROP/ALTER-COLUMN-TYPE.
5. **AGENTS.md compliance** — naming conventions, event IDs, feature IDs, route paths, DI patterns.
6. **Piotr Decision Library checklist** (Spec §10) — BC / reuse / tests / decentralize / security / scope / extract / commands / convention / necessity.
7. **i18n** — every user-facing string via `useT` / keyed by `titleKey` + `bodyKey`.
8. **Build pass.**

**No merges without all 8 green.**

---

## Handoff artifacts

Under `/Users/maciejgren/Documents/temp-1/specs/`:

- `README.md` — decomposition index + per-spec module list
- `EXECUTION-PLAN.md` — **this document** (implementation order + decisions)
- `CROSS-VALIDATION-REPORT.md` — App Spec drift + cross-spec contract mirroring + coverage check + dependency graph
- `PROXY-GATE-RESOLUTIONS.md` — 5 OM-source-verified resolutions (markdown editor, invite tx, role assignment, CrudForm, ratelimit)
- `SPEC-2026-04-23-agency-foundation.md`
- `SPEC-2026-04-23-wip-scoreboard.md`
- `SPEC-2026-04-23-attribution-loop.md`
- `SPEC-2026-04-23-wic-ingestion.md`
- `SPEC-2026-04-23-rfp-broadcast-response.md`
- `SPEC-2026-04-23-rfp-scoring-selection.md`
- `SPEC-2026-04-23-case-studies-marketing.md`

---

## What Patryk sees next

Patryk consumes these as 7 subspecs, in order:

1. Read `README.md` + `EXECUTION-PLAN.md` + `CROSS-VALIDATION-REPORT.md` + `PROXY-GATE-RESOLUTIONS.md` (≈1 hour — the orchestrator layer).
2. For each spec in order: read Technical Approach (§2), implement per §3–§9, run the quality gate §10, PR, merge, next spec.
3. Between specs, coordinate with the parallel implementer (if #3 ∥ #4 or #5 ∥ #7) on the cross-spec contracts from `CROSS-VALIDATION-REPORT.md` §2.
4. MVP ships at merge of Spec #3. Production beta possible there. Phases 4–6 add the remaining strategic levers.

---

## What Piotr expects

- **No decisions walked back.** Every technical decision in the specs has a rationale in Technical Approach. If implementation finds a decision was wrong, open a scoped PR with the correction, don't silently diverge.
- **App Spec corrections post-v1.** CROSS-VALIDATION-REPORT §1 lists ~10 entity/event naming items where the spec is canonical and App Spec needs a follow-up edit. These don't block implementation. Land them post-v1 ship.
- **OQ-007, OQ-008, OQ-006-v2 remain deferred.** v2 backlog per `app-spec/decisions-log.md` §2.

Best code is code you didn't write. The platform already ships ~80% of what PRM needs — the 7 specs above are the 20% that's actually new.
