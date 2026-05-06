# Session handoff — PR #1 in flight (2026-05-06, second session of the day)

Read this first if you're a new Claude session picking up after the PRM URL-fix + smoke-tests dispatch. The earlier handoff at `.ai/HANDOFF-2026-05-06.md` covers the broader PRM pipeline state (T0/T1/T2 freeze contracts, T3–T6 pending, the original "Failed to load license deals" diagnostic). **Read that first if you don't already have its context — this file only captures what changed in this session.**

## TL;DR

- **GitHub repo wired up:** `oss-prm` on the user's `matgren` account is now the canonical remote. `main` and `develop` both at `184dfb2`. Tag `mvp-2026-05-05` pushed.
- **PR #1 open against `develop`:** https://github.com/matgren/oss-prm/pull/1 — `fix(prm): restructure backend URLs + bootstrap Playwright smoke infra`. Status: **in-progress**.
- **The original `/backend/prm/* 404` bug is FIXED** in PR #1 Phase 1 — verified by `yarn typecheck` + `yarn jest src/modules/prm` (133/133, 17 suites) + generated-route inspection.
- **A NEW server-side bug surfaced** during Phase 2: `POST /api/prm/agency` and `POST /api/prm/license-deal` both return HTTP 500 with empty body in the ephemeral integration env. This blocks the T0/T1/T2 happy-path smokes (Phases 3/4/5 of the plan) and is the primary follow-up.
- **A process gate was added:** `AGENTS.md` CRITICAL rule #6 + `om-implement-spec` Step 4 now mandate §9 happy-path Playwright smoke per spec — no more "deferred to QA team".
- **No tag was applied.** `mvp-beta-t2` is intentionally pending until the 500 is fixed and at least the T0 smoke runs green.

## Repo state (as of HEAD on `main`)

```
git log --oneline | head -3
1725436 docs: session handoff snapshot 2026-05-06          (prior handoff; covers MVP state)
e62e860 fix(prm): mirror prospect_id as id column ...
80b1909 docs: track ProspectCandidateIndex reindex PK bug ...
```

**Plus one commit not yet pushed to local `main` from PR #1:**
- `184dfb2 docs: add PRM URL fix + smoke-test plan (2026-05-06)` — committed both to local `main` AND to `origin/main` AND to `origin/develop` early in the session. This is the file `.ai/plans/2026-05-06-prm-url-fix-and-smoke-tests.md` (the input plan to the PR work).

If `git status` shows local `main` at `1725436` and not `184dfb2`, run `git pull --ff-only origin main`.

**Branches:**
- `origin/main` → `184dfb2` (the plan commit on top of MVP)
- `origin/develop` → `184dfb2` (mirror of main; PR #1 targets here)
- `origin/fix/prm-url-fix-and-smoke-tests` → `797c481` (PR #1 head)

**Tag:** `mvp-2026-05-05` exists locally and on origin.

## What PR #1 contains

9 commits on `fix/prm-url-fix-and-smoke-tests`:

| # | SHA | What |
|---|---|---|
| 1 | `aa74ab1` | Run plan committed to `.ai/runs/2026-05-06-prm-url-fix-and-smoke-tests.md` |
| 2 | `87d5c12` | **Phase 1 — URL restructure.** Move 5 PRM backend page-leaf folders (`new`, `[id]`, `prospects`, `license-deals`, `agency-members`) under a `prm/` namespace segment so OM auto-discovery maps them to `/backend/prm/<sub>`. Removed dead empty `backend/agencies/` from a prior aborted restructure. |
| 3 | `1b1e6f1` | Plan progress: Phase 1 done |
| 4 | `3d126f2` | **Phase 2 (initial)** — local helpers + smoke; SUPERSEDED by `628938c` |
| 5 | `3e8729a` | Plan progress: Phase 2 done (later corrected) |
| 6 | `628938c` | **Phase 2 (redo)** — replaced local `helpers/auth` + raw-SQL `resetPRMState` with shipped OM fixture pattern. PRM module now ships its own fixtures at `src/modules/prm/testing/integration/{index,fixtures}.ts`. Pre-existing `__dirname` ESM bug fixed in `.ai/qa/tests/playwright.config.ts`. |
| 7 | `da28dcb` | Plan progress: Phase 2 redo + Phases 3/4/5 dropped |
| 8 | `aabe358` | **Phase 6 — gate update.** New `AGENTS.md` rule #6 + `om-implement-spec` Step 4 + Rules entries mandating §9 happy-path smoke per spec. |
| 9 | `797c481` | Plan progress: Phases 6+7 done |

**Validation gate at the time of opening the PR:** `yarn generate` ✓ · `yarn typecheck` ✓ · `yarn jest src/modules/prm` 133/133 ✓ · `yarn jest` (full) 133/133 ✓ · `yarn build` ✓.

## The blocker — the surfaced 500 bug

Both routes return HTTP 500 with **empty body** in the ephemeral integration env:
- `POST /api/prm/agency` (during `createAgencyFixture`)
- `POST /api/prm/license-deal` (during `createLicenseDealFixture`)

**What we know:**
- The fixture body shapes match the validators (`createAgencySchema`, `createLicenseDealSchema`).
- The staff `admin` token from `getAuthToken('admin')` correctly carries `prm.*` per `src/modules/prm/setup.ts` `defaultRoleFeatures`.
- The route handlers' `catch` block only handles `PrmDomainError` and re-throws other errors as Next.js 500s.
- The ephemeral runner pipes server stderr into a buffered `output` variable inside `runCommandWithOutputMonitoring` but never flushes it to stdout, which is why the 500 body is empty AND we never saw the actual server-side stack trace.

**To diagnose (next session, fastest path):**

1. Widen the `catch` blocks in `src/modules/prm/api/agency/route.ts` (around line 130) and `src/modules/prm/api/license-deal/route.ts` (around line 50) to JSON-encode `err.message` + `err.stack`:
   ```typescript
   } catch (err) {
     if (err instanceof PrmDomainError) {
       return NextResponse.json(toPrmErrorBody(err), { status: err.status })
     }
     // TEMPORARY DEBUG — remove before merge
     return NextResponse.json(
       { ok: false, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null },
       { status: 500 },
     )
   }
   ```
2. From a clean working tree on the PR branch, re-run:
   ```bash
   yarn test:integration:ephemeral --filter TC-PRM-SMOKE-001-fixtures --no-screenshots
   ```
   The smoke is `test.describe.fixme` so it won't run by default — temporarily swap to `test.describe` to actually exercise the path.
3. The error in the body should reveal the underlying cause. **Most likely suspects** (priority order):
   1. **Encryption helper failure**: `agencyService.createAgencyWithOrganization` uses `findWithDecryption` somewhere; the ephemeral env's tenant encryption is set up with a derived fallback key (warning visible in `yarn generate`: `🚨 Using derived tenant encryption keys (Vault unavailable / no DEK)`). It's plausible that the encryption layer fails silently when actual encryption is attempted on a fallback key.
   2. **DI container resolution**: `container.resolve('agencyService')` could throw if the AgencyService isn't registered in the ephemeral env's DI graph.
   3. **Missing organization context**: the route uses `auth.tenantId` and creates an Organization on the fly via `createAgencyWithOrganization`. If the staff admin's JWT lacks an `orgId` claim (or has one that doesn't exist in the freshly-seeded ephemeral DB), the organization-creation logic could blow up.

   The unit-test suite (jest 133/133) tests `agencyService.createAgencyWithOrganization` in isolation with mocks, so the unit pass tells us the SERVICE LOGIC is correct — the failure is at the route ↔ DI ↔ encryption boundary that only the runtime exercises.

4. Once fixed, remove the temporary debug catch and the `test.describe.fixme` markers. Re-run the smoke twice in a row (idempotency check). Then continue per the "How to continue" section below.

## What the PR does NOT include (intentionally dropped)

- **Phase 3 — T0 happy path smoke (UI flow).** Was written and ran in the session, but the click-through hit the 500 above. The spec was reverted; rewrite once the bug is fixed using the now-shipped fixtures (`createAgencyFixture` for setup-cleanup or to pre-seed list views).
- **Phase 4 — T1 prospect happy path smoke (portal flow).** Needs a customer-portal auth helper that doesn't ship in `@open-mercato/core/testing/integration`. The customer login endpoint (`POST /api/customer_accounts/login`, see `node_modules/@open-mercato/core/src/modules/customer_accounts/api/login.ts`) exists and takes `{ email, password, tenantId }` returning `customer_auth_token` + `customer_session_token` cookies, but no Playwright wrapper. Building one is its own scoped piece of work (~30–60 min depending on how thorough you want fixture seeding for the partner-admin user with a verified email).
- **Phase 5 — T2 attribution Path A smoke.** Same portal-auth dep as Phase 4, plus the saga workers need to be running in the ephemeral env (TBD whether they auto-start).
- **`mvp-beta-t2` tag.** Plan explicitly stopped before tag — agent does NOT run `git tag`. Apply manually after T0 smoke is green.

## Conventions baked into this PR (forward-looking)

These ship in `aabe358` and govern future spec implementation:

1. **`AGENTS.md` CRITICAL rule #6:** §9 happy-path Playwright smoke MUST ship in the same phase that introduces the API/UI surface. Edge cases (IT-2 onward) may defer only when explicitly tracked in `POST-MVP-FOLLOW-UPS.md` with owner + effort.
2. **Canonical smoke-test location:** `.ai/qa/tests/integration/TC-<MODULE>-<SPEC>-<ID>-<desc>.spec.ts`. Auto-discovered by `.ai/qa/tests/playwright.config.ts`. Run via `yarn test:integration:ephemeral`.
3. **Fixture pattern:** import seed/cleanup from `@open-mercato/core/testing/integration` for cross-cutting concerns (`getAuthToken`, `apiRequest`, `deleteEntityByPathIfExists`); module-owned fixtures live at `src/modules/<module>/testing/integration/{index,fixtures}.ts` mirroring `crmFixtures.ts` shape. **No raw SQL, no local `helpers/auth`/`helpers/db` files.**
4. **`om-implement-spec` Step 4** rewritten accordingly. The skill now spells out the file path, the fixture imports, the ephemeral runner command, and the idempotency requirement (run twice in a row).

PRM ships fixtures for Agency + LicenseDeal already. Prospect fixture is a stub (`throw`s) — needs portal auth.

## Pre-existing fixes that hitched a ride

- **`.ai/qa/tests/playwright.config.ts`** used `__dirname` which doesn't exist under `package.json` `"type": "module"`. Replaced with the standard ESM shim via `fileURLToPath(import.meta.url)`. This bug had blocked **every** integration spec in this repo, including the existing `TC-APP-001-metadata` and `TC-CLI-001-agentic-init` — they just hadn't been run.
- **`.gitignore`** now ignores `.ai/qa/ephemeral-build-cache.json`, `.ai/qa/ephemeral-env.json`, `.ai/qa/ephemeral-env.lock`, `.ai/qa/ephemeral-runtime.lock`, and `.ai/tmp/` (the auto-create-pr worktree parent).

## How to continue

**To diagnose & fix the 500 (recommended next step):**
```bash
gh pr checkout 1
# OR: git fetch origin fix/prm-url-fix-and-smoke-tests && git checkout fix/prm-url-fix-and-smoke-tests
yarn install
# Apply the temporary debug catch from the section above
# Run smoke
yarn test:integration:ephemeral --filter TC-PRM-SMOKE-001-fixtures --no-screenshots
```

**To resume PR #1 via auto-continue-pr (after diagnosis):**
```
/auto-continue-pr 1
```
The PR body has a `Tracking plan:` line pointing at `.ai/runs/2026-05-06-prm-url-fix-and-smoke-tests.md` so `auto-continue-pr` will pick it up. The Progress section there is current.

**Once smoke is green:**
1. Remove `test.describe.fixme` from `.ai/qa/tests/integration/TC-PRM-SMOKE-001-fixtures.spec.ts`.
2. Run `yarn test:integration:ephemeral --filter TC-PRM-SMOKE-001-fixtures` twice — must pass both times.
3. Add Phase 3 (T0 happy path smoke) — use the fixtures + the pattern in `TC-PRM-SMOKE-001-fixtures.spec.ts` as reference.
4. Trim `.ai/specs/POST-MVP-FOLLOW-UPS.md` for the now-covered IT entries.
5. After all phases complete: flip `Status: in-progress` → `Status: complete` in the PR body. The user applies `git tag -a mvp-beta-t2` post-merge.

**To handle Phase 4/5 (lower priority, scoped follow-up):**
1. Implement `loginAsPartnerAdmin` helper — POSTs to `/api/customer_accounts/login` with `{ email, password, tenantId }`, then attaches the resulting cookies to the page context. Live in `src/modules/prm/testing/integration/portalAuth.ts` (or contribute to `@open-mercato/core/testing/integration` if appropriate cross-module).
2. Implement the partner-admin user seed — likely needs to bypass invitation acceptance (which involves email verification). Cleanest: direct DB insert via `pg` in a fixture, OR call a service-auth endpoint that creates the user with a pre-verified email.
3. Then write Phase 4 (`TC-PRM-T1-001`) and Phase 5 (`TC-PRM-T2-001`) specs.

## What's NOT in scope (still owed work — see prior handoff)

These are unrelated to PR #1 but tracked from the earlier session:
- T3 (`wic-ingestion`) through T7 (`case-studies-marketing`) specs — all PENDING per the strict execution order in `.ai/specs/EXECUTION-PLAN.md`.
- T2 → T4 deferred dependency: `RfpPathBLockSubscriber` writes to `prm_rfps.is_path_b_locked` (column owned by T4).
- All other entries in `.ai/specs/POST-MVP-FOLLOW-UPS.md`.

The "Failed to load license deals" issue from the prior handoff is **resolved by Phase 1** of PR #1 — the cause was the same URL-namespace bug that affected `/backend/prm/new`. The license-deals page is at `/backend/prm/license-deals` post-restructure and resolves correctly via `yarn generate` route inspection.

## Workflow rules (still in effect)

From the prior handoff and the user's saved memory:
- Sequential subagent dispatch (no worktrees) for T# specs. Background dispatch is preferred mode.
- Per-T# commits, prefixed `T#:` for new spec work or `T#-fix:` for review-found issues, signed `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- User runs `yarn mercato db migrate` themselves between T# steps — don't auto-apply migrations.
- "Drop the easy wins" — small Low/Medium issues land before MVP tag stands; bigger items go to `POST-MVP-FOLLOW-UPS.md`.
- Code review subagent runs after each T# returns (independent verification of T0-lesson regressions).
