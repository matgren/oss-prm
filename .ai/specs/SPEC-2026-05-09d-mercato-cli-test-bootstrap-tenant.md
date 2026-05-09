# SPEC-2026-05-09d — `mercato test:bootstrap-tenant` CLI subcommand (upstream contribution)

**Date**: 2026-05-09
**Status**: SUPERSEDED 2026-05-10 by upstream PR open-mercato/open-mercato#1879 (`feat(auth): add scriptable provisioning flags to mercato auth setup`). The capability this spec proposed — scriptable, non-interactive, fully-provisioned tenant bootstrap with a JSON contract — is delivered by 1879 via `mercato auth setup --orgSlug <slug> --json` instead of a new `test:bootstrap-tenant` namespace. PR #1879 supersedes the predecessor #1878 (the original direct attempt at this spec) for three reasons documented in 1879's body: (1) namespace mismatch — `test:` reads as test infra but the documented audience is production customer onboarding + DR; (2) #1878 used `(em as any).findOne` instead of `findOneWithDecryption` (the most-cited Piotr review pattern in OM core); (3) #1878 omitted `failIfUserExists: true` and would have silently clobbered foreign tenants. 1879 closes all three by extending the existing `auth setup` subcommand with `--orgSlug`, `--with-examples`, `--json` flags. Local consumer (`scripts/bootstrap-test-tenant.ts`) gets a one-line swap to wrap `mercato auth setup --orgSlug --json` once 1879 merges + this app bumps `@open-mercato/core`. This spec is preserved as decision history; do NOT implement.
**Target**: Upstream PR to `open-mercato/open-mercato` against the `@open-mercato/cli` package
**Spawned by**: `.ai/specs/SPEC-2026-05-09b-tenant-per-spec-integration-tests.md` (Phase 1b deliverable; see that spec's "Architecture Options" section, Option B, for full context on why this contribution exists)
**Estimate**: ~1 day to author code + tests; +~1 day for the upstream review cycle (variable, depends on maintainer turnaround)
**Owner**: TBD

---

## TLDR

OM staff need a scriptable, non-interactive way to bootstrap a fully-provisioned tenant (Tenant + Organization + admin User + role ACLs + every module's `onTenantCreated` hook) from the command line — for staging seeding, demo provisioning, customer onboarding scripts, and disaster-recovery restores. Today the only fully-provisioned bootstrap path is the interactive `mercato init`, which assumes a fresh DB. This spec adds a small `mercato test:bootstrap-tenant` subcommand that wraps the existing internal `setupInitialTenant` helper and prints the resulting credentials to stdout as JSON. As a secondary benefit, this unblocks the tenant-per-worker Playwright fixture in SPEC-2026-05-09b (subprocess invocation cleanly escapes the MikroORM × Playwright stage-1-decorators loader collision documented in microsoft/playwright#29646).

## Problem Statement

OM staff today have no scriptable path for "create another tenant in an existing OM instance." The available paths are:

- **`mercato init`** (`node_modules/@open-mercato/core/src/modules/auth/cli.ts:24+`, calls `setupInitialTenant` at line 437) — interactive, prompts for prod-superadmin credentials, assumes a fresh DB, and is intended as a one-shot bootstrap step on a brand-new install. Not designed to run against an existing OM instance to add a new tenant.
- **`POST /api/directory/tenants`** (`node_modules/@open-mercato/core/src/modules/directory/commands/tenants.ts:44-97`) — public HTTP route, but only INSERTs a `Tenant` row and provisions a KMS DEK. It does NOT create an Organization, an admin User, role assignments, or fire any module's `onTenantCreated` lifecycle hook. A tenant created via this route is not usable for any real workflow until those steps are completed manually.
- **`mercato auth setup`** (`node_modules/@open-mercato/core/src/modules/auth/cli.ts:401-474`) — comes closest, but is a CLI command in the `auth` module's namespace, takes its arg shape, has no JSON-stdout contract, and is named "setup" which doesn't communicate "bootstrap one specific tenant for me right now."

The capability that's missing is the union of all three — same effect as `mercato init`, but: scriptable (no prompts), repeatable on an existing DB (mints a new tenant, doesn't assume fresh DB), with a structured JSON stdout contract suitable for piping into other scripts. `setupInitialTenant` (`node_modules/@open-mercato/core/src/modules/auth/lib/setup-app.ts:102-351`) already does the heavy lifting — it accepts an `EntityManager`, creates Tenant + Organization + primary User + role ACLs (via `ensureDefaultRoleAcls`), and at lines 340-344 fires `mod.setup.onTenantCreated({ em, tenantId, organizationId })` for every registered module. It's currently called by `mercato init` and `mercato auth setup`. This spec exposes it as a top-level `mercato test:` subcommand with a clean CLI contract.

## Proposed CLI Surface

```
mercato test:bootstrap-tenant \
  --slug <slug> \
  --org-name <name> \
  --admin-email <email> \
  --admin-password <password> \
  [--admin-display-name <name>] \
  [--with-examples]
```

**Output (stdout, single JSON object)**:

```json
{
  "tenantId": "<uuid>",
  "organizationId": "<uuid>",
  "adminUserId": "<uuid>",
  "adminEmail": "<email>"
}
```

**Exit codes**:
- `0` — success (JSON written to stdout)
- non-zero — failure with structured error message on stderr (e.g. `BOOTSTRAP_TENANT_FAILED: <reason>`)

**Idempotency / collision behavior**: if a tenant with the given `--slug` already exists, the command MUST exit non-zero with a clear `TENANT_SLUG_EXISTS` error. It MUST NOT silently overwrite, and MUST NOT silently merge into the existing tenant. Re-running with a fresh slug after a failure is the expected recovery path.

**`--with-examples`** mirrors the existing `mercato init` behavior of triggering each module's `seedExamples` lifecycle hook (used by demo provisioning and sales-engineering scripts that want a populated demo tenant out of the box). Default is OFF — bare bootstrap with no demo data.

**Required vs optional**: `--slug`, `--org-name`, `--admin-email`, `--admin-password` are all REQUIRED. There MUST NOT be a fallback default for any of these (no `admin@test.local` auto-default). Required args being required ensures production callers are explicit and prevents the subcommand from accidentally seeding test-friendly defaults into a prod database.

## Implementation Sketch

**Subcommand registration** — add to the existing `test` module's `cli` array in `packages/cli/src/mercato.ts` around line 1790 (next to `integration`, `ephemeral`, `interactive`, `coverage`, `spec-coverage`):

```ts
{
  command: 'bootstrap-tenant',
  run: async (args: string[]) => {
    await (await lazyIntegration()).runBootstrapTenant(args)
  },
},
```

Plus the matching `first === 'test:bootstrap-tenant'` shortcut around line 1072 (mirrors how `test:integration` etc. are wired).

**New file**: `packages/cli/src/lib/testing/bootstrap-tenant.ts` (sibling of `integration.ts`). Exports `runBootstrapTenant(args: string[]): Promise<void>`. Implementation outline:

1. Parse args (reuse the same `parseArgs` style as `mercato auth setup` at `cli.ts:403`); validate required args and exit non-zero with a clear usage message if anything is missing.
2. Construct a request-scoped DI container + EM via `createRequestContainer()` from `@open-mercato/shared/lib/di/container` (same path `mercato auth setup` uses at `cli.ts:430`).
3. Pre-check slug collision: query `Tenant` by slug; exit non-zero with `TENANT_SLUG_EXISTS` if found.
4. Call `setupInitialTenant(em, { orgName, primaryUser: { email, password, displayName, confirm: true }, includeDerivedUsers: false, modules: getCliModules() })` — `setupInitialTenant` already fires every module's `onTenantCreated` hook at lines 340-344 of `setup-app.ts`.
5. If `--with-examples` was passed, iterate `getCliModules()` and call `mod.setup?.seedExamples?.({ em, tenantId, organizationId, container })` for each (same pattern as `seed:defaults` already does in `mercato.ts` around line 1051 for `seedDefaults`).
6. Locate the primary admin user record from the `result.users` array (the entry where `roles` includes `'superadmin'` AND `created === true`); extract its `id` and `email`.
7. Write the JSON object to stdout as a single line. Do NOT mix log/banner output with the JSON payload — either route diagnostic logs through stderr only, or honor `OM_CLI_QUIET=1` (already supported in `mercato.ts:1828`) to suppress the banner and reduce stdout to the JSON payload alone.
8. On any thrown error, write a structured `BOOTSTRAP_TENANT_FAILED: <message>` line to stderr and exit non-zero.

**No new dependencies.** No changes to `setupInitialTenant` itself — pure wrapper. No changes to existing CLI commands.

## Test Plan (for the upstream PR)

**Unit tests** (`packages/cli/src/lib/testing/__tests__/bootstrap-tenant.test.ts`):
- Argument parsing: required args present → parses cleanly.
- Argument parsing: each required arg missing in turn → exits non-zero with a clear usage error mentioning the missing flag.
- `--with-examples` flag toggles correctly (default false; `--with-examples` flips it true).

**Integration test** (extend the existing CLI integration suite, or add a new spec): run `mercato test:bootstrap-tenant` against a fresh ephemeral DB (the same harness used by `mercato test:integration`), then assert:
- The printed JSON parses, `tenantId` / `organizationId` / `adminUserId` are valid UUIDs, `adminEmail` matches the input.
- The tenant is queryable via `SELECT * FROM tenants WHERE id = $1`.
- The organization is queryable and linked to the tenant.
- The admin user can authenticate via `POST /api/auth/login` with the provided credentials.
- Re-running with the same `--slug` exits non-zero with `TENANT_SLUG_EXISTS` and does NOT mutate the existing tenant.
- With `--with-examples`, at least one module's example data is present (pick a module that has a `seedExamples` hook with an observable side effect).

**Backwards compatibility**: pure addition. No existing CLI surface changes. No entity, schema, or behavior changes to `setupInitialTenant`. No changes to `mercato init` or `mercato auth setup`.

## Production Use Cases (Slack-explainability)

The subcommand passes the Slack-explainability test trivially — any OM staff member could write the following one-line invocations in Slack with no test context required:

- **Staging seeding** — populate a staging environment with N test tenants for QA / load testing:
  ```
  for i in {1..20}; do mercato test:bootstrap-tenant --slug acme-stg-$i --org-name "Acme Staging $i" --admin-email qa+$i@acme.test --admin-password $(openssl rand -base64 24); done
  ```
- **Demo provisioning** — sales engineering scripts a fresh demo tenant for a customer call, with branded org name, the prospect's email as admin, and example data populated:
  ```
  mercato test:bootstrap-tenant --slug bigcorp-demo --org-name "BigCorp Inc" --admin-email evaluator@bigcorp.com --admin-password 'TempDemo!2026' --with-examples
  ```
- **Customer onboarding** — operations runs the initial tenant provisioning when a new enterprise customer signs a contract, instead of clicking through the admin UI:
  ```
  mercato test:bootstrap-tenant --slug bigcorp-prod --org-name "BigCorp" --admin-email it-admin@bigcorp.com --admin-password "$BIGCORP_INITIAL_PW"
  ```
- **Disaster recovery / migrations** — re-create a tenant shell from backup metadata when restoring data into a fresh OM instance:
  ```
  mercato test:bootstrap-tenant --slug "$LOST_SLUG" --org-name "$LOST_ORG_NAME" --admin-email "$LOST_ADMIN" --admin-password "$(openssl rand -base64 32)"
  ```

The `test:` namespace prefix matches OM's existing convention (`mercato test:integration`, `mercato test:ephemeral`, etc. — see `packages/cli/src/mercato.ts:1790-1823`); it groups dev-tooling commands rather than implying "test-only seam." The subcommand itself is a general-purpose tenant-bootstrap tool that happens to also unblock the Playwright fixture in SPEC-2026-05-09b.

## Acceptance Criteria

- [ ] Subcommand is registered and callable as both `mercato test:bootstrap-tenant ...` (shortcut form, like `test:integration`) and `mercato test bootstrap-tenant ...` (long form).
- [ ] All four required args (`--slug`, `--org-name`, `--admin-email`, `--admin-password`) are validated; missing any required arg exits non-zero with a clear usage message naming the missing flag.
- [ ] JSON output schema matches the spec exactly: `{ tenantId, organizationId, adminUserId, adminEmail }`. JSON is the only content on stdout (banner suppressed via `OM_CLI_QUIET=1` or always routed to stderr).
- [ ] Idempotent on slug collision: passing an existing slug exits non-zero with `TENANT_SLUG_EXISTS`, does not overwrite, does not merge.
- [ ] `--with-examples` triggers each enabled module's `seedExamples` hook; default behavior (omitted flag) does not.
- [ ] All existing module `onTenantCreated` hooks fire (verified by an integration test that asserts a hook-side-effect for at least one core module).
- [ ] Unit + integration tests pass in OM core CI.
- [ ] Subcommand is documented in `packages/cli/README.md` (or wherever CLI command reference lives — discover during implementation; AGENTS.md at `packages/cli/AGENTS.md` is also a candidate).
- [ ] PR description leads with the production use cases (staging seeding / demo provisioning / customer onboarding / disaster recovery) — NOT with the test-infrastructure unblock — so upstream reviewers don't infer "test-only seam."
- [ ] Once merged + released, downstream apps can `yarn upgrade @open-mercato/cli` and immediately use `mercato test:bootstrap-tenant`.

## Anti-patterns to avoid

- ❌ **Naming the subcommand anything that screams "test" beyond the existing `test:` namespace prefix.** Don't make it `test:create-fake-tenant`, `test:seed-tenant-for-pw`, `test:provision-test-tenant`, etc. The subcommand is a general-purpose tenant-bootstrap tool; the `test:` prefix is purely the existing namespace for dev-tooling commands. Names that telegraph "test-only" will get rejected upstream as test seams masquerading as dev tools.
- ❌ **Adding any test-only branching inside `setupInitialTenant`.** The subcommand is a pure wrapper — no `if (process.env.NODE_ENV === 'test')`, no `if (process.env.OM_*_TEST_*)`, no flag plumbed through that toggles "test mode" inside the helper. If something needs to differ between test and prod usage, the difference belongs in the CLI wrapper, never in the helper.
- ❌ **Hardcoding test-friendly defaults** (e.g. "if no `--admin-email` provided, default to `admin@test.local`"). Required args MUST be required so prod uses are explicit and the subcommand can't accidentally seed weak defaults into a prod database. A staff member running this against staging or prod must be forced to pass real values.
- ❌ **Mixing JSON stdout with diagnostic log lines.** A consumer piping `mercato test:bootstrap-tenant ... | jq` must get clean parseable JSON. Banner / progress / log output goes to stderr or is suppressed via `OM_CLI_QUIET=1`.
- ❌ **Silently overwriting on slug collision** ("upsert" semantics). Slug collision is a programming error in the caller — fail loudly so the caller catches their bug, instead of silently merging into a foreign tenant.
- ❌ **Touching `mercato init` or `mercato auth setup`.** Both must remain unchanged. This is a pure addition, not a refactor.

## Sequencing Notes (relative to SPEC-2026-05-09b)

This upstream PR is authored as Phase 1b of SPEC-2026-05-09b and submitted to `open-mercato/open-mercato` early so the upstream review cycle runs in parallel with Phases 3–5 of the parent spec (which can proceed against an interim local script: `scripts/bootstrap-test-tenant.ts` in the consuming app, wrapping the same `setupInitialTenant` helper).

Once this PR merges and the consuming app bumps `@open-mercato/cli`, the parent spec's tenant fixture replaces the interim local-script invocation with `mercato test:bootstrap-tenant` in a one-line change and the local script is deleted.

**60-day exit gate** (mirrors SPEC-2026-05-09b Phase 6): if this PR has not merged upstream by 2026-07-08, the consuming app's local script becomes the permanent bootstrap path. The local script is itself not a test seam (it lives in `scripts/`, not in production code, and wraps a real production helper) so this is a tolerable fallback.

## PR Description (ready-to-use)

> Use this verbatim as the body of `gh pr create` against `open-mercato/open-mercato`.

### Title

`feat(cli): add mercato test:bootstrap-tenant subcommand for scriptable tenant provisioning`

### Body

```markdown
## Motivation

OM staff today have no scriptable, non-interactive way to bootstrap a fully-provisioned tenant (Tenant + Organization + admin User + role ACLs + every module's `onTenantCreated` hook) from the CLI. The available paths each fall short:

- `mercato init` is interactive and assumes a fresh DB.
- `POST /api/directory/tenants` only INSERTs a `Tenant` row + KMS DEK; no org, no user, no lifecycle hooks.
- `mercato auth setup` is in the `auth` namespace, has no JSON-stdout contract, and isn't named for the use case.

Concrete OM-staff scenarios this unblocks:

- **Staging seeding** — `for i in {1..20}; do mercato test:bootstrap-tenant --slug stg-$i ...; done`
- **Demo provisioning** — sales engineering scripts a fresh demo tenant for a customer call, with branded org name + the prospect's email + `--with-examples`
- **Customer onboarding** — ops scripts the initial tenant provisioning when a new enterprise customer signs, instead of clicking through the admin UI
- **Disaster recovery** — re-create a tenant shell from backup metadata when restoring data into a fresh OM instance

## What this PR adds

A new subcommand under the existing `mercato test:` namespace:

```
mercato test:bootstrap-tenant \
  --slug <slug> \
  --org-name <name> \
  --admin-email <email> \
  --admin-password <password> \
  [--admin-display-name <name>] \
  [--with-examples]
```

Outputs a single JSON object on stdout: `{ tenantId, organizationId, adminUserId, adminEmail }`.

Exit code 0 on success; non-zero with `TENANT_SLUG_EXISTS` on slug collision (no silent overwrite); non-zero with `BOOTSTRAP_TENANT_FAILED: <reason>` on any other error.

## Implementation

- New file `packages/cli/src/lib/testing/bootstrap-tenant.ts` exporting `runBootstrapTenant(args)`.
- Subcommand registered alongside `integration`, `ephemeral`, etc. in the `test` module's `cli` array in `packages/cli/src/mercato.ts`, with the matching `test:bootstrap-tenant` shortcut.
- Wraps the existing internal `setupInitialTenant` from `@open-mercato/core/modules/auth/lib/setup-app` — same code path `mercato init` and `mercato auth setup` already use. No changes to that helper.
- No new dependencies.

## Test plan

- Unit tests for arg parsing (required args present / missing).
- Integration test against a fresh ephemeral DB asserts: JSON parses, IDs are valid UUIDs, tenant + org rows exist, admin can authenticate via `POST /api/auth/login`, `--with-examples` triggers `seedExamples` hooks, slug collision exits non-zero without mutation.

## Breaking changes

None. Pure addition. No changes to existing CLI surface, helpers, or schemas.

## Checklist

- [ ] Unit tests added
- [ ] Integration test added
- [ ] Documented in `packages/cli/README.md` (or AGENTS.md)
- [ ] Manually verified: staging-seeding loop and demo-provisioning invocations from the motivation section
```

## Changelog

| Date | Change |
|------|--------|
| 2026-05-09 | Spec authored as Phase 1b deliverable of SPEC-2026-05-09b (tenant-per-spec Playwright integration tests rebuild). Target: upstream PR to `@open-mercato/cli`. Frames the contribution as a general-purpose dev tool (staging seeding / demo provisioning / customer onboarding / disaster recovery) so upstream reviewers don't infer "test seam" from the `test:` namespace prefix. |
