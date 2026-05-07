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
- **IT-2 — Duplicate GH-profile rejection (L-010)** — 409 with privacy-preserving message; no Agency name leaked (US1.2, US1.5, invariant #5). Owner: QA team. Effort: per-test.
- **IT-3 — Admin-only field 403 from portal** — `PATCH /api/prm/portal/agency/{id}` with `tier` field rejected (US1.3, US2.1, invariant #6). Owner: QA team. Effort: per-test.
- **IT-4 — Lockout recovery (US1.6)** — OMPartnerOps promotes a `partner_member` to `partner_admin` via B2 Members tab. Owner: QA team. Effort: per-test.
- **IT-5 — `status = historical` cascade banner** — `prm.agency.status_changed` propagates to AgencyMember read-model + portal banner (US1.7, Vernon C3). Owner: QA team. Effort: per-test.
- **IT-6 — Re-invite cooldown** — Second invite within 10min returns 429 with `retry_after_seconds` (US1.2). Owner: QA team. Effort: per-test.

### T1 WIP Scoreboard (SPEC-2026-04-23-wip-scoreboard.md §9)

- ~~**IT-9.1 — Register → transition → widget update**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T1-001-prospect-happy-path.spec.ts` (P5 register + P6 transitions qualified→contacted + P2 dashboard aggregate reflects WIP yearly count + tier descriptor).
- **IT-9.2 — Invariant #12 enforcement** — Illegal transition blocked with 409. Owner: QA team. Effort: per-test.
- **IT-9.3 — Invariant #1 (`registered_at` immutability)** — PATCH with `registered_at` rejected. Owner: QA team. Effort: per-test.
- **IT-9.4 — Projection consistency** — `ProspectCandidateIndex` keys match aggregate after edit + soft-delete. Owner: QA team. Effort: per-test.
- **IT-9.5 — Tenant isolation** — Cross-agency Prospect leak blocked. Owner: QA team. Effort: per-test.
- **IT-9.6 — PartnerMember author-scope** — Non-author cannot transition another member's Prospect. Owner: QA team. Effort: per-test.
- **IT-9.7 — Agency `historical` cascade rejection** — POST Prospect on historical agency → 409. Owner: QA team. Effort: per-test.
- **IT-9.8 — Dashboard widgets render correctly** — WIP / WIC / tier widgets with seeded data. Owner: QA team. Effort: per-test.
- **IT-9.9 — Cache invalidation** — *Blocked on the WIC dashboard cache wrapper trigger above.* Cache tag invalidated on transition. Owner: QA team. Effort: per-test.

### T2 Attribution Loop (SPEC-2026-04-23-attribution-loop.md §9)

- ~~**IT-9.1 — Path A happy path → MIN update**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-001-attribution-happy-path.spec.ts` (Path A attribute + Golden Rule default-pick + saga poll for `won` (≤30s, real saga, no stub) + portal MIN aggregate reflects bucketed annual value).
- **IT-9.2 — Golden Rule override with reasoning** — Non-default pick captures reasoning; `attribution_overridden` event fired. Owner: QA team. Effort: per-test.
- **IT-9.3 — Reverse attribution round trip** — LIFO compensation; Prospect reverts to qualified. Owner: QA team. Effort: per-test.
- **IT-9.4 — Path-B hard guard (cross-spec coordination with Spec #6)** — `RfpPathBLockSubscriber` writes `is_path_b_locked = true`; Spec #6 reads + enforces. Owner: QA team (jointly with Spec #6 QA). Effort: per-test.
- **IT-9.5 — Idempotent saga re-fire** — Duplicate `prm.license_deal.attributed` deduped via correlationKey. Owner: QA team. Effort: per-test.
- **IT-9.6 — US4.4b status unreverse gate** — `/unreverse-status` precondition; reverse only succeeds after status walk-back. Owner: QA team. Effort: per-test.
- **IT-9.7 — Churned is terminal** — `/unreverse-status` from `churned` → 409. Owner: QA team. Effort: per-test.

### T5 RFP Broadcast & Response (SPEC-2026-04-23-rfp-broadcast-response.md §9.3-§9.4)

- ~~**TC-PRM-T5-002 — Byte-identical 404 on un-broadcasted RFP**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T5-002-portal-rfp-byte-identical-404.spec.ts` (§9.2 invariant #15).
- ~~**TC-PRM-T5-003 — Submit happy path**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T5-003-portal-rfp-submit-happy-path.spec.ts` (§9.3 P10 happy path).
- ~~**TC-PRM-T5-PERF-001 — Eligibility evaluator at 500 agencies**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T5-PERF-001-eligibility-evaluator-500-agencies.spec.ts` (§9.6 #27).
- **P10 unsubmit (US5.4 step 5)** — Submit → unsubmit flow; response goes back to draft state. Owner: QA team. Effort: per-test.
- **Decline / undecline (US5.5)** — Decline broadcast → undecline; state transitions correct. Owner: QA team. Effort: per-test.
- **`partner_member` author-scope 403** — Non-author cannot edit another member's response. Owner: QA team. Effort: per-test.
