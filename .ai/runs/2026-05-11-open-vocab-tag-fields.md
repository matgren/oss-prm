# Run plan — PRM open-vocab tag fields

**Date**: 2026-05-11
**Slug**: prm-open-vocab-tag-fields
**Branch**: feat/prm-open-vocab-tag-fields
**Source spec**: `.ai/specs/SPEC-2026-05-11-open-vocab-tag-fields.md` (READY — rev3, flipped 2026-05-11 after two adversarial passes)
**PR**: pending

## Goal

Flip `technologies` and `services` tag fields from closed-vocab dictionary picklists to open-vocab type-and-enter chips on Agency profile (B1 backend, P3 portal) and Case Study (P8 portal). Upgrade RFP `requiredCapabilities` UX from comma-text to TagsInput with tenant-wide suggestions (OM-staff-only B-RFP form). `industries` stays closed-dictionary.

Per-agency suggestion source: union of own profile + own case studies. Tenant-wide suggestion source (RFP only): union of every active agency's tech tags + every non-deleted case study's tech tags.

## Scope

Backend (validators + 3 suggestion routes) + portal/backend UI (P3 + P8 + B1 + B-RFP) + 1 Playwright integration spec + Jest validator tests. No entity changes; no migration; no event changes; no cache invalidator changes.

## Non-goals

- Central tag-dictionary admin UI / merge tool (out per Mat brief).
- Industries vocabulary change (stays closed).
- Compliance tags / regions / languages dictionary changes.
- Deletion of inert `technologies` / `services` seed code (bounded tech debt).
- Backfill of existing slugs (round-trip natively; surface as suggestions).
- New LLM matching pipeline.

## External References

None — spec is self-contained.

## Implementation Plan

### Phase 1 — Open-vocab tag fields (single phase, atomic)

Final commit order (per spec §Execution Plan, **validators → endpoints → UI**):

1. **Commit 1** — `refactor(prm/validators): open-vocab Agency + array caps + RFP/CaseStudy/MarketingMaterial trim tightening`. `data/validators.ts`:
   - Add `openTagSlugArray = z.array(z.string().trim().min(1).max(80)).max(50, 'prm.errors.tagArrayTooLarge').default([])` (NM2 i18n key wired).
   - Swap on `updateAgencyBackendSchema` + `updateAgencyPortalSchema` for `services` + `techCapabilities` (`industries` stays `dictionaryIdArray`).
   - Tighten `slugStringArray` (line 811) with `.trim()` + `.max(50, 'prm.errors.tagArrayTooLarge')` — cascades to CaseStudy create/update AND MarketingMaterial create/update (callsites 829-830 + 930-945; NM1 audit).
   - Replace `rfpDraftBase.required_capabilities` (line 564) `z.array(z.string())` → `openTagSlugArray`.
   - Jest unit tests cover BC for Agency (uuid + free-form both accepted) + tightening for CaseStudy + MarketingMaterial.topics + RFP.
2. **Commit 2** — `feat(prm): portal tag-suggestion endpoint (per-agency union)`. NEW `src/modules/prm/api/portal/agency/[id]/tag-suggestions/route.ts`. Auth = `requireCustomerAuth` + `requireCustomerFeature(['prm.agency.view'])`. Scope guard = `agency.organizationId === auth.orgId` (404 on mismatch, leaks no existence). Query schema = `?field=technologies|services`. Returns `{ ok, items: TagsInputOption[] }`. UUID filter applied. OpenAPI metadata exported. Extract union+filter logic into a shared helper (e.g., `src/modules/prm/lib/tagSuggestions.ts`).
3. **Commit 3** — `feat(prm): backend per-agency tag-suggestion endpoint (B1 driver)`. NEW `api/agency/[id]/tag-suggestions/route.ts`. Auth = `requireAuth: true` + `requireFeatures: ['prm.agency.read']`. Calls the shared helper from commit 2.
4. **Commit 4** — `feat(prm): backend tenant-wide tag-suggestion endpoint (B-RFP driver)`. NEW `api/tag-suggestions/route.ts`. Auth = `requireAuth: true` + `requireFeatures: ['prm.rfp.create']`. Tenant-scoping via Agency join (CaseStudy has no `tenant_id` column). Only `?field=technologies` exposed in v1.
5. **Commit 5** — `feat(prm/portal): P8 case-study tags become open-vocab`. `frontend/[orgSlug]/portal/case-studies/caseStudyForm.tsx`. Replace `fetchDictionaryEntries('technologies'|'services')` with helper calling new portal endpoint (after resolving caller agency via `/api/prm/portal/me`). Two `<TagsInput />` blocks flip `allowCustomValues={false}` → `true`. Static pre-load pattern already in place — preserved.
6. **Commit 6** — `feat(prm/portal+backend): P3 + B1 + B-RFP UI bundle + Playwright spec`.
   - (a) `frontend/[orgSlug]/portal/agency/page.tsx` (P3 hand-rolled form) — extend form state + render two `<TagsInput />` blocks with `useEffect`-driven static pre-load; pass `suggestions={...}` (TagsInput primitive's static-filter prop).
   - (b) `backend/prm/[id]/page.tsx` (B1) — extend `profileSchema`; add two CrudForm `tags` fields with `useEffect`-driven static pre-load; pass `options: CrudFieldOption[]` (NB1 — CrudForm tag field reads `options`, not `suggestions`; no `loadOptions` = no per-keystroke TagsInput firing).
   - (c) `backend/prm/rfp/_shared/rfpFormConfig.tsx` (B-RFP) — five-identifier coordinated change (Nm3): `requiredCapabilities` becomes `type: 'tags'` with `options: capabilityOptions`; `rfpFormSchema.requiredCapabilities` flips `z.string().optional()` → `z.array(z.string()).default([])`; `RFP_FORM_INITIAL.requiredCapabilities` `''` → `[]`; `rfpToFormValues` drops `.join(', ')`; `rfpFormValuesToPayload` + `rfpFormValuesToPatchPayload` drop the comma-split. Static pre-load from tenant-wide endpoint.
   - (d) NEW `src/modules/prm/__integration__/TC-PRM-OPEN-VOCAB-TAGS-001.spec.ts` — Playwright spec under tenant-per-spec fixture (SPEC-2026-05-09b). **NB2 — partner_admin auth currently blocked by upstream `bootstrap-test-tenant.ts` seeding bug; matches existing PRM portal-spec skip pattern.** Per §8.1: 5 LIVE blocks (3 = tenant-wide RFP union; 5 = first-write-wins casing via backend per-agency endpoint; 6 = UUID filter via backend endpoint; 7 = max-array cap via backend PATCH; 8 = RFP validator tightening). 3 SKIP blocks (1 = per-agency portal union; 2 = cross-agency 404 via portal; 4 = portal cross-pollination via case-study save). Skip comment template per §8.1.

### Phase 1 validation gate (per spec §Execution Plan)

- `yarn generate` (no entity changes; structural cache purge run anyway).
- `yarn typecheck` — zero errors.
- `yarn jest --testPathPattern='src/modules/prm.*validators'` — green (validator BC + tightening).
- `yarn jest --testPathPattern='src/modules/prm'` — full PRM Jest scope green; pre-existing `llmScoringDraft.test.ts` model-id mismatch not regressed.
- `yarn test:integration:ephemeral --grep "TC-PRM-OPEN-VOCAB-TAGS-001"` — Playwright spec green under tenant-per-spec fixture. Requires `OM_PRM_WIC_IMPORT_SECRET` env per AGENTS.md.
- `yarn lint` — zero new warnings on touched files.
- i18n key presence: every new `t(...)` call has a matching entry in `src/modules/prm/i18n/en.json` (including `prm.errors.tagArrayTooLarge` for the max(50) message).
- Manual smoke checklist §8.4 — 6 steps against a dev tenant.

### Phase 2 — N/A

Single-phase amendment per Mat §8 (no partial-ship value).

## Risks

- **Validator changes are mixed** (Agency relaxes; CaseStudy + RFP tighten). All BC-verified in spec §3.1 + §5.2 + §14. If smoke surfaces an unexpected payload, fall-back is read-time normalisation in suggestion handlers (cheap escape hatch).
- **DOS / data-bloat capped** by `.max(50)` on all three tag arrays.
- **No cache, no invalidation churn** — read-distinct on every call against indexed columns.
- **Cross-pollination promise lands atomically** — commit 2 must precede commits 5-6 (UI loses suggestion source otherwise). Commit order encodes this.
- **B1 + B-RFP both need backend-only endpoints** — commits 3 + 4 ship them before commit 6's UI bundle so the dependencies are present.
- **Saved RFP draft compat**: form-state translator change drops the comma-split. Saved drafts already have arrays server-side; round-trip works. Verified in spec §6.4.
- **Legacy UUID-shaped values in `agency.services` / `agency.techCapabilities`**: suggestion handlers filter them out (M4). Storage unchanged; no migration triggered.
- **Adversarial review pass (2026-05-11 rev2)**: 2 blockers + 7 majors + 6 minors all addressed in spec. See spec §15 changelog.
- **Second adversarial review pass (2026-05-11 rev3)**: 2 new blockers + 3 new majors + 3 new minors all addressed. NB1 (CrudForm tag-field prop) verified against `CrudForm.tsx:3698-3713`; NB2 (Playwright fixture limitation) handled via test.skip pattern matching existing portal smokes; NM1 (slugStringArray cascades to MarketingMaterial) explicit in §5.2; NM2 (i18n key wired through `.max(50, 'prm.errors.tagArrayTooLarge')`); minors absorbed. See spec §15 changelog.
- **Open dependency (not blocking this spec)**: full portal Playwright coverage for blocks 1/2/4 unlocks when upstream `bootstrap-test-tenant.ts onTenantCreated` seeding lands. Live staff-auth coverage of the shared helper + validator proves the same logic in the meantime.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Open-vocab tag fields

- [x] 1.1 Commit 1 — validators (open-vocab Agency + slugStringArray tighten + RFP tighten + array caps) — 345e8be
- [x] 1.2 Commit 2 — portal per-agency tag-suggestion endpoint + shared helper — 48f8ce7
- [x] 1.3 Commit 3 — backend per-agency tag-suggestion endpoint (B1 driver) — 5a90dc6 (bundled with 1.4)
- [x] 1.4 Commit 4 — backend tenant-wide tag-suggestion endpoint (B-RFP driver) — 5a90dc6 (bundled with 1.3)
- [x] 1.5 Commit 5 — P8 case-study form: swap suggestion source, `allowCustomValues=true` — 4fb3d1e (bundled with 1.6)
- [x] 1.6 Commit 6 — P3 + B1 + B-RFP UI bundle + Playwright spec `TC-PRM-OPEN-VOCAB-TAGS-001.spec.ts` — 4fb3d1e (bundled with 1.5)
- [x] 1.7 Validator regression tests: BC-uuid for Agency + tightening for CaseStudy + MarketingMaterial + RFP — 345e8be (bundled with commit 1)
- [ ] 1.8 Validation gate: `yarn generate` / `yarn typecheck` / `yarn jest` PRM scope / `yarn test:integration:ephemeral --grep TC-PRM-OPEN-VOCAB-TAGS-001` / `yarn lint` / i18n keys / manual smoke §8.4
- [ ] 1.9 Update spec status DRAFT → IMPLEMENTED with the Implementation Status block populated

### Phase 2 — N/A

Single-phase amendment.

## References

- Spec: `.ai/specs/SPEC-2026-05-11-open-vocab-tag-fields.md`
- Mat brief: `app-spec/mat-notes/2026-05-10-open-vocabulary-tag-fields.md`
- Matom lessons (locked decisions): `app-spec/proxy-lessons.md`
- Parent specs amended (header pointers added):
  - `.ai/specs/SPEC-2026-04-23-agency-foundation.md` §3.1
  - `.ai/specs/SPEC-2026-04-23-case-studies-marketing.md` (CaseStudy tag-field policy)
  - `.ai/specs/SPEC-2026-04-23-rfp-broadcast-response.md` (`requiredCapabilities` UX)
- App-spec edits: `app-spec/app-spec.md` §1.4 (Agency Profile + Case Study field-definition table + Dictionaries note) + §3 Master Data Plan line 1343 (Dictionaries inert-for-forms annotation)
- Playwright fixture (SPEC-2026-05-09b): `src/modules/prm/__integration__/` tenant-per-spec via `mercato test:bootstrap-tenant`
