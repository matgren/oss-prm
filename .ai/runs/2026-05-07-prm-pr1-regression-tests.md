# PRM PR #1 resume-bug regression tests

Run plan for the POST-MVP-FOLLOW-UPS entry "Unit-test coverage for the two PR #1 resume bugs (T0 Agency)".

## Goal

Add regression tests that would have caught the two PR #1 resume bugs at jest time, so a future revert of either fix turns the corresponding test red.

## Scope

- New test file(s) under `src/modules/prm/__tests__/` covering:
  1. **Real Awilix DI resolution** with `InjectionMode.CLASSIC` for the PRM service registrations — proves that destructured-param `asFunction(...)` registrations chain `.proxy()` and that `em` is actually injected. Complements the existing static-text scanner `diProxyGuardrail.test.ts` with a runtime check.
  2. **Pre-flush UUID coherence** in `agencyService.createAgencyWithOrganization` — proves the service pre-generates the Organization UUID in-process so that `Agency.organizationId` is non-null at create-time, even when the EM does NOT auto-assign IDs on `create()` (the realistic Postgres behaviour with `defaultRaw: 'gen_random_uuid()'`).
- Tests must NOT use the existing `FakeEntityManager` shape that masked both bugs.
- Bugs are already fixed in commits d0141c2 + c488dbb. This PR adds tests only — production code is not touched.

## Source spec

Origin: `.ai/specs/POST-MVP-FOLLOW-UPS.md` Tracker line:

> **Unit-test coverage for the two PR #1 resume bugs (T0 Agency)** — Add tests that (a) construct `agencyService` via the real DI container (not the `FakeEntityManager`) and verify `em` is injected, and (b) verify `Agency.organizationId` matches the persisted Organization's id end-to-end. The `FakeEntityManager` auto-assigns ids on `create()`, which is why both bugs (DI resolution + pre-flush `.id` undefined) were missed by jest.

## Non-goals

- No production code changes.
- No edits to `FakeEntityManager` or existing tests that use it.
- No new Playwright integration tests — these are pure jest unit tests.
- No work on other deferred POST-MVP items.

## Implementation Plan

### Phase 1: Real-Awilix DI resolution test

Build a unit test that imports `register` from `src/modules/prm/di.ts`, creates a fresh Awilix container with `InjectionMode.CLASSIC` (mirroring the request container in `@open-mercato/shared/lib/di/container.ts`), pre-registers a sentinel `em` value, runs the registrar, and resolves each service. The test asserts the resolved service receives the actual `em` reference — not `undefined`. This would have caught the original DI bug at jest time, before the fix.

A static-text scanner already exists (`diProxyGuardrail.test.ts`); it catches the *shape*. The new test catches the *runtime behaviour* — specifically, a future regression where someone replaces `.proxy()` with another sibling helper that satisfies the regex but breaks injection (defense in depth).

### Phase 2: Pre-flush UUID coherence test

Build a unit test that exercises `agencyService.createAgencyWithOrganization` against a hand-rolled fake EM that simulates the Postgres `defaultRaw: 'gen_random_uuid()'` behaviour: `em.create()` does NOT auto-assign an ID; the row's `id` is left undefined until `em.flush()`. Pre-fix this would surface as `Agency.organizationId === undefined` (or a "Value for Agency.organizationId is required" thrown by the fake EM). Post-fix the service pre-generates the UUID via `randomUUID()` so `Agency.organizationId` matches `Organization.id` and is set BEFORE the flush.

The fake EM lives in the test file (or a sibling test helper) to keep it scoped and avoid mutating the shared `FakeEntityManager`, which intentionally auto-assigns IDs and is relied on by other tests.

### Phase 3: Wire-up + sanity checks

- Run `yarn jest src/modules/prm` and confirm both new tests are collected and green.
- Run `yarn typecheck` to confirm no type breakage.
- Optionally verify locally — by temporarily reverting the fix in a scratch copy — that each test would FAIL without the corresponding production fix. Do NOT commit any revert.

## Risks

- **Fake EM divergence from real MikroORM.** The Phase 2 fake EM needs to mirror the post-flush ID-assignment behaviour closely enough that the test is meaningful. Mitigation: keep the fake minimal (just the surface used by `agencyService` — `create`, `persist`, `findOne`, `flush`, `transactional`) and mark explicitly in comments which assertion proves the bug shape.
- **Awilix internal API drift.** Awilix `InjectionMode.CLASSIC` is part of the framework contract (the request container uses it). A future Awilix major could rearrange it. Mitigation: import `InjectionMode` from awilix directly, same as the request container.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Real-Awilix DI resolution test

- [x] 1.1 Add `agencyService.diResolution.test.ts` covering each PRM destructured-param registration end-to-end with a real Awilix container — 31be238

### Phase 2: Pre-flush UUID coherence test

- [x] 2.1 Add `agencyService.uuidCoherence.test.ts` exercising `createAgencyWithOrganization` against an EM that does NOT auto-assign IDs, asserting `Agency.organizationId === Organization.id` and is non-null at flush time — 5c1752a

### Phase 3: Wire-up + sanity checks

- [x] 3.1 Run `yarn jest src/modules/prm` green (413/413 across 44 suites) and `yarn typecheck` clean (exit 0); `yarn build` also green — ce4881a
- [x] 3.2 Open the PR (#15 — https://github.com/matgren/oss-prm/pull/15) and post the comprehensive summary comment

## Changelog

- 2026-05-07 — PR #15 opened against `develop`. `auto-review-pr` autofix pass returned APPROVED on first cycle (no findings). PR moved to `merge-queue`. Status: complete.
