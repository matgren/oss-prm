# PRM Playwright integration testing

PRM uses **tenant-per-worker** Playwright integration tests. This guide
explains the architecture, the rules every spec author must follow, and
how to add new specs.

Authority: `SPEC-2026-05-09b-tenant-per-spec-integration-tests.md`.

## Why tenant-per-worker

PRM's first integration suite was built around a single shared tenant +
a `TRUNCATE prm_*` HTTP seam (`OM_PRM_TEST_FIXTURES_ENABLED`). That
shipped 3 test-only routes in the production bundle (issue #39) and was
deleted on 2026-05-09. The rebuild flips the model: every Playwright
worker mints its own fresh Tenant + Organization + admin User on
startup, and every spec runs against its worker's tenant.

Cross-spec isolation is **structural** — different `tenant_id` values
mean specs literally cannot see each other's data. There is no shared
state between specs, so there is no need for an inter-spec cleanup
seam (and therefore no temptation to ship one in production).

## Where things live

```
src/modules/prm/
├── __integration__/
│   ├── fixtures/
│   │   └── tenantFixture.ts          # Worker-scoped fixture (THE entry point)
│   └── TC-PRM-*.spec.ts              # Specs (module-local convention)
├── testing/integration/
│   ├── fixtures.ts                   # Helpers (createAgencyFixture, etc.)
│   ├── customerAuth.ts               # Customer-portal login + admin user creation
│   ├── wicFixtures.ts                # WIC service-identity headers + envelope
│   ├── portalRfpFixtures.ts          # Portal RFP draft / submit / inbox helpers
│   └── index.ts                      # Re-exports — import from here in specs
└── lib/
    └── broadcastFailureInjector.ts   # DI-overridable §9.1 #4 fault injection
                                        (replaced the env-var seam in Phase 0b)

scripts/
└── bootstrap-test-tenant.ts          # CLI wrapper for setupInitialTenant
                                        (interim — swaps to upstream
                                        `mercato test:bootstrap-tenant` once
                                        SPEC-2026-05-09d merges)
```

## The fixture in one screen

```ts
import { test, expect } from './fixtures/tenantFixture'
import { createAgencyFixture } from '../testing/integration'

test('TC-PRM-T0-001 — Agency onboarding', async ({ tenant }) => {
  const agencyId = await createAgencyFixture(
    tenant.request,        // APIRequestContext pre-authenticated as the
                           // tenant's admin (Authorization: Bearer …
                           // injected on every request).
    tenant.staffToken,     // The raw JWT, in case a helper needs to set
                           // its own auth header.
    { name: '...', slug: '...' },
  )
  // tenant.tenantId / tenant.organizationId — structural ids.
  // tenant.workerIndex   — 0..N-1, useful for slug uniqueness.
  // tenant.adminEmail / tenant.adminPassword — credentials, in case
  //                                            you need a second login.
  // tenant.orgSlug       — diagnostic / portal-route construction.
})
```

Behind the scenes, on each worker startup:
1. `tenantFixture` spawns `tsx scripts/bootstrap-test-tenant.ts` via
   `node:child_process` with `--admin-email=pw-w<N>-<ts>-<rand>-admin@pw.test`.
2. The script wraps `setupInitialTenant` from compiled `@open-mercato/core`,
   running in a clean Node subprocess (this is load-bearing — it keeps
   MikroORM decorators OUT of the Playwright runner process and
   sidesteps microsoft/playwright#29646).
3. The script prints credentials JSON to stdout; the fixture parses and
   logs in via real `POST /api/auth/login`.
4. The fixture builds a long-lived `APIRequestContext` with the
   `Authorization` header pre-set and yields the `tenant` object.
5. Teardown is a no-op — `mercato test:integration` drops the entire
   ephemeral DB at suite end. Per-tenant cleanup adds latency without
   benefit.

## Discipline rules (load-bearing)

These are the rules that prevent recurrence of the deleted env-var-gated
seam pattern. Every PR touching `__integration__/` is reviewed against
them.

### Rule 1 — Import allowlist for fixtures + specs

PRM `__integration__/` files (specs AND `fixtures/*.ts`) MUST only
import from:

- `@playwright/test`
- `@open-mercato/core/helpers/integration/*` (the OM upstream fixtures)
- PRM-local helpers in `src/modules/prm/testing/integration/*`
- Other PRM-local helpers in `src/modules/prm/__integration__/fixtures/*`
- `node:*` built-ins

PRM `__integration__/` files MUST NOT import from any of:

- `@/modules/*/lib/*`
- `@/modules/*/data/*`
- `@/modules/*/commands/*`
- Any other production internal

Rationale: production internals carry MikroORM decorators that
Playwright's loader rejects. The bootstrap subprocess + HTTP routes are
the only allowed channels into production behavior. Verification:

```bash
grep -rEn "^[^*]*from\s+['\"]@/modules/[^'\"]+/(lib|data|commands)/" \
  src/modules/prm/__integration__/
# → must return empty
```

### Rule 2 — No test-only routes, no env-var seams

- No file under `src/modules/*/api/test-fixtures/`.
- No file under `src/modules/*/api/_test_*`.
- No `if (process.env.NODE_ENV === 'test'` in production code paths.
- No `if (process.env.OM_*_TEST_*` (state-reset OR fault-injection style).

Verification:

```bash
grep -rn 'process\.env\.OM_[A-Z_]*_TEST_' src/modules/
# → must return empty
```

If you need test-time fault injection in production code (e.g., Spec #5
§9.1 #4 partial-insert rollback proof), use a **DI-overridable
injection point** instead — see `lib/broadcastFailureInjector.ts` for
the canonical pattern.

### Rule 3 — When OM core lacks a capability

Resolution order:
1. Upstream PR (real production capability, useful to all OM apps).
   Spawn a separate spec for the PR. PRM consumes it after merge.
2. Use an existing OM core pattern (e.g., `inbox_ops` extraction).
3. **Descope the test until 1 or 2 lands.** Adding a test seam in
   PRM is *not* on this list; it's treated at the same severity as a
   leaked credential.

### Rule 4 — Portal-entity coverage

Any new PRM domain entity that surfaces in the customer portal
(`[orgSlug]/portal/*` routes) MUST ship with at least one happy-path
portal-flow smoke spec at `src/modules/prm/__integration__/`. The
smoke spec lands in the same PR as the portal pages.

## Adding a new spec

1. Create `src/modules/prm/__integration__/TC-PRM-<CATEGORY>-<NNN>-<short-name>.spec.ts`.
2. Import the fixture: `import { test, expect } from './fixtures/tenantFixture'`.
3. Compose existing helpers from `'../testing/integration'` (don't
   reinvent — every PRM HTTP route already has a helper, see
   `testing/integration/index.ts` for the full list).
4. Run `rtk proxy npx playwright test --config .ai/qa/tests/playwright.config.ts --list`
   to verify discovery (does NOT execute — fast feedback for loader issues).
5. Run the suite via `yarn test:integration:ephemeral` (this brings up
   the ephemeral testcontainers DB + app server).

## Adding a new helper

If a route doesn't have a helper yet, add one to
`src/modules/prm/testing/integration/<area>Fixtures.ts` (create new
file or append to existing). Re-export from `index.ts`. Helpers MUST:

- Take `(request: APIRequestContext, token: string, ...)` as the prefix
  (or `(request, customerToken, ...)` for portal-side helpers).
- Go through real production routes via `apiRequest` /
  `customerApiRequest` (no SQL, no service container access).
- Use Playwright's `expect` for status-code assertions inside the
  helper so failures point to the helper line, not the spec line.

## Configuration

- **Worker count**: env-driven. `.ai/qa/tests/playwright.config.ts`
  reads `PW_WORKERS` and `PW_RETRIES` env vars (defaults 1 / 1 to
  match upstream convention). The `package.json` script
  `test:integration:ephemeral` sets `PW_WORKERS=4 PW_RETRIES=0
  mercato test:integration` to override for the PRM suite. Note: the
  mercato CLI's `test:integration` subcommand does NOT accept
  `--workers`/`--retries` flags directly (those are only on the
  `:interactive` parser) — env vars in the playwright.config.ts are
  the correct injection point.
- **Retries are 0** for PRM specs (R7 mitigation per spec) — a real
  cross-tenant leak under workers > 1 must fail hard, not get silently
  retried into a green status.

## Known constraints

- **Invite-acceptance flows are v2.** Specs that need a CustomerUser
  linked to an `AgencyMember.customerUserId` row are scaffolded as
  `test.skip` until SPEC-2026-05-09c (upstream PR for partner-invite
  notifications-tenant-admin-recipient-filter) merges and
  `@open-mercato/core` is bumped here. See spec headers of any
  `TC-PRM-*-001.spec.ts` with `test.skip`.
- **WIC ingestion is workers=1-only** until a request-header tenant
  override lands upstream (separate v2 follow-up). The `T3-001` spec
  is scaffolded skipped with the rationale documented.

## Reference paths

- Spec: `.ai/specs/SPEC-2026-05-09b-tenant-per-spec-integration-tests.md`
- Fixture: `src/modules/prm/__integration__/fixtures/tenantFixture.ts`
- Bootstrap CLI: `scripts/bootstrap-test-tenant.ts`
- Helper exports: `src/modules/prm/testing/integration/index.ts`
- Discipline gate (run pre-commit / per PR review): see Rule 2 above.
