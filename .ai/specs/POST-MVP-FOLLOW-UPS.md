# POST-MVP-FOLLOW-UPS

What we owe. Each item: one line. Origin spec. Owner. Estimated effort.
This is the source of truth for follow-up work — when an item ships, delete the line.

## Tracker

- **Drop `customers` core-module dependency from PRM standalone** — `customers` is enabled in `src/modules.ts` *only* to satisfy `@open-mercato/cli` `mercato test:integration` readiness probe at `GET /api/customers/people`. Side effects: 19 backend routes in admin nav, 5 additive migrations, dictionary/currency/pipeline seed on next tenant init, default `customers.*` ACL grants on admin role. Two paths to remove: (a) ship a PRM-owned stub `/api/customers/people` route (mirrors core's response shape — risk: shape drift on core upgrade), or (b) upstream a configurable `OM_TEST_READINESS_URL` to `@open-mercato/cli`. Origin: `.ai/runs/2026-05-06-t0-002-review.md` M2 (chose A). Owner: TBD. Effort: S (a) / M (b).
- **Cache invalidator subscribers (T0 Agency)** — `prm:agency:list:tenant:{id}`, `prm:agency:{id}`, `prm:portal:agency:{id}:status_banner` declared in spec but not wired in shipped T0. Origin: SPEC-2026-04-23-agency-foundation.md §3.1.2-§3.1.4. Owner: TBD. Effort: M.
- **WIC dashboard cache wrappers (T1)** — Dashboard route is hand-rolled portal aggregate; cache attachment hooks live at the CRUD-factory layer. Deferred until traffic justifies a custom wrapper. Origin: SPEC-2026-04-23-wip-scoreboard.md §3.1 + §6.2. Owner: TBD. Effort: M.
- **`tier_requirements` static registry → DB-backed table (T1)** — Currently in-code at `src/modules/prm/lib/tierRequirements.ts`; promote to seeded DB table when business needs admin-editable values. Origin: SPEC-2026-04-23-wip-scoreboard.md §11 (T1 changelog). Owner: TBD. Effort: M.
- **Saga retry dashboard wiring (T2)** — Workflows module ships `/backend/workflows/instances/{id}` covering retry/cancel; verify the page handles PRM saga instances and link from B5 detail. Origin: SPEC-2026-04-23-attribution-loop.md §8.1. Owner: TBD. Effort: S.
- **`prm.prospect.update` undo (T1/T2)** — Service exposes `revertRegistration` (undo of `register`); `update`-undo requires command-bus before-snapshot capture. Origin: SPEC-2026-04-23-wip-scoreboard.md §4.1. Owner: TBD. Effort: L.
- **Reverse-path subscriber → JSON `reverse` trigger (T2)** — Currently PRM-owned synchronous compensation in `subscribers/license-deal-reversal-compensation.ts`. Migrate when workflows module ships JSON `reverse` trigger contract. Origin: SPEC-2026-04-23-attribution-loop.md §11. Owner: TBD. Effort: M.
- **Bounce-webhook handler (T0)** — OQ-014 deferred to v2; v1 relies on 72h TTL expiry + manual re-invite. Origin: SPEC-2026-04-23-agency-foundation.md §11. Owner: TBD. Effort: M.
- **Snapshot table for historical MIN (T2)** — v1 recomputes on read; v2 concern when MIN history queries become hot. Origin: SPEC-2026-04-23-attribution-loop.md §Scope (out). Owner: TBD. Effort: L.
- **Commission calculation / renewal attribution inheritance (T2)** — v2 backlog; v1 ships flat MIN aggregate + renewal flag only. Origin: SPEC-2026-04-23-attribution-loop.md §Scope (out). Owner: TBD. Effort: L.
- **Unit-test coverage for the two PR #1 resume bugs (T0 Agency)** — Add tests that (a) construct `agencyService` via the real DI container (not the `FakeEntityManager`) and verify `em` is injected, and (b) verify `Agency.organizationId` matches the persisted Organization's id end-to-end. The `FakeEntityManager` auto-assigns ids on `create()`, which is why both bugs (DI resolution + pre-flush `.id` undefined) were missed by jest. Origin: PR #1 om-code-review Medium #3. Owner: TBD. Effort: M.
- **Migrate deferred portal Playwright tests onto the new auth helper** — Base helper SHIPPED in PR-A: `src/modules/prm/testing/integration/customerAuth.ts` exposes `loginCustomer`, `customerApiRequest({ customerToken })`, and `bootPartnerAgencyWithMembers(...)`. The test-only seam `POST /api/prm/test-fixtures/agency-member-link` (gated by `OM_PRM_TEST_FIXTURES_ENABLED=1`) bypasses the partner-invite/email/accept dance for fixtures. Demo Playwright tests at `.ai/qa/tests/integration/TC-PRM-T5-002-portal-rfp-byte-identical-404.spec.ts` (§9.2 invariant #15) and `TC-PRM-T5-003-portal-rfp-submit-happy-path.spec.ts` (§9.3 P10 happy path) prove the helper end-to-end. **Remaining** — convert the still-deferred cases that previously dead-ended on the auth helper: T5 §9.3 P10 unsubmit (US5.4 step 5), T5 §9.4 decline / undecline (US5.5), partner_member author-scope 403, T0 IT-1/IT-3/IT-4/IT-5 portal flows, T1 IT-9.1/9.5/9.6 portal flows. Each is a small per-test conversion now that the boot fixture is wired. Origin: PR-A "Customer-portal Playwright auth helper". Owner: QA team. Effort: per-test (S each).
- **Spec #5 markdown editor primitive (P10 / P3 / P8)** — `packages/ui` does not ship a markdown editor in this OM version; Spec #5 currently uses plain `Textarea` with a "Markdown supported" hint (the read view in P10 already pre-renders user content in a monospace whitespace-pre block). Promote to a real editor (`@uiw/react-md-editor` or similar) when an OM primitive lands; the upgrade is purely additive — same field shapes, same draft route. Origin: SPEC-2026-04-23-rfp-broadcast-response.md §8.1 R1. Owner: TBD. Effort: M.
- **Spec #5 §9.6 perf smoke (eligibility evaluator at 500 agencies)** — Pure-function evaluator currently has unit-level coverage at 14 cases. Add a Postgres-backed perf smoke once we have a 500-agency seed fixture in place. Origin: SPEC-2026-04-23-rfp-broadcast-response.md §9.6 #27 + §8.1 R2. Owner: TBD. Effort: S.
- **PRM portal organizationId mismatch (T0 + T5 cross-cutting)** — Surfaced by the §9 IT-1 / IT-9.1 happy-path smokes (PR `feat/prm-t0-t1-t2-happy-path-smokes`). PRM creates one Organization per Agency (`agencyService.createAgencyWithOrganization`), so a real partner accepted via `CustomerInvitationService.acceptInvitation` lives in the *agency's* org. But several portal routes scope reads by `auth.orgId` (e.g., the `assertBroadcastedOrNotFound` lookup against `Rfp.organizationId` and the `agency.organizationId === auth.orgId` guard in `PATCH /api/prm/portal/agency/[id]/member/[memberId]`). RFPs are seeded by staff (in the staff org), so the customer-org-vs-RFP-org match relies on the seam keeping the customer in the staff org — which is the opposite of production. The test seam (`POST /api/prm/test-fixtures/agency-member-link`) currently leaves the customer in the staff org so T5-002/T5-003 stay green; the trade-off is that T0-001's profile-fill leg and any future cross-org portal smoke is deferred. Fix: scope portal RFP visibility by `tenantId + broadcast.agencyId` (drop the org filter on the central RFP table), and migrate the customer to the agency's org in the seam. ~~25-40 LOC across 2-3 routes + the seam~~. Origin: TC-PRM-T0-001 commit chain. Owner: TBD. Effort: M.
- **Test isolation for `.ai/qa/tests/integration/`** — Agencies (and other PRM rows) leak across spec files because there is no per-test reset hook. Currently masked because most specs use unique slugs / suffix-derived names, but TC-PRM-T5-001 §9.1 #1 fails in full-suite runs (passes in isolation) once a previous spec has seeded an Agency that the by_min_tier evaluator picks up. Fix: add a Playwright `beforeEach` (or `globalSetup` per worker) that truncates PRM tables / wraps each test in a transaction-rollback boundary. Surfaced by the post-mvp-beta-t3 final-test gate. Origin: TC-PRM-T5-001 fix run plan. Owner: QA team. Effort: M.
- **Integration runner needs `.env` documentation** — `OM_PRM_TEST_FIXTURES_ENABLED=1` and `OM_PRM_WIC_IMPORT_SECRET=...` are present in `.env.example` (commented-out) but the AGENTS.md "Key Commands" section does not call them out as required for `yarn test:integration:ephemeral`. Without them the runner returns 13 of 26 tests as "404" / "WIC import secret not configured", which masks real bugs. Fix: add a short paragraph to AGENTS.md (and ideally a `.env.test.example` template) documenting which env vars must be set for the integration runner. Surfaced by the post-mvp-beta-t3 final-test gate. Origin: TC-PRM-T5-001 fix run plan. Owner: TBD. Effort: S.
- **Audit non-PRM modules for the same dual-loaded `instanceof` bug pattern** — TC-PRM-T5-001 §9.1 #3 surfaced that under Next.js Turbopack production bundling the service-side and route-side chunks each receive their own copy of a domain-error class, which makes `err instanceof DomainError` return `false` and lets the route fall through to a bare 500. PRM was migrated to tag-based guards (`isPrmDomainError`, `isRfpVisibilityNotFoundError`) for both of its module-defined Error classes during PR #19. Other modules (e.g. agency-attached enrichers, customer-attached subscribers, any module-defined error classes) may still have the same latent bug. Audit: `grep -rn "instanceof.*Error" src/modules/` and convert any catch-block uses to the same name-based pattern. Origin: PR `fix/prm-fix-publish-zero-eligible-500`. Owner: TBD. Effort: M.

## Performance watchlist

Items here aren't owed work — they're triggers. Add a compound index / cache layer / etc. if and when production observation warrants it.

- **`prm_prospects` `(organization_id, agency_id, status)` compound index** — Trigger: WIP dashboard queries > 500ms in production. Origin: SPEC-2026-04-23-wip-scoreboard.md §5 (single-column indexes shipped instead of the compound index originally drafted).

## Design system follow-ups

Items here are cosmetic DS-compliance gaps (color tokens, text sizes, spacing). Bundle with adjacent UI work; not worth standalone fix commits.

> **Tracker correction (2026-05-07).** Several DS items previously claimed `Alert`,
> `StatusBadge`, `PortalEmptyState`, and `--status-warning/error/success-*` tokens
> were unavailable in this OM version. They are NOT — the primitives ship at
> `node_modules/@open-mercato/ui/src/primitives/{alert,status-badge}.tsx` and
> `node_modules/@open-mercato/ui/src/portal/components/PortalEmptyState.tsx`,
> and the semantic CSS variables live in `src/app/globals.css`. The PRM
> partner-portal sites that depended on those primitives were migrated in
> `feat/prm-portal-ds-migration` (DS Guardian audit follow-up) — the trigger
> was a real dark-mode UX regression: the app toggles `.dark` from a cookie
> at `src/app/layout.tsx:40`, and the legacy hand-rolled `bg-amber-50
> text-amber-900` banners had no `dark:` overrides, so they rendered
> illegibly for any partner using dark mode. Items below are the genuinely
> blocked ones (no shipping primitive in OM 0.4.x) and the out-of-scope ones
> (backend pages — not part of the portal-only PR) — bundle with the next
> backend / DS pass.

- **Hardcoded amber banner palette in BACKEND license-deals page** — `border-amber-300 bg-amber-50 text-amber-900` at `src/modules/prm/backend/license-deals/[id]/page.tsx:312`. The four PORTAL instances were migrated to `<Alert variant="warning">` in `feat/prm-portal-ds-migration`. The remaining backend instance can adopt the same primitive — Alert and the warning tokens both ship today. Origin: T2. Effort: S.
- **Hardcoded red LOST badge** — `bg-red-100 text-red-700` on the candidate "LOST" badge in `src/modules/prm/backend/license-deals/[id]/page.tsx:347`. Migrate to `<StatusBadge variant="error">` (or `destructive` Alert if it grows a description) — both primitives are available now. Origin: T2. Effort: S.
- **Hardcoded `text-rose-700` error label** — was inlined as `<div className="… text-rose-700">{error}</div>` in 5 portal pages; the four critical ones already moved to `ErrorMessage`, but the inline error inside the prospect-detail "back to list" branch (`…/portal/prospects/[id]/page.tsx:176`) still reads `text-rose-700`. Out of scope for `feat/prm-portal-ds-migration` (different code path — this lives in the missing-record state, not the rendered detail tree). Verify all rose-700 usages have moved to semantic tokens. Origin: T0/T1. Effort: S.
- **Raw `<select>` filters and form fields** — 11 instances across `src/modules/prm/backend/page.tsx:133,150`, `src/modules/prm/backend/prospects/page.tsx:155`, `src/modules/prm/backend/license-deals/page.tsx:179,198`, `src/modules/prm/backend/prm/wic-issues/page.tsx:243,262` (T4), `src/modules/prm/frontend/[orgSlug]/portal/prospects/page.tsx:206,242,259`, `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:191`. This OM version (0.4.x) does not ship a `Select` primitive — core modules (e.g. customers pipeline) use raw `<select>` with the same hand-rolled `h-8/h-9 rounded-md border border-input` classes. **Genuinely blocked.** Migrate when an OM `Select` primitive lands. Origin: T0/T1/T2/T4. Effort: M.
- **Raw `<input type="month">` filter** — 1 instance in `src/modules/prm/frontend/[orgSlug]/portal/prospects/page.tsx:278`. No date-range / month primitive currently used in PRM; bundle with a future date-input refresh. Origin: T1. Effort: S.
- **Raw `<input type="radio">` candidate picker** — 1 instance in `src/modules/prm/backend/license-deals/[id]/page.tsx:331`. No Radio primitive in this OM version; the surrounding card-style pick-row layout matches existing OM core patterns. Migrate when a `Radio` / `RadioGroup` primitive lands. Origin: T2. Effort: S.
- **Hardcoded `border-l-2 border-primary/60` quote box** — `src/modules/prm/backend/license-deals/[id]/page.tsx:185` uses raw primary tint for an attribution-reasoning callout. Could move to `<Alert variant="default">` or `<Alert variant="info">` now that Alert ships — the only reason to wait is whether a dedicated `Callout` primitive ships first. Origin: T2. Effort: S.
- **Raw `<table>` lists** — `src/modules/prm/backend/[id]/page.tsx:315`, `…/portal/members/page.tsx:169`, `…/portal/prospects/page.tsx:293`. Each is a small read-only list (members / prospects); OQ-010 explicitly opts out of `DataTable` for portal surfaces. Tracker has no DS-blocker but switch to `DataTable` for the backend-facing members tab once a "compact" variant is available. **Architectural opt-out, not blocked.** Origin: T0/T1. Effort: M.

## Playwright integration tests (deferred — require live Postgres + ESP fixture)

### T0 Agency Foundation (SPEC-2026-04-23-agency-foundation.md §9)

- ~~**IT-1 — Happy path onboarding**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T0-001-agency-happy-path.spec.ts` (Agency creation + invite + accept seam + cooldown probe + portal /me — covers US1.1, US1.2, US1.4 auth path, US2.1). The "fills profile" leg of US1.4 is deferred until the org-vs-route mismatch follow-up below lands.
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
- **IT-9.9 — Cache invalidation** — Cache tag invalidated on transition (blocked on cache wrapper follow-up above). Owner: QA team. Effort: per-test.

### T2 Attribution Loop (SPEC-2026-04-23-attribution-loop.md §9)

- ~~**IT-9.1 — Path A happy path → MIN update**~~ — SHIPPED in `.ai/qa/tests/integration/TC-PRM-T2-001-attribution-happy-path.spec.ts` (Path A attribute + Golden Rule default-pick + saga poll for `won` (≤30s, real saga, no stub) + portal MIN aggregate reflects bucketed annual value).
- **IT-9.2 — Golden Rule override with reasoning** — Non-default pick captures reasoning; `attribution_overridden` event fired. Owner: QA team. Effort: per-test.
- **IT-9.3 — Reverse attribution round trip** — LIFO compensation; Prospect reverts to qualified. Owner: QA team. Effort: per-test.
- **IT-9.4 — Path-B hard guard (cross-spec coordination with Spec #6)** — `RfpPathBLockSubscriber` writes `is_path_b_locked = true`; Spec #6 reads + enforces. Owner: QA team (jointly with Spec #6 QA). Effort: per-test.
- **IT-9.5 — Idempotent saga re-fire** — Duplicate `prm.license_deal.attributed` deduped via correlationKey. Owner: QA team. Effort: per-test.
- **IT-9.6 — US4.4b status unreverse gate** — `/unreverse-status` precondition; reverse only succeeds after status walk-back. Owner: QA team. Effort: per-test.
- **IT-9.7 — Churned is terminal** — `/unreverse-status` from `churned` → 409. Owner: QA team. Effort: per-test.
