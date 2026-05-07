---
title: PRM Spec #7 — Case Studies & Marketing Library
slug: prm-spec-07-case-studies-marketing
date: 2026-05-07
branch: feat/prm-spec-07-case-studies-marketing
author: matgren
input_spec: .ai/specs/SPEC-2026-04-23-case-studies-marketing.md
status: in-progress
---

# Run plan — PRM Spec #7 (Case Studies & Marketing Library)

## Goal

Implement Spec #7 (WF6 + WF2 partial) end-to-end: `CaseStudy` aggregate (soft-delete + invariant #8 publish gate), `MarketingMaterial` aggregate (visibility + tier gate), portal P7/P8 pages, P11 Library (custom React with facets), backend B8/B9 admin pages, four per-feature cache invalidator subscribers (OQ-019), `topics` dictionary seed (OQ-012), and the cross-spec promise: replace the v1 cross-Agency CaseStudy reject in `RfpService.upsertResponseDraft` with a real own-Agency lookup, plus wire the deferred picker in Spec #5's P10.

## Source documents

- **Input spec (canonical):** `.ai/specs/SPEC-2026-04-23-case-studies-marketing.md` (reconciled 2026-05-05)
- **Execution plan:** `.ai/specs/EXECUTION-PLAN.md` row #7 — depends on Spec #1 (shipped); soft-dep on Spec #5 (shipped).
- **Project rules:** `AGENTS.md` (root), `.ai/skills/implement-spec/SKILL.md`
- **Reference run plan:** `.ai/runs/2026-05-07-prm-spec-05-rfp-broadcast-response.md` (Spec #5 — same iteration cadence + test gate format)
- **Cross-spec contract:**
  - `RfpService.upsertResponseDraft` currently 400s any non-empty `attached_case_study_ids` (placeholder until Spec #7 ships). This spec replaces the placeholder with an own-Agency lookup against `prm_case_studies` (published only).
  - Spec #5's P10 case-study picker is deferred to this spec (POST-MVP-FOLLOW-UPS line item to be removed).

## External References

None — Piotr's dispatch passed no `--skill-url`.

## Hard constraints (FROZEN per dispatch)

1. **No core module modifications.** All code in `src/modules/prm/`. Additive only.
2. **Tenant scoping:** every CaseStudy / MarketingMaterial query MUST filter by `organization_id`. Use `findWithDecryption` (per AGENTS.md).
3. **Per-iteration quality gate:** `yarn typecheck` (exit 0), `yarn jest src/modules/prm` green, `yarn generate` clean.
4. **Tests-with-code:** every code commit ships tests in the same commit.
5. **Spec #5 promise closed:** when this PR lands, the cross-Agency reject in `rfpService.upsertResponseDraft` becomes a real query (own-Agency, published CaseStudy) AND the POST-MVP-FOLLOW-UPS "Spec #5 case-study picker" entry is trimmed.
6. **PR target: `develop`.**
7. **Per-iteration `yarn test:integration:ephemeral --no-reuse-env`** — sibling Spec #6 agent runs concurrently. `--no-reuse-env` is non-negotiable.
8. **Markdown editor primitive:** `@open-mercato/ui` v0.5.0 does not ship one. Use plain `Textarea` + "Markdown supported" hint, same as Spec #5.
9. **No `// for Spec #7` / `// AI-generated` / `// removed: X` comments.**

## Adaptations from spec text (will be documented inline as they land)

- **Dictionary FK shape:** spec §5.1 declares `client_industry_id UUID REFERENCES dictionary_entry(id)`. Spec #1 already deviated to free-form **slug strings** for industries / services / techCapabilities (Agency entity has `industries: string[]` + JSONB columns). v1 mirrors that decision: store **slug strings** for `client_industry`, `client_country`, `technologies_used[]`, `services_delivered[]`, `topics[]`. Promote to dictionary_entry FKs as a v2 follow-up if dictionary_entry rows materialize. Documented inline.
- **Attachment FKs:** the OM core `attachments` table uses `entity_id` + `record_id` text columns rather than direct FKs. Spec §5.1 says `hero_image_attachment_id UUID REFERENCES attachment(id)`. v1 stores the attachment-row UUID as `hero_image_attachment_id` (no DB FK constraint, since `attachments` may be in a different schema/migration ordering); the application owns ownership lookup. Documented inline.
- **`min_tier_rank` GENERATED column:** ships as a plain integer column maintained by application code (MikroORM has limited support for `GENERATED ALWAYS AS (...) STORED` columns across versions; the lookup is trivial). Computed in the service layer. Documented inline.
- **Tier rank lookup:** `om_agency = 1 < ai_native = 2 < ai_native_expert = 3 < ai_native_core = 4` — already used by Spec #1 conceptually; ships as a const in `lib/tierRank.ts`.
- **Cache `deleteByTags` resolution:** OM ships a `cache` DI registration (used by `customers`, `auth/sidebar/preferences`, etc.). Subscribers resolve via `ctx.resolve('cache')` and gate-check `typeof cache.deleteByTags === 'function'` before calling.

## Implementation Plan

Per spec §10, target is 5 atomic commits. Per dispatch, target ~8-10 to keep slices verifiable.

### Commit 1 — `CaseStudy` entity + migration + portal CRUD + soft-delete/restore (US2.2 + US2.3)

- Migration `Migration2026...._prm_case_study.ts` + companion `_indexes.ts`:
  - Table `prm_case_studies` per §5.1 (slug-shaped tags as JSON `[]`).
  - Indexes: `(agency_id, deleted_at)`, partial `(agency_id) WHERE deleted_at IS NULL`, partial `(may_publish_on_om_website, published_url) WHERE may_publish_on_om_website = TRUE`.
  - CHECK `chk_published_url_requires_flag`.
- Entity `CaseStudy` in `src/modules/prm/data/entities.ts`.
- Validators (`createCaseStudyInputSchema`, `updateCaseStudyInputSchema`, `setCaseStudyPublicationFlagSchema`, list filters) in `data/validators.ts`.
- ACL features: `prm.case_study.write`, `prm.case_study.toggle_publish`, `prm.case_study.read_all`. Granted to OM PartnerOps + OM Marketing in `setup.ts`.
- Service `CaseStudyService` in `src/modules/prm/lib/caseStudyService.ts` (DI-registered with `.proxy()`):
  - `createDraft`, `updateDraft`, `softDelete`, `restore`, `setPublicationFlag`, `listForAgency`, `listAll`, `getOwnedById`.
  - `softDelete` enforces invariant #8: blocked when `may_publish_on_om_website && published_url`.
  - `restore` enforces invariant: row must be in `deleted` state.
- Routes:
  - Portal: `src/modules/prm/api/portal/case-study/route.ts` (GET list / POST create), `[id]/route.ts` (GET / PUT), `[id]/delete/route.ts` (POST), `[id]/restore/route.ts` (POST).
  - Backend: `src/modules/prm/api/case-study/route.ts` (GET list), `[id]/route.ts` (GET), `[id]/publication-flag/route.ts` (PUT).
  - Portal write guard: payload key match `may_publish_on_om_website|published_url` → `422 ForbiddenField` + emit `prm.agency.admin_field_access_rejected`.
- Events added to `events.ts`: `prm.case_study.created`, `prm.case_study.updated`, `prm.case_study.deleted`, `prm.case_study.restored`, `prm.case_study.publication_flag_changed`.
- Cross-spec wiring (commit 1, since CaseStudy now ships): `RfpService.upsertResponseDraft` replaces the v1 reject with own-Agency lookup against `prm_case_studies`. Each ID must resolve to a CaseStudy with `agency_id = current_agency_id` AND `deleted_at IS NULL`. (Spec doesn't require "published" for portal RFP attachments — only own-Agency + non-deleted.)
- Unit tests: service-layer happy-path + invariant #8 + restore + cross-Agency reject + attached-CaseStudy ownership query.

Commit message: `feat(prm): T7 — CaseStudy entity + portal CRUD + soft-delete/restore + own-Agency picker (US2.2/US2.3)`

### Commit 2 — `MarketingMaterial` entity + migration + B9 backend admin (US7.1)

- Migration `Migration2026...._prm_marketing_material.ts` + companion `_indexes.ts`:
  - Table `prm_marketing_materials` per §5.2.
  - Indexes: live partial on `(published_at, visibility, min_tier_rank) WHERE published_at IS NOT NULL AND unpublished_at IS NULL`.
  - CHECKs: `chk_tier_gated_requires_min_tier`, `chk_unpublished_after_published`.
- Entity `MarketingMaterial`.
- Validators: `createMarketingMaterialInputSchema`, `updateMarketingMaterialInputSchema`, `unpublishMarketingMaterialSchema` (optional reason), list-filter schemas.
- ACL features: `prm.marketing_material.read`, `prm.marketing_material.write`, `prm.marketing_material.publish`. Granted in `setup.ts` (OM Marketing / Admin only — explicitly NOT to OM PartnerOps `employee` role).
- Service `MarketingMaterialService`:
  - `create`, `update`, `publish`, `unpublish`, `list`, `getById`, `delete`.
- Backend routes:
  - `src/modules/prm/api/marketing-material/route.ts` (GET / POST), `[id]/route.ts` (GET / PUT / DELETE), `[id]/publish/route.ts` (POST), `[id]/unpublish/route.ts` (POST).
- Backend admin pages (B9 list + create + edit) under `src/modules/prm/backend/marketing-materials/`:
  - `page.tsx` (DataTable list with publish/unpublish inline button).
  - `new/page.tsx` (CrudForm — create unpublished).
  - `[id]/page.tsx` (CrudForm edit + publish/unpublish actions).
- Events added: `prm.marketing_material.created`, `prm.marketing_material.updated`, `prm.marketing_material.published`, `prm.marketing_material.unpublished`.
- Unit tests: service-level + tier-gated invariant + publish/unpublish lifecycle (`unpublished_after_published`).

Commit message: `feat(prm): T7 — MarketingMaterial entity + B9 backend admin + publish/unpublish (US7.1)`

### Commit 3 — Backend B8 CaseStudy admin + topics dictionary seed

- Backend admin pages under `src/modules/prm/backend/case-studies/`:
  - `page.tsx` (cross-Agency DataTable with `may_publish` toggle inline; calls `/publication-flag` route).
  - `[id]/page.tsx` (read-only-ish detail with publication-flag form).
- `topics` dictionary seed in `setup.ts` (idempotent helper using `dictionaries` module's `Dictionary` + `DictionaryEntry` rows). v1 stores slug strings on `MarketingMaterial.topics[]`; the dictionary backs the picker UI.
- Unit tests: B8 publication-flag route guard (Marketing-only; OM PartnerOps 403).

Commit message: `feat(prm): T7 — B8 CaseStudy admin + topics dictionary seed (US2.4 + OQ-012)`

### Commit 4 — P11 Marketing Library portal page + facets + tier gate (US7.2)

- Portal route `src/modules/prm/api/portal/library/route.ts` (GET — server applies tier gate + facets).
- Portal `:id/download` route → `302` redirect or 404 if gate now fails.
- Portal page `src/modules/prm/frontend/[orgSlug]/portal/library/page.tsx` — custom React (no DataTable per OQ-010), facet filters (`material_type`, `topics[]`, `audiences[]`).
- Cache: response cached under tags `['prm:library', 'prm:agency:${agency_id}:tier:${tier}']` (resolved via DI `cache` if available; gracefully degrades if `cache.getOrSet` not present in container).
- Unit tests: tier-gate visibility (`om_agency` user can't see `ai_native_expert`-gated material), facet aggregation, download route 404 after unpublish.

Commit message: `feat(prm): T7 — P11 Marketing Library portal page + tier-gated visibility (US7.2)`

### Commit 5 — Cache invalidator subscribers + portal P7/P8 + Spec #5 picker wire-up

- Subscribers (per OQ-019 — per-feature, not generic):
  - `marketing-library-published-invalidator.ts` — `prm.marketing_material.published` → `cache.deleteByTags(['prm:library'])`.
  - `marketing-library-unpublished-invalidator.ts` — `prm.marketing_material.unpublished` → same.
  - `marketing-library-updated-invalidator.ts` — `prm.marketing_material.updated` → reads aggregate; if currently published → invalidate; else no-op.
  - `agency-tier-change-library-invalidator.ts` — `prm.agency.tier_changed` → `cache.deleteByTags(['prm:agency:${agency_id}:tier:*'])`.
- Portal P7 list + P8 form:
  - `src/modules/prm/frontend/[orgSlug]/portal/case-studies/page.tsx` (list, filter by include_deleted).
  - `src/modules/prm/frontend/[orgSlug]/portal/case-studies/new/page.tsx` (create form).
  - `src/modules/prm/frontend/[orgSlug]/portal/case-studies/[id]/page.tsx` (edit form + soft-delete + restore).
  - Plain `Textarea` + "Markdown supported" hint for narrative fields (R1 mitigation, same as Spec #5).
- Spec #5 P10 case-study picker wired in:
  - Replaces the deferred message at `prm.portal.rfp.response.caseStudy.deferred`.
  - Custom React checkbox list (max 5) sourcing from `GET /api/prm/portal/case-study?published=any` (own-Agency, non-deleted).
  - Auto-saves into `attached_case_study_ids` via the existing draft route — no new endpoint.
- Unit tests: subscriber idempotency, no-op on draft edit, P10 picker reads own-Agency, draft attaches case-study ids.

Commit message: `feat(prm): T7 — cache invalidators + portal P7/P8 + Spec #5 P10 case-study picker (US7.2 + cross-spec)`

### Commit 6 — Final verification + spec status + POST-MVP trim + PR

- Run full gate: `yarn typecheck`, `yarn jest src/modules/prm`, `yarn generate`, `yarn test:integration:ephemeral --no-reuse-env`.
- Update SPEC §Implementation Status table.
- Trim `POST-MVP-FOLLOW-UPS.md`: remove **"Spec #5 case-study picker"** entry (now resolved).
- Open draft PR against `develop`.

Commit message: `docs(runs): close prm-spec-07 run plan; spec implementation status; trim POST-MVP`

## Risks (carried from spec §8)

- **R1 External-system coupling (OQ-008 deferred):** v1 ships flag-on-PRM. v2 backlog only.
- **R2 Soft-delete + undelete:** restore is `deleted_at = NULL`, idempotent. Unit-tested.
- **R3 Attachment access via route ACL (no URL expiry):** OK for v1 — portal-authenticated. v2 only if external sharing.
- **R4 Cache invalidation timing:** subscriber synchronous; TTL 15 min fallback.
- **R5 Tier-gate regression on event drift:** `prm.agency.tier_changed` payload assumes `agency_id` + `tenant_id` keys (Spec #1 contract). Subscriber asserts shape; throws loudly on missing.
- **R6 MarketingMaterial unpublish clawback fiction:** WF6 edge case 5 — by design.
- **R7 Hero/gallery attachment orphans on hard-delete:** v1 only soft-deletes. v2 TODO.

## Out of scope (explicit)

- Public rendering on openmercato.com (external system).
- Event-driven CaseStudy publish handshake (OQ-008 → v2).
- Signed / short-TTL attachment URLs (OQ-011 resolution).
- Approval workflow / review queue for CaseStudies (L-007).
- Auto-reconciliation of already-published CaseStudies on edit (downstream Marketing owns).
- MarketingMaterial download analytics beyond raw fetch (v2).

## Bundled POST-MVP items (will trim from FOLLOW-UPS as they ship)

- **Spec #5 case-study picker** — resolved in Commit 5; trimmed in Commit 6.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Commit 0: Run plan

- [x] 0.1 Run plan committed

### Commit 1: CaseStudy + MarketingMaterial entities + portal CRUD + soft-delete/restore + cross-spec picker

- [x] 1.1 Entities (`CaseStudy` + `MarketingMaterial` — both shipped together since the OM ORM generator emits a single migration for both)
- [x] 1.2 Migration + `_indexes` companion (invariant #8 CHECK + partial indexes + FKs)
- [x] 1.3 Validators (case study + marketing material schemas)
- [x] 1.4 ACL features (case_study + marketing_material gates)
- [x] 1.5 `CaseStudyService` + DI registration with `.proxy()`
- [x] 1.6 Portal API routes (list/create/get/update/delete/restore)
- [x] 1.7 Backend API routes (list/get/publication-flag)
- [x] 1.8 Events added (case_study + marketing_material lifecycle)
- [x] 1.9 `RfpService.upsertResponseDraft` replaces cross-Agency reject with own-Agency lookup
- [x] 1.10 Unit tests — caseStudyService.test.ts + 3 new rfpService cross-spec tests; jest 278/278 across 29 suites
- [x] 1.11 typecheck + jest + generate green

### Commit 2: MarketingMaterial service + B9 backend admin

- [x] 2.1 Entity (`MarketingMaterial`) shipped in commit 1's auto-generated migration
- [x] 2.2 Migration + `_indexes` companion (CHECK + live partial idx) shipped in commit 1
- [x] 2.3 Validators (create/update/unpublish/listBackend/listLibraryPortal)
- [x] 2.4 ACL features (`prm.marketing_material.read/write/publish`) shipped in commit 1
- [x] 2.5 `MarketingMaterialService` (DI .proxy()) — create/update/publish/unpublish/delete/list/listPublishedForViewer
- [x] 2.6 Backend API routes (list/create/get/update/delete/publish/unpublish)
- [x] 2.7 B9 backend pages (list + new + edit)
- [x] 2.8 Events added (created/updated/published/unpublished) shipped in commit 1
- [x] 2.9 Unit tests — marketingMaterialService.test.ts (16 cases inc. tier gate happy/below/at/no-tier; topic post-filter; lifecycle invariants); jest 294/294
- [x] 2.10 Gate green (typecheck + jest)

### Commit 3: B8 CaseStudy admin + topics dictionary seed

- [ ] 3.1 B8 backend page (cross-Agency list + publication-flag toggle)
- [ ] 3.2 B8 detail page
- [ ] 3.3 `topics` dictionary seed in `setup.ts`
- [ ] 3.4 Unit tests
- [ ] 3.5 Gate green

### Commit 4: P11 Marketing Library + tier gate

- [ ] 4.1 Portal `/api/prm/portal/library` GET (tier gate + facets)
- [ ] 4.2 Portal `/api/prm/portal/library/[id]/download` redirect (re-checks publish state)
- [ ] 4.3 Portal P11 page (custom React + facets)
- [ ] 4.4 Tier-rank helper
- [ ] 4.5 Unit tests
- [ ] 4.6 Gate green

### Commit 5: Cache invalidators + portal P7/P8 + Spec #5 P10 picker

- [ ] 5.1 Four cache invalidator subscribers
- [ ] 5.2 Portal P7 list page
- [ ] 5.3 Portal P8 create/edit form
- [ ] 5.4 P10 case-study picker (replaces deferred message)
- [ ] 5.5 Unit tests
- [ ] 5.6 Gate green

### Commit 6: Final gate + PR

- [ ] 6.1 Full gate green (typecheck + jest + generate + integration)
- [ ] 6.2 Spec implementation-status section
- [ ] 6.3 Trim POST-MVP-FOLLOW-UPS "Spec #5 case-study picker"
- [ ] 6.4 Draft PR opened to `develop`
