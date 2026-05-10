# SPEC-2026-04-23 — PRM Case Studies & Marketing Library (WF2-partial + WF6 · Phase 6)

> **Cross-spec drift fixed 2026-05-05.** Routes live under `/api/prm/case-study/...`, `/api/prm/marketing-material/...`, `/api/prm/portal/case-study/...`, `/api/prm/portal/library/...` per the shipped T0/T1/T2 namespace convention (singular resources, no `/backend/` segment, OM auto-discovers from `src/modules/<module>/api/...`). Tables use the `prm_` prefix (`prm_case_studies`, `prm_marketing_materials`). All other contracts (event IDs, entity shapes, ACL features) remain valid as drafted.
>
> **2026-05-05 follow-up:** body paths replaced inline — legacy `/api/{backend,portal}/...` and plural `case-studies` / `marketing-materials` mentions corrected to canonical singular `/api/prm/case-study/...` / `/api/prm/marketing-material/...` / `/api/prm/portal/case-study/...` / `/api/prm/portal/library/...` throughout. Header now consistent with body.
>
> **Spec #7 of 7** · Author: Piotr (om-cto Spec Orchestrator) · Date: 2026-04-23
**Persona:** Martin Fowler (architectural-purity lens)
**Depends on:** SPEC-2026-04-23-agency-foundation (#1). Soft-dependency on SPEC-2026-04-23-rfp-broadcast-response (#5) — which *reads* CaseStudies produced here.
**Est. commits:** 5 (point — OQ-011, OQ-012, OQ-019 resolved; per-feature cache invalidators only)

---

## 1. Summary + Scope + Business Outcome

### TLDR
Phase 6 completes the marketing flywheel. Agencies self-manage CaseStudies through a rich portal form (media attachments, multi-dictionary tags, markdown narratives) and may soft-delete anything not yet published on the public OM website. OM Marketing reviews submissions on a backend list and, for those approved, flips a pair of admin-only fields (`may_publish_on_om_website` + `published_url`) that together constitute "published" per invariant #8. In parallel, OM Marketing uploads MarketingMaterials with tier-gated visibility, and Agencies browse them through a faceted Library page with per-feature cache invalidation. No core modifications — every primitive (`attachments`, `dictionaries`, `cache`, `events`) ships.

### Scope (in)
- **US2.2** — PartnerAdmin creates/edits CaseStudy on portal P8 (rich form, hero image + gallery, markdown narratives, dictionary-tagged).
- **US2.3** — PartnerAdmin soft-deletes CaseStudy on P7 with external-coupling guard (invariant #8).
- **US2.4** — OM Marketing flags `may_publish_on_om_website` + `published_url` on B8 (admin-only write); v1 flag-on-PRM shortcut per OQ-008 (deferred to v2).
- **US7.1** — OM Marketing uploads / publishes / unpublishes MarketingMaterial on B9.
- **US7.2** — AgencyMember browses P11 Marketing Library with facets, tier-gated visibility, and per-feature `cache.deleteByTags` invalidator subscribers.
- `setup.ts` seeds for the `topics` dictionary (OQ-012 resolution: PRM owns its own dictionary seeds).
- Read contract for Spec #5's P10 (RFPResponse form) picker over own-Agency, non-soft-deleted CaseStudies.

### Scope (out — explicit)
- Public rendering on openmercato.com (external Marketing system; PRM only emits the flag event per WF2 boundaries).
- Event-driven CaseStudy publish handshake (OQ-008 deferred to v2; v1 uses flag-on-PRM shortcut).
- Signed / short-TTL attachment URLs (OQ-011 resolution: regular URLs gated by partition/org/tenant segmentation + route ACL, acceptable for portal-authenticated users).
- Approval workflow / review queue for CaseStudies (L-007: no versioning / review steps in v1).
- Auto-reconciliation of already-published CaseStudies when Agency edits the narrative (WF2 edge case 2 — downstream Marketing owns reconciliation; PRM only emits `prm.case_study.updated`).
- MarketingMaterial download analytics beyond raw file-fetch (v2).
- Attaching CaseStudies to RFPResponses (that picker lives in Spec #5; this spec defines only the read contract).

### Business outcome
> *"My partners self-manage case studies. My partners always have the latest sales deck."*

- ≥ 1 CaseStudy per active Agency within 60 days of portal access (Cagan business criterion; Phase 6 §7).
- ≥ 80 % of active Agencies have at least one CaseStudy with `may_publish_on_om_website = true` within 6 months (flag-readiness leading indicator; publishing itself is on the external Marketing team's cadence, not PRM's).
- ≥ 80 % of active Agencies download at least one MarketingMaterial within 30 days of any new publication.
- Marketing Library (P11) lands in the top-5 portal pages by monthly session count — proves it's a routine touchpoint, not a one-time visit.
- `prm.case_study.publish_flag_changed` event emitted on every flag transition (100 % auditability of the external-system coupling).

---

## 2. Technical Approach (Piotr)

- **Mode:** Extend PRM module with content entities + backend CrudForms + custom portal pages + per-feature cache invalidator subscribers. No core modifications. Reuses `attachments` / `media`, `dictionaries`, `cache` modules.
- **New entities:**
  - `CaseStudy` (aggregate; FK `agency_id`; `title`, `client_name`, `client_industry` FK to `dictionaries.industries`, `client_country` FK to countries list, `challenge_markdown`, `approach_markdown`, `outcome_markdown`, `technologies_used[]` FK to dictionaries, `services_delivered[]` FK to dictionaries, `hero_image_attachment_id` FK, `gallery_attachment_ids[]` FK, `may_publish_on_om_website` boolean default false — Marketing-only write per US2.4, `published_url` nullable text — Marketing-only write, `deleted_at` nullable — soft-delete per US2.3, `created_at`, `updated_at`). **Invariant #8: publishing gated on `may_publish_on_om_website = true` AND `published_url IS NOT NULL`.**
  - `MarketingMaterial` (OM-owned; `title`, `description`, `material_type` enum `playbook` / `sales_deck` / `video` / `guide` / `case_study_template` / `other`, `min_tier` nullable enum `om_agency` / `ai_native` / `ai_native_expert` / `ai_native_core` — `NULL` ⇒ visible to all partners; non-null ⇒ tier-gated to that rank or above, `topics[]` FK to a `topics` dictionary (seeded by PRM `setup.ts` per OQ-012; backend new/edit form uses `TagsInput` (closed list) backed by the topics dictionary, matching the `caseStudyForm.tsx` pattern for technologies/services), `allowed_roles[]` jsonb of partner role slugs from `['partner_admin','partner_member']` (canonical list: `src/modules/prm/data/validators.ts` `ROLE_SLUGS`) — empty array ⇒ all roles within an at-tier agency; non-empty ⇒ only those role slugs see the row, `primary_attachment_id` FK, `published_at` nullable, `unpublished_at` nullable, `created_by_user_id`, `created_at`, `updated_at`).
- **Attachments (OQ-011 resolved):**
  - Reuses `packages/core/src/modules/attachments/`. Writes to local FS `storage/attachments/{partitionCode}/org_X/tenant_Y/...`.
  - `buildAttachmentImageUrl(attachmentId, sizeOptions)` returns a regular URL gated by partition/org/tenant segmentation.
  - **Access control via route-level ACL check, not URL expiry.** No signed short-TTL URLs. Acceptable for portal-authenticated users. v2 may revisit if external sharing materializes.
- **US2.2 Create/edit CaseStudy (P8 rich form):**
  - Custom React form. Required fields per entity schema; markdown editors for narrative fields (same editor as Spec #5 P10 or thin wrapper if `packages/ui` doesn't ship).
  - Hero image + gallery via `attachments` module upload.
  - Portal-API route-level write guard (same pattern as Spec #1 for admin-only fields): `may_publish_on_om_website` + `published_url` are **Marketing-only** — writes rejected regardless of CustomerUser role.
  - On save: emits `prm.case_study.created` or `prm.case_study.updated`.
- **US2.3 Soft-delete CaseStudy:**
  - Portal action on P7. Sets `deleted_at` — never hard delete.
  - **Guard:** if `may_publish_on_om_website = true` AND `published_url IS NOT NULL`, deletion blocked with error "This Case Study is published on the OM website. Ask OM Marketing to unflag or remove before deleting." (Invariant #8 plus external-system coupling guard — Cagan C3 accepted.)
  - Emits `prm.case_study.deleted`.
- **US2.4 Marketing publish flag (B8):**
  - Standard `DataTable` over CaseStudies with inline toggle for `may_publish_on_om_website` (Marketing-role-only). When toggled on, Marketing separately writes `published_url` (or leaves blank — invariant #8 says both must be true to constitute "published").
  - **v1 shortcut per OQ-008 (deferred to v2):** flag-on-PRM. v2 will move to event-driven handshake with external Marketing system.
  - Emits `prm.case_study.publication_flag_changed` with `may_publish_on_om_website` new value.
- **US7.1 Upload + publish MarketingMaterial (B9):**
  - Standard CrudForm + media upload via `attachments`. `publish` / `unpublish` actions toggle `published_at` / `unpublished_at`.
  - Emits `prm.marketing_material.published` / `prm.marketing_material.unpublished`.
- **US7.2 Browse Marketing Library (P11 portal custom list with facets):**
  - Custom React list (OQ-010 — no DataTable in portal).
  - Filter facets: material_type, topics. Tier-gate filter: `min_tier IS NULL OR min_tier_rank <= current_agency.tier_rank`.
  - Click-to-download: fetch `buildAttachmentImageUrl` (OQ-011 — regular URL, route-ACL-gated).
  - **Cache strategy (OQ-019):** P11 library list is cached per-agency (tier-dependent visibility). Cache tags: `[ 'prm:library', `prm:agency:${agency_id}:tier:${tier}` ]`. Role gate (`allowed_roles[]`) is applied **post-cache** by the request handler against the viewer's role membership — cache stays tier-keyed, never role-keyed.
  - Per-feature `cache.deleteByTags` invalidator subscribers (OQ-019 — no generic event-to-cache-bust router):
    - `prm.marketing_material.published` → invalidate `['prm:library']` (new material may now be visible to all agencies at/above min_tier).
    - `prm.marketing_material.unpublished` → invalidate `['prm:library']`.
    - `prm.agency.tier_changed` (from Spec #1) → invalidate `['prm:agency:${agency_id}:tier:*']` (agency's visibility set may change).
- **Dictionary seeds (OQ-012):** PRM `setup.ts` seeds `topics` dictionary. Countries + industries + services + technologies seeded in Spec #1.
- **Cross-spec:** Spec #5's P10 (RFPResponse form) attaches own-Agency CaseStudies as response evidence — reads from THIS spec's `CaseStudy` entity, scoped to current Agency + `deleted_at IS NULL`. This spec defines the read contract; Spec #5 consumes it.
- **Rationale:** Reuses shipped primitives (`attachments`, `dictionaries`, `cache`) — no new infra. Soft-delete + publish-flag guard (invariant #8) is the single domain risk. Per-feature cache invalidators are 3 subscribers = ~1 commit total.

> **Reconciliation note (Piotr):** The App Spec §1.4.1 CaseStudy block uses slightly different field names than the Technical Approach above (`client_public_name` / `client_anonymous_label` / `summary` / `challenge` / `solution` / `outcome` / `hero_image_url` text field / `gallery_urls` text[]). **The Technical Approach above is authoritative for implementation** — specifically: (a) the narrative fields are `challenge_markdown` / `approach_markdown` / `outcome_markdown` (markdown type explicit, `approach_markdown` replaces `solution` for clearer semantics); (b) hero + gallery are **attachment FKs**, not URL strings, because OQ-011 resolved in favour of the `attachments` module owning lifecycle; (c) `client_name` is a single field — the NDA-anonymisation decision is now a value-level choice by the Agency (type "Global Automotive Supplier" if anonymised) rather than two separate fields. The `client_public_name` / `client_anonymous_label` split is absorbed; `summary` is dropped (covered by `challenge_markdown`'s opening paragraph per markdown-narrative convention). Soft-delete column `deleted_at` is new vs App Spec — required by US2.3 per Cagan C3. The App Spec will be reconciled in a follow-up edit pass; this spec ships the resolved shape. `submitted_at` / `last_edited_at` collapse into the standard `created_at` / `updated_at` per the data-model convention used across all Phase 1-5 specs.

> **Reconciliation note #2 (Piotr; revised 2026-05-10):** Similarly, MarketingMaterial fields in App Spec §1.4.1 use `type` (enum includes `slide_deck` / `datasheet`), `file_url` / `thumbnail_url` string fields, `target_audience` string[] enum, `visibility` enum values `all_agencies` / `by_min_tier`, `is_published` boolean + `published_at` nullable. **This spec's authoritative shape (per Technical Approach):** `material_type` (renamed for clarity, collision avoidance with Postgres `type`; enum extended with `sales_deck` + `case_study_template` + `other` for v1 richness); `primary_attachment_id` FK (attachments module, not URL); boolean `is_published` collapses into the pair `published_at` / `unpublished_at` timestamps, where `published_at IS NOT NULL AND unpublished_at IS NULL` means "currently published" (explicit audit trail vs flag). **The App Spec `visibility` and `target_audience` mappings no longer apply.** The `visibility` enum is dropped entirely: visibility collapses into `min_tier IS NULL ⇒ all partners` vs `min_tier IS NOT NULL ⇒ tier-gated to that rank or above`. The old `target_audience` (`new_partner` / `active_partner` / `tier_progressing`) was an unproven persona enum and is **deferred to a future feature** tracked at [#42](https://github.com/matgren/oss-prm/issues/42) — it is replaced for v1 by `allowed_roles[]`, a multi-select of real RBAC role slugs (`partner_admin` / `partner_member`; empty ⇒ all roles within an at-tier agency).

---

## 3. API Contracts

All backend routes require `om.backend.session` + the feature flags enumerated in §6. Portal routes require `customer.session` and tenant-scoped `/{slug}/api/portal/...` routing per SPEC-060.

### 3.1 Portal — `/api/prm/portal/case-study`

Plural URL; singular entity. All responses scoped to caller's Agency via `req.auth.organization_id → agency_id`.

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/api/prm/portal/case-study` | — (query: `q`, `published`, `limit`, `offset`) | paged `CaseStudyDTO[]` | P7 list; excludes `deleted_at IS NOT NULL` by default |
| `POST` | `/api/prm/portal/case-study` | `CreateCaseStudyInput` (Zod) | `CaseStudyDTO` | P8 create; PartnerAdmin only |
| `GET` | `/api/prm/portal/case-study/:id` | — | `CaseStudyDTO` | P8 detail; 404 if `deleted_at` set or cross-Agency |
| `PUT` | `/api/prm/portal/case-study/:id` | `UpdateCaseStudyInput` (Zod) | `CaseStudyDTO` | P8 edit; Marketing-only fields rejected |
| `POST` | `/api/prm/portal/case-study/:id/delete` | `{ confirm: true }` | `204` or `409 ExternalCouplingGuard` | Soft-delete; 409 when `may_publish_on_om_website = true` AND `published_url IS NOT NULL` |
| `POST` | `/api/prm/portal/case-study/:id/restore` | — | `CaseStudyDTO` | Undelete (compensation); PartnerAdmin only; 409 if not in `deleted` state |

**Zod shapes:**

```ts
const CaseStudyWriteBase = z.object({
  title: z.string().min(3).max(200),
  client_name: z.string().min(1).max(200),
  client_industry_id: z.string().uuid(), // FK dictionaries.industries
  client_country_id: z.string().uuid(),  // FK dictionaries.countries (Spec #1)
  challenge_markdown: z.string().min(1),
  approach_markdown: z.string().min(1),
  outcome_markdown: z.string().min(1),
  technologies_used_ids: z.array(z.string().uuid()).default([]),
  services_delivered_ids: z.array(z.string().uuid()).default([]),
  hero_image_attachment_id: z.string().uuid().nullable(),
  gallery_attachment_ids: z.array(z.string().uuid()).default([]),
  // may_publish_on_om_website / published_url — NOT accepted on portal routes (route guard)
});

const CreateCaseStudyInput = CaseStudyWriteBase;
const UpdateCaseStudyInput = CaseStudyWriteBase.partial();
```

**Portal write guard (invariant #6):** any payload key matching `may_publish_on_om_website` or `published_url` is rejected with `422 ForbiddenField` *before* Zod parsing runs. Emits diagnostic event `prm.agency.admin_field_access_rejected` for OM-staff visibility. Pattern identical to Spec #1's Agency admin-field guard.

### 3.2 Backend — `/api/prm/case-study`

B8 CaseStudies list + publish-flag control. All rows visible (cross-Agency), including soft-deleted (OM Marketing needs reconciliation visibility per WF2 edge case 2).

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/api/prm/case-study` | — (query: `agency_id`, `may_publish`, `is_published`, `include_deleted`) | paged list | B8 list — default `include_deleted = true` for Marketing workflow |
| `GET` | `/api/prm/case-study/:id` | — | full DTO | |
| `PUT` | `/api/prm/case-study/:id/publication-flag` | `SetPublicationFlagInput` | `CaseStudyDTO` | Inline B8 toggle — **only** writes `may_publish_on_om_website` + `published_url`; narrative fields untouched |

```ts
const SetPublicationFlagInput = z.object({
  may_publish_on_om_website: z.boolean(),
  published_url: z.string().url().nullable(),
}).refine(
  // invariant #8 sanity: a TRUE flag without a URL is legal (approved but not yet live);
  // a published_url set while flag=false is NOT legal (can't mint a URL without approval)
  (v) => !(v.published_url !== null && v.may_publish_on_om_website === false),
  { message: 'Cannot set published_url when may_publish_on_om_website = false', path: ['published_url'] }
);
```

**RBAC (§6):** requires `prm.case_study.toggle_publish` — OM Marketing + OM Admin only. OM PartnerOps explicitly lacks this feature.

### 3.3 Backend — `/api/prm/marketing-material`

B9 MarketingMaterial CRUD + publish/unpublish.

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/api/prm/marketing-material` | — (query: `material_type`, `min_tier`, `is_published`, `q`) | paged list | B9 list |
| `POST` | `/api/prm/marketing-material` | `CreateMarketingMaterialInput` | `MarketingMaterialDTO` | Creates unpublished |
| `GET` | `/api/prm/marketing-material/:id` | — | DTO | |
| `PUT` | `/api/prm/marketing-material/:id` | `UpdateMarketingMaterialInput` | DTO | Rejects `published_at` / `unpublished_at` direct writes — use publish/unpublish actions |
| `POST` | `/api/prm/marketing-material/:id/publish` | — | DTO | Sets `published_at = NOW()`, clears `unpublished_at`; emits event + cache invalidation |
| `POST` | `/api/prm/marketing-material/:id/unpublish` | `{ reason?: string }` | DTO | Sets `unpublished_at = NOW()`; emits event + cache invalidation |
| `DELETE` | `/api/prm/marketing-material/:id` | — | `204` | Hard delete allowed while never-published; otherwise unpublish + soft-delete-retain |

```ts
const MaterialWriteBase = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).nullable(),
  material_type: z.enum(['playbook', 'sales_deck', 'video', 'guide', 'case_study_template', 'other']),
  // min_tier IS NULL ⇒ all partners; non-null ⇒ tier-gated to that rank or above
  min_tier: z.enum(['om_agency', 'ai_native', 'ai_native_expert', 'ai_native_core']).nullable(),
  topics_ids: z.array(z.string().uuid()).default([]),
  // allowed_roles[] empty ⇒ all roles within an at-tier agency; non-empty ⇒ only those role slugs see it
  allowed_roles: z.array(z.enum(['partner_admin', 'partner_member'])).default([]),
  primary_attachment_id: z.string().uuid(),
});
```

### 3.4 Portal — `/api/prm/portal/library`

Read-only faceted list for P11. Server applies tier-gate filter from session.

| Method | Path | Query | Returns |
|---|---|---|---|
| `GET` | `/api/prm/portal/library` | `material_type?`, `topics[]?`, `limit?`, `offset?` | `{ items: MarketingMaterialPublicDTO[], facets: { material_types, topics }, total }` |
| `GET` | `/api/prm/portal/library/:id/download` | — | `302` redirect to `buildAttachmentImageUrl(primary_attachment_id)` with route-ACL re-check |

**Server filter (concatenated with any user-supplied facet filter):**

```sql
WHERE published_at IS NOT NULL
  AND unpublished_at IS NULL
  AND (min_tier IS NULL OR min_tier_rank <= :viewer_rank)
```

Tier rank is a lookup (`om_agency = 1 < ai_native = 2 < ai_native_expert = 3 < ai_native_core = 4`) — same table seeded in Spec #1.

**Role gate (post-cache):** the request handler additionally filters the cached tier-keyed result against the viewer's role membership: a row with non-empty `allowed_roles[]` is dropped if the viewer's role slug is not in the array; an empty `allowed_roles[]` means "all roles at this tier". Applied **post-cache** so the cache stays tier-keyed (not role-keyed) — the alternative would multiply cache cardinality by `2^|roles|`.

**Cache:** Tier-keyed response cached under tags `['prm:library', 'prm:agency:${agency_id}:tier:${tier}']` with TTL 15 minutes. Invalidators in §4.3. Cache is **not** role-keyed.

`MarketingMaterialPublicDTO` exposes: `id`, `title`, `description`, `material_type`, `topics_ids`, `allowed_roles`, `primary_attachment_download_path`, `published_at`. Exposing `allowed_roles` is acceptable: an at-tier viewer who is filtered out of a row never receives the row in the response, and an at-tier viewer who does receive it benefits from knowing the role audience (e.g., a partner_admin reviewing their team's exposure). Never exposes `min_tier` (an agency below-tier never sees the row at all; an agency at-tier doesn't need to know the gate exists).

---

## 4. Commands & Events

### 4.1 Commands

All commands are undoable per the root Undoability law.

| Command | Trigger | Undoable? | Compensation |
|---|---|---|---|
| `CreateCaseStudyCommand` | `POST /api/prm/portal/case-study` | Yes | `SoftDeleteCaseStudyCommand` |
| `UpdateCaseStudyCommand` | `PUT /api/prm/portal/case-study/:id` | Yes | Replay prior snapshot (standard aggregate undo) |
| `SoftDeleteCaseStudyCommand` | `POST /api/prm/portal/case-study/:id/delete` | **Yes** (via `RestoreCaseStudyCommand`) | Restore — clears `deleted_at` |
| `RestoreCaseStudyCommand` | `POST /api/prm/portal/case-study/:id/restore` | Yes (by re-soft-deleting) | Re-apply `deleted_at` |
| `SetCaseStudyPublicationFlagCommand` | `PUT /api/prm/case-study/:id/publication-flag` | Yes (by setting flag back) | Flag toggle is its own inverse |
| `UploadMarketingMaterialCommand` | `POST /api/prm/marketing-material` | Yes (via DELETE while unpublished; soft-retain once published) | Delete / soft-retain |
| `PublishMarketingMaterialCommand` | `POST /:id/publish` | **Yes** (via `UnpublishMarketingMaterialCommand`) | Unpublish |
| `UnpublishMarketingMaterialCommand` | `POST /:id/unpublish` | Yes (by republishing) | Republish |

The `SoftDelete` ↔ `Restore` pair is the canonical undoability evidence for soft-deleted domain entities in this spec. Commands MUST read aggregate state before firing (calculations, not independent ops) — a restore of a never-deleted CaseStudy is a 409, not a no-op.

### 4.2 Events emitted

All events follow `prm.case_study.*` / `prm.marketing_material.*` naming per App Spec §1.4.5.

| Event | Payload | Purpose |
|---|---|---|
| `prm.case_study.created` | `{ case_study_id, agency_id, created_by_customer_user_id }` | P7 list refresh; Spec #5 P10 picker refresh |
| `prm.case_study.updated` | `{ case_study_id, agency_id, updated_by_customer_user_id, published: boolean }` | **If `published = true`, downstream Marketing reconciliation signal (WF2 edge case 2).** Also drives the `case_study_edit_re_review` notification to OM Marketing (via `notifications` module per OQ-015, owned by Spec #5's notification infrastructure) |
| `prm.case_study.deleted` | `{ case_study_id, agency_id, deleted_by_customer_user_id }` | Soft-delete audit; downstream Marketing unpublish signal |
| `prm.case_study.restored` | `{ case_study_id, agency_id, restored_by_customer_user_id }` | Undelete audit (new; paired inverse of `deleted`) |
| `prm.case_study.publication_flag_changed` | `{ case_study_id, may_publish_on_om_website, published_url, set_by_user_id }` | **Drives external Marketing system** (v1 shortcut per OQ-008; v2 will replace with full handshake) |
| `prm.marketing_material.created` | `{ material_id, material_type, min_tier?, created_by_user_id }` | B9 audit; no cache effect (not published yet) |
| `prm.marketing_material.updated` | `{ material_id, material_type, min_tier? }` | Metadata edit; **triggers cache invalidation if currently published** (§4.3) |
| `prm.marketing_material.published` | `{ material_id, min_tier?, published_at }` | **Drives cache invalidation** + P11 refresh |
| `prm.marketing_material.unpublished` | `{ material_id, unpublished_by_user_id, unpublished_at, reason? }` | Drives cache invalidation |

> **Naming note:** App Spec §1.4.5 uses `prm.case_study.submitted` for first-create and `prm.case_study.publish_flag_changed`. This spec renames the first to `prm.case_study.created` (submitted implies a review workflow which L-007 explicitly out-of-scopes) and the second to `prm.case_study.publication_flag_changed` (grammatical symmetry with other `*_changed` events in the catalog). Both renames are noted in the App Spec reconciliation backlog.

### 4.3 Events consumed (subscribers this spec owns)

Per OQ-019 resolution: no generic event-to-cache-bust router. Each subscriber is a small per-feature file in `modules/prm/subscribers/`.

| Event | Subscriber | Action |
|---|---|---|
| `prm.marketing_material.published` | `MarketingLibraryPublishedInvalidator` | `cache.deleteByTags(['prm:library'])` (all per-tier variants) |
| `prm.marketing_material.unpublished` | `MarketingLibraryUnpublishedInvalidator` | `cache.deleteByTags(['prm:library'])` |
| `prm.marketing_material.updated` | `MarketingLibraryUpdatedInvalidator` | Read aggregate; if `published_at IS NOT NULL AND unpublished_at IS NULL`, `cache.deleteByTags(['prm:library'])`; otherwise no-op (draft edit) |
| `prm.agency.tier_changed` (from Spec #1) | `AgencyTierChangeLibraryInvalidator` | `cache.deleteByTags(['prm:agency:${agency_id}:tier:*'])` — tier-specific variant only |
| `prm.case_study.publication_flag_changed` | (none — consumed by external Marketing system, out of PRM scope per WF2 boundary) | Event emission only |

All four invalidator subscribers together = 1 small commit (per-feature pattern, ~15 LOC each with shared helper).

---

## 5. Data Models

### 5.1 `case_study` table (new — owned by this spec)

```sql
CREATE TABLE case_study (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               UUID NOT NULL REFERENCES organization(id),
  agency_id                     UUID NOT NULL REFERENCES agency(id),

  -- content
  title                         TEXT NOT NULL,
  client_name                   TEXT NOT NULL,
  client_industry_id            UUID REFERENCES dictionary_entry(id),
  client_country_id             UUID REFERENCES dictionary_entry(id),
  challenge_markdown            TEXT NOT NULL,
  approach_markdown             TEXT NOT NULL,
  outcome_markdown              TEXT NOT NULL,

  -- multi-dictionary tags (JSONB array of UUIDs for v1 simplicity;
  -- v2 may pivot to a junction table if cross-entity dictionary queries matter)
  technologies_used_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  services_delivered_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- attachments (OQ-011: FK-to-attachment pattern)
  hero_image_attachment_id      UUID REFERENCES attachment(id),
  gallery_attachment_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Marketing-only fields (invariant #6 + #8)
  may_publish_on_om_website     BOOLEAN NOT NULL DEFAULT FALSE,
  published_url                 TEXT,

  -- lifecycle
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                    TIMESTAMPTZ,
  version                       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT chk_published_url_requires_flag
    CHECK (published_url IS NULL OR may_publish_on_om_website = TRUE)
);

CREATE INDEX idx_case_study_agency        ON case_study (agency_id, deleted_at);
CREATE INDEX idx_case_study_agency_live   ON case_study (agency_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_case_study_published     ON case_study (may_publish_on_om_website, published_url)
                                           WHERE may_publish_on_om_website = TRUE;
```

The partial `idx_case_study_agency_live` index serves Spec #5's P10 picker query (own-Agency, non-deleted) directly.

### 5.2 `marketing_material` table (new — owned by this spec)

```sql
CREATE TABLE marketing_material (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES organization(id),

  title                     TEXT NOT NULL,
  description               TEXT,
  material_type             TEXT NOT NULL
                              CHECK (material_type IN ('playbook','sales_deck','video','guide','case_study_template','other')),

  -- min_tier IS NULL ⇒ visible to all partners; non-null ⇒ tier-gated to that rank or above
  min_tier                  TEXT
                              CHECK (min_tier IN ('om_agency','ai_native','ai_native_expert','ai_native_core')),
  min_tier_rank             SMALLINT GENERATED ALWAYS AS (
                              CASE min_tier
                                WHEN 'om_agency' THEN 1
                                WHEN 'ai_native' THEN 2
                                WHEN 'ai_native_expert' THEN 3
                                WHEN 'ai_native_core' THEN 4
                                ELSE NULL
                              END) STORED,

  topics_ids                JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- allowed_roles[] empty ⇒ all roles at this tier may see the row;
  -- non-empty ⇒ only viewers whose role slug is in the array see it.
  -- Canonical slug list: src/modules/prm/data/validators.ts ROLE_SLUGS = ['partner_admin','partner_member'].
  allowed_roles             JSONB NOT NULL DEFAULT '[]'::jsonb,

  primary_attachment_id     UUID NOT NULL REFERENCES attachment(id),

  published_at              TIMESTAMPTZ,
  unpublished_at            TIMESTAMPTZ,

  created_by_user_id        UUID NOT NULL REFERENCES app_user(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_unpublished_after_published
    CHECK (unpublished_at IS NULL OR published_at IS NOT NULL)
);

CREATE INDEX idx_marketing_material_live
  ON marketing_material (published_at, min_tier_rank)
  WHERE published_at IS NOT NULL AND unpublished_at IS NULL;
```

"Currently published" = `published_at IS NOT NULL AND unpublished_at IS NULL`. Re-publishing after an unpublish sets `unpublished_at = NULL` and bumps `published_at = NOW()` — a new lifecycle window.

### 5.3 `topics` dictionary seed (OQ-012)

`setup.ts` on PRM module install (idempotent):

```ts
await ensureDictionary('topics', [
  { code: 'new-partner-onboarding', label: 'New Partner Onboarding' },
  { code: 'sales-plays', label: 'Sales Plays' },
  { code: 'pricing-positioning', label: 'Pricing & Positioning' },
  { code: 'delivery-playbooks', label: 'Delivery Playbooks' },
  { code: 'case-study-patterns', label: 'Case Study Patterns' },
  { code: 'technical-enablement', label: 'Technical Enablement' },
]);
```

Per OQ-012 resolution, the `dictionaries` module is production-ready and this seed is a plain helper call. Industries / services / technologies / countries are **already** seeded by Spec #1 — not duplicated here.

### 5.4 No separate cache-state table

Per OQ-019 resolution, `cache.deleteByTags` is tenant-scoped and ships natively. This spec uses it via subscribers only — no spec-owned cache-state table.

---

## 6. Access Control

### 6.1 Backend (OM staff)

| Feature flag | Who | Grants |
|---|---|---|
| `prm.case_study.read_all` | OM PartnerOps, OM Marketing, OM Admin | B8 GET endpoints (cross-Agency view) |
| `prm.case_study.toggle_publish` | **OM Marketing, OM Admin only** | `PUT /:id/publication-flag` — gates the admin-only field |
| `prm.marketing_material.read` | OM PartnerOps, OM Marketing, OM Admin | B9 GET endpoints |
| `prm.marketing_material.write` | OM Marketing, OM Admin | B9 POST / PUT / DELETE |
| `prm.marketing_material.publish` | OM Marketing, OM Admin | `/:id/publish` + `/:id/unpublish` — separate from write, per standard publish-gate pattern |

OM PartnerOps explicitly **does not** have `toggle_publish` or `marketing_material.write/publish` — the Marketing / PartnerOps role split is enforced here.

### 6.2 Portal (CustomerUser)

| Persona | P7 list | P8 form | Soft-delete | Marketing-only fields | P11 library |
|---|---|---|---|---|---|
| PartnerAdmin | Read (own Agency) | Read/write (own) | Yes (own) | **Never write** (guard §3.1) | Read (tier-gated) |
| PartnerMember | Read (own Agency) | Read (own Agency) | No | Never | Read (tier-gated) |
| Other Agency | 403 | 403 | 403 | N/A | Read (own-tier only) |

**Portal-API route-level write guard (same pattern as Spec #1):** POST/PUT on `/api/prm/portal/case-study` strips and rejects any `may_publish_on_om_website` / `published_url` key *before* the handler runs. Emits diagnostic event `prm.agency.admin_field_access_rejected` per invariant #6. No CustomerUser role grants these fields.

### 6.3 Attachment access

- CaseStudy hero / gallery: `buildAttachmentImageUrl` returns a URL like `/api/attachments/{partition}/org_{org_id}/tenant_{tenant_id}/{file}`. Route ACL checks `req.auth.organization_id` matches the URL segment + the caller's Agency owns the CaseStudy (for portal) OR the caller has `prm.case_study.read_all` (for backend). No signed short-TTL URL.
- MarketingMaterial primary attachment: the portal `GET /api/prm/portal/library/:id/download` redirect **re-checks** the tier-gate + publish state before issuing the redirect, closing the window where an old URL could grant post-unpublish access.

---

## 7. Backward Compatibility

**Additive only.** Checklist:

| Change | BC impact |
|---|---|
| New table `case_study` | None — net new |
| New table `marketing_material` | None — net new |
| New events under `prm.case_study.*` + `prm.marketing_material.*` | None — additive to event catalog |
| New subscribers (4 cache invalidators) | None — read-only reactive handlers |
| New feature flags `prm.case_study.*` + `prm.marketing_material.*` | Seeded via `setup.ts`; OM Marketing role gains them via seed patch — no existing roles modified |
| `topics` dictionary seed | None — dictionary entries are additive |
| New backend pages B8, B9 | Net new routes |
| New portal pages P7, P8, P11 | Net new routes under `/{slug}/portal/...` |
| Index on `case_study.agency_id WHERE deleted_at IS NULL` | New — serves Spec #5 P10 picker |
| Spec #1 `prm.agency.tier_changed` event | Already exists — this spec only adds a subscriber |

No renames, re-types, narrowing. App Spec §1.4.1 pre-declares both entities; this spec reifies the App Spec declaration with the §2 reconciliation notes applied.

---

## 8. Risks & Impact Review

### 8.1 External-system coupling (v1 OQ-008 shortcut)

**PRIMARY RISK.** CaseStudy `may_publish_on_om_website` + `published_url` are mutated directly on the PRM aggregate; the external Marketing system is expected to consume `prm.case_study.publication_flag_changed` and synchronise. If the external consumer is broken / absent, PRM's state diverges from openmercato.com.

Mitigation: v1 accepts the divergence window explicitly (OQ-008 deferral to v2). The soft-delete guard (§3.1 `/delete` 409) prevents the worst failure (agency deletes while public page is live → broken external link). v2 will replace with event-driven handshake where Marketing calls back with the URL before the flag commits.

### 8.2 Soft-delete + undelete semantics

Risk: an Agency soft-deletes a CaseStudy, then later realises they need it back. Scope includes `RestoreCaseStudyCommand` for this — but if the CaseStudy was referenced on a submitted RFPResponse (Spec #5), the restore must be visible-but-still-historically-correct: the response continues to reference the row whether deleted or restored. Cross-spec edge case 1886 documents the `(deleted Case Study)` label in the scoring UI.

Mitigation: restore is a simple `deleted_at = NULL` update, idempotent. Emits `prm.case_study.restored`. The Spec #5 scoring UI (B7) renders the current title when `deleted_at IS NULL`, else the `(deleted Case Study)` placeholder — this naturally "heals" on restore with no retroactive change.

### 8.3 Attachment access-control via route ACL (no URL expiry)

Risk: an Agency user copies a hero-image URL and shares externally; the URL remains valid as long as the attachment exists and the *recipient's* session has the right tenant — but it's a portal-auth URL, so an unauthenticated recipient sees a redirect to sign-in. If the recipient is a legit user of another Agency / tenant, the route ACL denies.

Mitigation (OQ-011 accepted): portal-authenticated audience only — acceptable for v1. v2 may revisit if external sharing (e.g., public portfolio links) becomes a product requirement; the attachment module then gains signed-URL capability without touching this spec.

### 8.4 Cache invalidation timing

Risk: subscriber fires after DB commit — between commit and invalidator completion, P11 serves a stale cached list. Agency X sees a just-published MarketingMaterial delayed by up to (cache-TTL ∧ subscriber-latency) seconds.

Mitigation: subscriber is synchronous (same event-bus round trip as commit); typical latency < 200ms. TTL is 15 min — the stale window is ≤ the subscriber latency, not the full TTL. For the worst case (subscriber fails to fire — e.g., crash), the 15-min TTL is the fallback. This is well within the Phase 6 Cagan criterion ("top-5 pages by monthly session count") which is about engagement, not real-time freshness.

### 8.5 Tier-gated visibility regression if Spec #1 tier change events miss

Risk: `AgencyTierChangeLibraryInvalidator` subscribes to `prm.agency.tier_changed` (Spec #1). If that event's payload schema drifts (e.g., key renamed in Spec #1 evolution), this invalidator silently fires `cache.deleteByTags(['prm:agency:undefined:tier:*'])` — no-op — and the agency sees materials appropriate to their OLD tier for up to 15 minutes.

Mitigation: integration test §9.6 asserts the handshake shape at test time. Schema drift in Spec #1 is caught by Zod parsing on the subscriber side; the subscriber throws loudly rather than silently no-oping. Add a dev-mode assertion: if `agency_id` is missing from the event payload, throw in non-prod to catch drift before release.

### 8.6 MarketingMaterial unpublish clawback fiction

Risk: an Agency downloads a file, then OM Marketing unpublishes. The local download persists; the Agency may still use obsolete content.

Mitigation: by design (WF6 edge case 5). The P11 library only guarantees "currently listable", not "currently valid for use". Product team accepts this — clawback is out of scope for v1.

### 8.7 Hero-image / gallery attachment orphans on CaseStudy hard-delete

Risk: there is no CaseStudy hard-delete in v1, but if v2 adds one, attachment FKs would dangle.

Mitigation: soft-delete retains the FKs. Any future hard-delete (v2) must delete via the `attachments` module's `deleteByOwner(entity_type, entity_id)` helper to reclaim the underlying files. Documented as a v2 TODO comment in the migration.

---

## 9. Integration Test Coverage (Playwright)

### 9.1 CaseStudy create → hero + gallery upload → P7 list
- Seed: Agency A + PartnerAdmin.
- PartnerAdmin navigates P7 → clicks "Create Case Study" → P8 form.
- Uploads 1 hero image + 2 gallery images via attachments module.
- Fills narrative markdown fields, selects industry + country, tags 3 technologies + 2 services.
- Saves. Assert: row visible on P7 with "Draft" badge (no `may_publish_on_om_website`, no `published_url`).
- Assert emitted: `prm.case_study.created { agency_id: A.id }`.
- Assert attachment URLs render inline on P8 detail view (route-ACL passes for own Agency).

### 9.2 CaseStudy edit flow + Marketing-only field rejection
- Seed: Agency A's existing CaseStudy (from 9.1).
- PartnerAdmin updates `challenge_markdown` → save → assert `prm.case_study.updated` emitted with `published: false`.
- Attempt PUT with payload `{ may_publish_on_om_website: true }` → assert `422 ForbiddenField`.
- Assert diagnostic `prm.agency.admin_field_access_rejected` emitted.

### 9.3 Soft-delete blocked when published
- Seed: Agency A's CaseStudy with `may_publish_on_om_website = true` AND `published_url = 'https://openmercato.com/...'` (set by OM Marketing via B8 in test setup).
- PartnerAdmin calls `POST /delete` → assert `409 ExternalCouplingGuard` with the expected error message.
- Assert CaseStudy still has `deleted_at IS NULL`.
- OM Marketing unflags `may_publish_on_om_website = false` → retry delete → succeeds → `prm.case_study.deleted` emitted.

### 9.4 Undelete via restore
- Seed: Agency A's CaseStudy soft-deleted.
- PartnerAdmin calls `POST /restore` → assert `200` + `prm.case_study.restored` emitted.
- P7 list shows the row again.
- Attempt restore on a non-deleted CaseStudy → `409 NotInDeletedState`.

### 9.5 Marketing toggles `may_publish_on_om_website` on B8
- Seed: Agency A's CaseStudy.
- OM Marketing user on B8 flips `may_publish_on_om_website = true` via inline toggle → assert `prm.case_study.publication_flag_changed { may_publish_on_om_website: true, published_url: null }`.
- OM PartnerOps user attempts same → `403` (lacks `prm.case_study.toggle_publish`).
- OM Marketing sets `published_url = 'https://...'` while flag = true → OK; assert second `publication_flag_changed` event with URL populated.
- Attempt `published_url` set while flag = false → Zod refine fails → `422`.

### 9.6 Spec #5 P10 picker read contract (cross-spec)
- Seed: Agency A with 3 CaseStudies (1 soft-deleted), Agency B with 1 CaseStudy.
- Spec #5 test (linked by shared fixture `.ai/test-fixtures/spec5-spec7-casestudy-picker.json`) navigates Agency A's P10 picker.
- Assert: picker shows 2 rows (excludes soft-deleted + other-Agency).
- This spec's test: direct GET `/api/prm/portal/case-study?limit=10` from Agency A → asserts same 2 rows.

### 9.7 MarketingMaterial publish → P11 library refresh within TTL
- Seed: Agency A at `tier = ai_native`. Baseline P11 fetch → empty list, cached under `['prm:library', 'prm:agency:A:tier:ai_native']`.
- OM Marketing creates + publishes MarketingMaterial M (`min_tier = NULL` ⇒ visible to all partners).
- Assert `prm.marketing_material.published` fired → `MarketingLibraryPublishedInvalidator` runs → `cache.deleteByTags(['prm:library'])`.
- Re-fetch P11 → M appears. Assert cache was re-populated with M visible.

### 9.8 Tier-gated hide + tier-upgrade reveal
- Seed: Agency A at `tier = om_agency` (rank 1). OM Marketing publishes material N with `min_tier = ai_native_expert` (rank 3).
- Agency A fetches P11 → N not visible.
- Spec #1 admin upgrades Agency A to `ai_native_core` (rank 4). Emits `prm.agency.tier_changed`.
- `AgencyTierChangeLibraryInvalidator` fires → `cache.deleteByTags(['prm:agency:A:tier:*'])`.
- Agency A re-fetches P11 → N now visible.

### 9.9 Attachment 403 for non-tenant
- Seed: Agency A's CaseStudy with hero image. Agency B user in a different tenant authenticated.
- Agency B user GETs the hero-image URL directly → assert `403` from route ACL.
- Unauthenticated GET → `302` redirect to sign-in.

### 9.10 MarketingMaterial unpublish → library removal
- Seed: Published material M visible on Agency A's P11.
- OM Marketing unpublishes M.
- Assert `prm.marketing_material.unpublished` → `MarketingLibraryUnpublishedInvalidator` fires.
- Agency A re-fetches P11 → M gone.
- Agency A attempts `GET /api/prm/portal/library/M/download` → 404 (route re-checks publish state on redirect; closed window per §6.3).

### 9.11 Draft MarketingMaterial edit does not invalidate cache
- Seed: Draft MarketingMaterial D (not published yet). Cached library fetch for Agency A populates tag set.
- OM Marketing edits D's title → `prm.marketing_material.updated` fires.
- `MarketingLibraryUpdatedInvalidator` reads aggregate, sees `published_at IS NULL`, no-ops.
- Assert cache NOT invalidated — tag still present, same response served.

---

## 10. Final Compliance Report — Piotr Decision Library Checklist

| Rule | Status | Evidence |
|---|---|---|
| **Singularity law** — singular entity / command / event names | PASS | `case_study`, `marketing_material`, `CreateCaseStudyCommand`, `prm.case_study.created`. URLs plural per routing convention |
| **FK IDs only** across modules | PASS | `agency_id`, `client_industry_id`, `hero_image_attachment_id`, `primary_attachment_id`, `created_by_user_id` — all FK IDs; no entity imports from `directory` / `attachments` / `dictionaries` modules |
| **`organization_id` mandatory on scoped entities** | PASS | Both `case_study.organization_id` + `marketing_material.organization_id` NOT NULL |
| **Undoability by default** | PASS | Soft-delete ↔ restore, publish ↔ unpublish, flag toggle is its own inverse (§4.1) |
| **Zod validation on all API inputs** | PASS | §3 inputs are Zod objects with `.refine()` conditional constraints |
| **Events over direct imports** | PASS | Cross-module side effects via events only: `prm.marketing_material.published` → cache invalidator; `prm.agency.tier_changed` → this spec's invalidator |
| **Tenant isolation** | PASS | `/api/portal/...` resolves `agency_id` from session; portal list + detail endpoints never honor client-supplied `agency_id` |
| **Command Graph vs Compound Command** | PASS — Command Graph | Soft-delete + restore coupled by aggregate state (read-before-write); not a Compound |
| **Architectural Diff — no CRUD noise** | PASS | §3 enumerates only the custom actions (`/delete`, `/restore`, `/publication-flag`, `/publish`, `/unpublish`, `/download`); standard CRUD is one-liner table rows |
| **Undo Contract as detailed as Execute** | PASS | §4.1 pairs each command with its compensation; §9.4 + §9.10 test the round trips |
| **Module Isolation** | PASS | No direct imports from `attachments` / `dictionaries` internals — only public helper `buildAttachmentImageUrl`. Spec #5's P10 picker consumes via the documented read contract, not a direct entity import |
| **Additive BC** | PASS | §7 table — no renames, no narrowing. App Spec reconciliation backlog documented in §2 notes |
| **Domain invariants preserved** | PASS | #6 (admin-only field guard §3.1 + §6.2), #8 (published gate §5.1 `chk_published_url_requires_flag` + §3.3 refine + §3.2 soft-delete 409) |
| **Cagan business criteria bound to tests** | PASS | §9.1 (creation velocity precondition), §9.5 (Marketing handshake auditability), §9.7 + §9.8 (library freshness vs tier gate) |
| **No generic event-to-cache-bust router (OQ-019)** | PASS | §4.3 — four per-feature invalidator subscribers, each < 20 LOC |
| **Route-ACL over signed URLs (OQ-011)** | PASS | §6.3 — `buildAttachmentImageUrl` + route ACL; no TTL primitive introduced |
| **Dictionary seeds in own `setup.ts` (OQ-012)** | PASS | §5.3 — `topics` seed idempotent on install; countries/industries/services/technologies reused from Spec #1 |
| **v1 flag-on-PRM shortcut (OQ-008 deferred)** | PASS | §2, §8.1 — explicit; v2 ticket will replace with event-driven handshake |

**Spec verdict: READY FOR IMPLEMENTATION**. Est. 5 commits (point):

1. `case_study` entity + migration + portal P7 list + P8 rich form + portal-API CRUD + soft-delete/restore actions + route guard for Marketing-only fields. **(US2.2 + US2.3)**
2. B8 backend CaseStudies DataTable + `/publication-flag` action + `prm.case_study.toggle_publish` feature flag + RBAC wiring. **(US2.4)**
3. `marketing_material` entity + migration + B9 CrudForm + `/publish` + `/unpublish` + `topics` dictionary `setup.ts` seed. **(US7.1 + OQ-012)**
4. P11 Marketing Library portal custom list + `/api/prm/portal/library` GET + `/download` redirect + tier-gate filter + cache tags. **(US7.2 — portal-side)**
5. Four per-feature cache invalidator subscribers + Spec #5 read-contract integration test scaffolding + cross-spec fixture. **(OQ-019 + US7.2 reactive + cross-spec with Spec #5)**

---

## 11. Implementation Status

| Phase / Commit | Status | Date | Notes |
|---|---|---|---|
| C1 — CaseStudy entity + portal CRUD + soft-delete/restore + own-Agency picker | Done | 2026-05-07 | MarketingMaterial entity + migration shipped together (single auto-generated migration). 5 events added (`prm.case_study.{created,updated,deleted,restored,publication_flag_changed}`). Cross-spec close: `RfpService.upsertResponseDraft` replaces v1 cross-Agency reject with own-Agency lookup against `prm_case_studies` (3 new jest cases). 16 caseStudyService cases. |
| C2 — MarketingMaterial service + B9 backend admin | Done | 2026-05-07 | Service: create/update/publish/unpublish/delete/list/listPublishedForViewer (tier-gate-aware). 4 backend routes (list/POST + detail GET/PUT/DELETE + publish + unpublish). B9 list (DataTable) + new (CrudForm) + edit pages. 16 marketingMaterialService cases inc. tier gate quad. |
| C3 — B8 CaseStudy admin + topics dictionary seed | Done | 2026-05-07 | B8 list with inline publication-flag toggle. B8 detail page (read-only narrative + flag/url editor). Topics dictionary seeded idempotently from `lib/topicsDictionarySeed.ts`. 3 setup-seed jest cases. |
| C4 — P11 Marketing Library + tier gate | Done | 2026-05-07 | `/api/prm/portal/library` GET with facets; `min_tier` never exposed to portal viewer. `/[id]/download` re-checks publish state + tier gate before issuing the URL. P11 portal page custom React + faceted sidebar. tierRank.test.ts (4 cases). |
| C5 — Cache invalidators + portal P7/P8 + Spec #5 P10 picker | Done | 2026-05-07 | Four per-feature invalidators (published / unpublished / updated-only-when-published / agency.tier_changed); shared `lib/libraryCache.ts` helper. Portal P7 list + new + edit pages. Spec #5 P10 case-study picker (max 5 checkbox list) replaces the deferred message. POST-MVP `Spec #5 case-study picker` entry trimmed; spec #5 §11 status table updated. 8 invalidator cases. |
| Spec revision — visibility/audiences removed; allowed_roles[] added; topics UX upgraded | Pending | 2026-05-10 | Mid-implementation review trimmed the MarketingMaterial shape: dropped the `visibility` enum (collapses into `min_tier IS NULL ⇒ all partners`), dropped `audiences[]` (deferred to a future feature, tracked at [#42](https://github.com/matgren/oss-prm/issues/42)), added `allowed_roles[]` (jsonb of partner role slugs from `src/modules/prm/data/validators.ts` `ROLE_SLUGS`; empty ⇒ all roles within an at-tier agency). Cache stays tier-keyed; role gate applied post-cache by the route handler. Topics field UX: backend new/edit form switches from comma-separated text to a closed-list `TagsInput` backed by the topics dictionary (matches `caseStudyForm.tsx` pattern for technologies/services); data shape `topics: string[]` unchanged. Schema/code follow-ups: drop `visibility` column, drop `chk_tier_gated_requires_min_tier`, drop `audiences` column, add `allowed_roles JSONB NOT NULL DEFAULT '[]'`, replace the live-row index with `(published_at, min_tier_rank)`. |

### Run plan reference

`.ai/runs/2026-05-07-prm-spec-07-case-studies-marketing.md`

### Test surface summary

- **Unit (jest):** 33 suites, 309 tests across PRM. New for Spec #7: `caseStudyService.test.ts` (16), `marketingMaterialService.test.ts` (16), `setupTopicsDictionary.test.ts` (3), `tierRank.test.ts` (4), `marketingLibraryInvalidators.test.ts` (8); plus 3 cross-spec cases added to `rfpService.test.ts` exercising the own-Agency picker contract.
- **Integration (Playwright):** §9.1–§9.11 deferred to the customer-portal Playwright auth helper follow-up (same blocker as Spec #5). The local `--no-reuse-env` runner currently fails at the migration step before reaching Spec #7's surface — the failure is on Spec #5's pre-existing `prm_rfps_organization_fk → directory_organizations(id)` migration (`relation directory_organizations does not exist`), which suggests a cross-module migration ordering quirk rather than a Spec #7 regression. Once the helper + ordering is resolved, §9.1–§9.11 can land additively without any code change here.

### Cross-spec contracts shipped / closed

- **Closed:** Spec #5 §10 commit 3c case-study picker deferral. `RfpService.upsertResponseDraft` now performs an own-Agency ownership lookup against `prm_case_studies`; cross-Agency / soft-deleted ids → 400 `validation_failed` with `reason: 'case_study_ownership_failed'`. P10 portal renders a checkbox list (max 5) sourced from `GET /api/prm/portal/case-study?includeDeleted=false`. POST-MVP-FOLLOW-UPS entry trimmed.
- **New:** `prm.case_study.publication_flag_changed` (consumed v2 by external Marketing handshake; v1 OQ-008 shortcut emits only). `prm.marketing_material.{published,unpublished}` (consumed by per-feature cache invalidators). `prm.agency.tier_changed` (already shipped by Spec #1) gains a per-Agency cache invalidator subscriber.

---

*End of SPEC-2026-04-23-case-studies-marketing.*
