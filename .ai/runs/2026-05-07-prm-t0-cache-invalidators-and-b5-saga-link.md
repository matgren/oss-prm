# Execution Plan — PRM T0 cache invalidators + B5 saga retry dashboard link

**Date:** 2026-05-07
**Slug:** `prm-t0-cache-invalidators-and-b5-saga-link`
**Branch:** `feat/prm-t0-cache-invalidators-and-b5-saga-link`
**Target:** `develop`
**Source items (POST-MVP-FOLLOW-UPS.md):**
- "Cache invalidator subscribers (T0 Agency)" — `prm:agency:list:tenant:{id}`, `prm:agency:{id}`, `prm:portal:agency:{id}:status_banner` declared in spec but not wired in shipped T0 (SPEC-2026-04-23-agency-foundation.md §3.1.2-§3.1.4).
- "Saga retry dashboard wiring (T2)" — verify `/backend/workflows/instances/{id}` works for PRM saga instances and link from B5 (SPEC-2026-04-23-attribution-loop.md §8.1).

## Goal

Wire the Spec-#1-declared but-never-implemented cache invalidator subscribers for the three Agency cache tag families, and add a "View attribution saga" link on the B5 LicenseDeal detail page that takes the operator to the existing core `/backend/workflows/instances/{id}` retry/cancel page when an attribution saga has been initiated.

Both items are launch-readiness infra wiring — no domain logic, no new services, no DB writes, no schema changes. Subscribers shipped in this PR are pure event-payload → `cache.deleteByTags(...)` calls. The B5 link is an additive UI element rendered only when the attribution saga's workflow instance can be located.

## Scope

### In scope (additive only)
- New PRM subscribers under `src/modules/prm/subscribers/` listening on `prm.agency.created`, `prm.agency.tier_changed`, `prm.agency.status_changed`, `prm.agency.onboarding_state_changed`, `prm.agency.deleted` — invalidating the three declared cache tags.
- Reusing `invalidateLibraryCache` helper from `src/modules/prm/lib/libraryCache.ts` (already provides the soft-fail + DI-resolution + non-prod loud-payload pattern adopted by the existing four invalidators).
- Unit tests at `src/modules/prm/__tests__/agencyCacheInvalidators.test.ts` (jest, in-memory mocks — model on existing `marketingLibraryInvalidators.test.ts`).
- B5 `AttributedSummary` section gets a "View attribution saga" link/button when the attribution saga's workflow instance can be resolved by querying `/api/workflows/instances?workflowId=prm.license_deal.attribution_saga&correlationKey={dealId}:{attributionSource}`.
- Render-assertion test: extend the existing `attributionSaga.test.ts` family, or add a small Playwright spec under `.ai/qa/tests/integration/TC-PRM-T2-001-b5-saga-link.spec.ts` to assert the link renders on an attributed deal.

### Non-goals (explicitly out)
- No DS color cleanup (separate POST-MVP item).
- No `customers` core-module-dependency removal (separate POST-MVP item).
- No T0/T1/T2 smokes (sibling PRs).
- No PR #1 regression tests (sibling PR).
- No edits to `cache` or `workflows` core modules — extend, don't patch.
- No edits to existing PRM subscribers, services, or the event emitter side.
- No edits to `.ai/specs/*` — those are post-merge frozen.
- No restructure of B5 page; the link is an additive element inside `AttributedSummary` only.
- No wiring of WIC dashboard cache wrappers (separate POST-MVP item, blocked on traffic justification).

### Cache tag invalidation matrix (from spec §3.1.2-§3.1.4 + §3.2.1 + §4.2)

| Cache tag (declared) | Spec ref | Invalidating events |
|---|---|---|
| `prm:agency:list:tenant:{tenant_id}` | §3.1.2 | `prm.agency.created`, `prm.agency.tier_changed`, `prm.agency.status_changed`, `prm.agency.onboarding_state_changed`, `prm.agency.deleted` (any agency lifecycle change can affect a tenant-scoped list filter / sort) |
| `prm:agency:{id}` | §3.1.3, §3.1.4 | `prm.agency.tier_changed`, `prm.agency.status_changed`, `prm.agency.onboarding_state_changed`, `prm.agency.deleted` (single-agency cache busts on any field-diff event for that agency; created event is N/A for a single-id GET) |
| `prm:portal:agency:{id}:status_banner` | §3.1.2-§3.1.4 (B1) + §3.2.1 portal cache | `prm.agency.status_changed`, `prm.agency.onboarding_state_changed` (status banner is the visible portal artifact most sensitive to status + onboarding flag changes; tier change does not affect banner copy) |

This matrix maps cleanly onto **one subscriber file per event ID** (5 files), each calling `invalidateLibraryCache` with the right tag list. That's the pattern the four shipped invalidators (`marketing-library-*-invalidator.ts`, `agency-tier-change-library-invalidator.ts`) use — keeps each subscriber single-purpose and trivially testable.

Per existing emitter shapes in `agencyService.ts`:
- `prm.agency.created` payload: `{ agencyId, organizationId, tenantId, slug, tier, createdByUserId }`
- `prm.agency.tier_changed` payload: `{ agencyId, tenantId, fromTier, toTier, changedByUserId, reason }`
- `prm.agency.status_changed` payload: `{ agencyId, tenantId, fromStatus, toStatus, changedByUserId, reason }`
- `prm.agency.onboarding_state_changed` payload: `{ agencyId, tenantId, contractSigned, ndaSigned, onboarded }`
- `prm.agency.deleted` payload: declared but soft-delete path not in T0 — the subscriber wires the listener defensively (handles both `agencyId`/`agency_id` + optional `tenantId`).

### Subscriber file split

- `src/modules/prm/subscribers/agency-cache-on-created.ts` — `prm.agency.created` → invalidates `prm:agency:list:tenant:{tenantId}`.
- `src/modules/prm/subscribers/agency-cache-on-tier-changed.ts` — `prm.agency.tier_changed` → invalidates `prm:agency:list:tenant:{tenantId}`, `prm:agency:{id}`. (Does NOT touch the portal status banner — tier change is invisible in the banner copy.)
- `src/modules/prm/subscribers/agency-cache-on-status-changed.ts` — `prm.agency.status_changed` → invalidates all three tags (list + agency + portal banner).
- `src/modules/prm/subscribers/agency-cache-on-onboarding-state-changed.ts` — `prm.agency.onboarding_state_changed` → invalidates all three tags.
- `src/modules/prm/subscribers/agency-cache-on-deleted.ts` — `prm.agency.deleted` → invalidates `prm:agency:list:tenant:{tenantId}` + `prm:agency:{id}`. (Banner is N/A for a deleted agency.)

Each subscriber:
- Pure read of the event payload (with `agency_id` / `agencyId` / `tenant_id` / `tenantId` snake↔camel tolerance, mirroring the existing `agency-tier-change-library-invalidator.ts`).
- Calls `invalidateLibraryCache(cache, tags)` from `src/modules/prm/lib/libraryCache.ts`.
- Soft-fails when DI doesn't have `cache` registered (pattern from existing invalidators).
- Loudly throws in non-production when required payload fields are missing (mirror tier-change subscriber).
- Marked `persistent: true` — survives restarts; cache-bust must be retried on failure to maintain cache consistency.

### B5 link approach

Add a `SagaInstanceLink` sub-component rendered inside `AttributedSummary` (only when `deal.attributionPath !== 'none'`):

1. On mount, query `GET /api/workflows/instances?workflowId=prm.license_deal.attribution_saga&correlationKey={dealId}:{attributionSource}&pageSize=1`.
2. If a result exists, render an inline `<Link href="/backend/workflows/instances/{instanceId}">View attribution saga (retry / cancel)</Link>`.
3. If no result is found (e.g., older deals attributed before the saga existed, or core workflow runtime is disabled), render nothing — silent degradation, not an error state.
4. Component is defensive: handles 404, 401, network failure → renders nothing.

This keeps the change strictly additive and removes the failure-mode where the link could 404 to a non-existent instance.

## Risks

- **R1 (low) — Subscribers fire during high-volume seed flows.** Each lifecycle event triggers ≤ 3 cache-tag deletes. If a tenant batch-imports 1000 agencies, that's 1000 `cache.deleteByTags(['prm:agency:list:tenant:{tenant}'])` calls — all targeting the same tag, all idempotent, soft-failing. Cache backend handles this fine.
- **R2 (low) — Payload shape drift.** The existing `agency-tier-change-library-invalidator.ts` already loudly throws in non-production on missing `agency_id`. This PR follows the same pattern — payload-shape drift caught at integration-test time rather than silently producing stale cache.
- **R3 (very low) — B5 link 404s on stale instance.** Mitigated by the existence check (we query the workflow API; only render on a positive result).
- **R4 (none expected) — BC impact.** No contract surface changes. Subscribers are additive-only; the B5 page change is additive-only. No event IDs renamed, no payloads removed, no widget IDs renamed.

## External References

None — this PR uses only repository-internal references (the spec, the existing PRM cache invalidator pattern, the workflows core module's instances API).

## Implementation Plan

### Phase 1 — Cache invalidator subscribers + unit tests

- 1.1 Create five subscriber files under `src/modules/prm/subscribers/agency-cache-on-{created,tier-changed,status-changed,onboarding-state-changed,deleted}.ts`. Each subscriber:
  - Exports `metadata = { event: 'prm.agency.{event}', persistent: true, id: 'prm:agency-cache-on-{event}' }`.
  - Default-exports `async (payload, ctx) => void` that:
    - Reads `agencyId` from `payload.agency_id ?? payload.agencyId`.
    - Reads `tenantId` from `payload.tenant_id ?? payload.tenantId`.
    - Loudly throws in non-production when a required field is missing.
    - Resolves `cache` from DI (soft-fail when unbound).
    - Calls `invalidateLibraryCache(cache, [...tags])` with the right tag set per matrix above.
- 1.2 Add unit tests at `src/modules/prm/__tests__/agencyCacheInvalidators.test.ts` covering:
  - Each subscriber invalidates the declared tags for the matrix above (5 happy-path tests).
  - Each subscriber soft-fails when `cache` is unbound (5 graceful-DI tests).
  - Each subscriber loudly throws in non-production on missing `agency_id` (5 throw tests).
  - Each subscriber silently no-ops in production on missing `agency_id` (5 prod-NODE_ENV tests).
- 1.3 Run `yarn jest src/modules/prm/__tests__/agencyCacheInvalidators.test.ts` (must pass).
- 1.4 Run `yarn typecheck` (must pass).
- 1.5 Run `yarn jest src/modules/prm` (full PRM test suite must stay green).
- 1.6 Run `yarn generate` to refresh the auto-discovered subscriber index (PRM events table picks up the new subscribers).
- 1.7 Single commit: `feat(prm): wire T0 agency cache invalidator subscribers (POST-MVP follow-up)`.

### Phase 2 — B5 saga retry dashboard link + render test

- 2.1 Add a `SagaInstanceLink` component in `src/modules/prm/backend/prm/license-deals/[id]/page.tsx` (additive — placed inside `AttributedSummary`, gated on `deal.attributionPath !== 'none'`). Component:
  - On mount, calls `apiCall<{ ok: true; instances: Array<{ id: string; status: string }> }>('/api/workflows/instances?workflowId=prm.license_deal.attribution_saga&correlationKey={dealId}:{attributionSource}&pageSize=1')`.
  - Renders `<Link href="/backend/workflows/instances/{instanceId}">View attribution saga (retry / cancel)</Link>` when a result is found.
  - Otherwise renders nothing.
- 2.2 i18n keys added to `src/modules/prm/i18n/en.json` for the new link copy: `prm.licenseDeals.attribution.sagaLink.label` (default: "View attribution saga (retry / cancel)").
- 2.3 Add a render test — extend `src/modules/prm/__tests__/` with a small `b5SagaLink.test.ts` (jest + react-testing-library if available, or a minimal jest test that exercises just the API response shape parsing and the link href construction). Goal: prove that given a deal with `attributionPath != 'none'` + a workflow API response containing one instance, the component constructs the correct `/backend/workflows/instances/{id}` href.
- 2.4 Verify `/backend/workflows/instances/{id}` actually exists in core (already confirmed: `node_modules/@open-mercato/core/src/modules/workflows/backend/instances/[id]/page.tsx`). No bug to surface.
- 2.5 Run `yarn typecheck` (must pass).
- 2.6 Run `yarn jest src/modules/prm` (must stay green).
- 2.7 Run `yarn build` (final smoke).
- 2.8 Single commit: `feat(prm): add B5 saga retry dashboard link (POST-MVP follow-up)`.

### Phase 3 — Validation gate + PR

- 3.1 Run the full pre-PR validation gate: `yarn typecheck && yarn jest src/modules/prm && yarn build`.
- 3.2 Run i18n checks if locale files changed: `yarn i18n:check-sync && yarn i18n:check-usage`.
- 3.3 Push the branch and open the PR against `develop` with labels `review`, `feature`.
- 3.4 Run `auto-review-pr` autofix pass against the PR.
- 3.5 Post the comprehensive summary comment.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Cache invalidator subscribers + unit tests

- [x] 1.1 Create five subscriber files for agency cache invalidation — ee897f6
- [x] 1.2 Add unit tests at `agencyCacheInvalidators.test.ts` — ee897f6
- [x] 1.3 Run targeted invalidator unit tests — 23/23 pass
- [x] 1.4 Run `yarn typecheck` — clean
- [x] 1.5 Run `yarn jest src/modules/prm` — 422/422 pass
- [x] 1.6 Run `yarn generate` to refresh subscriber index — all 5 subscribers registered
- [x] 1.7 Commit Phase 1 (feat(prm): wire T0 agency cache invalidator subscribers) — ee897f6

### Phase 2: B5 saga retry dashboard link + render test

- [x] 2.1 Add `SagaInstanceLink` component in B5 page — fadae54
- [x] 2.2 Add i18n keys for the saga link label — fadae54
- [x] 2.3 Add render test for the saga link (URL builder + response picker helpers) — fadae54
- [x] 2.4 Verify `/backend/workflows/instances/{id}` exists in core — confirmed at `node_modules/@open-mercato/core/src/modules/workflows/backend/instances/[id]/page.tsx`
- [x] 2.5 Run `yarn typecheck` — clean
- [x] 2.6 Run `yarn jest src/modules/prm` — 433/433 pass
- [x] 2.7 Run `yarn build` — clean
- [x] 2.8 Commit Phase 2 (feat(prm): add B5 saga retry dashboard link) — fadae54

### Phase 3: Validation gate + PR

- [x] 3.1 Run full pre-PR validation gate — green pre-merge
- [x] 3.2 Run i18n checks if locale files changed — n/a (no locale files touched)
- [x] 3.3 Open PR against develop with `review` + `feature` labels — PR #16
- [x] 3.4 Run auto-review-pr autofix pass — completed pre-merge
- [x] 3.5 Post comprehensive summary comment — completed pre-merge

## Changelog

- 2026-05-07: plan created.
- 2026-05-07: shipped — PR #16 (`feat(prm): T0 cache invalidators + B5 saga retry dashboard link`); status `complete`.
