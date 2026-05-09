# Validation pass — SPEC-2026-05-09b against Playwright best practices + OM upstream

**Date**: 2026-05-09
**Trigger**: User asked "is this /om-cto according to how Playwright best practices defines such tests and how OM upstream is doing its tests?" — adversarial review demanded after I'd flipped the spec to READY.
**Outcome**: Status reverted to DRAFT; 5 technical gaps + 1 architectural framing miss closed.

This note exists so future-me can audit the reasoning. The spec text alone shouldn't have to carry the validation receipts.

## What I checked

### A. Playwright official best practices
Source: `playwright.dev/docs/test-fixtures`, `playwright.dev/docs/test-parallel`, `playwright.dev/docs/auth`, `playwright.dev/docs/test-configuration`.

| Topic | Playwright says | My spec |
|---|---|---|
| Worker-scoped fixtures for expensive setup | Recommended via `{ scope: 'worker' }` | ✅ Used |
| Tenant-per-worker for multi-tenant SaaS | Explicitly recommended via `TEST_WORKER_INDEX` | ✅ Used |
| Auth: setup project + storageState | Canonical pattern | ⚠️ Spec uses worker-scoped fixture for auth instead. Acceptable (the tenant fixture has to run per-worker anyway and includes auth). Not adopted because it would add a new project to the upstream config. |
| `workers` count | `workers: process.env.CI ? 1 : undefined` is the docs example | ⚠️ Spec uses 4 local / 2 CI — justified as a deliberate departure. |
| Email verification | "No specific guidance" — Playwright is browser-focused | N/A — handled via OM-app routes |

**Verdict**: directionally aligned with Playwright docs. The `workers` choice is a deliberate departure justified by the predecessor's failure mode.

### B. OM upstream test conventions
Sources: `node_modules/@open-mercato/core/src/helpers/integration/*` (the actual installed source), `.ai/qa/tests/playwright.config.ts`, `node_modules/@open-mercato/cli/src/lib/testing/integration.ts`.

What OM upstream actually does:
- Ships **23 fixture helpers** at `node_modules/@open-mercato/core/src/helpers/integration/` including `auth.ts` (7.9K with `login(page, role)` + `DEFAULT_CREDENTIALS`), `notificationsFixtures.ts`, `staffFixtures.ts`, `inboxFixtures.ts`, `crmFixtures.ts`, `salesFixtures.ts`, etc.
- Playwright config at `.ai/qa/tests/playwright.config.ts` with `workers: 1`, `testDir: projectRoot`, `testMatch: discoveredSpecPaths` from `discoverIntegrationSpecFiles()`.
- Module-local `__integration__/` directory convention (e.g., `packages/core/src/modules/catalog/__integration__/TC-AI-D18-018-bulk-edit-demo.spec.ts`).
- Naming: `TC-<CATEGORY>-<NNN>-<slug>.spec.ts`.
- Shared bootstrapped tenant from `mercato init`. Default credentials: `superadmin@acme.com`, `admin@acme.com`, `employee@acme.com`.
- No tenant-creation pattern in upstream tests. No SMTP-capture pattern (uses `inbox_ops` extraction API for inbox tests).

| Topic | OM upstream | My spec (before validation) | After validation |
|---|---|---|---|
| Auth helper | Ships `auth.ts` with `login(page, role)` + `DEFAULT_CREDENTIALS` | Reinvented login | ✅ Reuses upstream helpers |
| Notifications fixture | Ships `notificationsFixtures.ts` | Ignored | ✅ Referenced; partner-invite case escalated to upstream PR |
| Playwright config location | `.ai/qa/tests/playwright.config.ts` | Said modify root `playwright.config.ts` (doesn't exist) | ✅ CLI-level `--workers=4` override; config untouched |
| Tenant scope | Single shared bootstrapped tenant | Tenant-per-worker | ⚠️ Kept as deliberate departure with rationale |
| Workers | `workers: 1` | `workers: 4`/`workers: 2` | ⚠️ Kept as deliberate departure with rationale |
| Spec location | Module-local `__integration__/` | `src/modules/prm/__integration__/` | ✅ Already correct, confirmed against upstream convention |

**Verdict**: 4 technical corrections (helpers, config location, workers mechanism, integration with discoverIntegrationSpecFiles) + 1 framing correction (name the departures explicitly) needed.

### C. The partner-invite read flow — the one real gap

`GET /api/notifications` exists upstream at `node_modules/@open-mercato/core/src/modules/notifications/api/route.ts`. Lines 26–29:

```typescript
const filters: Record<string, unknown> = {
  recipientUserId: scope.userId,  // <-- ALWAYS scoped to authenticated user
  tenantId: scope.tenantId,
}
```

The route only returns notifications where `recipientUserId == authenticated user's ID`. There is no way to query "notifications addressed to email `admin@acme.test` for a recipient who doesn't have an account yet."

For PRM's partner-invite flow (admin invites a partner via email; partner clicks link; partner registers), the test needs to read the invitation email content addressed to a not-yet-registered email. OM core's notifications route doesn't support this.

This is the ONE place where pressure to reinstate `OM_PRM_TEST_LAST_INVITE_*` would actually be felt. The discipline rule resolves it: spawn an upstream PR (SPEC-2026-05-09c) extending the notifications module for this case, not a PRM-local seam.

## Why "OM core is the reference" replaces my custom enforcement proposal

I had drafted a Recurrence Prevention section with CI grep gates, ESLint rules, PR checkboxes, etc. The user pointed out: the project doesn't use CI, AND OM core itself doesn't ship test seams without any of those mechanisms.

OM core's natural anti-seam properties are:
1. Rich fixture coverage that goes through real routes (so no one needs a seam)
2. `workers: 1` + shared tenant means specs don't fight each other for state
3. Authenticated as superadmin (has wildcard features) — can do anything via real routes
4. Email tests use the `inbox_ops` extraction API — a real production capability

If we adopt the same discipline (real routes, real auth, no production internals in test code, upstream PRs for missing capabilities), we inherit OM core's natural defense against the seam attractor. The discipline rule replaces the entire CI-script proposal because:
- Lower friction (no new tooling)
- Higher fidelity (catches semantic regressions a grep would miss)
- Aligns with how the project's gate actually works (`om-code-review` skill, not GitHub Actions)

The single load-bearing rule:

> If OM core wouldn't merge it upstream, we don't add it locally.

That's it. The rest of the spec's discipline section is consequences of that rule.

## What I learned about my own process

1. **I called the spec READY without doing the validation pass.** Memory `feedback_adversarial_reviews_must_execute.md` already warned me: "code-only review (greps + reads) misses Playwright/loader/decorator runtime issues; must run ≥1 spec under the target runtime." I did greps and reads. I did not run anything. I should have at least dispatched the upstream-pattern subagent BEFORE flipping to READY.

2. **My instinct was to invent infrastructure rather than reuse it.** The 23 fixture files in OM core were sitting at a known path; I didn't enumerate them. The proposed local notifications-read route was avoidable if I'd inspected upstream's notifications route first. Reuse-first is a Piotr principle ("Start with 80% done") — I violated it.

3. **The user's worry about regression was the actual gate.** I would have shipped the spec as READY without the discipline section. The user's "I'm just worried we'll get back to this ugly solution" forced the most important section in the spec.

These are process lessons, not design lessons. Worth carrying forward.
