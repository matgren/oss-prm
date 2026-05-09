# Run plan — fix(prm/marketing-materials): apply DS conventions to AttachmentPicker

**Date:** 2026-05-09
**Branch:** `fix/prm-attachment-picker-ds`
**Slug:** `prm-attachment-picker-ds`
**Origin:** DS Guardian REVIEW of the PRM module on 2026-05-09. The review identified
`src/modules/prm/backend/prm/marketing-materials/components/AttachmentPicker.tsx` as the
only file in the PRM module with concentrated DS violations. CTO advisory was to fix this
one file and explicitly NOT to sweep coverage gaps across other modules.

## Goal

Bring `AttachmentPicker.tsx` into compliance with the four DS rules it violates today,
without expanding scope beyond this single component file.

## Scope

**In scope (single file):**
`src/modules/prm/backend/prm/marketing-materials/components/AttachmentPicker.tsx`
plus a sibling unit test under `src/modules/prm/__tests__/`.

**Non-goals (explicitly out of scope):**
- Sweeping `EmptyState` coverage across the other 7 PRM list pages — DS Guardian
  flagged this as a process gap, but Piotr's advisory said no campaign PR; rely on the
  organic "every PR fixes the file it touches" pattern instead.
- Adding empty/loading state coverage to portal frontend pages.
- Touching any other PRM module file. The decorative gold-star toggle button at
  lines 211–227 is a raw `<button>` (per AGENTS.md, MUST be `IconButton`), but
  fixing it requires preserving the `text-amber-500` conditional for the gold-star
  visual. We mark it with a `DS-SKIP: decorative` comment and leave the button-vs-
  IconButton refactor as a separate follow-up to keep this PR focused on the four
  fixes the review identified.

## External References

None — no `--skill-url` arguments were passed. Project AGENTS.md routing applies:
`.ai/skills/ds-guardian/SKILL.md` is the authoritative DS source.

## Implementation Plan

### Phase 1 — DS fixes in `AttachmentPicker.tsx`

Single edit to the component file. All four fixes land in one commit alongside the
unit test (tests-with-code gate).

- **1.1** Replace the raw `fetch('/api/prm/marketing-material/upload', ...)` call at
  line 90 with `apiCallOrThrow` from `@open-mercato/ui/backend/utils/apiCall`. Pass
  the existing `FormData` body through `RequestInit` unchanged — `apiCallOrThrow`
  forwards it as-is and the browser sets the multipart boundary automatically. Use
  `result` from the returned `ApiCallResult` shape instead of `await res.json()`.
  Preserve the existing translated error fallback (`prm.backend.marketingMaterials
  .attachments.uploadFailed`).

- **1.2** Replace the `<div className="text-xs text-red-600">{error}</div>` error
  display at line 200 with `<Alert variant="destructive">` from
  `@open-mercato/ui/primitives/alert`. The Alert component's destructive variant
  already wires up the `--status-error-{bg,text,border,icon}` semantic tokens, so
  this drops the hardcoded `text-red-600` and gains dark-mode correctness for free.

- **1.3** Replace the amber "Primary" badge `<span>` at line 245 with
  `<StatusBadge variant="warning">` from `@open-mercato/ui/primitives/status-badge`,
  matching the prop shape used by `RfpResponseStatusChip` and `OnboardingChips` in
  the portal frontend. Drops the hardcoded `bg-amber-500/10 / text-amber-700`
  utilities AND the arbitrary `text-[10px]` size — StatusBadge has its own sizing.

- **1.4** Add a `{/* DS-SKIP: decorative gold-star icon, not a status semantic */}`
  comment immediately above the conditional `text-amber-500` className expression
  at lines 220–224. The gold star is a decorative "primary / favorite" UI
  convention, not a status color, so it does not migrate to a semantic token.
  The comment silences future DS Guardian scans for this site.

### Phase 2 — Unit test (DS migration regression guard)

Mirror the static-analysis pattern used by `backendLicenseDealsDsMigration.test.ts`.
The project's jest env is `node` (not jsdom), so we read the source file and assert
on its content with regex.

- **2.1** Add `src/modules/prm/__tests__/backendAttachmentPickerDsMigration.test.ts`
  asserting:
  - Imports `apiCallOrThrow` from `@open-mercato/ui/backend/utils/apiCall`.
  - Imports `Alert` from `@open-mercato/ui/primitives/alert`.
  - Imports `StatusBadge` from `@open-mercato/ui/primitives/status-badge`.
  - Uses `<Alert variant="destructive">` for the error surface.
  - Uses `<StatusBadge variant="warning">` for the Primary badge surface.
  - Source no longer contains `text-red-`, `bg-amber-7`, `text-amber-7`,
    `text-[10px]`, or raw `fetch(`.
  - Source DOES still contain `text-amber-500` once (the decorative star icon)
    and the `DS-SKIP: decorative` marker comment immediately above it.
  - Translation keys `prm.backend.marketingMaterials.attachments.uploadFailed`
    and `.primary` are preserved (regression guard for i18n drift).

## Risks

- **`apiCallOrThrow` + FormData.** Verified manually: `apiCall.ts` forwards
  `RequestInit` as-is via `apiFetch`, never sets `Content-Type`, and tolerates a
  FormData body. If the underlying `apiFetch` adds a JSON Content-Type header for
  any reason, the multipart boundary breaks. Mitigation: the unit test only checks
  the source-level migration; runtime behavior is exercised by the
  marketing-materials integration tests on PR.

- **Tests-with-code gate.** A code change without a colocated test fails the gate.
  Phase 2 lands in the same commit as Phase 1 to satisfy this.

- **Out-of-scope raw `<button>` (lines 211–227).** Documented as a known follow-up
  in this plan and in the PR body. Not fixing now keeps the diff scoped to the four
  reviewed violations and avoids a spec-creep failure during review.

## Verification

After each phase commit, the tests-with-code gate runs the staged-files mechanical
check from the auto-create-pr SKILL. Before opening the PR, the full validation gate:

- `yarn typecheck` — must pass
- `yarn test` — must pass (with the new test green)
- `yarn build` (or `yarn build:app` if available) — must pass
- DS scan: `grep -rn 'text-red-[0-9]\|bg-amber-[0-9]\|text-amber-7\|text-\[[0-9]' src/modules/prm/backend/prm/marketing-materials/components/AttachmentPicker.tsx`
  — should return only the DS-SKIP'd `text-amber-500` line on the star icon.
- Raw fetch scan: `grep -n 'fetch[(]' src/modules/prm/backend/prm/marketing-materials/components/AttachmentPicker.tsx`
  — should return zero hits.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: DS fixes in AttachmentPicker

- [ ] 1.1 Replace raw fetch with apiCallOrThrow
- [ ] 1.2 Replace text-red-600 error div with Alert variant="destructive"
- [ ] 1.3 Replace amber Primary badge with StatusBadge variant="warning"
- [ ] 1.4 Mark gold-star icon className as DS-SKIP: decorative

### Phase 2: DS migration regression test

- [ ] 2.1 Add backendAttachmentPickerDsMigration.test.ts (static-analysis assertions)

### Phase 3: Validation gate + PR

- [ ] 3.1 yarn typecheck / yarn test / yarn build all green
- [ ] 3.2 Open PR against develop with Tracking plan link
- [ ] 3.3 Apply review + skip-qa labels with comments
- [ ] 3.4 Run auto-review-pr autofix loop until clean
- [ ] 3.5 Post lean summary comment, mark Status: complete
