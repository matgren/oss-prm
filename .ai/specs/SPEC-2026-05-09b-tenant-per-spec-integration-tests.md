# SPEC-2026-05-09b — Tenant-per-spec Playwright integration test architecture for PRM

**Date**: 2026-05-09
**Status**: DRAFT (was incorrectly flipped to READY in an earlier rewrite — flipped back after a Playwright × OM-upstream validation pass exposed 5 technical gaps and one missing precedent for the partner-invite read flow)
**Predecessor**: `.ai/specs/SPEC-2026-05-09-test-fixtures-refactor.md` (ABANDONED — see postmortem in that file)
**Spawn**: `.ai/specs/SPEC-2026-05-09c-notifications-tenant-admin-recipient-filter.md` (TO BE AUTHORED — upstream PR to OM core for the partner-invite read pattern; gates invite-acceptance specs in this spec)
**Origin**: PRM has zero Playwright integration coverage as of 2026-05-09 (33 specs + 4 helpers + 3 routes deleted in commit `d554616`); rebuild owed.
**Platform spike**: `app-spec/piotr-notes/2026-05-09-playwright-platform-spike.md` (Q1–Q4) + `app-spec/piotr-notes/2026-05-09-playwright-upstream-validation.md` (the validation pass that re-flagged this DRAFT)
**Estimate**: **M (1–2 weeks)** for tier-0 minus invite-acceptance specs. Invite-acceptance specs ship in v2 once SPEC-2026-05-09c (upstream PR) merges.
**Owner**: TBD

---

## TLDR

Rebuild PRM Playwright integration coverage. **Reuse OM core's existing fixture infrastructure** (`@open-mercato/core/helpers/integration/auth.ts`, `notificationsFixtures.ts`, etc.) — do not invent parallel local fixtures.

Each Playwright **worker** mints its own tenant via the production route `POST /api/directory/tenants` (authenticated as the bootstrapped superadmin from `mercato init`) and reuses it across the specs that worker runs. Cross-spec isolation is automatic — different `tenant_id`s mean specs literally cannot see each other's data.

Override `workers` at the CLI invocation level (`mercato test:integration --workers=4` local, `--workers=2` CI) — do NOT fork the upstream `.ai/qa/tests/playwright.config.ts` which ships `workers: 1`. This is a deliberate departure from OM upstream's shared-tenant convention, justified by the predecessor's failure mode.

For the partner-invite read flow (the one capability OM core has no precedent for): **spawn an upstream PR** (SPEC-2026-05-09c) extending the `notifications` module so a tenant-admin can list invitations addressed to email-only recipients. Until that PR merges upstream and we bump `@open-mercato/core` in this app, invite-acceptance specs descope to v2.

Curated tier-0 subset (~6–10 happy-path specs, excluding invite-acceptance until v2). Specs live at `src/modules/prm/__integration__/TC-PRM-*.spec.ts` (OM module-local convention).

Phase 3 reuses the existing PRM-local helpers at `src/modules/prm/testing/integration/` (already scrubbed of cleanup rot in a separate pass — they use real production routes via `apiRequest`); only WIC-ingestion and a small set of new tier-0 helpers are net-new.

---

## Discipline: OM core is the reference

This is the load-bearing rule that prevents recurrence of the deleted env-var-gated test-routes anti-pattern.

> **If OM core wouldn't merge it upstream, we don't add it locally.**

Concretely:

1. **Reuse, don't reinvent.** PRM `__integration__/` specs and fixtures import only from:
   - `@playwright/test`
   - `@open-mercato/core/helpers/integration/*` (the 23 upstream fixture files including `auth.ts`, `notificationsFixtures.ts`, `staffFixtures.ts`, `inboxFixtures.ts`, etc.)
   - PRM-local helpers in `src/modules/prm/testing/integration/*` (existing, post-cleanup scrub of commit `02457db`) and `src/modules/prm/__integration__/fixtures/*` (new, for spec-specific composition) — both must themselves import only from the above
   
   PRM-local fixture files MUST NOT import from `@/modules/*/lib/*`, `@/modules/*/data/*`, `@/modules/*/commands/*`, or any other production internal. HTTP through real production routes only.

2. **No test-only routes.** No file under `src/modules/*/api/test-fixtures/`. No file under `src/modules/*/api/_test_*`. No `if (process.env.NODE_ENV === 'test'` or `if (process.env.OM_*_TEST_*` block inside any production code path.

3. **Any new HTTP route added during test work must pass the Slack-explainability test.** A support agent on a prod incident, with no test context, must be able to write a one-sentence Slack thread explaining when they would call this route. If they can't, it's a test seam — reject it.

4. **If a needed capability does not exist in OM core**, the resolution order is:
   1. Upstream PR (real production capability, useful to all OM apps). Spawn a separate spec for the PR. PRM consumes it after merge + version bump.
   2. Use an existing OM core pattern (e.g., `inbox_ops` extraction) if it fits.
   3. Descope the test until 1 or 2 lands.
   
   "Add a test seam in PRM" is **not** on this list and is treated at the same severity as a leaked credential.

5. **Enforcement**: per-PR review using the `om-code-review` skill (the project's CI/CD gate per session-start context). The skill checklist includes a "test-seam recurrence" section. Code review is the gate; there is no separate CI script because the project doesn't run CI.

6. **Portal-entity coverage rule.** Any PRM domain entity that surfaces in the customer portal (`[orgSlug]/portal/*` routes) MUST ship with at least one happy-path portal-flow smoke spec at `src/modules/prm/__integration__/`. Forward-going discipline: when a new portal-touching entity is added, its smoke spec lands in the same PR as the portal pages. Backend-only entities are exempt — functional coverage comes from the tier-0 workflow specs.

## Departures from OM upstream convention

Two deliberate departures, both justified by the predecessor's failure mode:

| Departure | OM upstream | This spec | Why |
|---|---|---|---|
| Worker count | `workers: 1` (sequential, shared-tenant model) | `workers: 4` local, `workers: 2` CI (parallel, tenant-per-worker) | Tenant-per-worker makes parallel safe. Sequential was an artifact of shared-tenant cleanup discipline that already failed once (the predecessor). |
| Tenant scope | Single bootstrapped tenant from `mercato init`, reused across all specs | One tenant per Playwright worker, minted at worker startup via real `POST /api/directory/tenants` | Removes any need for inter-spec cleanup (the seam pressure point). Backed by Playwright docs: `playwright.dev/docs/test-parallel` explicitly recommends `TEST_WORKER_INDEX`-based per-worker tenant isolation for multi-tenant backends. |

Both departures are **mechanical overrides at the CLI invocation level** — neither requires forking the upstream `.ai/qa/tests/playwright.config.ts` file.

## Problem Statement

The PRM Playwright integration suite was designed around a single shared tenant. Every spec wrote into that tenant; cross-spec isolation came from a `TRUNCATE prm_*` seam (the `OM_PRM_TEST_FIXTURES_ENABLED` route). That design produced 3 test-only HTTP routes that shipped in the production bundle, gated only by a runtime env var — the original concern that became GitHub issue #39.

The first rebuild attempt (predecessor spec, abandoned) tried to keep the single-tenant frame and replace the HTTP seams with direct-EM access from Playwright tests. It hit a Playwright × MikroORM decorator-loader incompatibility that has no clean fix (Playwright maintainers explicitly reject stage-1 decorator support — microsoft/playwright#29646).

This spec drops the single-tenant frame. **OM is multi-tenant by construction** (every entity has `tenant_id` + `organization_id`, every query is tenant-scoped). The market-leader Playwright pattern for multi-tenant apps — tenant-per-worker — gives us cross-spec isolation for free. The 3 deleted test-only routes existed to paper over a test design that didn't use the platform's own multi-tenancy.

## Architecture

### Worker-scoped tenant fixture (PRM-local, but built on OM core helpers)

Lives at `src/modules/prm/__integration__/fixtures/tenantFixture.ts`. **Imports only from `@playwright/test` and `@open-mercato/core/helpers/integration/*`.**

```ts
import { test as base, type APIRequestContext } from '@playwright/test'
import { DEFAULT_CREDENTIALS } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'

type PrmTenant = {
  tenantId: string
  organizationId: string
  staffToken: string  // JWT for an admin user inside this tenant
  request: APIRequestContext
  // PRM helpers — each goes through real production routes, no internals
  createAgency(input: AgencyInput): Promise<{ agencyId: string }>
  // ... etc
}

export const test = base.extend<{}, { tenant: PrmTenant }>({
  tenant: [async ({ playwright }, use) => {
    // 1. Authenticate as superadmin in the bootstrapped tenant (created by `mercato init`).
    //    Uses OM core's DEFAULT_CREDENTIALS — does not invent its own.
    const platformAdmin = await playwright.request.newContext({ baseURL: BASE_URL })
    const loginRes = await platformAdmin.post('/api/auth/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        email: DEFAULT_CREDENTIALS.superadmin.email,
        password: DEFAULT_CREDENTIALS.superadmin.password,
      }).toString(),
    })
    const { token: platformToken } = await loginRes.json()

    // 2. Mint a fresh tenant via the production route (Q1: POST /api/directory/tenants).
    const createTenantRes = await apiRequest(platformAdmin, 'POST', '/api/directory/tenants', {
      token: platformToken,
      data: { name: `pw-w${test.info().workerIndex}-${Date.now()}`, slug: `pw-${randomId()}` },
    })
    const { id: tenantId } = await createTenantRes.json()

    // 3. Bootstrap an admin user inside the new tenant + obtain that admin's JWT.
    //    (Implementation in fixture: provision admin via real prod route; capture JWT.)
    const { staffToken, organizationId } = await bootstrapTenantAdmin(platformAdmin, platformToken, tenantId)

    // 4. Build a request context pre-authenticated as that tenant's admin.
    const tenantRequest = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${staffToken}` },
    })

    await use(buildPrmHelpers({ tenantId, organizationId, staffToken, request: tenantRequest }))

    // 5. Teardown is intentionally NOOP. Ephemeral DB is dropped at suite end by `mercato test:integration`.
    //    Per-tenant cleanup adds latency without benefit since the whole DB dies anyway.
  }, { scope: 'worker' }],
})
```

### Spec shape

```ts
import { test, expect } from '../fixtures/tenantFixture'
import { createAgencyFixture } from '@/modules/prm/testing/integration'

test('TC-PRM-T0-001 happy-path agency onboarding (no invite acceptance)', async ({ tenant }) => {
  const { agencyId } = await createAgencyFixture(tenant.request, tenant.staffToken, { name: 'Acme', slug: 'acme' })
  // ... real assertions against real routes
})
```

Existing PRM helpers compose directly with the new tenant fixture: their `(request, token, input)` signature consumes the per-tenant `tenant.request` + `tenant.staffToken` from the worker-scoped fixture.

No `request, token` boilerplate. No `resetPrmState`. No `bootPartnerAgencyWithMembers` shortcut. The fixture binds everything to one tenant; helpers auto-scope. Login is via OM core's `DEFAULT_CREDENTIALS` — not redefined locally.

### The partner-invite read flow — gated on upstream PR

`GET /api/notifications` exists upstream (`node_modules/@open-mercato/core/src/modules/notifications/api/route.ts:18-70`) BUT filters by `recipientUserId: scope.userId` (line 27). It only returns notifications addressed to the authenticated user. There is no production route in OM core today that lets a tenant-admin list invitations addressed to email-only recipients (recipients without an account yet).

This is the one place where pressure for a PRM-local test seam would be felt. Resolution per the discipline rule:

**Spawn `SPEC-2026-05-09c-notifications-tenant-admin-recipient-filter.md`** — an upstream PR spec proposing a tenant-admin-scoped read API on the `notifications` module that returns invitations addressed to specific email-only recipients in that tenant. Justification for the upstream PR: support agents already need this capability to verify that customer invitations were dispatched correctly when debugging delivery issues. This is a real production capability, not a test seam.

Sequencing:
- Upstream PR drafted, submitted to `open-mercato/open-mercato`, reviewed, merged.
- This app bumps `@open-mercato/core` to the version containing the new route.
- Invite-acceptance specs (TC-PRM-T0-INVITE-*) land in v2 of this rebuild against the upstream-merged route.

Until that sequence completes, invite-acceptance specs are descoped — tier-0 ships without them.

### Configuration changes

- **`workers` override at the invocation level** — modify this app's `package.json`:
  ```json
  "test:integration:ephemeral": "mercato test:integration -- --workers=4"
  ```
  CI invocation: `mercato test:integration -- --workers=2`. Do NOT modify `.ai/qa/tests/playwright.config.ts` (it ships from upstream with `workers: 1` which is the right default for the rest of the suite).
- **Spec discovery** — module-local `src/modules/prm/__integration__/` is auto-discovered by `discoverIntegrationSpecFiles()` per the upstream config (`testDir: projectRoot`). No discovery-config change needed.
- **Old `.ai/qa/tests/integration/TC-PRM-*` location** — vacated; new specs live under `src/modules/prm/__integration__/`.

## Implementation phases

| Phase | What | Estimate |
|---|---|---|
| 0a | Preflight: confirm cleanup of `src/modules/prm/testing/integration/` JSDoc rot + `@open-mercato/core/testing/integration` import path verified as real (DONE in commit `02457db`). Audit `testingIntegrationFixtures.test.ts` confirmed live (kept). | DONE 2026-05-09 (zero days remaining) |
| 0b | **Eject the `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` env-var seam** at `src/modules/prm/lib/rfpService.ts:282`. Refactor to a DI-overridable injection point: introduce a `BroadcastFailureInjector` interface (default impl = no-op, registered in PRM `di.ts`), inject it into `rfpService` via Awilix, and rewrite `src/modules/prm/__tests__/rfpService.test.ts:329-357` to swap the impl at container construction instead of toggling the env var. Then delete the env var from code, JSDoc, `.env.example`, and any test-comment references. **Flagged but out of scope** for this spec: `OM_INTEGRATION_TEST` at `src/app/layout.tsx:26` (UI-chrome notice-bar gate, lower risk — no state behavior). Recommended follow-up replaces it with the upstream notice-suppression cookie pattern at `node_modules/@open-mercato/core/src/helpers/integration/auth.ts:60-87` (sets `om_demo_notice_ack` / `om_cookie_notice_ack` cookies at fixture init). | 0.5 day |
| 1 | `tenantFixture` + bootstrap-superadmin login (via OM core `DEFAULT_CREDENTIALS`) + `POST /api/directory/tenants` flow + smoke spec that verifies isolation across 2 workers | 2 days |
| 2 | Author `SPEC-2026-05-09c-notifications-tenant-admin-recipient-filter.md` (the upstream PR spec). Submit upstream PR. **This phase does NOT block phases 3–5** — invite-acceptance specs are explicitly descoped from v1. | 1 day to author + handoff (PR cycle is upstream maintainer time) |
| 3 | Adopt the existing helpers at `src/modules/prm/testing/integration/` (already compliant). Verify signature composition with the new `tenant` fixture (their `(request, token, input)` shape consumes `tenant.request` + `tenant.staffToken`). Build only net-new helpers: WIC ingestion (T3), and any tier-0-specific composers not already covered. | **1 day** (down from 2) |
| 4 | Rebuild tier-0 specs (~11–15 excluding invite-acceptance). **Workflow happy-paths**: TC-PRM-T0-001 onboarding (sans invite), T1-001 prospect register, T2-001 attribution, T3-001 WIC ingestion, T5-001 RFP publish, T5-002 portal RFP submit. **Portal-entity smokes** (one per portal-touching entity, ~30–50 LOC each): TC-PRM-PORTAL-AGENCY-001 (view own agency), TC-PRM-PORTAL-MEMBER-001 (partner_admin manages team), TC-PRM-PORTAL-PROSPECT-001 (view + transition own prospects), TC-PRM-PORTAL-LICENSEDEAL-001 (view attribution candidates), TC-PRM-PORTAL-RFP-BROWSE-001 (browse published RFPs). Plus 2–4 happy-path companions. CustomerUsers seeded via existing `createCustomerUserFixture` (real `POST /api/customer_accounts/admin/users`); login via existing `loginCustomer`. **Portal smokes are NOT gated on the invite-acceptance upstream PR** — they bypass the invite email flow via the staff-admin user-creation route, which is a real production capability (staff manually onboard customers). | 4–5 days |
| 5 | Wire `--workers=4` in `package.json`; document the fixture in `.ai/guides/`; run `om-code-review` on the full diff | 1 day |
| 6 (v2) | Once SPEC-2026-05-09c upstream PR merges and `@open-mercato/core` bumps in this app — restore TC-PRM-T0-INVITE-* specs against the upstream route | 1–2 days |

**v1 total**: 9.5–10.5 working days (≈M; +0.5 day for Phase 0b BROADCAST_INSERT_FAIL ejection on top of the 9–10d baseline that already absorbed the 5 portal-entity smokes).
**v2 follow-up**: 1–2 days, gated on upstream merge.

## Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Upstream PR (SPEC-2026-05-09c) is rejected or delayed → invite-acceptance specs never ship | Medium | If rejected, re-evaluate descope-permanently vs option 2 (rerouting through `inbox_ops`). Do NOT regress to a PRM-local test seam. |
| R2 | Tenant creation slower than estimated (5+ s) → worker init dominates suite runtime | Low | Q4 spike estimated 0.5–2s. If worse, switch to a tenant pool (4 tenants pre-created at suite init, claimed per worker). NOT a test-seam trigger. |
| R3 | `workers > 1` exposes a real cross-tenant leak in PRM code | Medium | This is a feature, not a bug. Any failure here is a real PRM correctness bug we should fix, not work around. |
| R4 | Bootstrap-superadmin credentials change between OM versions, breaking the platform-admin login in the fixture | Low | Fixture uses `DEFAULT_CREDENTIALS` from upstream `auth.ts` — pinned to upstream's source of truth, version-bumped together. |
| R5 | Tenant created via `POST /api/directory/tenants` doesn't auto-provision an admin user → bootstrap step needs to invoke a separate route | Medium-Low | Phase 1 verifies this; if true, Phase 1 also identifies the admin-bootstrap route. Tracked as a Phase 1 deliverable. |

## Acceptance criteria

- [ ] `src/modules/prm/__integration__/fixtures/tenantFixture.ts` exists, worker-scoped, mints a tenant via `POST /api/directory/tenants`, and imports ONLY from `@playwright/test` + `@open-mercato/core/helpers/integration/*`.
- [ ] `grep -r "from '@/modules/" src/modules/prm/__integration__/` returns nothing — no production internals imported in test code.
- [ ] At least 6 PRM specs rebuilt under tenant-per-worker, covering T0 onboarding (sans invite), T1 prospect, T2 attribution, T3 WIC, T5 RFP publish + portal submit. All passing.
- [ ] Zero test-only HTTP routes in PRM. (`grep -r 'OM_PRM_TEST_FIXTURES_ENABLED\|test-fixtures\|resetPrmState' src/` returns nothing.)
- [ ] Zero `OM_*_TEST_*` env vars in `.env.example` (broadened from `*_TEST_FIXTURES_ENABLED` to catch `*_TEST_INJECT_*` fault-injection seams too — both flavors are the same anti-pattern).
- [ ] Zero `if (process.env.NODE_ENV === 'test'` or `if (process.env.OM_*_TEST_*` blocks anywhere in `src/modules/**` (broadened from `src/modules/*/api/` to also catch `lib/`, `commands/`, `subscribers/`, etc.). **Pre-existing seams are not grandfathered** — Phase 0b cleans the one known survivor (`OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` at `src/modules/prm/lib/rfpService.ts:282`). Verification command: `grep -rn 'process\.env\.OM_[A-Z_]*_TEST_' src/modules/` returns nothing.
- [ ] `unset OM_PRM_TEST_FIXTURES_ENABLED && yarn test:integration:ephemeral` runs the rebuilt suite green (no env-var dependency).
- [ ] `package.json` invokes `mercato test:integration -- --workers=4`. Two consecutive runs at workers: 4 stay green (no flake from cross-tenant pollution).
- [ ] Smoke spec confirms: two specs running on different workers see disjoint tenant data.
- [ ] Spec location is `src/modules/prm/__integration__/`, not `.ai/qa/tests/integration/`.
- [ ] `SPEC-2026-05-09c-notifications-tenant-admin-recipient-filter.md` exists, the upstream PR has been submitted, and the v2 follow-up spec entry exists for restoring invite-acceptance specs.
- [ ] `om-code-review` skill checklist includes a "test-seam recurrence" section that any PR touching `src/modules/*/api/` or playwright fixtures must pass.
- [ ] Existing helpers at `src/modules/prm/testing/integration/` are reused via the new `tenant` fixture; no parallel re-implementations created. The spec implementation only adds net-new helpers (WIC, etc.) where coverage gaps exist.
- [ ] Every PRM portal-touching entity (Agency, AgencyMember, Prospect, LicenseDeal, RFP browse) has at least one happy-path portal smoke spec at `src/modules/prm/__integration__/TC-PRM-PORTAL-*-001.spec.ts`. Each smoke logs in as a real CustomerUser (seeded via `createCustomerUserFixture` → `loginCustomer`), exercises the portal flow end-to-end, and asserts via real prod routes only.

## Anti-patterns to avoid

- ❌ **TRUNCATE seam if fixture init is slow.** That's how we ended up here. Solve with a tenant pool (R2) or accept the cost.
- ❌ **`agency-member-link` shortcut if the upstream PR is delayed.** Descope invite-acceptance specs (per the discipline rule) — do not add a PRM-local test seam.
- ❌ **A "single-tenant exception for one spec because it's special".** All-or-nothing on tenant-per-worker. One exception metastasises into a `_reset` seam in 6 months.
- ❌ **Importing PRM entities (or any `@/modules/*/data/entities`) directly in fixture/spec code.** That's the predecessor's mistake (Playwright × MikroORM decorator incompatibility). Always go through HTTP. Enforced by the discipline rule's import allowlist.
- ❌ **Adding `OM_PRM_*` env vars to gate test behavior in production code.** The whole point of this spec is to remove that pattern; do not reintroduce it under a different name. Treated at the same severity as a leaked credential.
- ❌ **Forking `.ai/qa/tests/playwright.config.ts` to set `workers: 4`.** Override at the CLI invocation level instead — `mercato test:integration -- --workers=4` in `package.json`. Forking the config drifts from upstream and creates merge pain.
- ❌ **Inventing a PRM-local notifications-read API for the partner-invite flow.** That capability belongs upstream (real production support need). Spawn the upstream PR spec instead.
- ❌ **Adding `OM_*_TEST_INJECT_*` env-var-gated fault-injection points in production code paths** (the `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` pattern). Different mechanism than state-reset seams, but the same anti-pattern: production code knows about test mode via env var. Use DI-overridable injection points instead — tests swap the impl at container construction. Phase 0b ejects the one known survivor.

## Changelog

| Date | Change |
|------|--------|
| 2026-05-09 | Skeleton authored after predecessor (`SPEC-2026-05-09`) was abandoned + the 33-spec PRM Playwright suite was deleted. Status: SKELETON, gated on Open Questions Q1–Q9. |
| 2026-05-09 | Rewritten to READY (premature). Q1–Q4 resolved via platform spike. Q5–Q9 decided per Piotr defaults. Phases were concrete but the spec ignored OM upstream's existing fixture infrastructure and proposed a PRM-local notifications-read route. |
| 2026-05-09 | **Re-flagged to DRAFT after Playwright × OM-upstream validation pass.** Five technical gaps closed: (1) reuse `@open-mercato/core/helpers/integration/auth.ts` and `notificationsFixtures.ts` instead of reinventing; (2) target `.ai/qa/tests/playwright.config.ts` (not non-existent root config); (3) `workers` override at CLI invocation, not config edit; (4) tenant-per-worker named as a deliberate departure from upstream's `workers: 1` shared-tenant model; (5) the proposed local notifications-read API replaced with an upstream PR (SPEC-2026-05-09c) because OM core's `GET /api/notifications` filters by `recipientUserId`, which doesn't fit reading invites addressed to email-only recipients. Added "Discipline: OM core is the reference" section as the recurrence-prevention mechanism (no separate CI script — project doesn't run CI; enforcement via `om-code-review` skill). Invite-acceptance specs descope to v2, gated on upstream PR merge. |
| 2026-05-09 | Phase 3 estimate compressed (2d → 1d) after discovering `src/modules/prm/testing/integration/` was deliberately retained post-cleanup with all-real-route helpers, not stranded code. Phase 0 added to mark the JSDoc/import-path scrub completed in a parallel pass. v1 total: 9–10 → 8–9 working days. |
| 2026-05-09 | Tier-0 expanded with 5 portal-entity smoke specs (TC-PRM-PORTAL-AGENCY/MEMBER/PROSPECT/LICENSEDEAL/RFP-BROWSE-001) covering customer-portal entity surface — was zero-coverage post-cleanup. Unlocked because `createCustomerUserFixture` (real `POST /api/customer_accounts/admin/users`) bypasses invite email flow, so portal smokes are NOT gated on SPEC-2026-05-09c. Forward-going discipline rule (Discipline §6) added: any new PRM portal-touching entity ships with its own portal smoke spec in the same PR as the portal pages. v1 estimate: 8–9 → 9–10 working days. Phase 4: 3–4 → 4–5 days. Bullet redundancy in Discipline §1 import allowlist also tightened. |
| 2026-05-09 | **Closed the "fault-injection seam survives the cleanup" hole** identified during a second adversarial validation pass: `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` at `src/modules/prm/lib/rfpService.ts:282` was grandfathered by the old grep gate scope (`src/modules/*/api/`, verb "introduced"). (a) Tightened acceptance criteria — grep gate scope expanded to `src/modules/**` (catches `lib/`, `commands/`, etc.); env-var pattern broadened to `OM_*_TEST_*` (catches fault-injection style too); pre-existing seams no longer grandfathered. (b) Added Phase 0b — eject the env-var seam via DI-overridable `BroadcastFailureInjector`. (c) Added new anti-pattern entry forbidding `OM_*_TEST_INJECT_*` env-var gates in production code. v1 estimate: 9–10 → 9.5–10.5 working days. Flagged-but-out-of-scope: `OM_INTEGRATION_TEST` at `src/app/layout.tsx:26` (UI chrome only; recommended follow-up uses upstream notice-suppression cookie pattern). |
