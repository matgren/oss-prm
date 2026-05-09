# SPEC-2026-05-09 — Replace `OM_PRM_TEST_FIXTURES_ENABLED` HTTP test seams with Playwright DB fixtures

**Date**: 2026-05-09
**Status**: ❌ **ABANDONED** (2026-05-09)
**Successor**: `.ai/specs/SPEC-2026-05-09b-tenant-per-spec-integration-tests.md` (the rebuild)
**Origin**: GitHub issue [#39](https://github.com/matgren/oss-prm/issues/39)
**Owner**: —

---

## ⚠️ Postmortem — why this spec was abandoned

This spec went through 4 revisions, 2 adversarial reviews, an om-cto advisory, and most of a Phase 2 implementation before the architectural premise was recognised as wrong. **Both the spec and the test code it sought to replace were approached with single-tenant test thinking in a multi-tenant platform.**

### What happened

1. Issue #39 raised a real concern: 3 test-only HTTP routes shipping in the prod bundle, gated only by `OM_PRM_TEST_FIXTURES_ENABLED === '1'`.
2. This spec proposed replacing the routes with a Playwright `test.extend<{ db: PrmDbFixture }>` fixture that opens its own DI container + EntityManager.
3. Phase 1 probe (`scripts/probe-test-container.ts`) passed in pure Node via `tsx` — confirming `createRequestContainer()` works outside HTTP context.
4. Phase 2 implementation (helpers refactored, dbFixture stubs implemented, 33 spec files mechanically migrated, all typecheck-clean) hit a wall: **Playwright's TypeScript loader uses Babel with stage-3 (2023-05) decorators and does not honour `experimentalDecorators` from `tsconfig.json`.** MikroORM uses stage-1 decorators with metadata. The moment Playwright tried to load any spec file that transitively imported a PRM entity, it crashed with `TypeError: Cannot read properties of undefined (reading 'constructor')` at `@mikro-orm/core/decorators/PrimaryKey.js:10`.
5. Verified upstream: Playwright maintainers (microsoft/playwright#29646) explicitly reject adding stage-1 decorator support. Their guidance: "reference the compiled JS library rather than the TS source."

### The deeper miss

The PRM Playwright suite was designed around a **single shared tenant** — every spec wrote into the same tenant_id, then the test-fixtures `/reset` route TRUNCATEd between specs to keep them independent. The 3 test-only routes existed to paper over this single-tenant test design.

**OM is multi-tenant by construction.** Every entity has `tenant_id` + `organization_id`, every query is tenant-scoped. The market-leader Playwright pattern for multi-tenant apps — **tenant-per-spec** — gives you cross-spec isolation for free. No TRUNCATE seam needed. No `agency-member-link` seam needed (the invite flow can run for real with email interception per tenant). No `bulk-seed-agencies` seam needed (the perf smoke can use the production `POST /api/prm/agency` route into its own tenant).

The original test author and 4 spec revisions all reached for "TRUNCATE between specs" because the single-tenant frame was never questioned. Removing the seams without questioning the frame produced this spec — which fought Playwright internals rather than fixing the test architecture.

### What was deleted alongside this spec (2026-05-09)

- 3 routes under `src/modules/prm/api/test-fixtures/`
- 2 orphan unit tests (`testFixturesAgencyMemberLinkRoute.test.ts`, `testFixturesResetRoute.test.ts`)
- 4 helpers (`resetPrmState`, `linkAgencyMemberFixture`, `bootPartnerAgencyWithMembers`, `bulkSeedAgenciesFixture`)
- All 33 PRM Playwright integration specs in `.ai/qa/tests/integration/TC-PRM-*.spec.ts`
- The `OM_PRM_TEST_FIXTURES_ENABLED` env var + every documentation reference
- Phase 1+2 artifacts: `dbFixture.ts`, `prmTables.ts`, `dbFixture.test.ts`, `scripts/probe-test-container.ts`, `babel.config.js`
- The `resetPrmState` describe block in `testingIntegrationFixtures.test.ts`

### Lessons recorded

1. **In a multi-tenant platform, default to tenant-per-test.** No "shared state with cleanup" pattern unless the platform isn't multi-tenant.
2. **Adversarial reviews must include actual execution under the target runtime.** Both rounds verified API existence + logical correctness via reads + greps. Neither ran a Playwright test against the design. The failure mode (decorator loader) was 5 minutes to reproduce and would have been caught at rev 1.
3. **Playwright + ORM decorators is a known unfixable combination.** Playwright maintainers' answer is "compile your code first." For a multi-tenant project, this constraint is irrelevant because tenant-per-spec doesn't need to load entity classes in the test process at all.
4. **"Less is more."** When the implementation hits an architectural wall, deleting the broken work + the dependent tests + the smell is often the right move. Carrying broken code forward to preserve sunk effort is the worse trade.

---

## Original spec content (preserved as historical reference)

The remainder of this file is the spec as it stood when abandoned. Everything from this point forward describes a design that was implemented partway and then deleted. Read the successor spec for the rebuild plan.

---

## TLDR

Three test-only HTTP routes — `POST /api/prm/test-fixtures/{reset,agency-member-link,bulk-seed-agencies}` — currently ship in the production bundle, gated only by a runtime env-var equality check (`OM_PRM_TEST_FIXTURES_ENABLED === '1'`). Replace them with a Playwright `test.extend<{ db: PrmDbFixture }>` fixture that bootstraps DI via `bootstrapTest()` then opens an EM via `createRequestContainer()`, then delete the routes, the env var, and every documentation band-aid that orbits them.

**Scope:**
- Add `src/modules/prm/testing/integration/dbFixture.ts` — Playwright fixture providing a tenant-scoped EM via `bootstrapTest()` + `createRequestContainer()`.
- Migrate three existing test helpers (`resetPrmState`, `linkAgencyMember`, `bulkSeedAgencies`) from HTTP-based to direct-EM. Helper signatures unchanged.
- Delete `src/modules/prm/api/test-fixtures/` (3 route files + directory) and **two** orphan unit tests; **surgically remove** the `resetPrmState` describe block (lines 243-280) from a third unit test, leaving its other 4 describe blocks (covering unrelated portal/license-deal fixtures) untouched.
- Remove `OM_PRM_TEST_FIXTURES_ENABLED` from every doc + source-comment surface in this repo. Confirmed hit list (`grep -rln OM_PRM_TEST_FIXTURES_ENABLED`): `AGENTS.md`, `.env.example`, 1 functional spec (`SPEC-2026-05-08-agency-member-deactivation.md`), 3 integration spec files, 4 source-code files (`fixtures.ts`, `customerAuth.ts`, `perfAgencyBulkSeed.ts`, `lib/rfpService.ts`), 1 unit test (`testingIntegrationFixtures.test.ts`). Leave `.ai/runs/*.md` historical logs untouched.
- Production-bundle verification command in acceptance — **using the correct `distDir`** with a fail-loud guard so a missing build directory cannot mask the bug.

**Out of scope:**
- `serviceAuthMiddleware.ts` (real prod auth surface, not a test seam).
- `OM_PRM_WIC_IMPORT_SECRET` (real prod auth gate on `/api/prm/service/wic/*`, unrelated).
- Extracting the fixture to `@open-mercato/shared` (OM convention is "extract on second use"; PRM is use #1; upstream contributions tracked separately in `.ai/specs/POST-MVP-FOLLOW-UPS.md`).
- Refactoring sibling OM-core smell at `apps/mercato/src/modules/ratelimit_probe/api/ping/route.ts` (gated by `OM_INTEGRATION_TEST`; tracked as upstream contribution post-merge).

## Problem Statement

Three routes under `src/modules/prm/api/test-fixtures/` ship in the production bundle:

| Route | Operation | Blast radius if invoked in prod |
|---|---|---|
| `POST /reset` | `TRUNCATE prm_* CASCADE` across 14 tables | **Catastrophic** — all PRM data wiped |
| `POST /agency-member-link` | Inserts active linked `AgencyMember` bypassing invite/email/accept | High — privilege grant without paper trail |
| `POST /bulk-seed-agencies` | Bulk-inserts up to 2000 paired `Organization`+`Agency` rows via raw SQL, no events | High — data pollution, no audit |

Each is gated **only** by a single runtime check:

```ts
if (process.env.OM_PRM_TEST_FIXTURES_ENABLED !== '1') return notFound()
```

The current defenses are:
1. Strict `=== '1'` equality (any other value → 404).
2. Byte-identical 404 to non-existent routes (no signal leak to probers).
3. Auth: staff Bearer JWT with `prm.agency.invite_admin` (which a test fixture should not be sharing with).

Defense #2 is itself a tell — the original author knew shipping these in the prod bundle was risky.

**Why it's wrong:**

1. **Test infrastructure should not ship to production at all.** Build-time exclusion strictly dominates runtime gates.
2. **Single-layer protection of destructive operations.** Anyone who can flip an env var (CI export leak, copy-paste from staging, container env mutation, accidental `.env` import) gets a `TRUNCATE prm_*` button.
3. **OpenAPI surface still documents the routes** in production builds — the `openApi` exports compile in regardless of the runtime gate.
4. **Manual setup ritual** (`AGENTS.md` documents "remember to export `OM_PRM_TEST_FIXTURES_ENABLED=1` before integration tests") is paper-cut friction that has caused real test-suite failures (13/26 tests silently 404 when the var is unset).

## Proposed Solution

Replace the three routes with a Playwright `test.extend` fixture that:
1. Bootstraps DI registrars + ORM entities + entity IDs in the test process via the canonical `bootstrapTest()` helper.
2. Opens its own DI container via `createRequestContainer()` (the same helper the existing routes use).
3. Runs the operations directly from the test process against the same `DATABASE_URL` the running app uses.

### Why `bootstrapTest()` + `createRequestContainer()` and not standalone `MikroORM.init`?

`createRequestContainer()` (in `node_modules/@open-mercato/shared/src/lib/di/container.ts`) is the platform's single source of truth for wiring the EntityManager + encryption pipeline + all DI registrations. It's plain Node — no Next.js dependency.

**However**, calling it bare from a Playwright test process throws: `getDiRegistrars()` (line 33-38) requires `registerDiRegistrars()` to have run first. The Next.js app + the `mercato` CLI bootstrap registrars before invoking the container; a bare test process does not.

OM ships a canonical helper for exactly this case at `node_modules/@open-mercato/shared/src/lib/testing/bootstrap.ts`:

```ts
import { bootstrapTest } from '@open-mercato/shared/lib/testing/bootstrap'
await bootstrapTest({
  modules,        // from @/modules
  entityIds,      // from @/entity-ids
  ormEntities,    // from @/orm-entities
  diRegistrars,   // from @/di-registrars (or equivalent app-context aggregation)
})
```

This wires `registerModules`, `registerEntityIds`, `registerOrmEntities`, `registerDiRegistrars` against the global registries that `createRequestContainer()` reads from. Once bootstrapped, `createRequestContainer()` works identically to the in-app call.

Re-implementing MikroORM init in test code would:
- Duplicate ORM config (entities, naming strategy, migrations path).
- Re-register encryption helpers manually (or skip them and break decryption-aware queries).
- Drift from the platform whenever `createRequestContainer` changes.

### Design Decisions

| Decision | Rationale |
|---|---|
| Use `bootstrapTest()` then `createRequestContainer()` | Canonical OM-shipped helpers; `bootstrapTest` was added precisely for this use case (see its JSDoc). Encryption pipeline included. |
| Fixture lives at `src/modules/prm/testing/integration/dbFixture.ts` | Co-located with existing PRM testing helpers (`fixtures.ts`, `customerAuth.ts`, `perfAgencyRoster.ts`, `perfAgencyBulkSeed.ts`). |
| Do NOT extract to `@open-mercato/shared` | OM convention: extract on second use. PRM is use #1. Upstream contribution tracked separately. |
| `em.execute('TRUNCATE prm_* CASCADE')` + explicit commit, NOT transaction-rollback | Two reasons: (a) Postgres MVCC — running app's EM only sees committed mutations, so rollback fixtures would be invisible to the app under test; (b) OM ships **no per-test isolation primitive** (`grep -r "savepoint\|withTransaction\|schema.*per.*test"` in `node_modules/@open-mercato/*` → no match). Inventing one is out of scope. |
| `container.dispose()` in fixture teardown | Each spec file forks its own container; without disposal, connection-pool exhausts after ~6 spec files. |
| Keep `prm_*` table list canonical in fixture, mirroring `reset/route.ts` | Same source-of-truth pattern (entity table names from `data/entities.ts`); fixture inherits the same maintenance contract. |
| Bulk-seed retains "no events" semantic | Perf-smoke (`TC-PRM-T5-PERF-001`) needs <1s setup; emitting 500 events would dominate runtime. |
| Runtime assertion: `workers > 1` is fatal | Playwright config currently runs `workers: 1`. The fixture's commit-not-rollback semantics + shared DB make concurrent workers data-corruption-prone. Fail loud at fixture init if anyone bumps workers in the future, instead of letting silent data corruption surface as flaky tests. |

## Architecture

### What disappears

```
src/modules/prm/api/test-fixtures/
├── agency-member-link/route.ts             [DELETE]
├── bulk-seed-agencies/route.ts             [DELETE]
└── reset/route.ts                          [DELETE]

src/modules/prm/__tests__/
├── testFixturesAgencyMemberLinkRoute.test.ts   [DELETE — orphan, route gone]
└── testFixturesResetRoute.test.ts              [DELETE — orphan, route gone]

OM_PRM_TEST_FIXTURES_ENABLED                     [REMOVE from all docs, .env.example, source comments]
```

### What appears

```
src/modules/prm/testing/integration/
└── dbFixture.ts                    [NEW]
    ├── exports test = base.extend<{ db: PrmDbFixture }>({...})
    ├── PrmDbFixture has methods: resetPrm(), linkAgencyMember(), bulkSeedAgencies()
    ├── init: bootstrapTest({...}) → createRequestContainer() → resolve('em').fork()
    ├── teardown: container.dispose()
    └── runtime guard: throws if Playwright workers > 1
```

### What gets rewritten

| File | Change |
|---|---|
| `src/modules/prm/testing/integration/fixtures.ts` | `resetPrmState()` switches from `apiRequest('POST', '/api/prm/test-fixtures/reset', ...)` to direct `db.resetPrm()` call. **Signature changes** from `(request: APIRequestContext, token: string)` to `(db: PrmDbFixture)` — `request` and `token` are HTTP-specific and no longer needed. |
| `src/modules/prm/testing/integration/customerAuth.ts` | `linkAgencyMember()` switches to `db.linkAgencyMember()`. **Also scrub** lines 18-20 (JSDoc), 192-194 (JSDoc), 213 (URL string), 235 (error message), 241 (error message) — every reference to `/api/prm/test-fixtures/...` and `OM_PRM_TEST_FIXTURES_ENABLED`. |
| `src/modules/prm/testing/integration/perfAgencyBulkSeed.ts` | `bulkSeedAgencies()` switches to `db.bulkSeedAgencies()`; signature unchanged. |
| `src/modules/prm/testing/fixtures/perfAgencyRoster.ts` | Scrub line 6 comment referencing `/api/prm/test-fixtures/bulk-seed-agencies`. |
| `src/modules/prm/__tests__/testingIntegrationFixtures.test.ts` | **Surgical removal**, NOT full rewrite. File has 5 describe blocks at lines 52, 95, 149, 195, 243. Only the L243 `resetPrmState` block is tied to a deleted route — remove L243-280 only. The other 4 blocks (`getProspectViaPortalFixture`, `transitionProspectViaPortalFixture`, `attributeLicenseDealFixture`, `listGoldenRuleCandidatesFixture`) cover unrelated production-route contracts and **must stay**. *(REV 2 incorrectly authorized whole-file deletion — would have lost coverage on 4 unrelated fixtures.)* |

The three helper functions change signature: `(request, token, …)` → `(db, …)`. Spec files update in two places per file: (a) import `test` from `dbFixture` instead of bare `@playwright/test`, and (b) destructure `db` from the fixture and pass it to the helpers. Total estimated change: ~60 lines across ~20 spec files (3 lines each, mechanical). *(REV 4 corrected the prior REV 3 wording that incorrectly claimed signatures were unchanged — see om-cto advisory and Path A vs Path B analysis in the changelog.)*

### Fixture sketch (illustrative — implementation phase finalizes)

```ts
// src/modules/prm/testing/integration/dbFixture.ts
import { test as base } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { bootstrapTest } from '@open-mercato/shared/lib/testing/bootstrap'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
// Confirmed against src/bootstrap.ts:33-38 — the canonical app-context aggregation paths.
import { modules } from '@/.mercato/generated/modules.app.generated'
import { entities } from '@/.mercato/generated/entities.generated'
import { diRegistrars } from '@/.mercato/generated/di.generated'
import { E as entityIds } from '@/.mercato/generated/entities.ids.generated'

const PRM_TABLES = [
  'prm_agency_members', 'prm_prospect_candidate_index',
  'prm_rfp_response_scores', 'prm_rfp_responses', 'prm_rfp_broadcasts',
  'prm_rfps', 'prm_license_deals', 'prm_prospects', 'prm_agencies',
  'prm_case_studies', 'prm_marketing_materials',
  'prm_wic_contributions', 'prm_wic_import_audit_log',
  'prm_service_idempotency_key',
] as const

export type PrmDbFixture = {
  em: EntityManager
  resetPrm(): Promise<void>
  linkAgencyMember(input: LinkAgencyMemberInput): Promise<{ memberId: string }>
  bulkSeedAgencies(rows: BulkSeedAgencyRow[], tenantId: string): Promise<void>
}

export const test = base.extend<{ db: PrmDbFixture }>({
  db: async ({}, use, testInfo) => {
    if ((testInfo.config.workers ?? 1) > 1) {
      throw new Error(
        '[dbFixture] Playwright workers > 1 is unsupported — fixture relies on serial-worker semantics for shared-DB safety.'
      )
    }
    await bootstrapTest({ modules, entityIds, ormEntities: entities, diRegistrars })
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    await use({
      em,
      resetPrm: () => em.execute(
        `TRUNCATE ${PRM_TABLES.join(', ')} RESTART IDENTITY CASCADE`
      ),
      linkAgencyMember: async (input) => { /* persist + flush */ },
      bulkSeedAgencies: async (rows, tenantId) => { /* raw SQL bulk insert + commit */ },
    })
    await container.dispose()
  },
})
```

## Implementation Plan

Each phase is independently testable and committable. Phase 1 ends in a **go/no-go gate** that determines whether estimate stays at 4-6h or expands to 8-12h.

### Phase 1 — Add the fixture + DI bootstrap probe (NO deletes yet)

1. Create `src/modules/prm/testing/integration/dbFixture.ts` with the structure above.
2. **Probe (go/no-go gate):** Write a tiny standalone Node script (`scripts/probe-test-container.mjs` or equivalent) that calls `bootstrapTest({...}) + createRequestContainer() + resolve('em').fork() + em.execute("SELECT 1") + container.dispose()`. Run with `NODE_ENV=test DATABASE_URL=<ephemeral>` from the repo root. **Verify:**
   - `getDiRegistrars()` does NOT throw.
   - The `@/di` dynamic import (line 78 of `container.ts`) actually resolves from a Playwright spec context (it uses Webpack path aliasing in the Next runtime; verify it works under raw `tsx` / Playwright's runner).
   - `findOneWithDecryption(em, ...)` returns expected results against an encrypted column (proves encryption pipeline registered).
   - `container.dispose()` releases the connection (subsequent `pg_stat_activity` query shows pool freed).
3. **Decision point:**
   - **Probe passes** → continue to Phase 2. Estimate stays 4-6h.
   - **Probe fails** → expand scope: extract a slimmer `createTestContainer({ tenantId })` helper that takes the EM + encryption-only subset of the container's responsibilities. This adds 4-6h. Update the spec status, re-estimate, get user approval before continuing.
4. Add a small Jest unit smoke (`src/modules/prm/__tests__/dbFixture.test.ts`) that asserts the fixture imports cleanly and the `PRM_TABLES` constant is in sync with the actual `@Entity({ tableName: ... })` decorators in `src/modules/prm/data/entities.ts` (the canonical source of truth — independent of the about-to-be-deleted `reset/route.ts`). The check: parse `data/entities.ts` for `tableName: 'prm_*'` strings via reflection metadata or AST and assert set equality. *(REV 2 incorrectly anchored this against `reset/route.ts`, which Phase 3 deletes — would have left an unimportable test reference.)*

**Validates:** the architectural assumption is sound before any deletes happen.

### Phase 2 — Migrate the three helpers

1. Implement `db.linkAgencyMember()` and `db.bulkSeedAgencies()` real bodies in `dbFixture.ts` (mirror the deleted route handlers' logic).
2. Update `src/modules/prm/testing/integration/fixtures.ts`: `resetPrmState(db: PrmDbFixture)` calls `db.resetPrm()`. Drop `(request, token)` params.
3. Update `src/modules/prm/testing/integration/customerAuth.ts`: `linkAgencyMemberFixture(db, input)` calls `db.linkAgencyMember(input)`. Drop `(request, staffToken)` params.
4. Update `src/modules/prm/testing/integration/perfAgencyBulkSeed.ts`: `bulkSeedAgenciesFixture(db, agencies, tenantId)` calls `db.bulkSeedAgencies(agencies, tenantId)`. Drop `(request, token)` params.
5. Wire each helper's spec files to use the new `test` import from `dbFixture.ts` instead of bare `@playwright/test`, and destructure `db` from the fixture. Mechanical: ~3 line edits per spec file (1 import source, 1-2 call site arg changes). 1 reference spec file done first (`TC-PRM-T0-001-agency-happy-path.spec.ts`), remaining ~19 batched in parallel after pattern is validated.
6. Run `unset OM_PRM_TEST_FIXTURES_ENABLED && yarn test:integration:ephemeral` — full suite must pass.

**Validates:** the new fixture is functionally equivalent to the routes it replaces.

### Phase 3 — Delete the routes and BOTH orphan unit tests

1. Delete `src/modules/prm/api/test-fixtures/` (3 route files + directory).
2. Delete `src/modules/prm/__tests__/testFixturesAgencyMemberLinkRoute.test.ts`.
3. Delete `src/modules/prm/__tests__/testFixturesResetRoute.test.ts`. *(MISSED IN REV 1 — caught by adversarial review.)*
4. Run `yarn generate` (in case route discovery cached anything) and `yarn build`.
5. Re-run `yarn test:integration:ephemeral` — full suite still green.

**Validates:** the routes are not still in use; build still succeeds.

### Phase 4 — Scrub documentation, source comments, and surgically remove the third unit test's resetPrmState block

The canonical scrub list comes from `grep -rln OM_PRM_TEST_FIXTURES_ENABLED .` (excluding `.ai/runs/` and this spec). Verified hit list:

| File | Action |
|---|---|
| `AGENTS.md` | Delete the `OM_PRM_TEST_FIXTURES_ENABLED` row from the "Integration test environment" table. Leave `OM_PRM_WIC_IMPORT_SECRET` row alone — different env var, different purpose. |
| `.env.example` | Delete the "PRM Test Fixtures" block (verify presence; if absent, no-op). |
| `.ai/specs/SPEC-2026-05-08-agency-member-deactivation.md` | Remove inline references to the env var. |
| `.ai/qa/tests/integration/TC-PRM-T0-001-agency-happy-path.spec.ts` | Remove the env-var prerequisite comment block. |
| `.ai/qa/tests/integration/TC-PRM-T0-007-agency-member-deactivation.spec.ts` | Remove the env-var prerequisite comment block. |
| `.ai/qa/tests/integration/TC-PRM-T5-PERF-001-eligibility-evaluator-500-agencies.spec.ts` | Remove the env-var prerequisite comment block. |
| `src/modules/prm/testing/integration/fixtures.ts` | **JSDoc scrub** at line 13 — references the deleted env var as part of the helper's contract description. Phase 2 rewrites the body but does not touch JSDoc; explicit Phase 4 entry prevents JSDoc rot. |
| `src/modules/prm/testing/integration/customerAuth.ts` | **Source-code change.** `linkAgencyMemberFixture` switches to `db.linkAgencyMember()`. **Signature changes** from `(request, staffToken, input)` to `(db, input)`. Lines 18-20, 192-194 (JSDoc); line 213 (URL string in active code); lines 235, 241 (error messages) — replace JSDoc to describe the new `db` fixture path; remove the URL string entirely; rewrite error messages to refer to fixture state, not HTTP 404s. |
| `src/modules/prm/testing/integration/perfAgencyBulkSeed.ts` | **Source-code change.** `bulkSeedAgenciesFixture` switches to `db.bulkSeedAgencies()`. **Signature changes** from `(request, token, agencies)` to `(db, agencies, tenantId)`. JSDoc at line 9 also scrubbed (Phase 4 catches the rot). |
| `src/modules/prm/testing/fixtures/perfAgencyRoster.ts` | **Source-code change.** Line 6 — comment refers to `/api/prm/test-fixtures/bulk-seed-agencies`. Update to reference the new `db.bulkSeedAgencies()` fixture. |
| `src/modules/prm/lib/rfpService.ts` | **Production code comment scrub** at line 276. The comment says "Mirrors the `OM_PRM_TEST_FIXTURES_ENABLED` convention" — describing the gating pattern of an unrelated test-only env var (`OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL`, lines 280-284, which **stays** — it's a separate fault-injection seam owned by Spec #5 §9.1 #4). Rewrite the comment to describe the gating pattern in its own terms instead of referencing the about-to-be-deleted convention. The `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` env var itself is not affected. |
| `src/modules/prm/__tests__/testingIntegrationFixtures.test.ts` | **Surgical removal of L243-280** (the `resetPrmState` describe block). The other 4 describe blocks (L52, L95, L149, L195) cover unrelated production-route contracts — leave them untouched. *(REV 2 incorrectly authorized whole-file deletion; would have lost coverage on 4 unrelated fixtures.)* |

**Do NOT touch:**
- `.ai/runs/*.md` — frozen historical run logs; leave as-is.
- `OM_PRM_WIC_IMPORT_SECRET` references anywhere — different env var, different purpose, stays.
- This spec file (obviously).

### Phase 5 — Verify the production bundle is clean

1. Run `yarn build`.
2. Run the bundle-verification command (Acceptance #5 below) **with the correct `distDir`** and a fail-loud directory check.
3. Inspect the generated OpenAPI doc and confirm no `test-fixtures` paths appear.

**Validates:** the routes are not just deleted from source — they're not in the prod bundle either.

## Acceptance Criteria

- [ ] **Routes deleted.** `find src/modules/prm/api -name 'test-fixtures' -type d` returns nothing.
- [ ] **Both orphan tests deleted.** Neither `testFixturesAgencyMemberLinkRoute.test.ts` nor `testFixturesResetRoute.test.ts` exists.
- [ ] **Third unit test rewritten or deleted.** `testingIntegrationFixtures.test.ts` either exercises the new `db.*` fixture methods OR is deleted with a POST-MVP follow-up entry documenting the missing coverage.
- [ ] **Env var removed from runtime checks AND source comments.** `grep -rn 'OM_PRM_TEST_FIXTURES_ENABLED' src/ AGENTS.md .env.example .ai/specs/ .ai/qa/` returns zero hits (with the exception of this spec, which documents the deletion).
- [ ] **No `/api/prm/test-fixtures/` references in source code.** `grep -rn '/api/prm/test-fixtures' src/` returns zero hits.
- [ ] **Full integration suite green without the env var set.** `unset OM_PRM_TEST_FIXTURES_ENABLED && yarn test:integration:ephemeral` passes 26/26 (or current expected pass count, minus only the pre-existing POST-MVP-tracked T5-001 #1 cross-spec isolation failure).
- [ ] **Production bundle is clean.** After `yarn build`, this exact command succeeds:
  ```bash
  test -d .mercato/next/server/app/api || { echo "BUILD DIR MISSING — verification cannot run"; exit 2; }
  test -n "$(ls -A .mercato/next/server/app/api 2>/dev/null)" || { echo "BUILD DIR EMPTY — verification cannot run"; exit 2; }
  if grep -r "test-fixtures" .mercato/next/server/app/api/; then
    echo "FAIL: test-fixtures route handlers found in production bundle"; exit 1
  fi
  echo "PASS: no test-fixtures handlers in production bundle"
  ```
  *(REV 1 incorrectly used `.next/server/app/api/`. This app sets `distDir: '.mercato/next'` in `next.config.ts:8`. The `test -d` guard prevents a missing build dir from masking a real positive; the `test -n` guard catches the empty-dir edge case where `grep -r` against an empty dir would misleadingly print "PASS".)*
- [ ] **OpenAPI doc is clean.** With dev server running: `curl -s http://localhost:3000/api/docs/openapi | jq -r '.paths | keys[]' | grep -c test-fixtures` returns `0`.
- [ ] **Unit smoke for the fixture passes.** `yarn jest src/modules/prm/__tests__/dbFixture.test.ts` is green.
- [ ] **Workers > 1 throws.** A unit test confirms the runtime assertion fires when fed a config with `workers: 2`.
- [ ] **No new lint / typecheck errors.** `yarn lint && yarn typecheck` is green.

## Risks

| ID | Risk | Severity | Mitigation | Residual |
|----|------|----------|------------|----------|
| **R1** | `createRequestContainer()` from a Playwright test process fails: `getDiRegistrars()` throws (line 33-38 of `container.ts`) because no module has called `registerDiRegistrars()` yet. The `@/di` app-context dynamic import at line 78 may also fail to resolve outside the Next.js runtime, causing app-level DI overrides to silently not fire. | **High** *(was Medium in rev 1)* | **Mandatory:** Phase 1 step 1 calls `bootstrapTest({ modules, entityIds, ormEntities, diRegistrars })` BEFORE `createRequestContainer()`. The probe (Phase 1 step 2) explicitly verifies: (a) DI registrars are wired; (b) `@/di` resolves OR documents that app-level overrides are skipped (acceptable for test process if no test-relevant override exists); (c) `findOneWithDecryption` works against an encrypted column. | If even `bootstrapTest()` doesn't unblock, fall back to extracting a slimmer `createTestContainer({ tenantId })` helper that takes the EM + encryption-only subset. **This is a 4-6h scope expansion** — flagged in estimate header. |
| **R2** | Connection-pool exhaustion if the fixture forgets to dispose the container, especially after test failures. | **High** | `await use()` is wrapped so the code AFTER `await use()` always runs (Playwright fixture contract). Phase 1 unit smoke explicitly asserts `container.dispose()` releases the connection (`pg_stat_activity` check). | If a test crashes the process (OOM, `process.exit`), pool may leak — true of any test process and acceptable. |
| **R3** | Postgres MVCC: running app's EM doesn't see test-process mutations until commit; a transaction-rollback fixture would silently break tests asserting via HTTP. | **High** | Spec mandates `em.execute(TRUNCATE)` + explicit commit, NOT a transaction-rollback pattern. Acceptance criterion 6 (full integration suite green) catches regressions empirically. **Reinforced by**: OM ships no per-test isolation primitive (`grep -r "savepoint\|withTransaction\|schema.*per.*test"` in `node_modules/@open-mercato/*` → no match), so rollback-style fixtures are not buildable in-platform anyway. | None if the spec is followed. |
| **R4** | Deleting `agency-member-link` breaks an in-flight branch (e.g. some other dev's WIP test). | **Low** | `git grep test-fixtures origin/develop..HEAD` before merging. Spec covers all known consumers. | Possible 30-minute rebase pain for parallel branches; not a blocker. |
| **R5** | The fixture has bugs that don't surface until concurrent workers (data corruption from shared DB). | **Mitigated** | New runtime guard: `dbFixture.ts` throws if `testInfo.config.workers > 1` (acceptance criterion 9). Today's config is `workers: 1` (`.ai/qa/tests/playwright.config.ts:34`). Future bumps fail loud at fixture init. | None — guard prevents the failure mode entirely. |
| **R6** | App-context aggregation paths required by `bootstrapTest()` must resolve from a Playwright spec context. Paths confirmed against `src/bootstrap.ts:33-38`: `@/.mercato/generated/{modules.app,entities.ids,entities,di}.generated`. | **Low** *(was Medium in rev 2 — paths now confirmed)* | Fixture sketch already cites the exact paths. Phase 1 step 2 still verifies the imports resolve under Playwright's TypeScript runner (which honors the same tsconfig but uses esbuild/swc, not webpack). | If paths are present but resolver-mode-incompatible (e.g. ESM vs CJS), Phase 1 probe reports the failure and a `tsconfig.test.json` override may be needed. |

## Open Questions

None blocking spec approval. R1 + R6 are the two architectural unknowns and Phase 1 step 2 resolves both before any deletes happen.

## BC Impact

- **Customer-facing impact:** **None.** No product code changes; no API contract changes; no UI changes; no DB schema changes.
- **Test infrastructure impact:** Internal — Playwright spec files import `test` from `dbFixture.ts` instead of from `@playwright/test`. Test-helper signatures (`resetPrmState`, `linkAgencyMember`, `bulkSeedAgencies`) unchanged.
- **Production bundle impact:** **Smaller.** Three route handlers + their `openApi` exports + the env-var check leave the bundle.
- **Migration impact:** **None.** No DB migrations.
- **Deployment impact:** **None.** No new env vars; one env var (`OM_PRM_TEST_FIXTURES_ENABLED`) becomes ignored. Deployment configs that set it (none expected; var is PRM-test-only) can drop the line in a follow-up cleanup.
- **Documentation impact:** Several doc surfaces simplify (the AGENTS.md "Integration test environment" table becomes a single-row table for `OM_PRM_WIC_IMPORT_SECRET` only).

## Anti-Patterns Avoided

- ❌ **Speculative re-extraction to `@open-mercato/shared`** — explicitly deferred until a second consumer appears (see POST-MVP-FOLLOW-UPS "Upstream contributions to file").
- ❌ **Re-implementing MikroORM init in test code** — explicitly rejected in favor of `bootstrapTest()` + `createRequestContainer()` reuse.
- ❌ **Transaction-rollback fixture pattern** — explicitly rejected because of (a) MVCC visibility constraints, (b) OM ships no per-test isolation primitive to build it on.
- ❌ **Touching `serviceAuthMiddleware.ts` or `OM_PRM_WIC_IMPORT_SECRET`** — explicitly out of scope; those are real prod auth surfaces.
- ❌ **Editing `.ai/runs/*.md`** — explicitly out of scope; frozen historical logs.
- ❌ **Trusting a runtime env-gate for prod safety** — that's the bug being fixed.
- ❌ **A bundle-verification command that silently succeeds when the build dir is missing** — REV 1 had this bug; REV 2 wraps in `test -d || exit 2`.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| Phase 1 — Add fixture + DI bootstrap probe | **Done** | 2026-05-09 | Probe GREEN. 4 files added (1 more than originally planned — `prmTables.ts` extracted for Jest module-resolution reasons). `linkAgencyMember` and `bulkSeedAgencies` are intentional Phase-2 stubs. See changelog row for probe details. |
| Phase 2 — Migrate the three helpers | Not Started | — | Awaiting user approval to dispatch. |
| Phase 3 — Delete routes and orphan tests | Not Started | — | — |
| Phase 4 — Scrub docs, source comments, surgical unit-test removal | Not Started | — | — |
| Phase 5 — Verify production bundle is clean | Not Started | — | — |

### Phase 1 — Detailed Progress

- [x] Step 1: Created `src/modules/prm/testing/integration/dbFixture.ts` (Playwright fixture, workers>1 guard, dispose teardown, resetPrm one-liner, Phase-2 stubs for the other two methods).
- [x] Step 1b: Created `src/modules/prm/testing/integration/prmTables.ts` (zero-dep canonical PRM table list — extracted to bypass Jest's `moduleNameMapper` not resolving `@/.mercato/*`).
- [x] Step 2: Created `scripts/probe-test-container.ts` (standalone go/no-go probe; 7 checks). Probe ran successfully against the local dev DB.
- [x] Step 3 (gate): **PROBE PASSED** — see changelog. R1 mitigation is sufficient as written; no scope expansion needed. Estimate stays 4-6h.
- [x] Step 4: Created `src/modules/prm/__tests__/dbFixture.test.ts` (3 assertions on PRM_TABLES sync with `data/entities.ts` decorators). Jest 3/3 green; typecheck clean; zero `any` casts.

### Phase 1 — Implementation Findings (for spec maintenance)

The following discoveries during Phase 1 are honest deltas from the spec text — not defects, just realities the spec couldn't pre-anticipate. The spec itself does not need a rev 4 for these; they're documented here so Phase 2+ can reference them.

1. **PRM has zero `@Encrypted` columns** — the spec assumed `Agency` or `AgencyMember.email` might be encrypted. They are not. Probe satisfies the encryption-pipeline check via `container.hasRegistration('tenantEncryptionService')` instead of running an actual decrypt query. This proves the pipeline is wired without needing PRM-side encrypted data.
2. **Jest `moduleNameMapper` doesn't handle `@/.mercato/*`** — the only mapping is `'^@/(.*)$': '<rootDir>/src/$1'`. Adding a `.mercato` mapping would have been a one-line jest.config.cjs change but was outside Phase 1's "additive only" guardrail. Workaround: `prmTables.ts` extraction. Phase 2+ should consider whether to add the jest.config mapping if more `@/.mercato/*`-importing tests are needed.
3. **`diRegistrars` from `@/.mercato/generated/di.generated` is typed `(((c: any) => void) | undefined)[]`** — has nullable entries. Filter with `(r): r is (container: unknown) => void => typeof r === 'function'` before passing to `bootstrapTest`. Both dbFixture.ts and the probe do this.
4. **Awilix `dispose()` does not invalidate `container.resolve()` calls** — post-dispose resolves still return cached values. The actual connection-pool release happens in MikroORM's ORM-level lifecycle. Non-blocking for our purposes (the fixture's teardown still releases the underlying pool); flagged so future debuggers don't waste time chasing it.
5. **Probe runs against dev DB at `localhost:5432/open-mercato`** — safe because the probe only `SELECT 1`s and never mutates. For production CI runs, the probe would target the ephemeral DB the integration runner provisions. Run with: `set -a && source .env && set +a && NODE_ENV=test npx tsx scripts/probe-test-container.ts`.

## Changelog

| Date | Change |
|------|--------|
| 2026-05-09 | Initial spec (rev 1, status: AWAITING APPROVAL). Source: GitHub issue #39 + om-cto advisory. |
| 2026-05-09 | **Rev 2** — addresses round-1 adversarial review findings: C1 (corrected bundle-verification path from `.next/` to `.mercato/next/` + added fail-loud guard), C2 (added second orphan test deletion + flagged third unit test for rewrite), H1 (R1 promoted to High; mandated `bootstrapTest()` call; cited canonical helper at `node_modules/@open-mercato/shared/src/lib/testing/bootstrap.ts`), H2 (Phase 1 step 2 marked as go/no-go gate; estimate now conditional 4-6h or 8-12h), H3 (Phase 4 expanded to include source-comment scrubs and unit test rewrite), M1 (transaction-rollback dismissal now cites OM-no-isolation-primitive evidence), M2 (added runtime workers > 1 assertion + acceptance criterion). New Risk R6 added for app-context import path discovery. |
| 2026-05-09 | **APPROVED** for implementation. Pipeline next step: dispatch om-implement-spec for Phase 1 only (the createRequestContainer probe is a go/no-go gate; user re-confirms scope before Phase 2). Sibling smell `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` discovered at `rfpService.ts:280` tracked in `.ai/specs/POST-MVP-FOLLOW-UPS.md` as a follow-up triggered by this PR merging. |
| 2026-05-09 | **Rev 4** — corrected Phase 2 wording. Rev 3's "Helper signature unchanged" claim contradicted the fixture sketch (per-test container via `test.extend<{ db }>` requires `db` to be a fixture-scoped value, which means helpers receive it as a parameter). Path A (pass `db` as param) confirmed by om-cto advisory: 6 findings supported it, including (a) Path B's module-level singleton requires inventing a `globalTeardown` pattern with zero OM precedent (verified via `gh search`), (b) Decentralization principle (#4) cuts against singleton hidden state, (c) Path B's "signature preserved" benefit is illusory — params become required-but-ignored noise. Per-spec change is ~3 lines (1 import source, 1-2 call-site args), ~60 lines total across ~20 spec files. Implementation strategy: 1 reference spec edit first to validate, then parallel agents for the rest. |
| 2026-05-09 | **Phase 1 COMPLETE — go/no-go gate is GREEN.** All 4 probe steps passed: bootstrapTest succeeded, createRequestContainer succeeded, `em.execute('SELECT 1')` returned correct shape, encryption pipeline wired (`container.hasRegistration('tenantEncryptionService') === true`), eventBus/queryEngine/commandBus all registered, `container.dispose()` completed without throwing. One soft warning: post-dispose `container.resolve('em')` does NOT throw — Awilix `dispose()` doesn't invalidate registrations; the actual MikroORM connection-pool release happens in ORM lifecycle, not Awilix. Documented as non-blocking. **Estimate stays 4-6h.** Ready for Phase 2 dispatch on user approval. |
| 2026-05-09 | **Rev 3** — addresses round-2 adversarial review findings: **CRITICAL** (changed `testingIntegrationFixtures.test.ts` from "rewrite or delete whole file" to "surgical removal of L243-280 only"; whole-file deletion would have lost coverage on 4 unrelated portal/license-deal fixtures at L52, L95, L149, L195). **HIGH** (Phase 4 file table corrected: added `src/modules/prm/lib/rfpService.ts:276` production-code comment scrub, added explicit JSDoc-rot entries for `fixtures.ts:13` and `perfAgencyBulkSeed.ts:9`, removed phantom `SPEC-2026-04-23-rfp-broadcast-response.md` entry which had zero env-var hits). **HIGH** (Phase 1 step 4 regression guard rewritten — was anchored against the about-to-be-deleted `reset/route.ts`; now snapshots against `data/entities.ts` table-name decorators, the actual canonical source). **MEDIUM** (fixture sketch import paths corrected: `@/modules` and `@/entity-ids` were wrong; actual paths per `src/bootstrap.ts:33-38` are `@/.mercato/generated/{modules.app,entities.ids,entities,di}.generated`). **LOW** (acceptance #7 bundle-verification command now also guards against the empty-build-dir edge case via `test -n "$(ls -A ...)"`). R6 severity downgraded from Medium to Low — paths now confirmed. |
