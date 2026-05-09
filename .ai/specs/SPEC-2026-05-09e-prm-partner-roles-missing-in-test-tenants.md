# SPEC-2026-05-09e — PRM `partner_admin` / `partner_member` CustomerRoles missing in tenants minted by `scripts/bootstrap-test-tenant.ts`

**Date**: 2026-05-09
**Status**: PARKED 2026-05-10 — test-infrastructure debt, not a release blocker for PRM v1. The seed gap is **only** broken for the per-worker test bootstrap; real production tenants get `seedPartnerRoles` via `mercato init`'s normal flow, so partner portal RBAC works correctly in production. The 5 portal smokes that this spec would unblock ship under manual QA + production observability for v1 launch. Re-evaluate post-launch based on actual incident data — if a real partner_admin can't access the portal in prod, that's evidence; the test-skip is not.
**Spawned by**: SPEC-2026-05-09b Phase 4 — run-to-green debug pass uncovered that the new `bootstrap-test-tenant.ts` CLI (Phase 1, Option B) does not actually result in PRM's portal `CustomerRole`s being available in the freshly-minted tenant, even after the fix that switched the script to `bootstrapFromAppRoot` and added an explicit `seedDefaults` post-step. Tracked in-line as a `test.skip` block at `src/modules/prm/__integration__/TC-PRM-PORTAL-AGENCY-001.spec.ts:39-50` pending a focused fix.
**Estimate**: ~0.5–1 day (diagnostic) + ~0.5 day (fix + verification). The fix surface is small; the diagnostic is the load-bearing piece.
**Owner**: TBD

---

## TLDR

`scripts/bootstrap-test-tenant.ts` provisions a fresh tenant per Playwright worker by invoking `setupInitialTenant` from `@open-mercato/core` plus an explicit `seedDefaults` pass over every CLI module. PRM's `setup.onTenantCreated` and `setup.seedDefaults` both call `seedPartnerRoles`, which is supposed to insert two `CustomerRole` rows (`partner_admin`, `partner_member`) plus their `CustomerRoleAcl` entries. In practice, the staff-admin lookup `GET /api/customer_accounts/admin/roles?search=partner_admin` returns no results in the freshly-minted tenant, which means every PRM portal smoke that needs a portal role to log in as (`TC-PRM-PORTAL-AGENCY-001`, `-MEMBER-001`, `-PROSPECT-001`, `-LICENSEDEAL-001`, `-RFP-BROWSE-001`) currently has to remain `test.skip`. This spec scopes the diagnostic + fix so the portal-smoke coverage that SPEC-2026-05-09b Phase 4 promised is actually live.

## Problem Statement

### Observed symptom

Inside a tenant minted by `scripts/bootstrap-test-tenant.ts` (the Phase 1 / Option B script wired into `tenantFixture`), the staff-admin role-list endpoint returns zero results when filtered for the PRM portal role slugs:

```
GET /api/customer_accounts/admin/roles?pageSize=100&search=partner_admin
→ 200 { ok: true, items: [], total: 0 }
```

The `getCustomerRoleIdBySlug` helper at `src/modules/prm/testing/integration/customerAuth.ts:121-139` therefore throws on `expectId(role?.id, 'CustomerRole with slug "partner_admin" must be seeded for the tenant')`, which in turn forces `TC-PRM-PORTAL-AGENCY-001` (and every other portal-entity smoke that needs a `partner_admin` / `partner_member` `CustomerUser` to log in) to be skipped.

### Why this is surprising

PRM's `src/modules/prm/setup.ts:277-296` declares `seedPartnerRoles` in BOTH `onTenantCreated` AND `seedDefaults`, and `scripts/bootstrap-test-tenant.ts` already calls both phases:

- `setupInitialTenant(em, { ..., modules: cliModules })` — fires `onTenantCreated` per module per `node_modules/@open-mercato/core/src/modules/auth/lib/setup-app.ts:340-344`.
- A second loop iterating `cliModules` and calling `mod.setup?.seedDefaults?.(...)` directly with the same scope — added by the SPEC-2026-05-09b run-to-green pass at `scripts/bootstrap-test-tenant.ts:163-177`.

Either path SHOULD produce `partner_admin` / `partner_member` rows in `customer_roles`. Neither does. The skip-block comment at `src/modules/prm/__integration__/TC-PRM-PORTAL-AGENCY-001.spec.ts:39-50` records that `bootstrapFromAppRoot` was already added to load the CLI module registry — but the lookup still returns empty.

### Why it matters

SPEC-2026-05-09b Phase 4 pitched "TC-PRM-PORTAL-AGENCY-001 is the canonical portal smoke that does NOT need invite-acceptance" because the `GET /api/prm/portal/agency/{id}` route is gated only on a portal JWT + `prm.agency.view` (granted to both partner roles via `setup.ts:46-51`) + tenant scope. The route itself does NOT require an `AgencyMember.customerUserId` link, which is precisely what makes it implementable today without SPEC-2026-05-09c. With this seed bug, that promise is broken: the upstream invite-acceptance PR (SPEC-2026-05-09c) is no longer the only portal-smoke gate — the local seed gap is its own gate. Phase 4 currently ships ZERO active portal smokes; the spec markdown overpromised one.

## Investigation hooks (where to look first)

The diagnostic should start by isolating which of the four candidate failure modes is actually the root cause. Cheap-to-test ordering:

### Hypothesis A — PRM is not in `getCliModules()` after `bootstrapFromAppRoot`

The most likely root cause. App-local modules under `src/modules/<id>/` register themselves into the runtime via `src/modules.ts` (the explicit list) + `.mercato/generated/`, and `bootstrapFromAppRoot` is what loads the generated module list at CLI time. But the CLI registry is populated by per-module `cli.ts` files that call `registerCliModules(...)`. Concretely:

- `node_modules/@open-mercato/core/src/modules/<x>/cli.ts` files exist for every core module that ships CLI commands.
- The only app-local `cli.ts` in this repo is `src/modules/example/cli.ts`. **PRM has no `cli.ts`.**
- `node_modules/@open-mercato/shared/src/modules/registry.ts:386` — `getCliModules()` returns `_cliModules ?? []`, where `_cliModules` is set by `registerCliModules(...)`. If PRM never imports a `cli.ts`-side registration, it never lands in that array.

If this hypothesis is right, both `setupInitialTenant`'s `onTenantCreated` loop AND the bootstrap script's explicit `seedDefaults` loop iterate over a list that doesn't contain PRM, so `seedPartnerRoles` is never invoked for the new tenant.

**How to verify cheaply**: in the bootstrap script, after `bootstrapFromAppRoot(appRoot)`, log `cliModules.map(m => m.id)` to stderr (gated on `OM_BOOTSTRAP_DEBUG=1`) and re-run a single Playwright spec. If `prm` is missing from the list, this is the bug.

**Likely fix shape**: add `src/modules/prm/cli.ts` whose only job is to be discovered by `bootstrapFromAppRoot` for CLI-context registration (mirror the shape of `node_modules/@open-mercato/core/src/modules/customer_accounts/cli.ts` — which may itself only re-export the module registration without adding any commands). If app-local modules require an explicit `from: '@app'` route through the dynamic loader, file the framework gap separately.

### Hypothesis B — `seedPartnerRoles` runs but on the wrong tenant scope

If the role gets inserted under a different `tenantId` / `organizationId` than the one the bootstrap script returns to its caller, the staff-admin search (which is implicitly tenant-scoped via the JWT) would correctly return zero rows. Possible causes:

- `setupInitialTenant` returns `result.tenantId` / `result.organizationId` that are derived differently from what the per-module `onTenantCreated` callback sees in its `{ em, tenantId, organizationId }` arg. Re-read `node_modules/@open-mercato/core/src/modules/auth/lib/setup-app.ts:340-344` and confirm the values match.
- The `em` passed into `seedPartnerRoles` is in a different MikroORM `RequestContext` from the one that ultimately commits, so the writes get rolled back. Less likely but possible — verify by querying `customer_roles` directly via `psql` / the EM after the script returns and before the Playwright spec begins.

**How to verify cheaply**: enable verbose ORM logging on the bootstrap subprocess (e.g. `MIKRO_ORM_DEBUG=1`) and grep the logged INSERT statements for `customer_roles` — confirm rows are written, then SELECT them and compare `tenant_id` against the JSON the script writes to stdout.

### Hypothesis C — `seedPartnerRoles` writes successfully but the staff-admin search filters by `name` only

The customer_accounts roles route does:

```
node_modules/@open-mercato/core/src/modules/customer_accounts/api/admin/roles.ts:39-?
  if (search) { const escapedSearch = search.replace(/[%_\\]/g, '\\$&') ... }
```

If the LIKE clause hits only `name` (which is `'Partner Admin'`, capitalized + space) and not `slug` (`'partner_admin'`), then `?search=partner_admin` would correctly return zero matches even with the seed working. A trivial bypass would be to pass `?search=Partner` instead — but the right fix is to confirm the search semantics and either change the helper to use `?search=Partner%20Admin` (matches `name`) OR — if the route already searches both `name` and `slug` — confirm by reading the full ILIKE clause.

**How to verify cheaply**: read the rest of `node_modules/@open-mercato/core/src/modules/customer_accounts/api/admin/roles.ts:39-60` and confirm what columns the `escapedSearch` ILIKE actually targets. If it targets only `name`, switch `getCustomerRoleIdBySlug` to filter client-side after a `pageSize=100` unfiltered fetch (already does `body?.items?.find(r => r.slug === slug)` — so the only required change is to remove the `&search=...` query param entirely).

This is the cheapest hypothesis to test (5-line code reading) and should be confirmed first before going down the heavier registration-path investigation.

### Hypothesis D — `bootstrapFromAppRoot` does not statically import every app-module's `setup.ts`

`scripts/bootstrap-test-tenant.ts:114-117` calls `bootstrapFromAppRoot(appRoot)`. That helper loads `.mercato/generated/<x>` artifacts and registers CLI modules. If the generation pipeline only emits CLI registrations for modules that have a `cli.ts`, then PRM (which has no `cli.ts`) is correctly registered for runtime DI, entities, widgets, etc. — but is NOT in the CLI module list. Hypothesis A and Hypothesis D collapse into the same fix: PRM needs a `cli.ts` (even an empty one whose only effect is being included in the CLI module manifest).

This duplication is intentional — the spec calls them out as separate hypotheses because the diagnostic step (run `yarn generate` and grep `.mercato/generated/cli/*` for `prm`) confirms whether the generator is even aware of the module.

## Acceptance Criteria

- [ ] Root cause documented in this spec's "Resolution" section (added by the implementer): which hypothesis was correct and why.
- [ ] `TC-PRM-PORTAL-AGENCY-001` runs unskipped against the per-worker tenant fixture and passes.
- [ ] `getCustomerRoleIdBySlug` helper either (a) keeps using `?search=...` with a corrected query OR (b) drops the search param and filters client-side. Either way, the helper must work against any tenant that has the PRM seed run, not just specially-prepared ones.
- [ ] If the fix involves adding `src/modules/prm/cli.ts`, that file passes `yarn generate` cleanly and the regenerated `.mercato/generated/cli/*` includes the PRM module.
- [ ] `yarn test:integration:ephemeral` passes the full integration suite — confirm no other module's seed was inadvertently broken by any change to the CLI registration / `seedDefaults` loop.
- [ ] Spec SPEC-2026-05-09b Phase 4 status is updated: portal-smoke count goes from "0 active" to "≥1 active". Update the Phase 4 acceptance row in that spec accordingly.
- [ ] If `seedDefaults` and `onTenantCreated` end up double-running `seedPartnerRoles` for new tenants (the existing idempotency guard at `setup.ts:174-194` is the only thing keeping that safe), document that explicitly in `setup.ts` so a future contributor doesn't "clean up" the apparent duplicate and reintroduce a regression.

## Anti-patterns to avoid

- ❌ **Bypassing the seed by hand-inserting `partner_admin` / `partner_member` rows in the bootstrap script.** This violates SPEC-2026-05-09b's no-test-only-seam discipline rule (mirrors the deleted-2026-05-09 `OM_PRM_TEST_FIXTURES_ENABLED` env var + the abandoned SPEC-2026-05-09). The fix lives in module registration / lookup helper / customer_accounts route — wherever the actual bug is — not in a "test fixture" branch that diverges from production.
- ❌ **Adding an `if (process.env.NODE_ENV === 'test') ...` short-circuit in PRM `setup.ts` or in the bootstrap script.** Same discipline rule. The production tenant-create path either fires `onTenantCreated` or it doesn't — the right fix is to make sure the production path actually runs.
- ❌ **"Seed the role lazily on first portal login."** That would couple module bootstrap to runtime auth, regress idempotency guarantees, and silently mask future regressions of the actual tenant-init path.
- ❌ **Renaming the helper to `getCustomerRoleIdByName`.** If the issue is search semantics (Hypothesis C), the production-correct fix is to query by slug — slug is the stable identifier; name is human-facing and operator-editable in some flows. Don't bias the integration helper toward the wrong column.
- ❌ **Marking the other portal smokes (`-MEMBER`, `-PROSPECT`, `-LICENSEDEAL`, `-RFP-BROWSE`) as the same root cause without confirming.** Those four were already `test.skip` for a different reason — they need an `AgencyMember.customerUserId` link that today is set only by `prm-invitation-accepted` after the v2 invite flow (gated by SPEC-2026-05-09c). Fixing this spec re-enables `TC-PRM-PORTAL-AGENCY-001` only; the other four remain gated by SPEC-2026-05-09c v2 acceptance.

## Sequencing Notes

- **Independent of SPEC-2026-05-09c** (upstream `customer_accounts` invitation-list / rotate API). That spec gates four other portal smokes, not this one.
- **Independent of SPEC-2026-05-09d** (upstream `mercato test:bootstrap-tenant` CLI subcommand). When SPEC-2026-05-09d merges + this app upgrades `@open-mercato/core`, the `scripts/bootstrap-test-tenant.ts` body becomes a one-liner `mercato test:bootstrap-tenant ...` — but the seed-not-running root cause (likely PRM's missing CLI registration) carries over to the upstream subcommand too. If anything, fixing this spec's root cause is a precondition for SPEC-2026-05-09d to ship a useful CLI: an upstream `mercato test:bootstrap-tenant` that doesn't fire app-local module hooks is broken in the same way the local script is.
- **Should land BEFORE SPEC-2026-05-09c v2** — once SPEC-2026-05-09c v2 invite-acceptance specs come online, they too will need `partner_admin` / `partner_member` to exist in the tenant. Fixing this first removes a hidden dependency.

## Resolution

> Filled in by the implementer once root cause is identified. Format:
>
> **Root cause**: <one sentence>
> **Fix**: <files changed, ~LOC>
> **Verification**: <command(s) run, expected output>

## Changelog

| Date | Change |
|------|--------|
| 2026-05-09 | Spec spawned by SPEC-2026-05-09b run-to-green debug. The Phase 4 implementation subagent claimed all phases pass; run-to-green pass uncovered TC-PRM-PORTAL-AGENCY-001 still fails because `partner_admin` is not visible in the staff-admin role-list lookup against a freshly-minted test tenant — even after `bootstrap-test-tenant.ts` was switched to `bootstrapFromAppRoot` and gained an explicit `seedDefaults` loop. Four candidate hypotheses documented (A: PRM missing from `getCliModules()`; B: tenant-scope mismatch; C: roles search semantics filter `name`-only; D: `bootstrapFromAppRoot` skips modules without `cli.ts`). Hypothesis C is cheapest to verify and should be tested first. |
