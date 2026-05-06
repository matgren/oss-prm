# Plan — PRM URL restructure + Playwright smoke tests

**Date:** 2026-05-06
**Goal:** unblock manual testing of T0/T1/T2 PRM module AND close the integration-test gap before T3 dispatch.
**Status:** Ready for dispatch.

---

## Why this exists

A manual click-through of the PRM module on 2026-05-06 hit a 404 on `/backend/prm/new`. Diagnosis:

1. **PRM backend pages are in the wrong folder layout.** OM's route generator maps `src/modules/prm/backend/<sub>/page.tsx` → `/backend/<sub>` (no module prefix on subroutes). PRM's pages assume `/backend/prm/<sub>` URLs (per `<Link href="/backend/prm/new">` at `src/modules/prm/backend/page.tsx:126`). Generated patterns disagree:
   - `backend/page.tsx` → `/backend/prm` ✅ (special index handling)
   - `backend/new/page.tsx` → `/backend/new` ❌ (expected `/backend/prm/new`)
   - `backend/[id]/page.tsx` → `/backend/[id]` ❌ (wildcard catching every `/backend/<segment>`)
   - `backend/prospects/page.tsx` → `/backend/prospects`
   - `backend/license-deals/page.tsx` → `/backend/license-deals`
   - `backend/agency-members/page.tsx` → `/backend/agency-members`

   Compare to working core convention (`src/modules/customers/backend/customers/companies/page.tsx` → `/backend/customers/companies`).

2. **Why this wasn't caught earlier:** §9 integration tests in T0/T1/T2 specs were marked "deferred to QA team" and never written or run. No human or agent ever clicked through the flow. Three rounds of audits checked structure, conventions, spec compliance, and DS — none asked "does the app actually run?"

This plan fixes both: the immediate bug AND the structural gap that allowed it.

---

## Phases

Each phase has acceptance criteria. **Do not advance to the next phase until the current phase's criteria are green.** Commit at the end of each phase.

### Phase 1 — Restructure PRM backend folders

**Goal:** all PRM backend pages live under `/backend/prm/...` URLs, matching the hrefs already in code.

**Steps:**

1. Move folders. Use `git mv` so history is preserved:
   ```
   src/modules/prm/backend/new/             → src/modules/prm/backend/prm/new/
   src/modules/prm/backend/[id]/            → src/modules/prm/backend/prm/[id]/
   src/modules/prm/backend/prospects/       → src/modules/prm/backend/prm/prospects/
   src/modules/prm/backend/license-deals/   → src/modules/prm/backend/prm/license-deals/
   src/modules/prm/backend/agency-members/  → src/modules/prm/backend/prm/agency-members/
   ```
   Leave `src/modules/prm/backend/page.tsx` and `page.meta.ts` in place — those are the `/backend/prm` index, special-cased by the router.

2. Run `yarn generate`. Verify generated routes now show:
   - `/backend/prm` (index)
   - `/backend/prm/new`
   - `/backend/prm/[id]`
   - `/backend/prm/prospects`
   - `/backend/prm/prospects/[id]` (if exists)
   - `/backend/prm/license-deals`
   - `/backend/prm/license-deals/new`
   - `/backend/prm/license-deals/[id]`
   - `/backend/prm/agency-members`
   - `/backend/prm/agency-members/[id]`

3. Grep PRM source tree for any `Link` or `router.push` references that still hardcode the broken pre-restructure paths. Should be zero — paths in code already use `/backend/prm/...` form. If any need updating, do so.

4. Verify breadcrumbs in `page.meta.ts` files don't reference stale paths.

5. `yarn typecheck` and `yarn jest src/modules/prm` — both must pass.

6. Browser click-through is **deferred to Phase 3** — the T0 happy-path Playwright smoke is the canonical proof that Phase 1 worked. The auto-PR agent does not need to start `yarn dev` and click around manually.

**Acceptance:**
- [ ] Generated route output (from `yarn generate`) shows all 10 expected `/backend/prm/...` URLs
- [ ] `yarn typecheck` clean
- [ ] `yarn jest src/modules/prm` green (no test broke from path change)
- [ ] Phase 3's Playwright smoke (run later) is the live-app verification — DO NOT mark Phase 1 fully done until Phase 3 is also green

**Commit:** `T0-fix: restructure PRM backend pages under /backend/prm/* URL namespace`

**Note for the agent:** if any test imports a moved page by relative path, fix the import. Otherwise the move is transparent — Next.js discovery is path-based, not import-graph-based.

---

### Phase 2 — Bootstrap Playwright

**Goal:** a runnable Playwright harness pointed at local dev, with login + DB-seed helpers.

**Steps:**

1. Install: `yarn add -D @playwright/test` and run `npx playwright install chromium`.

2. Create `playwright.config.ts` at repo root:
   - baseURL: `http://localhost:3000`
   - testDir: `tests/e2e`
   - webServer: spawn `yarn dev` if not already running (use `reuseExistingServer: true` for dev iteration)
   - workers: 1 (these are stateful E2E tests, not parallel-safe)
   - timeout: 60s per test (saga steps can be slow)

3. Create `tests/e2e/helpers/auth.ts`:
   - `loginAsAdmin(page)` — navigates to `/backend/login`, fills `admin@acme.com` / `secret` from env (fallback to `secret`), waits for dashboard
   - Reads `OM_INIT_ADMIN_PASSWORD` from `.env` if set; otherwise defaults to `secret`

4. Create `tests/e2e/helpers/db.ts`:
   - `resetPRMState()` — TRUNCATEs `prm_agencies`, `prm_agency_members`, `prm_prospects`, `prm_prospect_candidate_index`, `prm_license_deals` (CASCADE). Use a direct `pg` client with credentials from `.env`'s `DATABASE_URL`. Do NOT touch core tables.
   - Called in `test.beforeEach` so each test starts clean.

5. Add to `package.json` scripts:
   - `"test:e2e": "playwright test"`
   - `"test:e2e:headed": "playwright test --headed"`
   - `"test:e2e:debug": "playwright test --debug"`

6. Add `tests/e2e/` and `playwright-report/` to `.gitignore` if not already excluded for outputs.

**Acceptance:**
- [ ] `yarn test:e2e --list` returns at least the harness scaffold
- [ ] A trivial smoke test (`tests/e2e/smoke.spec.ts`) that just calls `loginAsAdmin` and asserts `Dashboard` is visible runs green against `yarn dev`
- [ ] `resetPRMState()` runs cleanly against the local DB without dropping core data

**Commit:** `chore: bootstrap Playwright harness with auth + DB-reset helpers`

---

### Phase 3 — T0 smoke test (IT-1: Agency happy path)

**Goal:** a single Playwright test that exercises the T0 happy path end-to-end.

**Source:** SPEC-2026-04-23-agency-foundation.md §9, IT-1.

**Steps:**

1. Create `tests/e2e/prm/t0-agency-happy-path.spec.ts`:
   - `beforeEach`: `resetPRMState()`, `loginAsAdmin(page)`
   - Test: "OMPartnerOps creates Agency, sets tier, sees it in list"
     - Navigate to `/backend/prm`
     - Click "+ New Agency" — assert URL changes to `/backend/prm/new`
     - Fill form (name, slug, tier=`active`, GH profile, anything else mandatory per validators)
     - Submit — assert redirect to `/backend/prm/[id]` and detail page renders
     - Navigate back to `/backend/prm` — assert the new agency appears in the list

2. Run it: `yarn test:e2e tests/e2e/prm/t0-agency-happy-path.spec.ts`

3. **If it fails** — that's a real bug. Document it in the test as `// TODO bug: <description>` and DO NOT mark Phase 3 done. Surface to the user.

**Acceptance:**
- [ ] Test runs green against `yarn dev`
- [ ] Test runs green twice in a row (idempotency check — `resetPRMState` actually resets)
- [ ] No bugs surface (or if they do, they're documented and surfaced — Phase 3 is NOT green until bugs are addressed)

**Commit:** `test: add T0 IT-1 Agency happy-path Playwright smoke`

---

### Phase 4 — T1 smoke test (IT-9.1: Prospect register → transition → widget)

**Goal:** Playwright covering the T1 portal flow end-to-end.

**Source:** SPEC-2026-04-23-wip-scoreboard.md §9, IT-9.1.

**Steps:**

1. Add to `helpers/db.ts`: `seedAgencyForTesting()` — inserts a minimal Agency + PartnerAdmin user (`partner_admin` role) so portal tests can authenticate.

2. Add `helpers/auth.ts`: `loginAsPartnerAdmin(page, agencySlug)` — logs into the `/[orgSlug]/portal` route as the seeded partner-admin.

3. Create `tests/e2e/prm/t1-prospect-happy-path.spec.ts`:
   - `beforeEach`: reset, seed Agency, login as partner-admin
   - Test: "Partner registers a Prospect, transitions to qualified → contacted, sees widget update"
     - Navigate to portal P5 (Prospects list)
     - Click "+ Register Prospect", fill form, submit
     - Open the prospect detail
     - Click "Qualify" — assert state badge changes
     - Click "Mark contacted" — assert state badge changes
     - Navigate to P2 dashboard
     - Assert WIP widget shows count = 1 (or whatever the matching scope predicts)

4. Run it. Surface any bugs same way as Phase 3.

**Acceptance:**
- [ ] Test runs green twice in a row
- [ ] Surfaces any T1 bugs

**Commit:** `test: add T1 IT-9.1 Prospect happy-path Playwright smoke`

---

### Phase 5 — T2 smoke test (IT-9.1: Path A attribution + MIN update)

**Goal:** Playwright covering the T2 attribution loop end-to-end.

**Source:** SPEC-2026-04-23-attribution-loop.md §9, IT-9.1.

**Steps:**

1. Build on Phase 4 helpers — same Agency/PartnerAdmin seed.

2. Create `tests/e2e/prm/t2-attribution-happy-path.spec.ts`:
   - `beforeEach`: reset, seed Agency + PartnerAdmin + a Prospect in `qualified` state
   - Test: "OMPartnerOps creates LicenseDeal, attributes via Path A, sees MIN reflect"
     - Login as admin, navigate to `/backend/prm/license-deals`
     - Create LicenseDeal (link to existing Prospect's company)
     - Trigger attribution — Golden Rule should auto-pick the Prospect
     - Wait for saga to complete (poll prospect status until `won`, max 30s)
     - Assert LicenseDeal status = `attributed`
     - Logout, login as partner-admin, navigate to portal dashboard
     - Assert MIN widget shows the deal value

3. **The 30s wait is critical:** sagas are async. If timeout hits, surface as a bug — either the workers aren't running in `yarn dev` or the saga is broken.

**Acceptance:**
- [ ] Test runs green twice in a row
- [ ] Saga completes within 30s (if it doesn't, that's a bug to surface)

**Commit:** `test: add T2 IT-9.1 attribution Path A Playwright smoke`

---

### Phase 6 — Update om-implement-spec gate

**Goal:** the process gap that allowed §9 deferrals goes away. Future specs can't be marked done without smoke proof.

**Steps:**

1. Read `.ai/skills/implement-spec/SKILL.md` (or wherever `om-implement-spec` lives in this repo's superpowers).

2. Add a step to its checklist: **"Before marking spec done: run `yarn test:e2e tests/e2e/prm/<spec-shortname>-happy-path.spec.ts` and confirm green."**

3. Update language anywhere in the skill that allows "deferred to QA team" — replace with explicit "if no smoke test exists for this flow, write one as part of the spec implementation."

4. Add a corresponding line to `AGENTS.md` under "Quality & Process" or similar section: **"Every spec ships with at least one Playwright smoke test for its §9 happy-path scenario. Listing scenarios in §9 without writing them is not acceptable."**

**Acceptance:**
- [ ] Skill file updated, change is visible to a future agent invocation
- [ ] AGENTS.md reflects the new rule
- [ ] No remaining "deferred to QA team" language in any spec changelog template or skill

**Commit:** `docs: require Playwright smoke per spec; remove "deferred to QA team" loophole from om-implement-spec`

---

### Phase 7 — Tag MVP

**Goal:** mark a known-good rollback point.

**Steps:**

1. Verify all of:
   - `yarn typecheck` clean
   - `yarn jest` green
   - `yarn test:e2e` green (Phase 3 + 4 + 5 all running)

2. Update `POST-MVP-FOLLOW-UPS.md`: remove the IT-1, IT-9.1 (T1), IT-9.1 (T2) entries from the deferred list since they're now in the smoke suite. Leave the others (IT-2 through IT-9.9 for the remaining scenarios) — those are still owed work, just not blocking MVP.

3. **Commit the POST-MVP-FOLLOW-UPS update.**

4. **STOP before tagging.** Do NOT run `git tag` automatically. The agent must:
   - Surface the PR for human review
   - Wait for explicit user approval ("yes, tag it" / "go ahead and tag")
   - The user (or a follow-up session after merge) runs `git tag -a mvp-beta-t2 -m "T0+T1+T2 MVP gate clear, smoke tests green"` manually.
   - Rationale: tags are visible markers and final go/no-go authority belongs to the user, per the plan's "Dependencies on user" section.

**Acceptance:**
- [ ] POST-MVP-FOLLOW-UPS.md updated
- [ ] PR description notes "READY FOR mvp-beta-t2 TAG — awaiting user approval"
- [ ] Agent did NOT run `git tag`

**Commit:** `docs: trim POST-MVP follow-ups now covered by smoke suite`
**Tag:** `mvp-beta-t2` — applied by user post-merge, NOT by agent

---

## Risks & escalation

- **Phase 3/4/5 surface real bugs.** Likely. Don't paper over them. Document inline (`// TODO bug:`), surface to user, decide fix-vs-defer per bug.
- **Saga doesn't run in `yarn dev`.** If Phase 5 times out and workers aren't starting, that's a separate bug (worker bootstrap). Surface to user; do not stub the saga.
- **Login as partner-admin fails.** May need to check whether `customer_accounts` portal auth works in dev. If not, escalate — the test seed may need a different invitation/acceptance flow than the production path.
- **Playwright + Turbopack flakiness.** Next.js 16 + Turbopack is recent. If timing issues appear, prefer explicit `await expect(...)` waits over arbitrary `waitForTimeout`.

## Out of scope

- Backfilling Playwright tests for IT-2 through IT-9.9 — that's owed work for POST-MVP. This plan covers ONE happy-path test per spec, which is the minimum to prove the spec works at all.
- Fixing any non-URL bugs found during Phase 3/4/5 — those go to a separate fix-commit per bug. This plan is about the harness + smoke tests, not the bug-fix loop.
- L1 (`window.prompt` in B5), cache subscribers, optimistic concurrency — already tracked in POST-MVP-FOLLOW-UPS.md, not blocking MVP.

## Dependencies on user

- User must run `yarn initialize` if local DB doesn't have admin@acme.com seeded.
- User must approve before tagging `mvp-beta-t2` (final go/no-go).
- User decides what to do with bugs that Phase 3/4/5 surface — fix-now vs fix-later.
