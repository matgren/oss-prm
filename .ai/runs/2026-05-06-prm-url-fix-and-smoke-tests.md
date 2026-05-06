---
title: PRM URL restructure + Playwright smoke tests
slug: prm-url-fix-and-smoke-tests
date: 2026-05-06
branch: fix/prm-url-fix-and-smoke-tests
author: matgren
input_plan: .ai/plans/2026-05-06-prm-url-fix-and-smoke-tests.md
status: closed
closed_date: 2026-05-06
closed_by: PR #1 (merged 77e5178)
---

# Run plan — PRM URL restructure + Playwright smoke tests

## Closed — 2026-05-06

This run is closed. PR #1 (merge commit `77e5178`) shipped Phases 1, 2, 6, 7. Phases 3/4/5 were explicitly descoped at PR time and have been superseded:

- **Phase 3 (T0 happy path)** — replaced by `TC-PRM-T0-002-create-flow-ui` shipped in `6407e4c` + `8aa3914`. Original `TC-PRM-T0-001-agency-happy-path` filename was abandoned; the equivalent backend create-flow coverage now lives at `.ai/qa/tests/integration/TC-PRM-T0-002-create-flow-ui.spec.ts`.
- **Phase 4 (T1 prospect smoke)** — still owed; blocked on a customer-portal auth helper that is not yet shipped in `@open-mercato/core/testing/integration`. Tracked in `.ai/specs/POST-MVP-FOLLOW-UPS.md` (IT-9.1 wip-scoreboard entry).
- **Phase 5 (T2 attribution smoke)** — still owed; same portal-auth blocker. Tracked in `POST-MVP-FOLLOW-UPS.md` (IT-9.1 attribution-loop entry).
- **Phase 6 mandate (CRITICAL rule #6)** — relaxed in `36d0606` from MUST-ship to recommended after the rule proved heavy-handed for non-API/UI phases. The `.ai/skills/integration-tests` skill remains the source of truth for HOW; the WHEN is now driven by spec §9 + phase scope.

The `mvp-beta-t2` tag is owed once T1+T2 smokes land; not gated on this run anymore.

Do not re-open this file. Open a new dated run for the remaining T1/T2 smoke work when the portal-auth helper ships.

## Goal

Fix the `/backend/prm/*` 404 (Phase 1, folder restructure to match OM's auto-discovery convention), bootstrap PRM smoke tests on top of the existing Playwright harness (Phase 2), add one happy-path smoke per shipped spec — T0/T1/T2 (Phases 3/4/5), close the process gap that allowed §9 IT scenarios to ship deferred (Phase 6), and prep a `mvp-beta-t2` tag (Phase 7 — agent stops before tag, user approves).

## Source documents

- **Input plan (canonical):** `.ai/plans/2026-05-06-prm-url-fix-and-smoke-tests.md`
- **Session handoff:** `.ai/HANDOFF-2026-05-06.md`
- **Project rules:** `AGENTS.md` (root), `.ai/skills/implement-spec/SKILL.md` (Phase 6 target)
- **Spec sources for smoke tests:**
  - `.ai/specs/SPEC-2026-04-23-agency-foundation.md` §9 IT-1 (T0)
  - `.ai/specs/SPEC-2026-04-23-wip-scoreboard.md` §9 IT-9.1 (T1)
  - `.ai/specs/SPEC-2026-04-23-attribution-loop.md` §9 IT-9.1 (T2)

## External References

None — no `--skill-url` arguments passed.

## Adaptations from input plan (decided during triage)

The input plan was written before checking the actual repo state. Two material deviations adopted with user approval:

1. **Reuse existing Playwright harness at `.ai/qa/tests/`** (NOT scaffold a new one at `tests/e2e/`). The repo already has:
   - `.ai/qa/tests/playwright.config.ts` (uses `@open-mercato/cli/lib/testing/integration-discovery`)
   - `package.json` script `test:integration` → `npx playwright test --config .ai/qa/tests/playwright.config.ts`
   - Existing specs follow `TC-<SCOPE>-<ID>-<desc>.spec.ts` naming.
   - PRM smoke specs go to `.ai/qa/tests/integration/TC-PRM-T{0,1,2}-*-happy-path.spec.ts`. Helpers live at `.ai/qa/tests/integration/helpers/{auth,db}.ts`.

2. **Phase 1 also removes empty `src/modules/prm/backend/agencies/`** — leftover dead code from an aborted prior restructure attempt (empty `[id]/` and `new/` subdirs). The plan's URL target is `/backend/prm/<sub>` (per the existing `<Link href="/backend/prm/new">` at `backend/page.tsx:126`), so the dangling `agencies/` namespace must go.

The plan's intent is unchanged. Only file paths and commands shift to match repo conventions.

## Hard constraints

1. **Phase 7: STOP before `git tag`.** PR description must say "READY FOR mvp-beta-t2 TAG — awaiting user approval". User applies the tag manually post-merge.
2. **Phase 1 manual click-through deferred to Phase 3.** Phase 3's Playwright smoke is the canonical proof Phase 1 worked. Do NOT start `yarn dev` and click manually.
3. **Surface bugs found in Phases 3/4/5 — do NOT paper over.** Document inline as `// TODO bug: <description>`, surface in PR body, do NOT mark phase done if bug unresolved.
4. **Migration discipline (only if Phase 1 unexpectedly triggers one):** PRM-scoped only. After `yarn db:generate`, verify with `wc -l` and `grep -ohE 'table "[a-z_]+"'`. Do NOT auto-apply.
5. **Quality gate per phase commit (where applicable):** `yarn typecheck` (exit 0), `yarn jest src/modules/prm` (must remain 133/133 across 17 suites), `yarn generate` (clean), `yarn build` (exit 0).
6. **PR target: `develop`.**

## Implementation Plan

### Phase 1 — Restructure PRM backend folders

Move all PRM backend page folders under a `prm/` namespace segment. After this, OM's route generator maps:
- `src/modules/prm/backend/page.tsx` → `/backend/prm` (special index handling, untouched)
- `src/modules/prm/backend/prm/<sub>/page.tsx` → `/backend/prm/<sub>` (correct shape, matching `<Link href>` references already in code)

Steps:
1.1 `git mv` five top-level folders under `backend/prm/`:
- `backend/new/` → `backend/prm/new/`
- `backend/[id]/` → `backend/prm/[id]/`
- `backend/prospects/` → `backend/prm/prospects/`
- `backend/license-deals/` → `backend/prm/license-deals/`
- `backend/agency-members/` → `backend/prm/agency-members/`

1.2 Remove empty `backend/agencies/` directory (dead code from aborted prior restructure).

1.3 Run `yarn generate` and inspect the regenerated routes — verify all 10 expected `/backend/prm/...` URLs are present, no orphaned routes remain.

1.4 Grep for any hardcoded `/backend/<segment>` paths in PRM source that referenced the OLD layout. Fix any stragglers (paths in code already use `/backend/prm/...`, so this is mostly a sanity check).

1.5 `yarn typecheck` clean; `yarn jest src/modules/prm` green (133/133).

Commit: `T0-fix: restructure PRM backend pages under /backend/prm/* URL namespace`

### Phase 2 — Add PRM Playwright helpers (auth + DB-reset)

Reuse existing `.ai/qa/tests/playwright.config.ts`. Add helpers under `.ai/qa/tests/integration/helpers/` so PRM smoke tests can authenticate and reset state.

Steps:
2.1 Create `.ai/qa/tests/integration/helpers/auth.ts`:
- `loginAsAdmin(page)` — navigates to `/backend/login`, fills `admin@acme.com` + admin password (env `OM_INIT_ADMIN_PASSWORD` or fallback `secret`), waits for dashboard.
- `loginAsPartnerAdmin(page, agencySlug)` — placeholder for Phase 4 (portal flow).

2.2 Create `.ai/qa/tests/integration/helpers/db.ts`:
- `resetPRMState()` — TRUNCATEs `prm_agencies`, `prm_agency_members`, `prm_prospects`, `prm_prospect_candidate_index`, `prm_license_deals` (CASCADE). Direct `pg` client using `DATABASE_URL` from env. Does NOT touch core tables.
- `seedAgencyForTesting()` — placeholder for Phase 4 (inserts minimal Agency + PartnerAdmin user).

2.3 Verify `pg` is already a dep (likely via `@open-mercato/core`); if not, install as dev dep.

2.4 Add a trivial smoke spec at `.ai/qa/tests/integration/TC-PRM-SMOKE-001-helpers.spec.ts` that just calls `loginAsAdmin` and asserts the dashboard is visible. Run with `yarn test:integration`. Confirms helpers wire up before Phase 3 builds on them.

Commit: `chore: add PRM Playwright helpers (auth + DB-reset) to .ai/qa/tests/integration/`

### Phase 3 — T0 smoke (IT-1: Agency happy path)

Source: SPEC-2026-04-23-agency-foundation.md §9 IT-1.

Steps:
3.1 Create `.ai/qa/tests/integration/TC-PRM-T0-001-agency-happy-path.spec.ts`:
- `beforeEach`: `resetPRMState()`, `loginAsAdmin(page)`.
- Test: "OMPartnerOps creates Agency, sets tier, sees it in list":
  - Navigate to `/backend/prm`.
  - Click "+ New Agency" → assert URL = `/backend/prm/new`.
  - Fill required fields (name, slug, tier=`active`, GH profile, anything else mandatory per validators).
  - Submit → assert redirect to `/backend/prm/[id]` and detail page renders.
  - Navigate back to `/backend/prm` → assert new agency in list.

3.2 Run via `yarn test:integration` (filter to the new spec). Run twice in a row to verify `resetPRMState` actually resets.

3.3 If test fails: that's a real Phase 1 bug (URL structure). Fix it (or document as `// TODO bug:` if too involved), recommit Phase 1, rerun Phase 3.

Commit: `test: add T0 IT-1 Agency happy-path Playwright smoke`

### Phase 4 — T1 smoke (IT-9.1: Prospect register → transition → widget)

Source: SPEC-2026-04-23-wip-scoreboard.md §9 IT-9.1.

Steps:
4.1 Extend `.ai/qa/tests/integration/helpers/db.ts`: implement `seedAgencyForTesting()`. Insert an Agency row + a PartnerAdmin user with `partner_admin` role, return the agency slug.

4.2 Extend `.ai/qa/tests/integration/helpers/auth.ts`: implement `loginAsPartnerAdmin(page, agencySlug)`. Navigates to `/{orgSlug}/portal`, logs in.

4.3 Create `.ai/qa/tests/integration/TC-PRM-T1-001-prospect-happy-path.spec.ts`:
- `beforeEach`: reset, seed Agency, login as partner-admin.
- Test: "Partner registers Prospect, transitions to qualified → contacted, sees widget update":
  - Navigate to portal P5 (Prospects list).
  - Click "+ Register Prospect", fill form, submit.
  - Open prospect detail.
  - Click "Qualify" → assert state badge = `qualified`.
  - Click "Mark contacted" → assert state badge = `contacted`.
  - Navigate to P2 dashboard.
  - Assert WIP widget shows count = 1.

4.4 Run twice. Surface any bugs same way as Phase 3.

Commit: `test: add T1 IT-9.1 Prospect happy-path Playwright smoke`

### Phase 5 — T2 smoke (IT-9.1: Path A attribution + MIN update)

Source: SPEC-2026-04-23-attribution-loop.md §9 IT-9.1.

Steps:
5.1 Create `.ai/qa/tests/integration/TC-PRM-T2-001-attribution-happy-path.spec.ts`:
- `beforeEach`: reset, seed Agency + PartnerAdmin + a Prospect in `qualified` state.
- Test: "OMPartnerOps creates LicenseDeal, attributes via Path A, sees MIN reflect":
  - Login as admin, navigate to `/backend/prm/license-deals`.
  - Create LicenseDeal (link to existing Prospect's company).
  - Trigger attribution → Golden Rule auto-picks Prospect.
  - Poll prospect status until `won` (max 30s timeout — explicit `await expect(...).toBe('won')` with retries).
  - Assert LicenseDeal status = `attributed`.
  - Logout, login as partner-admin, navigate to portal dashboard.
  - Assert MIN widget shows the deal value.

5.2 Saga is async — if 30s wait times out, that's a bug to surface (workers not running in dev, or saga broken). Do NOT stub the saga.

Commit: `test: add T2 IT-9.1 attribution Path A Playwright smoke`

### Phase 6 — Update om-implement-spec gate

Goal: future specs cannot be marked done without smoke proof for §9 happy path.

Steps:
6.1 Read `.ai/skills/implement-spec/SKILL.md`. Add a step to its checklist: **"Before marking spec done: run `yarn test:integration` filtered to the spec's smoke test and confirm green. If no smoke test exists for the spec's §9 happy-path scenario, write one as part of the implementation — do NOT defer."**

6.2 Replace any "deferred to QA team" language in the skill with explicit "if no smoke test exists, write one as part of implementation".

6.3 Add a corresponding line to `AGENTS.md` under the Quality & Process section: **"Every spec ships with at least one Playwright smoke test for its §9 happy-path scenario, located at `.ai/qa/tests/integration/TC-PRM-<spec>-<id>-<desc>.spec.ts`. Listing scenarios in §9 without writing them is not acceptable."**

6.4 Verify no remaining "deferred to QA team" loophole language in any spec changelog template or other skill file (grep across `.ai/`).

Commit: `docs: require Playwright smoke per spec; remove deferred-to-QA loophole from om-implement-spec`

### Phase 7 — Prep tag (NO `git tag` — agent stops here)

Steps:
7.1 Run full validation gate: `yarn typecheck`, `yarn jest`, `yarn test:integration` (Phases 3+4+5 specs), `yarn build`. All must be green.

7.2 Update `.ai/specs/POST-MVP-FOLLOW-UPS.md`: remove the IT-1 (T0), IT-9.1 (T1), IT-9.1 (T2) entries from the deferred list (they ship in this PR). Leave IT-2 through IT-9.9 entries — those are still owed.

7.3 Commit the POST-MVP-FOLLOW-UPS update.

7.4 **STOP. Do NOT run `git tag`.** PR description must include "READY FOR mvp-beta-t2 TAG — awaiting user approval". The user (or a follow-up session post-merge) applies `git tag -a mvp-beta-t2 -m "..."` manually.

Commit: `docs: trim POST-MVP follow-ups now covered by smoke suite`

## Risks

- **Phase 3/4/5 may surface real bugs.** Likely. Plan handles via `// TODO bug:` + surface to user. User decides fix-now vs fix-later per bug.
- **Saga workers not running in dev.** If Phase 5 polls hit 30s timeout, that's a separate bug (worker bootstrap). Surface; do not stub.
- **Portal auth flow (Phase 4) may need a different invitation/acceptance path** than production. If `loginAsPartnerAdmin` fails, escalate to user — may need test-only seed shortcut.
- **Spec discovery in `.ai/qa/tests/playwright.config.ts`** uses `@open-mercato/cli/lib/testing/integration-discovery`. Verify new specs are picked up; if not, may need to nudge discovery glob.
- **Backwards compatibility:** Phase 1 folder moves change the on-disk layout but the URL surface is what code already expects. No public API contract changes. Phase 6 changes a skill file and `AGENTS.md` rule — additive, no removal of guidance.

## Out of scope (explicit)

- IT-2 through IT-9.9 (other §9 scenarios) — POST-MVP, not blocking.
- Non-URL bugs found during smoke runs — fix-commit per bug ONLY if user approves; otherwise document and defer.
- L1 (`window.prompt` in B5), cache subscribers, optimistic concurrency — already in `POST-MVP-FOLLOW-UPS.md`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Restructure PRM backend folders

- [x] 1.1 git mv five top-level folders under backend/prm/ — 87d5c12
- [x] 1.2 Remove empty backend/agencies/ directory — 87d5c12
- [x] 1.3 yarn generate + verify all 9 /backend/prm/... URLs (no /prospects/[id] backend route — portal-only) — 87d5c12
- [x] 1.4 Grep for stale /backend/<segment> path references — 87d5c12 (zero stale refs)
- [x] 1.5 yarn typecheck + yarn jest src/modules/prm green (133/133, 17 suites) — 87d5c12

### Phase 2: PRM Playwright fixtures

> ⏳ **Reset 2026-05-06** — original Phase 2 used local `helpers/auth.ts`-style
> helpers and a raw-SQL `resetPRMState`. Per user feedback, replaced with the
> shipped OM fixture pattern at `@open-mercato/core/testing/integration`
> (`getAuthToken`, `apiRequest`, `deleteEntityByPathIfExists`, etc.). PRM
> module now ships its own fixtures at `src/modules/prm/testing/integration/`
> (mirroring `crmFixtures.ts` shape). All seeding goes through `apiRequest`,
> no raw SQL. Pre-existing `playwright.config.ts` ESM fix from 3d126f2 is
> still in effect — only the helpers/spec layer was redone.

- [x] 2.1 Read OM core testing/integration fixtures (api, auth, authFixtures, crmFixtures, generalFixtures) — pattern adopted
- [x] 2.2 Create `src/modules/prm/testing/integration/{index,fixtures}.ts` — exports `createAgencyFixture`, `createLicenseDealFixture`, `createProspectFixture` (stub — needs portal token), `delete*IfExists` wrappers
- [x] 2.3 No new local helpers — fixtures use core `apiRequest` + `getAuthToken` + `deleteEntityByPathIfExists` — 628938c
- [x] 2.4 TC-PRM-SMOKE-001-fixtures.spec.ts SHIPPED but `test.describe.fixme()` — see "Surfaced bug" below — 628938c
- [x] 2.5 Pre-existing fix: replace `__dirname` with ESM shim in playwright.config.ts (config never worked under "type": "module") — 3d126f2
- [x] 2.6 Add ephemeral runner state files to .gitignore — 3d126f2
- [x] 2.7 Resume 2026-05-06: diagnose surfaced bug — widened POST catch to surface stderr; smoke run #1 against ephemeral Postgres surfaced two distinct root causes (see below)
- [x] 2.8 Resume 2026-05-06: fix root cause #1 — chain `.proxy()` on PRM scoped DI registrations so destructured factory params receive `em` under `InjectionMode.CLASSIC` — d0141c2
- [x] 2.9 Resume 2026-05-06: fix root cause #2 — pre-generate Organization UUID in `agencyService` so `Agency.organizationId` is set before flush (Organization PK uses `defaultRaw: 'gen_random_uuid()'`, deferred to DB) — c488dbb
- [x] 2.10 Resume 2026-05-06: remove `test.describe.fixme()` from TC-PRM-SMOKE-001-fixtures.spec.ts — 2be2900
- [x] 2.11 Resume 2026-05-06: confirm smoke green twice in a row via `yarn test:integration:ephemeral --filter TC-PRM-SMOKE-001-fixtures` — runs #4 (2 passed, 0 failed) and #5 (2 passed, 0 failed) — 2be2900

**Surfaced bug (Phase 2.4) — RESOLVED 2026-05-06.** Both `POST /api/prm/agency` and `POST /api/prm/license-deal` returned HTTP 500 with empty body in the ephemeral integration environment. Two distinct root causes, masked behind one symptom:

1. **DI:** PRM `di.ts` registered services via `asFunction(({ em }) => new Service(em)).scoped()` without `.proxy()`. The shared request container uses `InjectionMode.CLASSIC` (per `node_modules/@open-mercato/shared/src/lib/di/container.ts`), under which destructured factory params do not receive named dependencies — `em` arrived undefined and the first `findOneWithDecryption` call threw `TypeError: Cannot read properties of undefined (reading 'findOne')`. Canonical fix is `.proxy()` per the data_sync module pattern.
2. **Persistence ordering:** `agencyService.createAgencyWithOrganization` read `(organization as any).id` before `em.flush()`. Organization PK uses `defaultRaw: 'gen_random_uuid()'` (DB-side default), so the value was undefined at create-time — MikroORM rejected the Agency insert with `ValidationError: Value for Agency.organizationId is required, 'undefined' found`. Fix is to call `randomUUID()` inside the service and reuse the value for both the Organization create and the Agency `organizationId` FK.

Both fixes are server-side; the HTTP contract for `POST /api/prm/agency` is unchanged.

**Phases 3/4/5 still dropped from this PR.** Phase 3 (T0 happy-path UI Playwright spec) is a separate piece of work — the fixture-level smoke (TC-PRM-SMOKE-001-fixtures, now green) covers the API surface and is what gates this resume. Phase 4/5 still need the customer-portal auth helper that doesn't ship in `@open-mercato/core/testing/integration`. Tracked as POST-MVP follow-ups.

### Phase 3: T0 smoke (Agency happy path) — SUPERSEDED

> Superseded post-merge by `TC-PRM-T0-002-create-flow-ui` (commits `6407e4c` + `8aa3914`).
> The original `TC-PRM-T0-001-agency-happy-path` filename was abandoned in favour of the
> backend create-flow UI smoke that better matched the user-reported "loading hang" symptom.

- [x] 3.1 Create TC-PRM-T0-001-agency-happy-path.spec.ts — SUPERSEDED by TC-PRM-T0-002-create-flow-ui (6407e4c)
- [x] 3.2 Run twice — green both times — SUPERSEDED (T0-002 verified 2× green in 8aa3914 verification gate)
- [x] 3.3 Address any surfaced bug or document as TODO bug — DONE (BUG-PRM-UI-001 + BUG-PRM-UI-002 documented in 6407e4c, fixed in 211eef2)

### Phase 4: T1 smoke (Prospect happy path) — DESCOPED

> Descoped: blocked on a customer-portal auth helper that is not shipped in
> `@open-mercato/core/testing/integration`. Owed work tracked in
> `.ai/specs/POST-MVP-FOLLOW-UPS.md` (IT-9.1 wip-scoreboard entry).

- [x] 4.1 Implement seedAgencyForTesting() — DESCOPED (tracked in POST-MVP-FOLLOW-UPS.md)
- [x] 4.2 Implement loginAsPartnerAdmin() — DESCOPED (no shipped customer-portal auth helper)
- [x] 4.3 Create TC-PRM-T1-001-prospect-happy-path.spec.ts — DESCOPED
- [x] 4.4 Run twice — green both times — DESCOPED

### Phase 5: T2 smoke (Attribution Path A + MIN) — DESCOPED

> Descoped: same portal-auth blocker as Phase 4. Owed work tracked in
> `.ai/specs/POST-MVP-FOLLOW-UPS.md` (IT-9.1 attribution-loop entry).

- [x] 5.1 Create TC-PRM-T2-001-attribution-happy-path.spec.ts — DESCOPED (tracked in POST-MVP-FOLLOW-UPS.md)
- [x] 5.2 Saga completes within 30s — DESCOPED

### Phase 6: Update om-implement-spec gate

- [x] 6.1 Update .ai/skills/implement-spec/SKILL.md Step 4 + Rules — aabe358
- [x] 6.2 No exact "deferred to QA team" loophole language existed in the skill itself; the historical phrase appears only in T0/T1/T2 §11 frozen changelogs (left alone — describes what shipped at tag) and in this PR's own plan files (intentional)
- [x] 6.3 Add CRITICAL rule #6 to AGENTS.md mandating §9 happy-path smoke per spec — aabe358
- [x] 6.4 Grep verification done — only frozen historical changelog references remain — aabe358

### Phase 7: Prep tag (agent STOPS before tag)

- [x] 7.1 Full validation gate green (typecheck, jest, build) — see PR comment
- [x] 7.2 POST-MVP-FOLLOW-UPS.md NOT trimmed — the IT-1, IT-9.1 entries remain owed since the corresponding smoke tests are not green this PR (Phase 2 surfaced bug; Phases 3/4/5 dropped). The entries continue to track the work owed.
- [x] 7.3 No POST-MVP commit needed (no trimming).
- [x] 7.4 PR body notes "TAG PENDING USER APPROVAL — agent does NOT run git tag". Tag is owed once Phase 2.4 bug is fixed and at least the T0 smoke is green.
