# Follow-up: eject `OM_INTEGRATION_TEST` env-var check from `src/app/layout.tsx`

**Date**: 2026-05-09
**Status**: PROPOSED — flagged out-of-scope in SPEC-2026-05-09b but worth a small standalone commit
**Risk**: Low (UI chrome only — notice bar suppression, no state behavior)
**Effort**: ~5–10 LOC change + smoke-test, ~30 min

## What's there today

`src/app/layout.tsx:26`:

```ts
const noticeBarsEnabled = process.env.OM_INTEGRATION_TEST !== 'true'
```

Passed as a prop to `AppProviders` at line 48:

```tsx
<AppProviders locale={locale} dict={dict} demoModeEnabled={demoModeEnabled} noticeBarsEnabled={noticeBarsEnabled}>
```

The check exists to suppress notice bars (demo notice, cookie notice, feedback dialog) during integration tests. It's the same anti-pattern shape as `OM_*_TEST_*` env vars (production code knows about test mode), just opposite-polarity (`!== 'true'` enables prod behavior).

## Why it's lower-risk than the seams that were deleted

- It only suppresses UI chrome — no state mutations, no API behavior changes
- It doesn't ship a test-only HTTP route
- It doesn't gate any data-modifying code path

But it IS still production code that branches on a test-mode env var, and it would fail the discipline rule's grep gate if the gate were broadened beyond `src/modules/**` to all of `src/`.

## The clean fix — use the upstream cookie pattern

OM core's `node_modules/@open-mercato/core/src/helpers/integration/auth.ts:60-87` (`acknowledgeGlobalNotices`) already dismisses these notices via the same UX path users use:

```ts
async function acknowledgeGlobalNotices(page: Page): Promise<void> {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
  await page.context().addCookies([
    { name: 'om_demo_notice_ack', value: 'ack', url: baseUrl, sameSite: 'Lax' },
    { name: 'om_cookie_notice_ack', value: 'ack', url: baseUrl, sameSite: 'Lax' },
    { name: 'om_feedback_suppress', value: '1', url: baseUrl, sameSite: 'Lax' },
    { name: 'om_feedback_shown', value: new Date().toISOString().slice(0, 10), url: baseUrl, sameSite: 'Lax' },
  ])
}
```

This is called inside the upstream `login(page, role)` helper at `auth.ts:152` — every test that logs in via the OM core login helper already gets notices dismissed. No env var needed.

## Proposed cleanup diff

### `src/app/layout.tsx`

```diff
   const demoModeEnabled = process.env.DEMO_MODE !== 'false'
-  const noticeBarsEnabled = process.env.OM_INTEGRATION_TEST !== 'true'
   return (
     <html lang={locale} suppressHydrationWarning>
       ...
-      <AppProviders locale={locale} dict={dict} demoModeEnabled={demoModeEnabled} noticeBarsEnabled={noticeBarsEnabled}>
+      <AppProviders locale={locale} dict={dict} demoModeEnabled={demoModeEnabled}>
         {children}
       </AppProviders>
```

### `src/components/AppProviders.tsx` (or wherever the prop is consumed)

Remove the `noticeBarsEnabled?: boolean` prop. Notices are always rendered in production code; tests dismiss them via the cookies set by the OM core auth helper at fixture init.

### Verification

1. `grep -rn 'noticeBarsEnabled\|OM_INTEGRATION_TEST' src/` → should return nothing after the change.
2. Manually verify in dev that demo notice, cookie notice, and feedback dialog still appear by default (they should — we removed the suppression mechanism, not the notices themselves).
3. Once SPEC-2026-05-09b's `tenantFixture` lands and uses the OM core `login(page, role)` helper, confirm Playwright specs see no notices (cookies dismiss them at login time per `auth.ts:60-87`).

## Why this isn't in SPEC-2026-05-09b's scope

- SPEC-2026-05-09b's scope is the test architecture rebuild + Phase 0b ejection of the BROADCAST_INSERT_FAIL fault-injection seam. The `OM_INTEGRATION_TEST` env var is in `src/app/`, not `src/modules/`.
- Including it would scope-creep the spec from "rebuild PRM Playwright suite" to "audit and clean every test-mode env var in the codebase" — a different effort.
- It's safe to ship as a separate standalone commit any time. Doesn't depend on SPEC-2026-05-09b's implementation status.

## Suggested commit when this lands

```
refactor(app): remove OM_INTEGRATION_TEST env-var notice-bar gate; rely on upstream cookie-based dismissal

Notice-bar suppression during integration tests was previously gated by
the OM_INTEGRATION_TEST env var read in src/app/layout.tsx. This is the
same anti-pattern shape as the deleted OM_*_TEST_* state-reset seams (with
opposite polarity), and it conflicted with the discipline rule established
in SPEC-2026-05-09b ("if OM core wouldn't merge it upstream, we don't add
it locally").

The clean fix uses the upstream cookie pattern at
node_modules/@open-mercato/core/src/helpers/integration/auth.ts:60-87
(acknowledgeGlobalNotices), which sets dismissal cookies the same way a
human user would dismiss the notices via the UX. The OM core login(page,
role) helper already calls this at fixture init — Playwright tests that
log in via the standard helper get notices dismissed automatically.

Production behavior unchanged: notices appear by default for all users.

Co-Authored-By: ...
```

## When to do this

- After SPEC-2026-05-09b's tenantFixture lands AND uses `login(page, role)` from `@open-mercato/core/helpers/integration/auth` — at that point the cookie-based dismissal is verifiably wired up for tests.
- Or earlier as a standalone cleanup if someone wants to tighten the discipline gate sooner.
- NOT before either, because removing the env-var check without the cookie path active would leave Playwright specs (when they exist) seeing notices that interfere with assertions.
