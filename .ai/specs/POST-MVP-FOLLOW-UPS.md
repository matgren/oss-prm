# POST-MVP-FOLLOW-UPS

What we owe. Each item: one line. Origin spec. Owner. Estimated effort.
This is the source of truth for follow-up work — when an item ships, delete the line.

## Tracker

- **L1 — Replace `window.prompt` with proper Dialog in B5 reverse / unreverse-status flows** — Cmd+Enter submit, Escape cancel per AGENTS dialog convention; current implementation at `src/modules/prm/backend/license-deals/[id]/page.tsx:549,569`. Origin: SPEC-2026-04-23-attribution-loop.md §11 (T2 review L1). Owner: TBD. Effort: M.
- **Cache invalidator subscribers (T0 Agency)** — `prm:agency:list:tenant:{id}`, `prm:agency:{id}`, `prm:portal:agency:{id}:status_banner` declared in spec but not wired in shipped T0. Origin: SPEC-2026-04-23-agency-foundation.md §3.1.2-§3.1.4. Owner: TBD. Effort: M.
- **Optimistic concurrency on Agency PATCH (T0)** — `If-Match` / `updated_at` token pattern not implemented; T2's `LicenseDeal.version` is the reference implementation. Origin: SPEC-2026-04-23-agency-foundation.md §3.1.4. Owner: TBD. Effort: M.
- **WIC dashboard cache wrappers (T1)** — Dashboard route is hand-rolled portal aggregate; cache attachment hooks live at the CRUD-factory layer. Deferred until traffic justifies a custom wrapper. Origin: SPEC-2026-04-23-wip-scoreboard.md §3.1 + §6.2. Owner: TBD. Effort: M.
- **`tier_requirements` static registry → DB-backed table (T1)** — Currently in-code at `src/modules/prm/lib/tierRequirements.ts`; promote to seeded DB table when business needs admin-editable values. Origin: SPEC-2026-04-23-wip-scoreboard.md §11 (T1 changelog). Owner: TBD. Effort: M.
- **Saga retry dashboard wiring (T2)** — Workflows module ships `/backend/workflows/instances/{id}` covering retry/cancel; verify the page handles PRM saga instances and link from B5 detail. Origin: SPEC-2026-04-23-attribution-loop.md §8.1. Owner: TBD. Effort: S.
- **`prm.prospect.update` undo (T1/T2)** — Service exposes `revertRegistration` (undo of `register`); `update`-undo requires command-bus before-snapshot capture. Origin: SPEC-2026-04-23-wip-scoreboard.md §4.1. Owner: TBD. Effort: L.
- **Reverse-path subscriber → JSON `reverse` trigger (T2)** — Currently PRM-owned synchronous compensation in `subscribers/license-deal-reversal-compensation.ts`. Migrate when workflows module ships JSON `reverse` trigger contract. Origin: SPEC-2026-04-23-attribution-loop.md §11. Owner: TBD. Effort: M.
- **Bounce-webhook handler (T0)** — OQ-014 deferred to v2; v1 relies on 72h TTL expiry + manual re-invite. Origin: SPEC-2026-04-23-agency-foundation.md §11. Owner: TBD. Effort: M.
- **Snapshot table for historical MIN (T2)** — v1 recomputes on read; v2 concern when MIN history queries become hot. Origin: SPEC-2026-04-23-attribution-loop.md §Scope (out). Owner: TBD. Effort: L.
- **Commission calculation / renewal attribution inheritance (T2)** — v2 backlog; v1 ships flat MIN aggregate + renewal flag only. Origin: SPEC-2026-04-23-attribution-loop.md §Scope (out). Owner: TBD. Effort: L.
- **Wrap Organization + Agency create in `withAtomicFlush` (T0)** — `agencyService.createAgencyWithOrganization` currently does `em.create(Organization) → persist → em.create(Agency) → persist → em.flush()`. If the Agency insert is rejected after the Organization is persisted (e.g. unique-violation race on `prm_agencies_tenant_slug_uniq`, future trigger), MikroORM 6.x does not auto-wrap the flush in a transaction — a partial commit is theoretically possible. Use `withAtomicFlush(em, [createOrganization, createAgency], { transaction: true })` from `@open-mercato/shared/lib/commands/flush`. Origin: PR #1 om-code-review Medium #1. Owner: TBD. Effort: S.
- **DI guardrail test — `.proxy()` mandatory on destructured-param factories** — Add a unit test under `src/modules/<module>/__tests__/` that scans every `src/modules/*/di.ts` and asserts any `asFunction(({ ... }) => ...)` registration also chains `.proxy()`. Prevents regression of the bug fixed in `d0141c2` where Awilix `InjectionMode.CLASSIC` returned `undefined` for destructured params. Origin: PR #1 om-code-review Medium #2. Owner: TBD. Effort: S.
- **Unit-test coverage for the two PR #1 resume bugs (T0 Agency)** — Add tests that (a) construct `agencyService` via the real DI container (not the `FakeEntityManager`) and verify `em` is injected, and (b) verify `Agency.organizationId` matches the persisted Organization's id end-to-end. The `FakeEntityManager` auto-assigns ids on `create()`, which is why both bugs (DI resolution + pre-flush `.id` undefined) were missed by jest. Origin: PR #1 om-code-review Medium #3. Owner: TBD. Effort: M.

## Performance watchlist

Items here aren't owed work — they're triggers. Add a compound index / cache layer / etc. if and when production observation warrants it.

- **`prm_prospects` `(organization_id, agency_id, status)` compound index** — Trigger: WIP dashboard queries > 500ms in production. Origin: SPEC-2026-04-23-wip-scoreboard.md §5 (single-column indexes shipped instead of the compound index originally drafted).

## Design system follow-ups

Items here are cosmetic DS-compliance gaps (color tokens, text sizes, spacing). Bundle with adjacent UI work; not worth standalone fix commits.

- **Hardcoded amber banner palette** — `border-amber-300 bg-amber-50 text-amber-900` for historical / lost-reason banners. 5 instances across `src/modules/prm/frontend/[orgSlug]/portal/dashboard/page.tsx:94`, `…/portal/agency/page.tsx:35`, `…/portal/members/page.tsx:97`, `…/portal/prospects/[id]/page.tsx:206`, `src/modules/prm/backend/license-deals/[id]/page.tsx:312`. Replace with semantic warning tokens once they exist in this OM version. Origin: T0/T1/T2 mixed. Effort: S.
- **Hardcoded emerald onboarding chips** — `bg-emerald-50 text-emerald-800` on Contract / NDA / Onboarded chips. 3 instances in `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:138-140`. Migrate to a `StatusBadge` once a success token exists. Origin: T0. Effort: S.
- **Hardcoded red LOST badge** — `bg-red-100 text-red-700` on the candidate "LOST" badge in `src/modules/prm/backend/license-deals/[id]/page.tsx:347`. Migrate to a destructive status token / `StatusBadge`. Origin: T2. Effort: S.
- **Hardcoded `text-rose-700` error label** — was inlined as `<div className="… text-rose-700">{error}</div>` in 5 portal pages; the four critical ones already moved to `ErrorMessage`, but the inline error inside the prospect-detail "back to list" branch (`…/portal/prospects/[id]/page.tsx:176`) still reads `text-rose-700` after the swap. Verify all rose-700 usages have moved to semantic tokens. Origin: T0/T1. Effort: S.
- **Raw `<select>` filters and form fields** — 9 instances across `src/modules/prm/backend/page.tsx:133,150`, `src/modules/prm/backend/prospects/page.tsx:155`, `src/modules/prm/backend/license-deals/page.tsx:179,198`, `src/modules/prm/frontend/[orgSlug]/portal/prospects/page.tsx:206,242,259`, `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:191`. This OM version (0.4.x) does not ship a `Select` primitive — core modules (e.g. customers pipeline) use raw `<select>` with the same hand-rolled `h-8/h-9 rounded-md border border-input` classes. Migrate when an OM `Select` primitive lands. Origin: T0/T1/T2. Effort: M.
- **Raw `<input type="month">` filter** — 1 instance in `src/modules/prm/frontend/[orgSlug]/portal/prospects/page.tsx:278`. No date-range / month primitive currently used in PRM; bundle with a future date-input refresh. Origin: T1. Effort: S.
- **Raw `<input type="radio">` candidate picker** — 1 instance in `src/modules/prm/backend/license-deals/[id]/page.tsx:331`. No Radio primitive in this OM version; the surrounding card-style pick-row layout matches existing OM core patterns. Migrate when a `Radio` / `RadioGroup` primitive lands. Origin: T2. Effort: S.
- **Hardcoded `border-l-2 border-primary/60` quote box** — `src/modules/prm/backend/license-deals/[id]/page.tsx:185` uses raw primary tint for an attribution-reasoning callout. Promote to a `Callout` or `Alert` primitive when one fits. Origin: T2. Effort: S.
- **Raw `<table>` lists** — `src/modules/prm/backend/[id]/page.tsx:315`, `…/portal/members/page.tsx:169`, `…/portal/prospects/page.tsx:293`. Each is a small read-only list (members / prospects); OQ-010 explicitly opts out of `DataTable` for portal surfaces. Tracker has no DS-blocker but switch to `DataTable` for the backend-facing members tab once a "compact" variant is available. Origin: T0/T1. Effort: M.

## Playwright integration tests (deferred — require live Postgres + ESP fixture)

### T0 Agency Foundation (SPEC-2026-04-23-agency-foundation.md §9)

- **IT-1 — Happy path onboarding** — OMPartnerOps creates Agency, invites PartnerAdmin, accepts invite, fills profile (US1.1, US1.2, US1.4, US2.1). Owner: QA team. Effort: per-test.
- **IT-2 — Duplicate GH-profile rejection (L-010)** — 409 with privacy-preserving message; no Agency name leaked (US1.2, US1.5, invariant #5). Owner: QA team. Effort: per-test.
- **IT-3 — Admin-only field 403 from portal** — `PATCH /api/prm/portal/agency/{id}` with `tier` field rejected (US1.3, US2.1, invariant #6). Owner: QA team. Effort: per-test.
- **IT-4 — Lockout recovery (US1.6)** — OMPartnerOps promotes a `partner_member` to `partner_admin` via B2 Members tab. Owner: QA team. Effort: per-test.
- **IT-5 — `status = historical` cascade banner** — `prm.agency.status_changed` propagates to AgencyMember read-model + portal banner (US1.7, Vernon C3). Owner: QA team. Effort: per-test.
- **IT-6 — Re-invite cooldown** — Second invite within 10min returns 429 with `retry_after_seconds` (US1.2). Owner: QA team. Effort: per-test.

### T1 WIP Scoreboard (SPEC-2026-04-23-wip-scoreboard.md §9)

- **IT-9.1 — Register → transition → widget update** — Full P5/P6/P2 happy path. Owner: QA team. Effort: per-test.
- **IT-9.2 — Invariant #12 enforcement** — Illegal transition blocked with 409. Owner: QA team. Effort: per-test.
- **IT-9.3 — Invariant #1 (`registered_at` immutability)** — PATCH with `registered_at` rejected. Owner: QA team. Effort: per-test.
- **IT-9.4 — Projection consistency** — `ProspectCandidateIndex` keys match aggregate after edit + soft-delete. Owner: QA team. Effort: per-test.
- **IT-9.5 — Tenant isolation** — Cross-agency Prospect leak blocked. Owner: QA team. Effort: per-test.
- **IT-9.6 — PartnerMember author-scope** — Non-author cannot transition another member's Prospect. Owner: QA team. Effort: per-test.
- **IT-9.7 — Agency `historical` cascade rejection** — POST Prospect on historical agency → 409. Owner: QA team. Effort: per-test.
- **IT-9.8 — Dashboard widgets render correctly** — WIP / WIC / tier widgets with seeded data. Owner: QA team. Effort: per-test.
- **IT-9.9 — Cache invalidation** — Cache tag invalidated on transition (blocked on cache wrapper follow-up above). Owner: QA team. Effort: per-test.

### T2 Attribution Loop (SPEC-2026-04-23-attribution-loop.md §9)

- **IT-9.1 — Path A happy path → MIN update** — Saga completes within 10min; Prospect → won; portal MIN reflects deal. Owner: QA team. Effort: per-test.
- **IT-9.2 — Golden Rule override with reasoning** — Non-default pick captures reasoning; `attribution_overridden` event fired. Owner: QA team. Effort: per-test.
- **IT-9.3 — Reverse attribution round trip** — LIFO compensation; Prospect reverts to qualified. Owner: QA team. Effort: per-test.
- **IT-9.4 — Path-B hard guard (cross-spec coordination with Spec #6)** — `RfpPathBLockSubscriber` writes `is_path_b_locked = true`; Spec #6 reads + enforces. Owner: QA team (jointly with Spec #6 QA). Effort: per-test.
- **IT-9.5 — Idempotent saga re-fire** — Duplicate `prm.license_deal.attributed` deduped via correlationKey. Owner: QA team. Effort: per-test.
- **IT-9.6 — US4.4b status unreverse gate** — `/unreverse-status` precondition; reverse only succeeds after status walk-back. Owner: QA team. Effort: per-test.
- **IT-9.7 — Churned is terminal** — `/unreverse-status` from `churned` → 409. Owner: QA team. Effort: per-test.
