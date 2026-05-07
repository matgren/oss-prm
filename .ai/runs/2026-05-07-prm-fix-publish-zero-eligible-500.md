# Run plan — prm-fix-publish-zero-eligible-500

**Branch:** `fix/prm-fix-publish-zero-eligible-500`
**Target:** `develop`
**Origin:** post-mvp-beta-t3 final-test gate; pre-existing Spec #5 bug masked by the develop migration-init failure that the mvp-beta-t3 batch unblocked.
**Source spec:** `.ai/specs/SPEC-2026-04-23-rfp-broadcast-response.md` §9.1 #3 (frozen — not edited by this run; only `.ai/specs/POST-MVP-FOLLOW-UPS.md` is touched).

## Goal

Fix `POST /api/prm/rfp/{id}/publish` so a zero-eligible publish (e.g. `eligibility_filter=by_min_tier` + `min_tier=ai_native_core` against a single `om_agency` tier) returns the documented `409 validation_failed` envelope instead of `500`/`null`.

## Scope

- One-line decision required: figure out the actual root cause (upstream throw before the eligibility check, `instanceof PrmDomainError` failing under dual-load, or something stranger) and apply the narrowest fix.
- Apply the fix consistently — if the root cause is `instanceof` failing across module-resolution paths, every PRM route that uses that pattern (~39 sites) MUST be corrected, otherwise the same bug lurks elsewhere.
- Add a unit test that exercises the route handler at the HTTP boundary (not just the service layer), so a future "500/null on a thrown PrmDomainError" regression surfaces immediately.
- Capture two POST-MVP follow-up entries surfaced by the post-mvp-beta-t3 gate (test isolation + integration runner env-config docs).

## Non-goals

- DO NOT touch any frozen spec under `.ai/specs/SPEC-*.md`.
- DO NOT modify env files beyond documentation.
- DO NOT address T5-001 #1 (full-suite Agency leak); that is a separate POST-MVP item and is out of scope here.
- DO NOT introduce string-matching error shims; only structured `name` checks or a typed helper.
- DO NOT eject or modify any `@open-mercato/*` core module.

## Implementation Plan

### Phase 1: Reproduce + identify root cause

- Add temporary `console.error('[T5-001-debug]', err?.constructor?.name, err?.message, err?.stack)` to the catch block in `src/modules/prm/api/rfp/[id]/publish/route.ts`.
- Run `OM_PRM_TEST_FIXTURES_ENABLED=1 OM_PRM_WIC_IMPORT_SECRET=dev-wic-secret-for-local-and-integration-tests-1234567890 yarn test:integration:ephemeral --filter "TC-PRM-T5-001"` and capture stderr.
- If runner swallows stderr, try unit-level repro via a route-handler test that simulates the HTTP boundary, since the service test for the same scenario passes (so the failure must be at the handler boundary).
- Identify whether the throw is `PrmDomainError` failing `instanceof` (dual-load), an upstream throw (e.g. `loadRfpForWrite` / `findWithDecryption`), or a different error type entirely.
- Remove the debug logging.

### Phase 2: Narrowest fix

- If `instanceof PrmDomainError` is the issue: add an `isPrmDomainError(err): err is PrmDomainError` helper to `src/modules/prm/lib/errors.ts` that uses a tag check (`err?.name === 'PrmDomainError'` + structural shape: `code`, `status`). Replace `err instanceof PrmDomainError` in every PRM route catch with `isPrmDomainError(err)`. This is narrow because it has a single root cause but applies at multiple call sites — leaving any unfixed leaves the same bug latent.
- If upstream throw: catch the offending throw at the right boundary and rethrow as a typed `PrmDomainError`.
- Either way, the route MUST return a structured `{ ok: false, error: { code, message } }` envelope, never a bare 500.

### Phase 3: Regression tests

- Add a unit test under `src/modules/prm/__tests__/` that invokes the publish route handler directly (bypassing the network) with a mocked container that returns a service which throws a `PrmDomainError(VALIDATION_FAILED, ..., 409)` — assert response status 409 AND body `{ ok: false, error: { code: 'validation_failed', message: ... } }`.
- Bonus: extend the unit test with the dual-load / `name`-only check (construct an error-like object with the right shape but a non-`instanceof` prototype, verify the helper still recognises it) so any future regressions in the helper itself surface.

### Phase 4: POST-MVP-FOLLOW-UPS entries

Append two entries to `.ai/specs/POST-MVP-FOLLOW-UPS.md`:

1. Test isolation for `.ai/qa/tests/integration/` — agencies leak across specs because there's no per-test reset. Currently masked because most specs use unique slugs/names. T5-001 #1 fails in full-suite runs (passes in isolation). Effort: M.
2. Integration runner needs `.env` documentation — `OM_PRM_TEST_FIXTURES_ENABLED=1` and `OM_PRM_WIC_IMPORT_SECRET=...` are documented in `.env.example` (commented-out) but missing from the committed `.env` template guidance in `AGENTS.md`. Without them, `yarn test:integration:ephemeral` fails 13 of 26 tests with "404"/"WIC import secret not configured". Effort: S.

If Phase 2 leaves any `instanceof PrmDomainError` sites unfixed (i.e. fix is one-route patch only), add a third entry tracking the broader cleanup as out-of-scope.

### Phase 5: Validation gate

- `yarn typecheck`
- `yarn jest` (full suite — must remain ≥ 464 passing)
- `OM_PRM_TEST_FIXTURES_ENABLED=1 OM_PRM_WIC_IMPORT_SECRET=dev-wic-secret-for-local-and-integration-tests-1234567890 yarn test:integration:ephemeral` (must show ≥ 24/26 with TC-PRM-T5-001 #3 passing; the only acceptable lingering failure is T5-001 #1 cross-spec test isolation, which is tracked as POST-MVP)
- `yarn build`

## Risks

- **`instanceof` fix surface is wide (~39 sites):** if I take the helper-replacement route, the diff is large but mechanical. Risk mitigated by leaving the `PrmDomainError` class + `instanceof` semantics unchanged (additive helper); existing unit tests keep passing.
- **`yarn test:integration:ephemeral` runtime is long:** I will run it once after the fix; if a transient cross-spec leak (T5-001 #1) keeps failing, that's expected per the task brief and tracked as POST-MVP.
- **Missing the actual root cause:** mitigated by capturing the actual `err?.constructor?.name` + `err?.message` first via temporary instrumentation before writing the fix.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce + identify root cause

- [ ] 1.1 Add temporary debug catch instrumentation to publish route
- [ ] 1.2 Run failing test in isolation, capture actual error class/message
- [ ] 1.3 Decide root cause (instanceof / upstream / other) — record in plan
- [ ] 1.4 Remove debug instrumentation

### Phase 2: Apply narrowest fix

- [ ] 2.1 Implement chosen fix at the right layer
- [ ] 2.2 Sweep PRM routes for the same root-cause pattern (if applicable)

### Phase 3: Regression tests

- [ ] 3.1 Unit test invoking the publish route handler directly, asserting body shape
- [ ] 3.2 Helper-level test (if isPrmDomainError helper added) covering tag-based detection

### Phase 4: POST-MVP-FOLLOW-UPS entries

- [ ] 4.1 Append test-isolation + integration-runner-env entries to POST-MVP-FOLLOW-UPS.md

### Phase 5: Validation gate

- [ ] 5.1 yarn typecheck
- [ ] 5.2 yarn jest (full)
- [ ] 5.3 yarn test:integration:ephemeral (with required env vars)
- [ ] 5.4 yarn build

### Phase 6: Open PR + summary comment

- [ ] 6.1 Push branch + open PR against develop
- [ ] 6.2 Apply labels (review, bug)
- [ ] 6.3 Post comprehensive PR summary comment
