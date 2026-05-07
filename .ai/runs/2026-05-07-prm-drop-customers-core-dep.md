---
title: Drop @open-mercato/core/customers dependency from PRM standalone
slug: prm-drop-customers-core-dep
date: 2026-05-07
owner: matgren
target: develop
branch: chore/prm-drop-customers-core-dep
labels: review, chore
origin: .ai/specs/POST-MVP-FOLLOW-UPS.md (entry #1)
predecessor: .ai/runs/2026-05-06-t0-002-review.md (M2 — chose A)
---

## Goal

Replace the standalone-app dependency on `@open-mercato/core/customers` with a PRM-owned stub of `GET /api/customers/people` so the `mercato test:integration` ephemeral readiness probe stays green without dragging in 19 admin-nav routes, 5 unrelated migrations, dictionary/currency/pipeline seeds, and `customers.*` ACL grants on the admin role.

## Scope

- **In scope.**
  - Add a PRM-owned stub at `src/modules/prm/api/customers/people/route.ts` mirroring the CRUD-factory paged-list response shape (`{ items, total, page, pageSize, totalPages }`).
  - Add a co-located unit test asserting the stub's response shape and probe-required HTTP 200 status on the canonical probe URL `?pageSize=1`.
  - Remove `{ id: 'customers', from: '@open-mercato/core' }` from `src/modules.ts`.
  - Re-run `yarn generate` so the structural caches and generated registries drop the customers module.
  - Validate via the full gate, with **`yarn test:integration:ephemeral`** as the load-bearing check (this is the actual probe surface).

- **Non-goals.**
  - Path (b) — upstreaming `OM_TEST_READINESS_URL` to `@open-mercato/cli`. The follow-ups doc explicitly chose path (a).
  - Ejecting the customers module — the stub is a single GET route; ejection would be overkill.
  - Touching `src/modules/example/*` — the example module is scaffolding and is **not** in `enabledModules`. Its `customers` references are inert at runtime.
  - Deleting / renaming any spec under `.ai/specs/`.
  - Bundling sibling follow-ups (cache invalidator wiring, T0/T1/T2 smokes, PR #1 regression tests).

## Probe contract — verbatim

From `node_modules/@open-mercato/cli/src/lib/testing/integration.ts:1315-1374` (`probeAuthenticatedApi`):

1. `POST /api/auth/login` with `email=admin@acme.com`, `password=secret` → expect 200 + `{ token: string }`.
2. `GET /api/customers/people?pageSize=1` with header `Authorization: Bearer <token>` → expect HTTP 200.
3. Body shape is **NOT inspected**; the probe only checks `apiResponse.status === 200`.

The stub is therefore correct as long as it:
- Authenticates the bearer token via the framework's standard `requireAuth` metadata.
- Returns 200.
- Mirrors the CRUD-factory list response shape (defensive — protects against any downstream consumer that may inspect the body, even though the probe does not).

The CRUD-factory list shape is **flat** (verified in `node_modules/@open-mercato/shared/src/lib/crud/factory.ts:1588-1595`):
```ts
{ items: [], total: 0, page: 1, pageSize: 1, totalPages: 0 }
```
This is the shape we emit — **not** the nested `{ pagination: { totalItems, totalPages } }` form drafted in the M2 review (verified mismatch).

## Why path (a) and not path (b)

- Path (a) is local, reversible, and ships in one PR.
- Path (b) requires upstream PR + release + dependency bump. Out of scope for the launch follow-up arc.
- Decided in `.ai/runs/2026-05-06-t0-002-review.md` M2; tracker line in `.ai/specs/POST-MVP-FOLLOW-UPS.md` records the choice.

## PRM coupling check (pre-flight)

Grep results — `customers` references in `src/`:

| File / module | Status |
|---|---|
| `src/modules.ts:17` | The line being removed. |
| `src/modules/prm/**` | **Zero functional refs** — only one comment in `data/enrichers.ts` clarifying that PRM does NOT enrich `customers.customer`. Safe. |
| `src/modules/example/**` | Many refs, BUT example is **NOT in `enabledModules`**. Inert at runtime. |
| `.ai/qa/tests/**` | No refs to `customers/people`. |
| `scripts/**` | No refs. |

`src/modules/prm/index.ts` `requires`: `customer_accounts, directory, notifications, dictionaries, workflows` — **does not list `customers`**. Drop is clean.

## ACL impact

- `customers.*` ACL grants on the admin role come **only** from `@open-mercato/core/customers/setup.ts` `defaultRoleFeatures`.
- PRM `setup.ts` does **not** declare any `customers.*` feature in its `defaultRoleFeatures`.
- When `customers` is removed from `enabledModules`, the module isn't loaded → its `defaultRoleFeatures` is never merged into staff role ACLs by `ensureDefaultRoleAcls()`. No PRM-side cleanup is required.
- For tenants previously initialized with `customers` enabled, any persisted `customers.*` ACL rows become harmless dangling refs. Production still has no live tenants on this codebase.

## Risks

| Risk | Mitigation |
|---|---|
| Core upgrade changes the CRUD-factory list shape (e.g. nested pagination). | Stub returns the **factory's current shape**; the only inspector is our own integration runner, which only checks status code. Comment in the stub flags the shape-drift surface. Re-verify on next core bump. |
| The probe URL changes (e.g. `mercato test:integration` updates to a new endpoint). | Out of our control — would require either updating the stub path or restoring `customers`. Tracked in POST-MVP-FOLLOW-UPS for path-(b) escalation. |
| A PRM route or test starts depending on `customers` after this PR. | Pre-flight grep shows zero such usage today. CI will catch any new usage via typecheck/build. |
| `yarn generate` produces structural-cache deltas that miss a module-removal step. | The full gate includes `yarn test:integration:ephemeral` against an ephemeral runtime — if generation is wrong, the runtime won't start. |

## Implementation Plan

### Phase 1 — Ship the stub route + unit test (single commit)

- 1.1 Create `src/modules/prm/api/customers/people/route.ts`:
  - `GET` handler, `requireAuth: true`, no `requireFeatures` (any authenticated user is sufficient — the probe logs in as admin so any auth gate is satisfied).
  - Response: `NextResponse.json({ items: [], total: 0, page: 1, pageSize, totalPages: 0 })` where `pageSize` is read from query (`?pageSize=1`) with safe defaults.
  - Header comment: stub for `@open-mercato/cli` integration-test readiness probe; pointer to POST-MVP-FOLLOW-UPS.
  - TODO with shape-drift caveat: revisit on core upgrade if the factory list shape changes.
  - Export `openApi: OpenApiRouteDoc` per AGENTS.md (every API route MUST export `openApi`).
- 1.2 Create `src/modules/prm/__tests__/customersPeopleStubRoute.test.ts`:
  - Mock `getAuthFromRequest` to return an authenticated principal.
  - Call `GET` with `?pageSize=1` (the canonical probe URL) and assert: status 200, JSON shape `{ items: [], total: 0, page: 1, pageSize: 1, totalPages: 0 }`.
  - Call `GET` without `pageSize` (default fallback) — still 200, shape preserved.
  - Call `GET` with `requireAuth` shortcut returning null → 401 (defensive).

### Phase 2 — Remove customers from src/modules.ts + refresh generated artefacts (single commit)

- 2.1 Edit `src/modules.ts`: drop the `{ id: 'customers', from: '@open-mercato/core' }` line and its trailing readiness-probe comment.
- 2.2 Run `yarn generate` to refresh `.mercato/generated/*` and the structural cache.
- 2.3 Verify `git status` shows generated files in expected diff. Stage `src/modules.ts` + any generated-file deltas.

### Phase 3 — Full validation gate (no commit)

Run, in order:

1. `yarn typecheck` — MUST exit 0.
2. `yarn test` — Jest, includes the new stub test.
3. `yarn test:integration:ephemeral` — **CRITICAL**. Boots an ephemeral runtime, runs the readiness probe against the new stub, and runs all Playwright specs. Must report green. This is the load-bearing proof that the stub satisfies the probe.
4. `yarn build` — production build sanity check.

If any step fails, fix-forward in a new commit; do not amend.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Ship the stub route + unit test

- [x] 1.1 Create `src/modules/prm/api/customers/people/route.ts` — 1119ca4
- [x] 1.2 Create `src/modules/prm/__tests__/customersPeopleStubRoute.test.ts` — 1119ca4

### Phase 2: Remove customers from src/modules.ts + refresh generated artefacts

- [x] 2.1 Drop `customers` entry from `src/modules.ts` — 5c504c0
- [x] 2.2 Run `yarn generate` to refresh generated files — 5c504c0 (no tracked file changes; `.mercato/generated` is gitignored. OpenAPI route count went from 179 → 150 confirming customers routes dropped.)

### Phase 3: Full validation gate

- [x] 3.1 `yarn typecheck` — 1f89ecb (clean exit 0)
- [x] 3.2 `yarn test` — 1f89ecb (43 suites / 406 tests passed)
- [ ] 3.3 `yarn test:integration:ephemeral` (CRITICAL) — running after Phase 4 fixes
- [ ] 3.4 `yarn build`

### Phase 4: Validation-gate blocker fixes (folded into this PR)

- [x] 4.1 Fix `directory_organizations` → `organizations` in
      Migration20260507062343 + Migration20260507100001 (pre-existing bug from T7;
      confirmed on `origin/develop`).
- [x] 4.2 Add `metadata.path = '/customers/people'` to stub route +
      pinning unit test (without this the route is registered under the module
      prefix as `/prm/customers/people` and the probe never hits the stub).

## Changelog

- 2026-05-07: plan drafted.
- 2026-05-07: Phase 1 + Phase 2 landed. Validation gate uncovered two pre-existing blockers
  on `develop` that needed fixing inside this PR to prove the stub works:

  **Blocker A — broken FK refs in T7 migrations.**
  Migration20260507062343 + Migration20260507100001 reference `directory_organizations`
  but the directory module declares the table as `organizations`. The earlier
  Migration20260506224954 already documents the same fix verbatim ("Directory core
  module declares the table as `organizations` (not `directory_organizations`); the
  original reference here failed at migrate time and blocked all ephemeral Playwright
  runs."). Confirmed bug exists on `origin/develop` with customers enabled (ran
  `yarn test:integration:ephemeral` from develop directly — same failure). Fix is
  mechanical: SQL string `directory_organizations` → `organizations` in the two
  newer migrations. Without this fix the validation gate could not run on either
  branch, so this PR cannot prove the customers-drop is correct without including it.

  **Blocker B — module-prefix collision on stub URL.**
  The framework's module-registry generator namespaces all `@app` routes under the
  module id by default (`reqSegs = [modId, ...segs]`), so a route at
  `src/modules/prm/api/customers/people/route.ts` would register as
  `/prm/customers/people` (not `/customers/people`). The probe expects
  `GET /api/customers/people`. Fix: set `metadata.path = '/customers/people'` on
  the stub route, which is the supported escape hatch in `resolveApiPathFromMetadata`
  (same generator file). The catch-all at `src/app/api/[...slug]/route.ts` strips
  the `/api/` prefix before matching the manifest, so the registered path uses
  the post-strip form. Added a unit test that pins this contract so any future
  drift fails CI loudly.
