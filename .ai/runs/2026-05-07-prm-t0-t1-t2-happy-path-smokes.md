---
title: PRM T0/T1/T2 §9 happy-path Playwright smokes
slug: prm-t0-t1-t2-happy-path-smokes
date: 2026-05-07
branch: feat/prm-t0-t1-t2-happy-path-smokes
author: matgren (via om-auto-create-pr)
---

# Run plan — PRM T0/T1/T2 §9 happy-path Playwright smokes

## Goal

Land the three deferred §9 happy-path Playwright integration smokes for PRM
Specs #1, #2, #3 (T0/T1/T2). Closes the launch-gate prerequisite tracked in
`.ai/specs/POST-MVP-FOLLOW-UPS.md` (Playwright integration tests — deferred)
and the dropped Phases 3/4/5 of `.ai/runs/2026-05-06-prm-url-fix-and-smoke-tests.md`.
After this lands the user can apply the `mvp-beta-t2` tag.

## Source documents

- **Project rules:** `AGENTS.md` (root), `.ai/skills/integration-tests/SKILL.md`
- **Spec sources for smoke tests:**
  - `.ai/specs/SPEC-2026-04-23-agency-foundation.md` §9 IT-1 (T0)
  - `.ai/specs/SPEC-2026-04-23-wip-scoreboard.md` §9 IT-9.1 (T1)
  - `.ai/specs/SPEC-2026-04-23-attribution-loop.md` §9 IT-9.1 (T2)
- **Origin run plan (Phases 3/4/5 dropped, now resumed):** `.ai/runs/2026-05-06-prm-url-fix-and-smoke-tests.md`
- **Tracking entry:** `.ai/specs/POST-MVP-FOLLOW-UPS.md` "Playwright integration tests (deferred)"

## External References

None — no `--skill-url` arguments passed.

## Hard constraints

1. **Reuse existing harness** — don't scaffold anything new:
   - `.ai/qa/tests/playwright.config.ts` (uses `@open-mercato/cli/lib/testing/integration-discovery`)
   - `src/modules/prm/testing/integration/{index,fixtures,customerAuth}.ts`
   - Test-only seam `POST /api/prm/test-fixtures/agency-member-link` (env `OM_PRM_TEST_FIXTURES_ENABLED=1`)
2. **Each spec must run TWICE green in a row before commit.** Proves teardown / ephemeral DB reset works.
3. **T2 saga polling:** explicit 30s timeout via `expect.poll(...)`. **No stubs, real saga only.** If the
   poll times out, that's a production bug — surface in PR body and stop.
4. **`apiRequest`-style fixture pattern only.** No raw SQL, no direct EM access in tests.
5. **Do NOT modify** `TC-PRM-T5-002-portal-rfp-byte-identical-404.spec.ts`, `TC-PRM-T5-003-portal-rfp-submit-happy-path.spec.ts`,
   `TC-PRM-SMOKE-001-fixtures.spec.ts`. Those are already green and part of a different surface area.
6. **Fixture changes are additive only** — don't rename existing exports in `src/modules/prm/testing/integration/`.
7. **Naming:** `TC-PRM-<phase>-<id>-<desc>.spec.ts`.
8. **Tests-with-code commit discipline:** every code change ships with its test in the same commit.
9. **PR target: `develop`.**

## Implementation Plan

### Phase 1 — Bootstrap (env wiring + fixture additions)

The customer-portal auth helper requires `OM_PRM_TEST_FIXTURES_ENABLED=1` for the test-only
`agency-member-link` seam to return 200/201 instead of 404. The existing `.env.example`
documents the var but the live `.env` does NOT set it. The ephemeral runner inherits
`process.env`, so flipping the var in `.env` is sufficient for `yarn test:integration:ephemeral`.

For T1/T2 we also need:
- A staff-side `transitionProspectFixture(request, customerToken, prospectId, toStatus)` helper
  to drive the qualified→contacted path. Mirrors the existing portal endpoint contract
  (PATCH `/api/prm/portal/prospects/{id}` with `{ kind: 'transition', toStatus }`).
- An `attributeLicenseDealFixture(request, staffToken, licenseDealId, body)` helper for T2's
  Path A attribution call (POST `/api/prm/license-deal/{id}/attribute`).
- A `getProspectViaPortalFixture(request, customerToken, prospectId)` helper for the saga
  status poll.

All three are thin `apiRequest` wrappers — additive exports only.

Steps:
- 1.1 Add `OM_PRM_TEST_FIXTURES_ENABLED=1` to `.env` (project-local; `.env` is gitignored,
  but commit a corresponding documentation note in `.env.example` if it isn't already there).
- 1.2 Extend `src/modules/prm/testing/integration/fixtures.ts` with:
  `transitionProspectViaPortalFixture`, `attributeLicenseDealFixture`,
  `getProspectViaPortalFixture`. Re-export from `index.ts`.
- 1.3 Add a focused unit test under `src/modules/prm/__tests__/` that the new fixtures call
  the expected route + verb (using a stubbed `APIRequestContext`). This satisfies the
  tests-with-code gate for the Phase 1 commit.
- 1.4 `yarn typecheck` clean; `yarn jest src/modules/prm` green.

Commit: `test(prm): testing fixtures — transition prospect, attribute license deal, get prospect (additive)`

### Phase 2 — T0 smoke (IT-1: Agency happy path)

Source: SPEC-2026-04-23-agency-foundation.md §9 IT-1.

Scenario: OMPartnerOps creates Agency, invites a PartnerAdmin, the invite is
"accepted" (via the test-only seam — bypasses the email/accept dance), and the
PartnerAdmin's profile is filled in. Covers US1.1, US1.2, US1.4, US2.1.

Implementation choice — **stay on the HTTP contract layer, not full UI**.
The OQ-014 email/accept dance is a known integration gap; the production-equivalent
flow is "create Agency → invite member → accept token → assume role". The Agency
fixture already exercises `POST /api/prm/agency`. The invite endpoint
(`POST /api/prm/agency/{id}/invite`) is what IT-1 most cares about — it returns
`{ agencyMemberId, invitationId, expiresAt }`. We assert that response, then use
the test-only `agency-member-link` seam to complete the dance, log in as the
partner_admin, and PATCH the partner's profile via the portal `agency-member` route.

Steps:
- 2.1 Create `.ai/qa/tests/integration/TC-PRM-T0-001-agency-happy-path.spec.ts`:
  - `staffToken = await getAuthToken('admin')`.
  - Create Agency via `createAgencyFixture`.
  - PATCH it onboarded via `setAgencyOnboardedFixture`.
  - POST `/api/prm/agency/{id}/invite` directly (no fixture wrapper needed — single-shot)
    — assert 201 with `agencyMemberId`, `invitationId`, `expiresAt`.
  - Re-invite cooldown sanity probe: a second POST within 10min returns 429 with
    `retryAfterSeconds`. (Bonus: this doubles as cheap IT-6 coverage.)
  - Boot a separate Agency via `bootPartnerAgencyWithMembers` (uses the test-only
    seam — the canonical "invite-accepted" outcome). Assert `admin.token` works
    against `/api/prm/portal/me`.
  - Profile fill: PATCH `/api/prm/portal/agency-member/{memberId}` with `firstName`,
    `lastName`, `githubProfile` — assert 200 + persisted values via subsequent GET.
- 2.2 Run twice via `yarn test:integration:ephemeral --filter TC-PRM-T0-001`. Both green.
- 2.3 If a real bug surfaces: surface in PR body. Fix only if <50 LOC.

Commit: `test(prm): T0 IT-1 §9 — Agency creation + invite + accept + profile fill happy path`

### Phase 3 — T1 smoke (IT-9.1: Prospect register → transition → widget)

Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.1.

Scenario: PartnerAdmin registers a Prospect, transitions it qualified → contacted,
sees widget update on the dashboard.

Steps:
- 3.1 Create `.ai/qa/tests/integration/TC-PRM-T1-001-prospect-happy-path.spec.ts`:
  - Boot Agency + partner_admin via `bootPartnerAgencyWithMembers`.
  - Register Prospect via `createProspectFixture` (portal-side; uses `customerToken`).
  - Assert status `new` → call portal PATCH transition to `qualified`. Assert.
  - Assert canTransitionTo includes `contacted` → call portal PATCH to `contacted`. Assert.
  - GET `/api/prm/portal/dashboard` — assert WIP yearly count = 1, byStatus.contacted >= 1.
  - GET `/api/prm/portal/dashboard` — assert tier widget present (`tier.current`).
  - (Per spec: P5/P6/P2 happy path — using API-contract instead of UI render saves on
    selector-fragility and proves the same invariants.)
- 3.2 Run twice via `yarn test:integration:ephemeral --filter TC-PRM-T1-001`. Both green.
- 3.3 Surface bugs same way as Phase 2.

Commit: `test(prm): T1 IT-9.1 §9 — Prospect register + transitions + dashboard widget happy path`

### Phase 4 — T2 smoke (IT-9.1: Path A attribution + saga + MIN)

Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.1.

Scenario: OMPartnerOps creates a LicenseDeal, attributes it via Path A (Golden Rule
auto-pick of an existing Prospect), the saga completes within 30s, the Prospect's
status walks to `won`, and the Agency's portal MIN widget reflects the deal value.

The attribute route runs an inline saga + emits the saga event (the platform's
wildcard subscriber also picks it up). With `runInlineSaga` in the route handler,
the response itself returns the post-saga snapshot, so the 30s polling is
defence-in-depth (catches workers-not-running regressions).

Steps:
- 4.1 Create `.ai/qa/tests/integration/TC-PRM-T2-001-attribution-happy-path.spec.ts`:
  - Boot Agency + partner_admin (via `bootPartnerAgencyWithMembers`).
  - Register Prospect via portal (`createProspectFixture` with a unique
    `companyName + contactEmail`); transition to `qualified` via portal PATCH.
  - Staff-side: `createLicenseDealFixture` with `clientCompanyName === Prospect.companyName`.
  - Staff-side: GET `/api/prm/license-deal/golden-rule-candidates?clientCompanyName=...`.
    Assert exactly one default-pick candidate, matching our prospect_id.
  - Staff-side: POST `/api/prm/license-deal/{id}/attribute` with Path A:
    `{ attribution_path: 'A', prospect_id, golden_rule_default_prospect_id: prospect_id, competing_prospect_ids_to_retire: [] }`.
    Assert 202 with `sagaCorrelationKey` + `licenseDeal.attributedAgencyId === agencyId`.
  - **Saga poll (≤30s)** — `expect.poll(async () => prospect.status, { timeout: 30_000, intervals: [500, 1000, 2000] })`
    `.toBe('won')`. Use the new `getProspectViaPortalFixture` helper.
  - Portal MIN: GET `/api/prm/portal/min` as partner_admin → assert `ownCount >= 1` and the
    license identifier appears in `ownDeals`.
- 4.2 Run twice via `yarn test:integration:ephemeral --filter TC-PRM-T2-001`. Both green.
- 4.3 If saga poll times out: that's the bug the test is designed to catch. Surface in PR
  body, do NOT stub. Stop and report.

Commit: `test(prm): T2 IT-9.1 §9 — Path A attribution + saga + MIN happy path`

### Phase 5 — Validation gate + POST-MVP trim

Steps:
- 5.1 Run validation gate end-to-end (typecheck + jest + ephemeral × 2 filtered + build).
- 5.2 Trim `.ai/specs/POST-MVP-FOLLOW-UPS.md` — remove the IT-1 (T0), IT-9.1 (T1),
  IT-9.1 (T2) entries from the deferred list (they ship in this PR). Leave IT-2..IT-9.9
  entries — those are still owed.
- 5.3 Update `.ai/runs/2026-05-06-prm-url-fix-and-smoke-tests.md` Phase 3/4/5 to mark
  the dropped steps as picked up by this run plan (one-line cross-reference, no churn).

Commit: `docs: trim POST-MVP follow-ups now covered by smoke suite + cross-reference dropped phases`

## Risks

- **`OM_PRM_TEST_FIXTURES_ENABLED` env hygiene.** Setting in `.env` is local-only
  (gitignored). For a future CI run we'd need `.github/workflows/*` env wiring; not
  blocking this PR since `yarn test:integration:ephemeral` runs locally.
- **Saga timing.** The attribute route runs `runInlineSaga` synchronously, so the
  immediate response should already reflect `won`. The 30s `expect.poll` is a defensive
  net for workers-not-running regressions. If it ever takes >2-3s in healthy CI, that's
  a real bug.
- **Re-invite cooldown leakage across test reruns.** The cooldown is keyed
  `(agency_id, lower(email))` — using a unique-per-run suffix on Agency name AND email
  avoids cross-run collisions. The ephemeral DB resets between runs so this is moot, but
  on a non-ephemeral run-twice it would matter.
- **No raw UI page interactions.** The brief asks for HTTP-contract proof; this matches
  the T5-002/T5-003 demo specs. UI render is not part of §9 IT-1/IT-9.1 wording. T0-002
  (already shipped) covers the create-flow UI.

## Out of scope (explicit)

- IT-2 through IT-9.9 — POST-MVP tracker entries; not blocking the tag.
- Setting `OM_PRM_TEST_FIXTURES_ENABLED=1` in any production / CI workflow file —
  separate hygiene PR.
- Eliminating the test-only `agency-member-link` seam — that's the entire point of
  the helper.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Bootstrap (env + fixtures)

- [x] 1.1 Set OM_PRM_TEST_FIXTURES_ENABLED in worktree .env (local; .env is gitignored). .env.example already documents the var. — env-only, no commit
- [x] 1.2 Extend src/modules/prm/testing/integration/fixtures.ts with transition / attribute / get fixtures — dfc0072
- [x] 1.3 Add unit test for the new fixture wrappers (8 cases) — dfc0072
- [x] 1.4 typecheck + jest src/modules/prm green (43 suites, 407 tests) — dfc0072

### Phase 2: T0 smoke (Agency happy path)

- [ ] 2.1 Create TC-PRM-T0-001-agency-happy-path.spec.ts (create + invite + accept seam + profile)
- [ ] 2.2 Run twice — green both times
- [ ] 2.3 Surface any real bug; do NOT stub

### Phase 3: T1 smoke (Prospect happy path)

- [ ] 3.1 Create TC-PRM-T1-001-prospect-happy-path.spec.ts (register + transitions + dashboard)
- [ ] 3.2 Run twice — green both times
- [ ] 3.3 Surface any real bug; do NOT stub

### Phase 4: T2 smoke (Attribution Path A + saga + MIN)

- [ ] 4.1 Create TC-PRM-T2-001-attribution-happy-path.spec.ts (attribute Path A + saga poll + MIN)
- [ ] 4.2 Run twice — green both times
- [ ] 4.3 If saga poll >30s — surface as a real bug, stop

### Phase 5: Validation gate + POST-MVP trim

- [ ] 5.1 Full gate: typecheck + jest src/modules/prm + test:integration:ephemeral filtered ×2 + build
- [ ] 5.2 Trim POST-MVP-FOLLOW-UPS.md IT-1/IT-9.1(T1)/IT-9.1(T2) entries
- [ ] 5.3 Cross-reference dropped Phases 3/4/5 of 2026-05-06 run plan
