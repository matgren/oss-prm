# POST-MVP-FOLLOW-UPS

What we owe. Each item: one line. Origin spec. Owner. Estimated effort.
This is the source of truth for follow-up work — when an item ships, delete the line.

## Tracker

All real owed code work has either shipped through Wave 0 (PRs #25, #27, #28, #29, #30, #31) or moved to **Triggers, not debt** below. The Playwright integration-test fleet is tracked in its own section at the bottom — Wave 1 (PRs in flight) is striking those entries as each test lands.

## Triggers, not debt

Items deferred by design. Each names a specific signal that should trigger reviving the work — until that signal fires, this is not owed.

- **WIC dashboard cache wrappers (T1)** — *Trigger:* WIP dashboard p95 > 500ms in production. Dashboard route is hand-rolled portal aggregate; cache attachment hooks live at the CRUD-factory layer. Origin: SPEC-2026-04-23-wip-scoreboard.md §3.1 + §6.2. Effort: M.
- **`tier_requirements` static registry → DB-backed table (T1)** — *Trigger:* first admin requests editable tier requirements. Currently in-code at `src/modules/prm/lib/tierRequirements.ts`. Origin: SPEC-2026-04-23-wip-scoreboard.md §11. Effort: M.
- **`prm.prospect.update` undo (T1/T2)** — *Trigger:* first partner ticket about needing to undo a Prospect edit. Service exposes `revertRegistration` (undo of `register`); `update`-undo requires command-bus before-snapshot capture. Origin: SPEC-2026-04-23-wip-scoreboard.md §4.1. Effort: L.
- **Reverse-path subscriber → JSON `reverse` trigger (T2)** — *Trigger:* OM workflows module ships JSON `reverse` trigger contract. Currently PRM-owned synchronous compensation in `subscribers/license-deal-reversal-compensation.ts`. Origin: SPEC-2026-04-23-attribution-loop.md §11. Effort: M.
- **Bounce-webhook handler (T0)** — *Trigger:* first partner reports they never received an invite (no support tickets in beta to date). v1 relies on 72h TTL expiry + manual re-invite. Origin: SPEC-2026-04-23-agency-foundation.md §11 / OQ-014. Effort: M.
- **Snapshot table for historical MIN (T2)** — *Trigger:* MIN history queries become hot in production. v1 recomputes on read. Origin: SPEC-2026-04-23-attribution-loop.md §Scope (out). Effort: L.
- **Commission calculation / renewal attribution inheritance (T2)** — *Trigger:* v2 product roadmap. v1 ships flat MIN aggregate + renewal flag only. Origin: SPEC-2026-04-23-attribution-loop.md §Scope (out). Effort: L.
- **Spec #5 markdown editor primitive (P10 / P3 / P8)** — *Trigger:* OM `packages/ui` ships a `MarkdownEditor` primitive. Currently uses plain `Textarea` with a "Markdown supported" hint; the read view in P10 already pre-renders user content in a monospace whitespace-pre block. Upgrade is purely additive. Origin: SPEC-2026-04-23-rfp-broadcast-response.md §8.1 R1. Effort: M.
- **Raw `<select>` filters and form fields** — *Trigger:* OM `packages/ui` ships a `Select` primitive. 11 instances across PRM backend + portal pages (`backend/page.tsx`, `backend/prospects/page.tsx`, `backend/license-deals/page.tsx`, `backend/prm/wic-issues/page.tsx`, `frontend/[orgSlug]/portal/prospects/page.tsx`, `frontend/[orgSlug]/portal/agency/page.tsx`). Genuinely blocked — no shipping primitive. Origin: T0/T1/T2/T4. Effort: M.
- **Raw `<input type="month">` filter** — *Trigger:* OM ships a date/month-input primitive. 1 instance at `frontend/[orgSlug]/portal/prospects/page.tsx:278`. Origin: T1. Effort: S.
- **Raw `<input type="radio">` candidate picker** — *Trigger:* OM ships a `Radio`/`RadioGroup` primitive. 1 instance at `backend/license-deals/[id]/page.tsx:331`. Origin: T2. Effort: S.
- **Raw `<table>` lists in portal members / prospects** — *Architectural opt-out (OQ-010), not deferred work.* Portal pages use raw `<table>` by design. Backend members tab could migrate to `DataTable` once a "compact" variant ships, but no action is owed. Origin: T0/T1.

## Performance watchlist

Items here aren't owed work — they're triggers. Add a compound index / cache layer / etc. if and when production observation warrants it.

- **`prm_prospects` `(organization_id, agency_id, status)` compound index** — Trigger: WIP dashboard queries > 500ms in production. Origin: SPEC-2026-04-23-wip-scoreboard.md §5 (single-column indexes shipped instead of the compound index originally drafted).

## Playwright integration tests (deferred — require live Postgres + ESP fixture)

Wave 1 in flight: F1 covers T0 IT-2..6, F2 covers T1 IT-9.2..9.8, F3 covers T2 IT-9.2..9.7, F4 covers T5 §9.3-§9.4 deferred. Each PR strikes its own entries as it lands.

### T0 Agency Foundation (SPEC-2026-04-23-agency-foundation.md §9)

- ~~**IT-1 — Happy path onboarding**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-001-agency-happy-path.spec.ts` (Agency creation + invite + accept seam + cooldown probe + portal /me — covers US1.1, US1.2, US1.4 auth path, US2.1).
- ~~**IT-2 — Duplicate GH-profile rejection (L-010)**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-002-duplicate-github-profile.spec.ts` (cross-Agency invite with same `githubProfile` returns 409 `github_profile_conflict`; verbatim L-010 privacy-preserving message asserted; body string-scanned to confirm Agency-A name/slug/id never leak — US1.2, US1.5, invariant #5).
- ~~**IT-3 — Admin-only field 403 from portal**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-003-admin-only-field-403.spec.ts` (PartnerAdmin `PATCH /api/prm/portal/agency/{id}` with `tier` rejected with 403 `admin_only_field`; `details.fields` includes `tier`; post-PATCH GET proves both editable + admin-only fields are unchanged — US1.3, US2.1, invariant #6).
- ~~**IT-4 — Lockout recovery (US1.6)**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-004-lockout-recovery.spec.ts` (OMPartnerOps `PATCH /api/prm/agency-member/{id}` with `roleSlug: partner_admin` promotes the partner_member; pre-existing partner_admin row unchanged — US1.6).
- ~~**IT-5 — `status = historical` cascade banner**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-005-historical-cascade-banner.spec.ts` (backend PATCH flips Agency.status to `historical`; portal `/me` reflects synchronously; persistent subscriber polled ≤30s for AgencyMember.agencyStatus cascade across both members — US1.7, Vernon C3).
- ~~**IT-6 — Re-invite cooldown**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-006-reinvite-cooldown.spec.ts` (second invite within window → 429 `invite_cooldown_active` + `retryAfterSeconds` + `Retry-After` header; cross-Agency same-email and cross-email same-Agency control axes prove the cooldown key is `(agency_id, lower(email))` — US1.2).

### T1 WIP Scoreboard (SPEC-2026-04-23-wip-scoreboard.md §9)

- ~~**IT-9.1 — Register → transition → widget update**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-001-prospect-happy-path.spec.ts` (P5 register + P6 transitions qualified→contacted + P2 dashboard aggregate reflects WIP yearly count + tier descriptor).
- ~~**IT-9.2 — Invariant #12 enforcement**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-002-invariant-12-illegal-transition.spec.ts` (illegal `new→contacted` and terminal-state `lost→qualified` both return 409 `invalid_transition` with `{ fromStatus, toStatus }` details).
- ~~**IT-9.3 — Invariant #1 (`registered_at` immutability)**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-003-registered-at-immutable.spec.ts` (camelCase + snake_case PATCH smuggling rejected with 400 `registered_at_immutable`; field byte-identical post-attempt).
- ~~**IT-9.4 — Projection consistency**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-004-projection-consistency.spec.ts` (`prm_prospect_candidate_index` normalized keys + `current_status` mirror tracked through register + edit + transition via the B4 keyed-search route).
- ~~**IT-9.5 — Tenant isolation**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-005-tenant-isolation.spec.ts` (cross-agency GET / PATCH transition / PATCH edit all return 404 `prospect_not_found`; portal list never includes the other agency's row).
- ~~**IT-9.6 — PartnerMember author-scope**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-006-partner-member-author-scope.spec.ts` (invariant #12 C4: non-author member transition + edit both 403 `not_author_or_admin`; admin can transition; member can transition own-authored prospect).
- ~~**IT-9.7 — Agency `historical` cascade rejection**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-007-historical-cascade-rejection.spec.ts` (post-historical POST `/api/prm/portal/prospects` returns 409 `agency_historical`).
- ~~**IT-9.8 — Dashboard widgets render correctly**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-008-dashboard-widgets-render.spec.ts` (WIP yearly/monthly/byStatus exclude `lost` per invariant #14; WIC awaiting-shape descriptor; tier descriptor advertises `next` for `om_agency`).
- **IT-9.9 — Cache invalidation** — *Blocked on the WIC dashboard cache wrapper trigger above.* Cache tag invalidated on transition. Owner: QA team. Effort: per-test.

### T2 Attribution Loop (SPEC-2026-04-23-attribution-loop.md §9)

- ~~**IT-9.1 — Path A happy path → MIN update**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-001-attribution-happy-path.spec.ts` (Path A attribute + Golden Rule default-pick + saga poll for `won` (≤30s, real saga, no stub) + portal MIN aggregate reflects bucketed annual value).
- ~~**IT-9.2 — Golden Rule override with reasoning**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-002-golden-rule-override.spec.ts` (two-agency competing-prospect setup + override w/o reasoning rejected 422 ATTRIBUTION_REASONING_REQUIRED + override w/ reasoning fires `attribution_overridden` event + saga walks picked prospect to `won` while default stays `qualified` per OQ-004 + reasoning persisted on aggregate).
- ~~**IT-9.3 — Reverse attribution round trip**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-003-reverse-attribution-roundtrip.spec.ts` (forward attribute → saga walks prospect to `won` → POST `/reverse` → LIFO compensation walks prospect won→qualified within 30s + deal returns to `pending`+`none` + re-attribute round-trips).
- **IT-9.4 — Path-B hard guard (cross-spec coordination with Spec #6)** — Test SHIPPED at `.ai/qa/tests/integration/TC-PRM-T2-004-path-b-hard-guard.spec.ts` but currently `test.fixme()`'d. The `prm:rfp-path-b-lock` subscriber is registered (`.mercato/generated/modules.generated.ts:1038`) and the unit test (`__tests__/rfpPathBLockSubscriber.test.ts`, 5 cases) is green, but the in-process subscriber dispatch never lands the `is_path_b_locked = true` write within 30s of the Path B attribute (verified via Playwright trace). Cross-spec invariant remains covered at the unit-test level for both writer (Spec #3) and reader (Spec #6 `rfpSelectionService.test.ts` "scenario:lockedReopen"). Un-fixme after triaging the runtime subscriber dispatch (likely `createLazyModuleSubscriber` lazy-loader interaction with the wildcard `workflows:event-trigger` in the same emit cycle). Owner: QA team (jointly with Spec #6 QA). Effort: per-test.
- ~~**IT-9.5 — Idempotent saga re-fire**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-005-idempotent-saga-refire.spec.ts` (correlationKey FROZEN shape `<dealId>:prospect` verified + re-attribute on `signed` returns 409 `status_change_not_allowed` + observable invariants: prospect statusChangedAt unchanged, deal version unchanged, MIN ownCount = 1 — no double-counting from re-fire).
- ~~**IT-9.6 — US4.4b status unreverse gate**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-006-unreverse-status-gate.spec.ts` (attribute → forward `signed→active` → `/reverse` returns 409 `attribution_frozen` → `/unreverse-status active→signed` returns 200 → `/reverse` succeeds 202 → compensation walks prospect won→qualified + sanity: pending→pending unreverse rejected 409).
- ~~**IT-9.7 — Churned is terminal**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-007-churned-is-terminal.spec.ts` (attribute → `signed→active→churned` → `/unreverse-status churned→signed` returns 409 `churned_is_terminal` + `/unreverse-status churned→pending` also rejected + `/reverse` returns 409 `attribution_frozen` + fail-closed verification: prospect statusChangedAt unchanged through rejected paths).

### T5 RFP Broadcast & Response (SPEC-2026-04-23-rfp-broadcast-response.md §9.3-§9.4)

- ~~**TC-PRM-T5-002 — Byte-identical 404 on un-broadcasted RFP**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T5-002-portal-rfp-byte-identical-404.spec.ts` (§9.2 invariant #15).
- ~~**TC-PRM-T5-003 — Submit happy path**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T5-003-portal-rfp-submit-happy-path.spec.ts` (§9.3 P10 happy path).
- ~~**TC-PRM-T5-PERF-001 — Eligibility evaluator at 500 agencies**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T5-PERF-001-eligibility-evaluator-500-agencies.spec.ts` (§9.6 #27).
- **P10 unsubmit (US5.4 step 5)** — Submit → unsubmit flow; response goes back to draft state. Owner: QA team. Effort: per-test.
- **Decline / undecline (US5.5)** — Decline broadcast → undecline; state transitions correct. Owner: QA team. Effort: per-test.
- **`partner_member` author-scope 403** — Non-author cannot edit another member's response. Owner: QA team. Effort: per-test.
