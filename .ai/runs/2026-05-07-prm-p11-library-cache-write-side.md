# PRM P11 Library — wire cache.wrap write-side

**Source spec:** `.ai/specs/SPEC-007-prm-case-studies-marketing.md` §3.4 (P11 portal library), §4.3 (invalidators / OQ-019 resolution), §8.4 (stale-window perf rationale).
**Trigger:** `post-mvp-beta-t3` audit surfaced an architectural gap — 4 cache invalidator subscribers ship and are tested, but `src/modules/prm/api/portal/library/route.ts` never calls `cache.set/get`. The invalidators fire against an unwritten cache, so the §8.4 stale-window perf analysis is moot.
**PR target:** `develop`
**Branch:** `feat/prm-p11-library-cache-write-side`
**Slug:** `prm-p11-library-cache-write-side`

## Goal

Wire the canonical OM cache primitive (`@open-mercato/cache` resolved via DI as `'cache'`) around the read query in `GET /api/prm/portal/library`, using the spec-declared tag set, so the existing 4 invalidator subscribers actually flush something and the §8.4 perf model holds.

## Scope

**In:**
- `src/modules/prm/api/portal/library/route.ts` — wrap the read with `cache.get` / `cache.set`.
- `src/modules/prm/lib/libraryCache.ts` — extend with cache-key helper, tag constants, TTL constant, and an enumerated tier-tag list (replaces wildcard usage).
- `src/modules/prm/subscribers/agency-tier-change-library-invalidator.ts` — replace literal `'prm:agency:${agencyId}:tier:*'` (which never matches because `deleteByTags` is exact-match against sha1-hashed tags) with the enumerated 4-tier tag set from the helper. **This is the only subscriber-side edit.** The 3 material invalidators already use `'prm:library'` correctly.
- Unit tests:
  - extend `marketingLibraryInvalidators.test.ts` to assert tier-change emits the 4 enumerated tags
  - new `libraryRouteCache.test.ts` — second identical request hits cache (service called once); invalidator clears so third call re-queries; key changes when `agencyId` or `tier` differ; key does not change when only tier-irrelevant query order changes.

**Out (explicit non-goals):**
- Do NOT extend cache to other PRM portal routes (case studies P10, etc.).
- Do NOT touch the 3 marketing-material invalidators (their tag is correct).
- Do NOT remove the tier filter from `MarketingMaterialService.listPublishedForViewer` — defense-in-depth (cache key includes tier, but we still want the SQL to enforce visibility on cache miss).
- Do NOT touch DS migration files (`src/modules/prm/frontend/[orgSlug]/portal/*.tsx`) or test-isolation files (`src/modules/prm/testing/integration/`).
- Do NOT edit `.ai/specs/POST-MVP-FOLLOW-UPS.md` (DS migration agent owns the lock); cleanup owed in PR body.
- Do NOT modify spec files under `.ai/specs/SPEC-*.md`.

## Architecture decisions

1. **Cache primitive:** `cache` registered in DI by `@open-mercato/core/bootstrap` (line 61). Type: `CacheStrategy` from `@open-mercato/cache`. Methods: `get(key)`, `set(key, value, { ttl, tags })`, `deleteByTags(tags)`. Tag matching is exact-string via sha1 hashing — **no wildcards**.

2. **Tag scheme (per spec §3.4):**
   - `'prm:library'` — universal tag (invalidates every cached library response)
   - `'prm:agency:${agencyId}:tier:${tier}'` — per-(agency, tier) tag
   The 3 material invalidators delete by `['prm:library']` (correct). The tier-change invalidator must delete by **all 4 enumerated tier tags** for the agency, since (a) `deleteByTags` doesn't support wildcards, (b) the payload may not always include the prior tier, (c) 4 is bounded and deterministic. New helper `allAgencyTierTags(agencyId): string[]` returns the 4 tags.

3. **Cache key:** `prm:portal:library:${orgId}:${agencyId}:${tier|null}:${sha1(canonicalParams)}`. Canonical params are the validated parsed query (page, pageSize, materialType, sorted topics, sorted audiences). Deterministic across array ordering on the wire.

4. **TTL:** 15 minutes per spec §3.4 → `15 * 60 * 1000 = 900_000` ms. Constant in helper.

5. **Cached value:** the full `NextResponse` JSON body (items + facets + pagination), so we don't have to re-compute facets on cache hit. Cache stores POJO; route reconstructs `NextResponse.json` on hit.

6. **No-agency-member case** (member missing → empty response) is **not cached** — keeps the cache key invariant (it requires agencyId) and avoids polluting the cache with empty no-op shapes.

7. **Soft-fail:** if `cache.get` or `cache.set` throws, the route logs at warn and falls through to direct DB query, returning the same shape — same posture as the existing invalidator helper. The 15-min TTL is the §8.4 fallback.

## Implementation Plan

### Phase 1: Extend `lib/libraryCache.ts` helper + align tier-change invalidator

Outcome: helper exposes `LIBRARY_CACHE_TAG`, `LIBRARY_CACHE_TTL_MS`, `agencyTierTag`, `allAgencyTierTags`, `buildLibraryCacheKey`. Tier-change invalidator uses `allAgencyTierTags`. Existing `invalidateLibraryCache(cache, tags)` API preserved (BC).

Tests:
- New unit `libraryCacheHelpers.test.ts`:
  - `agencyTierTag('a', 'om_agency')` → `'prm:agency:a:tier:om_agency'`
  - `allAgencyTierTags('a')` → array of 4 in stable order
  - `buildLibraryCacheKey` deterministic across param ordering (object key order, topic array order, audience array order)
  - `buildLibraryCacheKey` differs across tier / agencyId / orgId
- Update `marketingLibraryInvalidators.test.ts`:
  - tier-change handler now invokes `cache.deleteByTags` with the 4 enumerated tags instead of the wildcard.

Phase commit: `feat(prm): extend libraryCache helper with key/tag/TTL primitives + enumerate tier tags`

### Phase 2: Wire `cache.wrap` into `api/portal/library/route.ts`

Outcome: route calls `cache.get(key)`; on miss runs the existing DB query + facet computation + `cache.set(key, payload, { ttl, tags })`; same response shape, same status codes. Tier filter remains in `listPublishedForViewer` (defense-in-depth).

Tests (`libraryRouteCache.test.ts`):
- Mock `MarketingMaterialService.listPublishedForViewer`, mock cache as in-memory map honoring `get`/`set`/`deleteByTags`.
- Two identical authenticated requests → `listPublishedForViewer` called exactly once (the second is a cache hit), responses identical.
- Run `MarketingLibraryPublishedInvalidator` against the same mock cache → next request re-queries.
- Run `AgencyTierChangeLibraryInvalidator` for the same `agencyId` → next request re-queries.
- Different `agencyId` → not a cache hit (separate key).
- HTTP status 200 + response shape unchanged on miss and on hit.

Phase commit: `feat(prm): cache.wrap GET /api/prm/portal/library with spec-declared tags + 15min TTL`

### Phase 3: Validation gate + summary

Outcome: green gate.
- `yarn typecheck`
- `yarn jest src/modules/prm` (must remain ≥ baseline + new tests)
- `yarn build`

If gate is red: stop, surface, fix, re-run; do not push under failing gate.

Phase commit (Progress only): `docs(runs): mark Phase 3 gate green`

## Risks

- **Cache backend mismatch in dev vs prod.** Default strategy is `memory` (per-process). `deleteByTags` semantics are identical across strategies (per `@open-mercato/cache/src/types.ts`), so the wiring is strategy-agnostic. The dev-scope `memory` cache won't share across processes — that's expected and acceptable for the standalone app's single-process deployment.
- **Tag-set drift between writers and invalidators.** This PR collapses the wildcard mismatch by enumerating the tier values in one place (`allAgencyTierTags`). If a 5th tier is ever added in `data/validators.ts`, the helper needs updating — added a comment in the helper to flag that.
- **Cached payload contains attachment download paths.** Those are tenant-scoped (already in the response today, not new exposure). The cache wrapper in `@open-mercato/cache/src/service.ts` is tenant-scoped via `runWithCacheTenant`; the request flow runs inside the customer-portal request context which sets the tenant key. **Verified**: cache keys are sha1-namespaced under `tenant:${tenantId}:`, so cross-tenant bleed is structurally impossible.
- **PII / encryption.** No raw PII leaves the cache; values are the same DTOs the route already returns.

## Out-of-scope cleanups owed (NOT in this PR)

- Document the architectural gap closure in `.ai/specs/POST-MVP-FOLLOW-UPS.md` once the DS migration agent releases the lock. (Owner: future PR; tracking in PR body.)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Extend libraryCache helper + align tier-change invalidator

- [x] 1.1 Extend `src/modules/prm/lib/libraryCache.ts` with `LIBRARY_CACHE_TAG`, `LIBRARY_CACHE_TTL_MS`, `agencyTierTag`, `allAgencyTierTags`, `buildLibraryCacheKey` — 06af699
- [x] 1.2 Add `src/modules/prm/__tests__/libraryCacheHelpers.test.ts` covering helpers — 06af699
- [x] 1.3 Update `subscribers/agency-tier-change-library-invalidator.ts` to use `allAgencyTierTags`; update `marketingLibraryInvalidators.test.ts` expectation — 06af699

### Phase 2: Wire cache.wrap into portal library route

- [x] 2.1 Edit `src/modules/prm/api/portal/library/route.ts` to read-through cache (get → on miss query + set) — db1371f
- [x] 2.2 Add `src/modules/prm/__tests__/libraryRouteCache.test.ts` (identical-request hit, invalidator clears, separate keys per agency) — db1371f

### Phase 3: Validation gate

- [x] 3.1 `yarn typecheck` clean (post `yarn generate`)
- [x] 3.2 `yarn jest src/modules/prm` clean — 51 suites, 504 tests passed (was 482; this PR added +14 helper + +8 route = +22; the rest were already in develop tip)
- [x] 3.3 `yarn build` clean (exit 0; only pre-existing optional-import warning from `llmScoringDraft.ts`, not from this PR)
