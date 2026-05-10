# Run plan — PRM partnership-year anchor

**Date**: 2026-05-10
**Slug**: prm-partnership-year-anchor
**Branch**: feat/prm-partnership-year-anchor
**Source spec**: `.ai/specs/SPEC-2026-05-10-partnership-year.md`
**PR**: pending

## Goal

Make PRM yearly KPIs (MIN + WIP/WIC "This year" toggles) aggregate over each agency's **partnership year** (12 months from `Agency.partnership_start_date`) rather than calendar year. Falls back to calendar year + a banner prompt when the anchor is unset.

## Scope

Backend + edit-page-only PR. The portal MIN-widget UI affordances (null-anchor banner, pre-rollover hint, post-rollover caption) require the PRM portal widgets tree, which is uncommitted on `develop` and lands separately. Deferred entry tracked in `POST-MVP-FOLLOW-UPS.md`.

## Non-goals

- Portal MIN-widget banner/hint/caption (deferred — widgets tree not yet on develop).
- Cosmetic widget renames (WIC → "Wildly Important Contributions", WIP → "Wildly Important Prospects", MIN → "Most Important Number — Licenses"), tier 4-pip stepper, MIN list cleanup, WIP redesign per spec corrections. Separate PR.
- Demo-data seeder for `partnership_start_date` (no agency-row seeder in `setup.ts` today — deferred).
- Server-side dashboard cache wrapper (dashboard route uncached in v1).
- Renewal-event modeling (deferred — single editable anchor for v1).
- Backfill for existing agencies (deferred — left null, banner prompts OM staff).

## External References

None — no `--skill-url` arguments supplied. Pre-flight + duplicate-PR keyword check came back clean.

## Implementation Plan

### Phase 1 — Entity + migration

Add `partnership_start_date` (nullable date) to `Agency`. Run `yarn mercato db generate`. Rename the generated migration to the spec-required descriptive suffix. Apply via `yarn mercato db migrate`.

### Phase 2 — Helper + routes + validators + service + DTO

- New `src/modules/prm/lib/partnershipYear.ts` exporting `getPartnershipYearWindow(agency, asOf)` — returns `{ start, end, yearNumber }` or `null`. Feb-29 anchor clamps to Feb-28 in non-leap years.
- New `src/modules/prm/__tests__/partnershipYear.test.ts` — 8 cases (null/undefined, before-anchor, leap-year clamp, multi-year walk).
- `updateAgencyBackendSchema`: add `partnershipStartDate` with Zod refinements (`>= 2020-01-01`, `<= today + 30d`).
- `ADMIN_ONLY_AGENCY_FIELDS`: add both casing mirrors.
- `portalMinQuerySchema`: add optional `partnershipYear` (precedence over `year` when both supplied).
- `agencyService.updateAgency`: snapshot `partnershipStartDate` in `before`, patch branch, `version` bumps via existing assignment, emit `prm.agency.partnership_anchor_changed` on change (set / edit / clear).
- `summariseAgency` (DTO at `api/agency/route.ts:33`): return `partnershipStartDate` as YYYY-MM-DD string or null.
- `api/portal/min/route.ts`: load agency entity, switch to partnership-year window when anchor present, reject `?partnershipYear=N` against null anchor with HTTP 400 `anchor_missing`, response gains `partnershipYear`, `calendarYear`, and `period.partnershipYear { start, end, number, priorYearMinCount }` — same MIN counting predicate as before (`signedAt OR attributedAt`).
- `api/portal/dashboard/route.ts`: same window swap; `period.partnershipYear` envelope; `priorYearMinCount` for the rollover affordance; calendar-year fallback when anchor missing surfaces `warnings: ['partnership_start_date_missing']`.

### Phase 3 — Event + edit-page UI (backend only this PR)

- `events.ts`: add `prm.agency.partnership_anchor_changed` (clientBroadcast + portalBroadcast).
- `agencyService.updateAgency`: emit the new event with payload `{ agencyId, tenantId, previous, current, changedByUserId }` only when the anchor actually changed.
- `backend/prm/[id]/page.tsx`: add `partnershipStartDate` to `AgencyDetail`, to `statusSchema`, render as a `date` field in the Status tab, wire `useConfirmDialog` for non-null → non-null edits (history-mutation guard). Render `ConfirmDialogElement` in the page tree.

**Portal MIN-widget UI deferred** — needs the PRM widget tree to land on develop first. Spec's three UI affordances (null-anchor banner, pre-rollover hint, post-rollover "Year N-1 closed" caption) are itemised in `POST-MVP-FOLLOW-UPS.md`.

### Phase 4 — App-spec edits

Update the canonical app-spec (`/Users/maciejgren/Documents/prm/app-spec/app-spec.md` — **outside this repo**) glossary entry for MIN, KPI summary line, US-5.6, acceptance line, and changelog summary. Verified with `grep` that no stale "MIN = calendar year" remains.

### Phase 5 — Verification + spec status

- `yarn generate`, full `yarn jest` PRM scope, `yarn typecheck`.
- Update `SPEC-2026-05-10-partnership-year.md` Implementation Status section.

## Risks

- **Anchor mutation moves history.** Accepted v1 risk — `priorYearMinCount` is computed live, no snapshot table. Confirm dialog is the safeguard; documented in §8 BC of the spec.
- **Portal MIN-widget UI deferred to a follow-up.** The dashboard route already exposes the envelope; widget can wire it whenever the widget tree lands.
- **Forward contract on tier-evaluation worker.** No tier-eval spec exists yet; entry added to `POST-MVP-FOLLOW-UPS.md` so whoever writes it imports `getPartnershipYearWindow` rather than recomputing calendar windows.
- **MIN counting predicate unchanged.** Locked byte-for-byte (`signedAt OR (signedAt null AND attributedAt) within window`); only the window bounds shift.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Entity + migration

- [x] 1.1 Add `partnership_start_date` column to `Agency` + generate migration + apply — ba53654

### Phase 2: Helper + routes + validators + service + DTO

- [x] 2.1 Helper `getPartnershipYearWindow` + unit tests — ba53654
- [x] 2.2 Validator updates (`updateAgencyBackendSchema`, `ADMIN_ONLY_AGENCY_FIELDS`, `portalMinQuerySchema`) — 3cad1d0
- [x] 2.3 `agencyService.updateAgency` field-diff branch + DTO update + portal min/dashboard route window swap — 3cad1d0

### Phase 3: Event + edit-page UI

- [x] 3.1 `prm.agency.partnership_anchor_changed` event + emission in `agencyService.updateAgency` — 58b49d2
- [x] 3.2 Agency edit page date input + confirm dialog — 58b49d2

### Phase 4: App-spec edits

- [ ] 4.1 Update canonical app-spec MIN glossary + KPI references (out-of-repo file)

### Phase 5: Verification + spec status

- [ ] 5.1 `yarn generate`, tests green, typecheck clean
- [ ] 5.2 Update spec Implementation Status section + `POST-MVP-FOLLOW-UPS.md`

## Changelog

| Date | Change |
|------|--------|
| 2026-05-10 | Initial plan, four review passes complete (2× PM, 2× CTO), spec at Status: Ready |
