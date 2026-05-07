# Execution Plan — Fix RfpPathBLockSubscriber scope-column mismatch (IT-9.4 unblock)

**Date:** 2026-05-07
**Slug:** `prm-rfp-path-b-lock-organization-id`
**Branch:** `fix/prm-rfp-path-b-lock-organization-id`
**Target:** `develop`
**Source items (POST-MVP-FOLLOW-UPS.md):** "Playwright integration tests (deferred) → T2 Attribution Loop → IT-9.4 — Path-B hard guard (cross-spec coordination with Spec #6)" (line 63 on develop).
**Source spec:** `.ai/specs/SPEC-2026-04-23-attribution-loop.md` §9 IT-9.4 + §8.4 cross-spec contract.

## Goal

Fix the in-process subscriber bug that prevented `RfpPathBLockSubscriber` from writing `prm_rfps.is_path_b_locked = true` after a Path-B attribution, then ship the previously-fixmed integration test that exercises the cross-spec contract.

## Root cause (already diagnosed and validated)

`src/modules/prm/subscribers/rfp-path-b-lock.ts` filters `prm_rfps` by `tenant_id`, but `prm_rfps` has only `organization_id` (no `tenant_id` column — see `src/modules/prm/data/entities.ts:503-510` Rfp entity + `src/modules/prm/migrations/Migration20260506224953_prm_rfp.ts:30`). The UPDATE silently throws `column "tenant_id" does not exist` (Postgres error code 42703); the events bus's per-handler `try/catch` (`@open-mercato/events/src/bus.ts:118-129`) swallows it to `console.error`, invisible to Playwright. The unit tests (`src/modules/prm/__tests__/rfpPathBLockSubscriber.test.ts`) are green only because they use a `FakeKnexBuilder` mock that records `whereCalls` without executing SQL — the schema mismatch is invisible at the unit-test surface.

End-to-end verified during pre-implementation diagnosis: with the fix applied, `TC-PRM-T2-004-path-b-hard-guard.spec.ts` passes in 1.1s; unit tests stay 8/8 green.

The bug is **not** the wildcard `workflows:event-trigger` subscriber consuming the event ahead of the PRM subscriber (it returns early — `safeEmit` does not pass `tenantId` in `EmitOptions`, so `ctx.tenantId` is null and the wildcard early-returns before any side effect). The bug is **not** `createLazyModuleSubscriber` silently failing on first invoke (instrumentation confirms the handler IS entered first invoke). The IT-9.4 test docstring's two suspect causes were both eliminated by the diagnostic run.

## Scope

### In scope (additive only)

1. `src/modules/prm/subscribers/rfp-path-b-lock.ts` — change the `prm_rfps` UPDATE filter from `tenant_id` to `organization_id`; require `organizationId` in the early-return guard; add a docstring "Scope-column note" explaining the intra-PRM scope split (`prm_license_deals` is tenant-scoped; `prm_rfps` is organization-scoped).
2. `src/modules/prm/__tests__/rfpPathBLockSubscriber.test.ts` — payload-guards test now also covers missing `organizationId`; branch-3 happy-path assertion changed from `['tenant_id', 'tenant-1']` to `['organization_id', 'org-1']` with an inline comment.
3. `.ai/qa/tests/integration/TC-PRM-T2-004-path-b-hard-guard.spec.ts` — new file, copied from `git show test/prm-t2-attribution-it-9-2-through-9-7:.ai/qa/tests/integration/TC-PRM-T2-004-path-b-hard-guard.spec.ts` (i.e. commit `c54f4d6`), with `test.fixme(...)` flipped to `test(...)` and the now-stale 30+ line STATUS docstring block removed.
4. `.ai/specs/POST-MVP-FOLLOW-UPS.md` — strike the "IT-9.4 — Path-B hard guard" entry on line 63.

### Non-goals (explicitly out)

- Cherry-picking the full F3 fleet (commit c54f4d6 has 5 other tests — IT-9.2, 9.3, 9.5, 9.6, 9.7 — that ship in a separate PR off branch `test/prm-t2-attribution-it-9-2-through-9-7`).
- Touching the events bus, the lazy loader, the wildcard `workflows:event-trigger` subscriber, or anything in `node_modules/@open-mercato/`.
- Touching any other PRM file.
- Touching the unit tests for branches 1 and 2 (table-missing and column-missing) — those branches don't query `prm_rfps` at all, so they're not affected by the scope-column change.

## Risks

- **R1 (very low) — BC impact on the `prm.license_deal.status_changed` payload contract.** The payload already carries `organizationId` (verified at `src/modules/prm/lib/licenseDealService.ts:597`). The subscriber merely starts requiring it. Other subscribers on the same event already require `organizationId` (see e.g. `prm:license-deal-reversal-compensation`). Net impact: zero — the payload shape doesn't change.
- **R2 (low) — Other PRM subscribers on `prm.license_deal.status_changed` repeat the `tenant_id` mistake against `prm_rfps`.** Verified by `rtk grep -rn "prm_rfps.*tenant_id\|knex('prm_rfps')" src/modules/prm/`: only this one subscriber has the bug. No other call sites need fixing.
- **R3 (none expected) — Test isolation bleed across the F3 fleet.** This PR ships only TC-PRM-T2-004 (NOT the rest of F3); the test uses the standard `resetPrmState` fixture, identical to the other 11 currently-shipped Playwright tests. No new fixtures.
- **R4 (none expected) — Re-running the F3 fleet PR will conflict on the same test file.** The F3 branch has the test in fixmed state; this PR ships it un-fixmed. Whichever lands second can rebase + delete-only the fixme line. Treat as an additive merge conflict; no hidden semantic conflict.

## External References

None. The fix is informed by:
- `src/modules/prm/data/entities.ts` Rfp entity (line 503-510 — `organization_id` column)
- `src/modules/prm/migrations/Migration20260506224953_prm_rfp.ts:30` (CREATE TABLE has only `organization_id`, no `tenant_id`)
- `src/modules/prm/lib/licenseDealService.ts:592-611` (the emit site shape — `organizationId` is already in the payload)
- `git show c54f4d6:.ai/qa/tests/integration/TC-PRM-T2-004-path-b-hard-guard.spec.ts` (the fixmed test on the F3 branch)

## Implementation Plan

### Phase 1 — Subscriber fix + unit-test correction

- 1.1 Edit `src/modules/prm/subscribers/rfp-path-b-lock.ts`:
  - Change the early-return guard from `if (!payload?.tenantId || !payload?.rfpId) return` to `if (!payload?.tenantId || !payload?.organizationId || !payload?.rfpId) return`.
  - Change the `prm_rfps` UPDATE chain's second `.where('tenant_id', payload.tenantId)` to `.where('organization_id', payload.organizationId)`.
  - Append a "Scope-column note" paragraph to the file-level JSDoc explaining `prm_license_deals` carries `tenant_id` while `prm_rfps` scopes by `organization_id`.
- 1.2 Edit `src/modules/prm/__tests__/rfpPathBLockSubscriber.test.ts`:
  - Update the first `it('no-ops when tenantId or rfpId is missing...)` test name and body to also cover missing `organizationId`.
  - Update the branch-3 happy-path's `rfpsRecord.whereCalls` assertion from `['tenant_id', 'tenant-1']` to `['organization_id', 'org-1']`.
  - Add a one-line comment above the assertion explaining the scope-column split.
- 1.3 Run `yarn jest src/modules/prm/__tests__/rfpPathBLockSubscriber.test.ts` (must be 8/8 green).
- 1.4 Run `yarn jest src/modules/prm` (must stay green — no other test references `tenant_id` on `prm_rfps`).
- 1.5 Run `yarn typecheck` (must pass — adding `organizationId` to the guard does not change the public type since it was already in `StatusChangedPayload`).
- 1.6 Single commit: `fix(prm): RfpPathBLockSubscriber filter prm_rfps by organization_id (IT-9.4 root cause)`.

### Phase 2 — Ship the IT-9.4 integration test

- 2.1 Copy `.ai/qa/tests/integration/TC-PRM-T2-004-path-b-hard-guard.spec.ts` from `git show c54f4d6:.ai/qa/tests/integration/TC-PRM-T2-004-path-b-hard-guard.spec.ts` to develop.
- 2.2 Replace `// eslint-disable-next-line playwright/no-skipped-test\n  test.fixme(` with `test(` (un-fixme).
- 2.3 Remove the now-stale 30+ line "STATUS — `test.fixme()` (2026-05-07): ..." comment block from the docstring.
- 2.4 Run the validated integration smoke: `OM_PRM_TEST_FIXTURES_ENABLED=1 OM_PRM_WIC_IMPORT_SECRET="ci-it94-32char-secret-aaaaaaaaaaa" yarn test:integration:ephemeral --filter "TC-PRM-T2-004" --verbose` (must pass — proven 1.1s).
- 2.5 Single commit: `test(prm): un-fixme TC-PRM-T2-004 IT-9.4 Path-B hard-guard integration test`.

### Phase 3 — Tracker hygiene

- 3.1 Strike `IT-9.4 — Path-B hard guard (cross-spec coordination with Spec #6)` from `.ai/specs/POST-MVP-FOLLOW-UPS.md` line 63 (replace the bullet body with a `~~strikethrough~~` containing a SHIPPED reference).
- 3.2 Single commit: `docs(postmvp): strike IT-9.4 Path-B hard guard (shipped)`.

### Phase 4 — Validation gate + PR

- 4.1 Run the full validation gate: `yarn typecheck && yarn jest src/modules/prm && yarn build`.
- 4.2 Run i18n checks (no locale changes expected, but cheap to verify): `yarn i18n:check-sync && yarn i18n:check-usage`.
- 4.3 Push the branch and open the PR against `develop` with labels `fix`, `review`, `skip-qa` (per AGENTS.md skip-qa criteria — this PR's only customer-facing surface is the read-model write that was already proven via the un-fixmed integration test).
- 4.4 Run `auto-review-pr` autofix pass against the PR.
- 4.5 Post the lean (v1.12.0+) summary comment.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Subscriber fix + unit-test correction

- [x] 1.1 Edit subscriber to filter prm_rfps by organization_id — ffb9aa0
- [x] 1.2 Edit unit test to assert organization_id and cover missing organizationId — ffb9aa0
- [x] 1.3 Run targeted unit tests (8/8 green) — 8/8 pass
- [x] 1.4 Run full PRM jest suite (must stay green) — 636/636 pass
- [x] 1.5 Run typecheck (must pass) — clean
- [x] 1.6 Commit Phase 1 (fix(prm): RfpPathBLockSubscriber filter prm_rfps by organization_id) — ffb9aa0

### Phase 2: Ship the IT-9.4 integration test

- [ ] 2.1 Copy TC-PRM-T2-004 spec from c54f4d6
- [ ] 2.2 Un-fixme the test
- [ ] 2.3 Remove stale STATUS comment block
- [ ] 2.4 Run integration smoke (must pass)
- [ ] 2.5 Commit Phase 2 (test(prm): un-fixme TC-PRM-T2-004 IT-9.4)

### Phase 3: Tracker hygiene

- [ ] 3.1 Strike IT-9.4 entry from POST-MVP-FOLLOW-UPS.md
- [ ] 3.2 Commit Phase 3 (docs(postmvp): strike IT-9.4)

### Phase 4: Validation gate + PR

- [ ] 4.1 Run full pre-PR validation gate
- [ ] 4.2 Run i18n checks
- [ ] 4.3 Open PR against develop with `fix` + `review` + `skip-qa` labels
- [ ] 4.4 Run auto-review-pr autofix pass
- [ ] 4.5 Post lean summary comment

## Changelog

- 2026-05-07: plan created.
