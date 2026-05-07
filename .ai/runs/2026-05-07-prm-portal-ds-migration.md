# PRM portal DS migration — `<Alert>` / `<StatusBadge>` / `<PortalEmptyState>`

**Branch:** `feat/prm-portal-ds-migration`
**Base:** `develop` (`a317ea7`)
**Status:** in-progress

## Goal

Replace 6 hardcoded color sites on the PRM partner portal with `<Alert>` / `<StatusBadge>` and add `<PortalEmptyState>` to 4 list pages, fixing a real dark-mode UX regression (light-only `bg-amber-50 text-amber-900` banners are unreadable when `.dark` class is active — toggled from a cookie at `src/app/layout.tsx:40`). Also corrects `POST-MVP-FOLLOW-UPS.md` entries that mislabeled these primitives as unavailable in OM 0.4.x.

## Context

The DS Guardian audit after the post-mvp-beta-t3 closeout flagged the following:

- Dark mode IS active in this app (`src/app/layout.tsx:40` cookie-driven `.dark` class).
- OM 0.4.x DOES ship `Alert` (`variant: default | destructive | success | warning | info`), `StatusBadge` (`variant: success | warning | error | info | neutral`, with optional `dot`), and `PortalEmptyState` (`{ icon?, title, description?, action? }`) — verified against the installed package sources.
- The semantic CSS tokens (`--status-error/warning/success-{bg,text,border,icon}`) ship in `src/app/globals.css`.
- POST-MVP-FOLLOW-UPS currently states these are blocked on missing primitives — that is incorrect.

Two raw-`<select>` filter sites and two raw-`<table>` list sites remain genuinely blocked (Select primitive not in OM 0.4.x; tables are an OQ-010 architectural opt-out from DataTable). These stay untouched.

## Scope

### In scope (16 items)

**Banners → `<Alert variant="warning">` (5 sites)**
1. `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:38` — `PartnerStatusBanner`
2. `src/modules/prm/frontend/[orgSlug]/portal/dashboard/page.tsx:107` — `HistoricalBanner`
3. `src/modules/prm/frontend/[orgSlug]/portal/members/page.tsx:99` — inline historical notice
4. `src/modules/prm/frontend/[orgSlug]/portal/prospects/[id]/page.tsx:205` — lost-reason notice
5. `src/modules/prm/frontend/[orgSlug]/portal/rfp/[id]/page.tsx:202` — declined notice (already had `dark:` overrides; standardize)

**Error card → `<Alert variant="destructive">` (1 site)**
6. `src/modules/prm/frontend/[orgSlug]/portal/prospects/[id]/page.tsx:243` — lost-reason confirmation card

**Status chips → `<StatusBadge>` (4 sites)**
7. `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:141` — Contract chip → `variant="success"`
8. `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:142` — NDA chip → `variant="success"`
9. `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx:143` — Onboarded chip → `variant="success"`
10. `src/modules/prm/frontend/[orgSlug]/portal/rfp/page.tsx:221` — RFP responded/submitted chip → `variant="success"` (already had `dark:` overrides; standardize)

**Empty states → `<PortalEmptyState>` (4 list pages)**
11. `src/modules/prm/frontend/[orgSlug]/portal/prospects/page.tsx` — render `<PortalEmptyState>` instead of empty-row `<td colSpan={6}>` when items.length === 0
12. `src/modules/prm/frontend/[orgSlug]/portal/library/page.tsx` — replace inline `<div className="rounded-md border bg-muted/30 p-6">` empty card
13. `src/modules/prm/frontend/[orgSlug]/portal/case-studies/page.tsx` — same shape
14. `src/modules/prm/frontend/[orgSlug]/portal/rfp/page.tsx` — replace empty `<li>` placeholder

(Site #15 `notifications/page.tsx` is dropped from scope — it is a thin wrapper over `PortalNotificationPanel`, which already implements its own DS-compliant empty state via `text-muted-foreground` tokens. Adding `PortalEmptyState` here would duplicate empty UIs. This decision is documented in the PR body.)

**Doc correction (1 file)**
15. `.ai/specs/POST-MVP-FOLLOW-UPS.md` — under "Design system follow-ups": delete the "Hardcoded amber banner palette" portal entries and the "Hardcoded emerald onboarding chips" entry that incorrectly claimed primitives were missing. Add a top-of-section note explaining the correction. Keep the genuinely-blocked items (raw `<select>`, raw `<input type="month">`, raw `<input type="radio">`, raw `<table>`, `border-l-2 border-primary/60`, backend-only `LOST` badge, backend-only amber banner, `text-rose-700` audit).

### Out of scope (hard constraints from brief)

- 4 raw `<select>` filter sites (`prospects/page.tsx:206/242/259`, `agency/page.tsx:191`) — Select primitive missing in OM 0.4.x.
- 2 raw `<table>` list sites (`prospects/page.tsx:293`, `members/page.tsx:167`) — OQ-010 architectural opt-out.
- Backend pages (`backend/license-deals/[id]/page.tsx`, `backend/prospects/page.tsx`, etc.) — outside this PR's portal-only focus.
- Adding `dark:` override classes manually — primitives handle dark mode via tokens.
- Spec files under `.ai/specs/SPEC-*.md` (frozen post-merge).

## Primitive APIs (verified at `node_modules/@open-mercato/ui/src/...`)

```ts
// primitives/alert.tsx
<Alert variant="warning|destructive|success|info|default" className?>
  <AlertTitle>title</AlertTitle>
  <AlertDescription>body</AlertDescription>
</Alert>
// role="alert" is set on the wrapper.

// primitives/status-badge.tsx
<StatusBadge variant="success|warning|error|info|neutral" dot?>
  text
</StatusBadge>

// portal/components/PortalEmptyState.tsx
<PortalEmptyState
  icon?={ReactNode}
  title="..."
  description?="..."
  action?={ReactNode}
/>
```

## Chip → tone mapping justification

| Site | Visual semantic | StatusBadge variant |
|---|---|---|
| Contract signed | "achievement" / positive milestone | `success` |
| NDA signed | "achievement" / positive milestone | `success` |
| Onboarded | "achievement" / positive milestone | `success` |
| RFP responded (draft or submitted) | "you've engaged with this" / positive | `success` |

All four were `bg-emerald-*` historically, which maps cleanly to `success` (the semantic emerald-rooted token).

## Risks

- **Risk:** A primitive renders incorrectly in dark mode for some reason (e.g., upstream regression).
  **Mitigation:** Manual dev-server smoke in light + dark on one page per category before opening the PR. Documented in PR body. Escalate to user if a primitive is broken upstream — do not paper over with manual `dark:` classes.
- **Risk:** Refactoring inline JSX into helper components for testability accidentally changes layout (e.g., margin collapse from a removed wrapper `<div>`).
  **Mitigation:** Each helper preserves the same outer wrapper className when reasonable; lint via `yarn typecheck` and `yarn build`. Manual smoke confirms layout.
- **Risk:** Tests (pure-logic, no jsdom in this project's jest env) cannot use `getByRole('alert')`.
  **Mitigation:** Test by importing the page module and asserting `tree.type === Alert` / `tree.type === StatusBadge` / `tree.type === PortalEmptyState` against the React element returned by extracted helper components. This is the same testing discipline used by `confirmDialog.test.ts` (test the helper, not the rendered page).
- **Risk:** Visual smoke fails to find a CASE where the historical banner renders (need a `historical` partner status).
  **Mitigation:** Smoke covers ONE page per category that is reachable in the seed-data state. The `rfp` declined chip is reachable via the rfp inbox. The historical banner can be visually checked by temporarily forcing `agency._prm.status = 'historical'` in the dev session if needed; otherwise the structural test is sufficient evidence.

## Implementation plan

### Phase 1 — Banners → `<Alert variant="warning">`

Replace 5 inline `bg-amber-50 text-amber-900` banners. Where the banner is already a small inline component (e.g., `PartnerStatusBanner`, `HistoricalBanner`), refactor into a clean helper that returns an `<Alert>` element. Add a structural test asserting the helper's React element type is `Alert` with `variant="warning"`.

### Phase 2 — Error card → `<Alert variant="destructive">`

Replace the `border-rose-300 bg-rose-50` lost-reason confirmation card with `<Alert variant="destructive">` while preserving the `onKeyDown` handler that drives the Cmd/Ctrl+Enter / Escape contract. Add a structural test asserting the new wrapper component returns `<Alert variant="destructive">`.

### Phase 3 — Status chips → `<StatusBadge>`

Replace 4 inline emerald chips with `<StatusBadge variant="success">`. Tests cover each chip helper.

### Phase 4 — Empty states → `<PortalEmptyState>`

Wire `<PortalEmptyState>` into 4 list pages (prospects, library, case-studies, rfp). Empty-state copy reuses the existing translation keys where present and keeps partner-facing voice. Tests cover the helpers.

### Phase 5 — POST-MVP-FOLLOW-UPS correction + manual smoke

Rewrite the "Design system follow-ups" section header with a one-paragraph correction note. Delete the entries that incorrectly claimed primitives were unavailable. Run the full validation gate (typecheck + jest + build), then `yarn dev` smoke (1 page per category, light + dark). Capture verification in PR body.

## Validation gate

- `yarn typecheck` — must pass.
- `yarn jest` (or `yarn test`) — full suite must remain green at 482+/482+ (we add new tests; total grows).
- `yarn build` — production build smoke.
- `yarn dev` — manual visual smoke: `agency` (banner + chips), `rfp` inbox (chip + empty state), `library` (empty state), in BOTH light + dark mode.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 0: Plan + branch claim

- [ ] 0.1 Land plan on the new branch as the first commit

### Phase 1: Banners → Alert (warning)

- [ ] 1.1 Migrate `agency/page.tsx` historical banner + tests
- [ ] 1.2 Migrate `dashboard/page.tsx` historical banner + tests
- [ ] 1.3 Migrate `members/page.tsx` historical banner + tests
- [ ] 1.4 Migrate `prospects/[id]/page.tsx` lost-reason banner + tests
- [ ] 1.5 Migrate `rfp/[id]/page.tsx` declined notice + tests

### Phase 2: Error card → Alert (destructive)

- [ ] 2.1 Migrate `prospects/[id]/page.tsx` lost-reason confirmation card + tests

### Phase 3: Status chips → StatusBadge

- [ ] 3.1 Migrate `agency/page.tsx` Contract / NDA / Onboarded chips + tests
- [ ] 3.2 Migrate `rfp/page.tsx` responded chip + tests

### Phase 4: Empty states → PortalEmptyState

- [ ] 4.1 Wire `prospects/page.tsx` empty state + tests
- [ ] 4.2 Wire `library/page.tsx` empty state + tests
- [ ] 4.3 Wire `case-studies/page.tsx` empty state + tests
- [ ] 4.4 Wire `rfp/page.tsx` empty state + tests

### Phase 5: Doc + verification

- [ ] 5.1 Correct POST-MVP-FOLLOW-UPS.md "Design system follow-ups" section
- [ ] 5.2 Run full validation gate (typecheck + jest + build)
- [ ] 5.3 Manual dev-server smoke (1 page per category, light + dark) — note in PR body

### Phase 6: Open PR + auto-review-pr loop

- [ ] 6.1 Open PR; apply `review` + `feature` labels; post short label rationale comments
- [ ] 6.2 Run `auto-review-pr` autofix pass; address actionable findings (if any)
- [ ] 6.3 Post comprehensive summary comment

## Changelog

- 2026-05-07 — Plan created on `feat/prm-portal-ds-migration`.
