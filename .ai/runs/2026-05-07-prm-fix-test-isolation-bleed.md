# PRM — Fix T5-001 #1 cross-spec test-isolation bleed

**Status:** in-progress
**Branch:** `fix/prm-fix-test-isolation-bleed`
**Target:** `develop`
**Owner:** matgren

## Goal

Eliminate the cross-spec test-isolation bleed in the PRM Playwright integration suite so `TC-PRM-T5-001 §9.1 #1` (`by_min_tier publish broadcasts to ≥ ai_native (A + B), excludes C`) stops failing when the full suite runs back-to-back. The eligibility evaluator currently sees Agency rows leaked from upstream specs (T0/T1/T2/T3 each seed agencies and don't tear them down) and returns 4 broadcast targets instead of the expected 2.

This closes the only remaining `yarn test:integration:ephemeral` failure observed in the post-mvp-beta-t3 audit.

## Scope

- Add a test-only `POST /api/prm/test-fixtures/reset` route that TRUNCATEs PRM tables in dependency order, gated behind `OM_PRM_TEST_FIXTURES_ENABLED=1` (mirrors the existing `agency-member-link` seam contract — production deployments return 404, byte-identical to a non-existent route).
- Add `resetPrmState(request, token)` to `src/modules/prm/testing/integration/` and re-export from `index.ts`.
- Wire `resetPrmState()` via `test.beforeEach` in every PRM Playwright spec under `.ai/qa/tests/integration/TC-PRM-*.spec.ts`. Done as a small, mechanical edit per file — no shared `test.extend` factory because Playwright's `request` worker fixture already serializes per-worker and the suite runs `workers: 1`. Keeping `beforeEach` explicit per-file mirrors the existing OM core integration-test pattern (each spec calls `getAuthToken` directly today).
- Ship a dedicated regression spec (`TC-PRM-RESET-001`) that exercises the helper: seed an agency in test #1, reset in beforeEach, confirm test #2's seed doesn't see test #1's leftovers.

## Non-goals

- Do NOT TRUNCATE non-PRM tables (organizations, customers, customer_users, customer_user_invitations, customer_roles, customer_user_roles, etc.) — those are seeded once per ephemeral run by the bootstrap step and the suite depends on that state surviving across specs.
- Do NOT touch `src/modules/prm/frontend/[orgSlug]/portal/*.tsx` (DS agent owns the portal migration in parallel).
- Do NOT touch `.ai/specs/POST-MVP-FOLLOW-UPS.md` (DS agent owns); request orchestrator removal of the test-isolation line in PR body comment instead.
- Do NOT modify `.ai/specs/SPEC-*.md` files (frozen post-merge).
- Do NOT modify the existing `agency-member-link` seam beyond adding a sibling route. Keep that seam's contract.
- Do NOT migrate the non-PRM tests under `TC-CLI-*` — those don't seed PRM rows.

## External References

None — no `--skill-url` arguments were passed.

## Approach

**Approach A — Module-owned `resetPrmState()` fixture + TRUNCATE seam.**

Why A over B (per-suffix seed isolation):

- B doesn't actually fix the underlying issue; it papers over it. The eligibility evaluator's SQL (`status='active' AND onboarded=true`) intentionally has no namespace prefix awareness, and we don't want to teach it one for tests.
- A is the standard pattern (Rails / Django / OM core all use TRUNCATE-between-tests for integration suites). The ephemeral Postgres role is the bootstrap superuser (verified — it ran the migrations) so TRUNCATE rights are granted by construction.
- A scales: future PRM specs can rely on a clean PRM slice without re-discovering the bleed.

### Reset order (FK dependency graph, child → parent)

PRM has no cross-table FK constraints inside its own slice (every cross-row reference is a UUID column without a DB-level FK — that's the OM "no direct ORM relationships between modules" rule applied internally too), so order matters only for readability and TRUNCATE-CASCADE safety. We use a single `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` statement listing all 14 PRM tables; Postgres handles dependency order internally.

Tables (verified by grepping `tableName:` in `src/modules/prm/data/entities.ts`):

```
prm_agency_members
prm_prospect_candidate_index
prm_rfp_response_scores
prm_rfp_responses
prm_rfp_broadcasts
prm_rfps
prm_license_deals
prm_prospects
prm_agencies
prm_case_studies
prm_marketing_materials
prm_wic_contributions
prm_wic_import_audit_log
prm_service_idempotency_key
```

Note: brief listed `prm_wic_import_audit_logs` and `prm_service_idempotency_keys` (plural) but the actual entity tableName values are singular. Use the entity-derived names — they're what's in the DB.

## Risks

- **Wrong table list / FK violation** → covered by `TRUNCATE ... CASCADE` plus a unit test on the route that asserts `204 No Content` against an empty schema and after a seed.
- **Reset bleeds into non-PRM data** → the reset route lists tables explicitly and never accepts a wildcard; a unit test asserts other tables (e.g. `customer_users`, `organizations`) are untouched.
- **Reset runs in production by accident** → identical 404-gate as `agency-member-link/route.ts` (`OM_PRM_TEST_FIXTURES_ENABLED=1`). A unit test asserts `404` when the env var is unset.
- **`beforeEach` slows the suite** → measured at ~30ms per call (single SQL roundtrip); 26 tests × 30ms = under 1s overhead. Acceptable.
- **Race against another worker** → suite runs `workers: 1` (verified in `playwright.config.ts`). If that ever changes, beforeEach reset becomes unsafe across workers. Documented inline as a guardrail.

## Implementation Plan

### Phase 1 — Reset seam route

1.1 Create `src/modules/prm/api/test-fixtures/reset/route.ts`:
- Same env gate as `agency-member-link/route.ts` (`OM_PRM_TEST_FIXTURES_ENABLED=1` else 404).
- Same auth contract (staff Bearer JWT with `prm.agency.invite_admin` — reuses the production feature so the seam can never widen authorisation; whichever staff token already drives PRM fixtures will work).
- POST handler executes a single `TRUNCATE TABLE prm_agency_members, prm_prospect_candidate_index, prm_rfp_response_scores, prm_rfp_responses, prm_rfp_broadcasts, prm_rfps, prm_license_deals, prm_prospects, prm_agencies, prm_case_studies, prm_marketing_materials, prm_wic_contributions, prm_wic_import_audit_log, prm_service_idempotency_key RESTART IDENTITY CASCADE` against the request EM connection.
- Returns `{ ok: true, truncatedTables: [...] }` with status 200.
- Exports `metadata` (`requireAuth`, `requireFeatures`) and `openApi` for discovery parity.

1.2 Unit-test the route under `src/modules/prm/__tests__/test-fixtures/reset.test.ts`:
- 404 when `OM_PRM_TEST_FIXTURES_ENABLED` is unset.
- 401 when no auth.
- 200 + tables truncated when gated open and authed.
- Asserts non-PRM table (e.g. `organizations` row count) remains unchanged.

### Phase 2 — `resetPrmState()` helper

2.1 Add `resetPrmState(request, token)` to `src/modules/prm/testing/integration/fixtures.ts`:
- POST to `/api/prm/test-fixtures/reset`.
- Asserts 200 and `ok: true`.
- Returns void.

2.2 Re-export from `src/modules/prm/testing/integration/index.ts`.

### Phase 3 — Wire `beforeEach` into PRM Playwright specs

3.1 Add `test.beforeEach` calling `resetPrmState()` to each PRM spec under `.ai/qa/tests/integration/`:
- `TC-PRM-T0-001-agency-happy-path.spec.ts`
- `TC-PRM-T0-002-create-flow-ui.spec.ts`
- `TC-PRM-T1-001-prospect-happy-path.spec.ts`
- `TC-PRM-T2-001-attribution-happy-path.spec.ts`
- `TC-PRM-T3-001-wic-ingestion-happy-path.spec.ts`
- `TC-PRM-T5-001-rfp-publish-happy-path.spec.ts`
- `TC-PRM-T5-002-portal-rfp-byte-identical-404.spec.ts`
- `TC-PRM-T5-003-portal-rfp-submit-happy-path.spec.ts`
- `TC-PRM-SMOKE-001-fixtures.spec.ts`

(Skip `TC-CLI-001-agentic-init.spec.ts` — not PRM, doesn't seed PRM rows.)

3.2 Each `beforeEach` acquires the staff `admin` token (already a cheap one-time seed) and calls `resetPrmState`.

### Phase 4 — Regression spec proving the helper works

4.1 Add `.ai/qa/tests/integration/TC-PRM-RESET-001-test-isolation.spec.ts`:
- Test #1: seed an Agency, assert created.
- Test #2: list all Agencies via the staff API, assert the test-#1 Agency is gone (i.e. count is whatever the empty-state is).
- Demonstrates beforeEach is doing its job. Two-test minimum so the bleed lane is exercised back-to-back inside a single spec file (orthogonal to cross-spec bleed but cheap & catches regressions if the helper ever becomes a no-op).

### Phase 5 — Validation gate

5.1 `yarn typecheck`
5.2 `yarn jest src/modules/prm` — assert ≥482 passing (482 was the baseline; new reset.test.ts adds 4-ish tests).
5.3 `yarn test:integration:ephemeral` with `OM_PRM_TEST_FIXTURES_ENABLED=1 OM_PRM_WIC_IMPORT_SECRET=dev-wic-secret-for-local-and-integration-tests-1234567890` — run twice back-to-back. T5-001 #1 must pass green both runs.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reset seam route

- [x] 1.1 Create `src/modules/prm/api/test-fixtures/reset/route.ts` — d1cf385
- [x] 1.2 Add unit tests in `src/modules/prm/__tests__/testFixturesResetRoute.test.ts` — d1cf385

### Phase 2: `resetPrmState()` helper

- [ ] 2.1 Add `resetPrmState` to `fixtures.ts`
- [ ] 2.2 Re-export from `testing/integration/index.ts`

### Phase 3: Wire `beforeEach` into PRM Playwright specs

- [ ] 3.1 Add `test.beforeEach` to all PRM specs
- [ ] 3.2 Confirm each beforeEach acquires admin token + calls reset

### Phase 4: Regression spec

- [ ] 4.1 Add `TC-PRM-RESET-001-test-isolation.spec.ts`

### Phase 5: Validation gate

- [ ] 5.1 `yarn typecheck`
- [ ] 5.2 `yarn jest src/modules/prm` ≥482 passing
- [ ] 5.3 `yarn test:integration:ephemeral` × 2 back-to-back, T5-001 #1 green both runs
