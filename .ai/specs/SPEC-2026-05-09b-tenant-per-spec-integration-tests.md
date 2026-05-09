# SPEC-2026-05-09b — Tenant-per-spec Playwright integration test architecture for PRM

**Date**: 2026-05-09
**Status**: SKELETON — awaiting answers to Open Questions before phases can be written
**Predecessor**: `.ai/specs/SPEC-2026-05-09-test-fixtures-refactor.md` (ABANDONED — see postmortem)
**Origin**: PRM has zero Playwright integration coverage as of 2026-05-09; rebuild owed.
**Estimate**: TBD pending Open Questions. Order-of-magnitude: **M-L** (1-2 weeks for a tier-0 subset; 2-3 weeks for full restoration of the 33 deleted specs).
**Owner**: TBD

---

## TLDR

**Key Points:**
- Rebuild PRM Playwright integration coverage. Each spec gets its own freshly-created tenant via the production tenant-creation API. All test data lives inside that tenant. Cross-spec isolation is automatic — different `tenant_id`s means specs literally cannot see each other's data.
- Zero test-only HTTP routes. Zero `OM_*_TEST_FIXTURES_ENABLED` env vars. Zero TRUNCATE seams. Setup uses real production routes (`POST /api/prm/agency`, `POST /api/prm/agency/{id}/invite`, etc). Email-driven flows use intercepted SMTP (MailHog or in-process capture).
- Playwright `workers > 1` becomes safe and unlocks parallel execution — tenant isolation removes the serial-worker constraint the old suite needed.

**Scope:**
- Worker-scoped Playwright fixture: tenant lifecycle (create on `beforeAll`, optionally drop on `afterAll`).
- New helpers that take `tenantId` instead of relying on a singleton: `createAgencyInTenant`, `createPartnerAdminInTenant`, etc.
- SMTP capture mechanism for the partner-invite/email/accept flow.
- Migration / rebuild of (some subset of) the 33 deleted PRM specs against the new fixture.

**Out of scope:**
- Restoring the deleted test-fixtures routes. Permanently gone.
- Direct-EM access from test code (decorator/loader incompatibility — see predecessor postmortem).
- Per-test tenant lifecycle (worker-scoped is enough; per-test is overkill and slow).

---

## Open Questions *(remove before finalizing — the answers gate the design)*

These are real architectural unknowns. Each must be resolved before the implementation plan can be honestly scoped.

### Platform capability questions

- **Q1**: Does OM core expose a tenant-creation API usable from a Playwright test process? Specifically: is there a `POST /api/tenants` (or equivalent admin route) that takes `{ name, slug }` and returns a fresh `tenantId`? Or is tenant creation only possible via the `mercato` CLI / DB-init script? *(Determines whether tenant-per-spec is an HTTP call or requires a different mechanism.)*

- **Q2**: How does `yarn test:integration:ephemeral` set up the initial demo tenant today? Can `mercato test:integration` be configured to skip the demo seed, OR can each Playwright worker bootstrap its own tenant on top of the empty ephemeral DB? *(Determines whether the ephemeral runner needs upstream changes.)*

- **Q3**: Does OM ship an SMTP-interception helper for tests, OR does the running app need a `NOTIFICATION_TRANSPORT=memory` mode that captures emails into an in-process queue Playwright can poll? *(Determines whether the partner-invite flow can run real-mode in tests, or if portal-auth tests need a different approach.)*

- **Q4**: Does the OM tenant model support cheap-and-fast tenant creation? E.g., creating a tenant takes `< 500ms` and doesn't trigger a wave of seed data, schema migrations, or background workers? *(Determines whether worker-scoped is fast enough or per-test would also be feasible.)*

### Scope questions

- **Q5**: Rebuild ALL 33 deleted specs, or curate down to a tier-0 subset (e.g., one happy-path per major flow: T0 onboarding, T1 prospect register, T2 attribution, T3 WIC ingestion, T5 RFP publish + portal submit)? Curated subset is ~8-12 specs and ~M effort. Full rebuild is ~L effort and most of the value is in the happy paths anyway. *(Determines L vs M.)*

- **Q6**: For the perf smoke (formerly TC-PRM-T5-PERF-001 — "publish at 500 agencies under 2s"): accept the slower setup of seeding 500 agencies via real `POST /api/prm/agency` (likely 30-60s setup, then the actual publish wall-clock is what's measured), OR is the perf smoke not worth restoring at all (publish-side perf is a CI nice-to-have, not a release gate)?

- **Q7**: The deleted `bootPartnerAgencyWithMembers` helper bypassed the email-round-trip via the `agency-member-link` seam. The tenant-per-spec rebuild needs to either (a) run the real invite flow with SMTP capture (Q3), or (b) accept that portal-auth tests are slower because they wait for an in-memory email queue. Which trade is acceptable?

### Operational questions

- **Q8**: Is enabling `Playwright workers > 1` desirable now (tenant isolation makes it safe)? If yes, target what concurrency — `workers: 2-4` for laptop, more in CI? *(Determines whether the rebuild also needs to address worker-pool config in playwright.config.ts.)*

- **Q9**: Naming + location: keep `.ai/qa/tests/integration/TC-PRM-*.spec.ts` for the rebuild, OR move to `src/modules/prm/__integration__/TC-PRM-*.spec.ts` (the OM core convention)? Prior author chose `.ai/qa/`; OM core convention is `__integration__`. *(Determines whether the rebuild aligns with OM convention or preserves PRM's prior choice.)*

**STOP.** Do not author phases until Q1-Q9 have answers. The design depth depends critically on Q1-Q3 (platform capabilities) and Q5-Q7 (scope). Without those answers, any phase plan would be speculation.

---

## Problem Statement

The PRM Playwright integration suite was designed around a single shared tenant. Every spec wrote into that tenant; cross-spec isolation came from a `TRUNCATE prm_*` seam (the `OM_PRM_TEST_FIXTURES_ENABLED` route). That design produced 3 test-only HTTP routes that shipped in the production bundle, gated only by a runtime env var — the original concern that became GitHub issue #39.

The first attempt at fixing #39 (predecessor spec, abandoned) tried to keep the single-tenant frame and replace the HTTP seams with direct-EM access from Playwright tests. It hit a Playwright × MikroORM decorator-loader incompatibility that has no clean fix (Playwright maintainers explicitly reject stage-1 decorator support — microsoft/playwright#29646).

This spec drops the single-tenant frame. **OM is multi-tenant by construction** (every entity has `tenant_id` + `organization_id`, every query is tenant-scoped). The market-leader Playwright pattern for multi-tenant apps — tenant-per-spec — gives us cross-spec isolation for free. The 3 test-only routes existed to paper over a test design that didn't use the platform's own multi-tenancy. With tenant-per-spec, no seams are needed.

## Design Principles

1. **Tenant-per-spec, not shared-tenant.** Every spec creates its own tenant in `beforeAll` (worker-scoped fixture). All entities created inside that spec are tenant-scoped. Specs literally cannot pollute each other.

2. **Real routes, no seams.** Setup uses production HTTP routes (`POST /api/prm/agency`, `POST /api/prm/agency/{id}/invite`, etc). No test-only routes. No env-var gates. The production bundle is exactly what runs in prod.

3. **Real auth flows.** Partner invite/email/accept runs end-to-end via captured email. Portal logins go through `POST /api/customer_accounts/login`. No `agency-member-link` shortcut.

4. **Parallel-safe by construction.** Tenant isolation removes the `workers: 1` constraint. Playwright can run specs in parallel within a single ephemeral DB. (Q8 decides target concurrency.)

5. **Performance is acceptable, not optimal.** Real-route setup is slower than raw-SQL seams. We accept the cost. If a single spec's setup balloons past ~30s, we'll redesign that spec, not regress to seams.

## Architecture (sketch — pending Open Questions)

```ts
// src/modules/prm/testing/integration/tenantFixture.ts
import { test as base, type APIRequestContext } from '@playwright/test'

type PrmTenant = {
  tenantId: string
  organizationId: string
  staffToken: string  // JWT for an admin user inside this tenant
  request: APIRequestContext
  // helpers that auto-bind to this tenant:
  createAgency(input: AgencyInput): Promise<{ agencyId: string }>
  invitePartnerAdmin(agencyId: string): Promise<{ acceptUrl: string }>
  acceptInvite(acceptUrl: string, password: string): Promise<{ customerToken: string }>
}

export const test = base.extend<{}, { tenant: PrmTenant }>({
  tenant: [async ({ browser }, use) => {
    // 1. Create a fresh tenant via production API (Q1).
    // 2. Get a staff JWT for that tenant.
    // 3. Build helpers that auto-scope to this tenantId.
    await use({...})
    // 4. Optionally drop the tenant on teardown (Q4 — depends on cost).
  }, { scope: 'worker' }],
})
```

Spec files become (illustrative):

```ts
import { test, expect } from '@/modules/prm/testing/integration/tenantFixture'

test('happy-path agency onboarding', async ({ tenant }) => {
  const { agencyId } = await tenant.createAgency({ name: 'Acme', slug: 'acme' })
  const { acceptUrl } = await tenant.invitePartnerAdmin(agencyId)
  const { customerToken } = await tenant.acceptInvite(acceptUrl, 'pass-123')
  // ... real assertions against the real flow
})
```

Notice: **no `request, token` boilerplate, no `resetPrmState`, no `bootPartnerAgencyWithMembers`.** The fixture binds everything to one tenant, helpers auto-scope.

## Implementation phases (placeholder — to be detailed once Open Questions resolve)

| Phase | What | Dependencies | Estimate |
|---|---|---|---|
| 1 | Resolve Open Questions Q1-Q4 (platform capability spike) | — | 1-2 days investigation |
| 2 | Build `tenantFixture` + minimum helpers (createAgency, login flow) | Phase 1 | 1-2 days |
| 3 | Rebuild ONE happy-path spec end-to-end (T0-001 equivalent) as reference | Phase 2 | 1 day |
| 4 | Curated subset rebuild OR full rebuild (Q5) | Phase 3 | 1-2 weeks |
| 5 | Decide on `workers > 1` (Q8) + tune | Phase 4 | 0.5 day |

Phase 1 IS the spec's gate. Without it, Phases 2-5 are speculation.

## Risks (preliminary)

| ID | Risk | Severity | Notes |
|----|------|----------|-------|
| R1 | OM doesn't expose tenant creation as an API — would need an upstream feature request OR a `mercato` CLI extension OR direct DB inserts in test setup. | **High** | Q1. If true, this spec stalls until OM ships an answer. |
| R2 | SMTP capture pattern doesn't exist in OM today — invite flow can't run end-to-end without inventing one. | **Medium** | Q3. Mitigation: skip portal-auth tests in the first rebuild; restore them when SMTP capture exists. |
| R3 | Tenant creation is slow (e.g., 5-10s due to seed data or schema setup) → worker-scoped fixture init dominates suite runtime. | **Medium** | Q4. Mitigation: pre-create N tenants once at suite init, claim from a pool per worker. |
| R4 | Decision paralysis on Open Questions — design stays speculative for weeks. | **Medium** | Mitigation: time-box Phase 1 spike at 2 days; if questions still open, escalate or descope. |

## Acceptance criteria (preliminary)

- [ ] All Open Questions Q1-Q9 answered.
- [ ] Implementation plan finalised with concrete phases + estimates.
- [ ] At least one happy-path spec rebuilt and passing under tenant-per-spec.
- [ ] Zero test-only HTTP routes added to PRM.
- [ ] Zero `OM_*_TEST_FIXTURES_ENABLED`-style env vars introduced.
- [ ] `unset OM_PRM_TEST_FIXTURES_ENABLED && yarn test:integration:ephemeral` runs the rebuilt suite green (no env-var dependency).
- [ ] If `workers > 1` is enabled (Q8), confirm parallel runs don't cross-pollute.

## Anti-patterns to avoid

- ❌ **Reaching for a TRUNCATE seam if the fixture init is slow.** That's how we ended up here. Solve with tenant pooling (R3) or accept the cost.
- ❌ **Reaching for a `agency-member-link` shortcut if SMTP capture is hard.** Skip portal-auth tests temporarily; come back when SMTP capture exists.
- ❌ **Reverting to single-tenant "for one spec because it's special".** All-or-nothing on the tenant-per-spec discipline. One single-tenant spec metastasises into a `_reset` seam in 6 months.
- ❌ **Importing PRM entities directly in fixture/spec code.** That's the predecessor's mistake. Always go through HTTP.

## Changelog

| Date | Change |
|------|--------|
| 2026-05-09 | Skeleton spec authored after the predecessor (`SPEC-2026-05-09`) was abandoned + the 33-spec PRM Playwright suite was deleted. Open Questions Q1-Q9 must be resolved before phases. |
