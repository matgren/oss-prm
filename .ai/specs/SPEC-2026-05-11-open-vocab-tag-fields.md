# SPEC-2026-05-11 — Open-Vocabulary Tag Fields (Agency + CaseStudy + RFP UX)

**Date**: 2026-05-11
**Status**: IMPLEMENTED
**Authors**: Mat (Marty Cagan, product brief) -> Piotr (om-cto, technical spec)
**Persona (review lens)**: Martin Fowler — staff-engineer architectural purity
**Estimated commits**: 6 (refined down from Mat's atomic estimate of 5; suggestion endpoint split for clearer review hygiene, see §7)

> **Amends**:
> - `SPEC-2026-04-23-agency-foundation.md` §3.1 + §5.1 — drops the "closed dictionary" invariant for `services` + `tech_capabilities`; `industries` stays closed.
> - `SPEC-2026-04-23-case-studies-marketing.md` §3.1 (CaseStudy tag-field policy) — flips `allowCustomValues` on `technologies_used` + `services_delivered`.
> - `SPEC-2026-04-23-rfp-broadcast-response.md` (§3.1 RFP draft form) — `required_capabilities` UX upgrade only; semantics + storage shape unchanged.
>
> **Does not amend**:
> - `SPEC-2026-04-23-rfp-scoring-selection.md` — eligibility/scoring code paths untouched (`rfpEligibility.ts` doesn't read capabilities; `llmScoringDraft.ts` is typo-tolerant).
> - `SPEC-2026-04-23-attribution-loop.md`, `SPEC-2026-04-23-wip-scoreboard.md`, `SPEC-2026-04-23-wic-ingestion.md` — no consumer of the affected columns.
>
> **App-spec edits**: `app-spec/app-spec.md` §1.4 — field-definition table for Agency Profile + Case Study + Dictionaries note (see §11 Inline Amendments).
>
> **Source brief**: `app-spec/mat-notes/2026-05-10-open-vocabulary-tag-fields.md` (Mat, 2026-05-10). All five "Open Questions for Piotr" are resolved in §10 of this spec; no escalation back to the user is needed beyond DRAFT → READY approval.

---

## 1. TLDR

`technologies` and `services` are currently closed-vocab dictionary-backed picklists. Agency partners can't describe capabilities that don't happen to be in the OM-curated seed (16 technologies, 10 services), which means the asymmetric cost ("email OM, wait, retry") exceeds the curated-taxonomy benefit. This amendment flips both fields to **open-vocab, per-agency, type-and-enter** on the Agency profile (B1 Status/Profile + P3 portal) and Case Study (P8). The RFP `required_capabilities` field — already free-form at the storage layer — gets the same UX upgrade (TagsInput with tenant-wide suggestions; OM-staff-only form, no cross-agency leak risk).

The change is **additive at the storage layer** (no migration: columns are already `jsonb` string arrays), **policy-only at the validator layer** (drop `z.string().uuid()` → free-form `z.string().trim().min(1).max(80)`), and **a single new internal API** (per-agency + tenant-wide tag suggestions). The closed dictionary for `industries` is preserved exactly as today. Eligibility/matching is unaffected — `rfpEligibility.ts` never read these fields; `llmScoringDraft.ts` is downstream of Spec #6 and typo-tolerant by design.

## 2. Goal + Non-Goals

### 2.0 Naming conventions (resolves m2)

Across this spec, three different identifiers refer to "tag arrays" depending on the surface:

| Surface | Identifier | Where it appears |
|---|---|---|
| User-facing label (UI) | `Technologies` / `Services` / `Required capabilities` | `t(...)` keys in CrudForm + TagsInput labels |
| Agency entity columns | `services` / `techCapabilities` (camelCase JS), `services` / `tech_capabilities` (snake_case DB) | `Agency` entity, `summariseAgency` DTO, `updateAgency*Schema` |
| CaseStudy entity columns | `technologiesUsed` / `servicesDelivered` (camelCase JS), `technologies_used` / `services_delivered` (snake_case DB) | `CaseStudy` entity, `createCaseStudySchema` |
| RFP entity column | `requiredCapabilities` (camelCase JS), `required_capabilities` (snake_case DB) | `Rfp` entity, `rfpDraftBase` |

When this spec writes `technologies` without qualification, it means the user-facing concept; when it writes `Agency.techCapabilities` or `CaseStudy.technologiesUsed`, it means the specific entity column.

### 2.1 Goals

1. Replace the closed-vocab `allowCustomValues={false}` UX on `technologies_used` + `services_delivered` (CaseStudy) with open-vocab type-and-enter chips.
2. Render the same two fields on the Agency profile in two places that don't currently render them:
   - Backend `/backend/prm/[id]/page.tsx` (Status + Profile tabs — currently the columns exist but no form input writes them; data is read-only via `summariseAgency`).
   - Portal `frontend/[orgSlug]/portal/agency/page.tsx` (P3 own-agency edit — currently reads `techCapabilities` + `services` into state but doesn't render them).
3. Provide a per-agency suggestion source so that on first load each form pre-populates autocomplete from the same agency's own historical slugs (own profile ∪ own case studies). No suggestions ever leak across agencies on portal surfaces.
4. Upgrade the RFP `requiredCapabilities` field UX from comma-text Input → TagsInput. Suggestion source = tenant-wide union of every agency's tech tags + every case study's tech tags (B-RFP is OM-staff-only, no leak risk). Storage shape and form-state translation must be migrated end-to-end (no comma-split on save).
5. Drop the validator enforcement of `z.string().uuid()` on `Agency.services` / `Agency.techCapabilities` (both backend and portal patch schemas).

### 2.2 Non-goals (explicit scope cuts, per Mat brief §1.4)

- ❌ No central tag-dictionary admin UI; no merge/rename/dedupe tool.
- ❌ No slug-lowercase / no-whitespace constraint at storage. Trim only; verbatim casing preserved.
- ❌ No backfill of existing case-study or RFP rows. Existing slugs continue to round-trip; they surface as suggestions naturally via read-distinct from rows.
- ❌ No change to `industries` (Agency or CaseStudy). Stays closed-dictionary.
- ❌ No change to `compliance_tags`, `regions`, `languages` dictionaries (not part of any form covered here).
- ❌ No deletion of the seeded `technologies` and `services` dictionary rows or seed code (`lib/technologiesDictionarySeed.ts`, `lib/servicesDictionarySeed.ts`). They remain on disk, called from `setup.ts`, and seed data continues to be created — but the forms no longer query them. Bounded-tech-debt rule per Matom proxy.
- ❌ No new LLM matching pipeline for eligibility. (None exists; capabilities aren't consumed by eligibility today.)

## 3. BC / Risk Analysis

### 3.1 Contract surfaces audited

Per `BACKWARD_COMPATIBILITY.md` § "Contract surface categories":

| Surface | Impact | Mitigation |
|---|---|---|
| **Entity columns** | Zero change. `agency.services`, `agency.techCapabilities`, `caseStudy.technologiesUsed`, `caseStudy.servicesDelivered`, `rfp.requiredCapabilities` are already `jsonb` arrays of free-form strings. No migration. | None needed. |
| **Validator schemas** | Three changes in one commit (§5.2 covers detail): **(1) Agency tag fields relax**: `updateAgencyBackendSchema` + `updateAgencyPortalSchema` element constraint loosens from `z.string().uuid()` → `z.string().trim().min(1).max(80)`. **(2) `slugStringArray` (CaseStudy) tightens**: gains `.trim()` so case-study writes normalise the same way as agency writes (prevents `'React'` vs `'  React  '` surfacing as separate autocomplete entries). **(3) RFP `required_capabilities` tightens**: from permissive `z.array(z.string())` to `openTagSlugArray` (trimmed, non-empty, ≤80 chars per element, ≤50 elements). All three changes add a `.max(50)` array cap to bound DOS/data-bloat. | BC: legacy uuid payloads on Agency still accept (`'<uuid>'` is a valid trimmed ≤80-char string). CaseStudy tightening is BC-safe in practice (UI never wrote whitespace-only values); RFP tightening rejects only payloads that were never user-reachable (B-RFP form emits trimmed non-empty strings already). Verified §5.2. |
| **API response envelope** | Zero change. Same field names, same shape (array of strings). The `summariseAgency` and CaseStudy DTOs already emit whatever strings are in the jsonb column. | None. |
| **Event payloads** | No event is emitted on tag-array changes today. No new event needed (the slugs are not subject to subscriber-driven side effects). | None. |
| **Cache keys** | `libraryCache.ts` tags the marketing library by topic slugs, not by capability slugs. No invalidator subscribes to these fields. | None. |
| **Eligibility / scoring** | `rfpEligibility.ts` reads only `tier` + `explicitAgencyIds`. `llmScoringDraft.ts` consumes response markdown for Spec #6 scoring — typo-tolerant. **Verified by grep across `src/modules/prm/lib`, `api`, `subscribers`, `workers`** (see §3.2). | None. |
| **Search indexing** | `search.ts` — `grep -n "techCapabilities\|services\|technologies" src/modules/prm/search.ts` returns no matches. The tag fields are not indexed. | None. |
| **Custom-fields / CE** | `ce.ts` registers nothing on these native columns. | None. |
| **Translations** | `translations.ts` — tag fields are slug arrays, not translated. | None. |
| **Notifications** | No notification fires on tag changes. | None. |
| **OpenAPI** | The new suggestion endpoint(s) ship `openApi` metadata per platform convention (every route MUST export `openApi`, see AGENTS.md). Existing routes unaffected. | New file ships matching pattern. |
| **i18n keys** | New keys added for the suggestion-endpoint failure flash + the TagsInput placeholder on B1 / P3 / B-RFP. Existing keys unchanged. | Additive. |
| **RBAC features** | New endpoints reuse existing features. Per-agency portal endpoint = `prm.agency.view` (mirrors the existing portal agency GET at `src/modules/prm/api/portal/agency/[id]/route.ts:82`). Per-agency backend endpoint = `prm.agency.read` (B1 driver). Tenant-wide backend endpoint = `prm.rfp.create` (OM-staff B-RFP gate). The earlier draft cited `portal.partner.access` for the per-agency portal endpoint — corrected after verifying the real GET handler's feature gate. | Established feature reuse. `acl.ts` verified — features `prm.agency.read`, `prm.agency.read_admin_fields`, `prm.agency.edit`, `prm.agency.edit_admin_fields` all exist; the `_admin_fields` variants gate sensitive contract/NDA columns and are NOT the right surface for read-side tag suggestions. |

### 3.2 Cross-spec dependency search

Grep across `.ai/specs/SPEC-2026-04-23-*.md`:

- **`SPEC-2026-04-23-attribution-loop.md`** line 228 — mentions `client_industry` as "dictionary key" for the Prospect entity. Industries stays closed; no impact.
- **`SPEC-2026-04-23-rfp-broadcast-response.md`** lines 135 / 138 / 293 / 296 — calls `industry` and `required_capabilities` "dictionary slug(s)". Storage shape doesn't change; the comment annotation in the spec text becomes outdated but is informational only. Documented via the inline amendment pointer (§11).
- **`SPEC-2026-04-23-wip-scoreboard.md`** line 670 — uses "dictionary" only in the i18n-locale sense ("locale dictionary at `i18n/en.json`"). False positive.
- **`SPEC-2026-04-23-rfp-scoring-selection.md`** — zero matches for the affected fields.
- **`SPEC-2026-04-23-wic-ingestion.md`** — zero matches for the affected fields.
- **`SPEC-2026-04-23-case-studies-marketing.md`** §5.3 — the `topics` dictionary seed is separate (a different field, `MarketingMaterial.topics`). Untouched. The case-study tag tags are covered by this amendment.

**Conclusion**: Beyond the three specs Mat flagged (agency-foundation, case-studies-marketing, rfp-broadcast-response), no other live spec consumes the closed-vocab invariant for these fields. Cross-spec validation is clean.

### 3.3 Storage-layer assumption checks

- `prm_agencies.services`, `prm_agencies.tech_capabilities`: `jsonb DEFAULT '[]'` (entities.ts:53–60). Already accepts any strings. ✓
- `prm_case_studies.technologies_used`, `prm_case_studies.services_delivered`: `jsonb DEFAULT '[]'` (entities.ts:1094–1100). ✓
- `prm_rfps.required_capabilities`: `jsonb DEFAULT '[]'` (entities.ts:555–557). The storage shape is `text[]` in the SPEC-2026-04-23-rfp-broadcast-response.md §3.1 documentation, but the entity uses `type: 'json'` — both serialise as a Postgres jsonb array of strings. Either way: no migration needed.
- No GIN indexes on these columns; deferred per agency-foundation §5.1 (queries today are point-id-IN filters, not contains-search). Still no need.

### 3.4 New risks introduced

1. **Case-handling is asymmetric — first-write wins on canonical casing, subsequent dupes are NOT case-insensitively deduped within the same agency.** Documented precisely so future readers don't assume otherwise:

   - **At read time** (suggestion endpoint): the `unique-preserving-first-casing` step in §5.1.1/§5.1.2 collapses the same string at different casings into the earliest one observed. So if an agency's history holds `'React'` (oldest) and `'react'` (newer), the autocomplete shows only `'React'`.
   - **At type-time** (`TagsInput` resolution against suggestions): typing `react` when `'React'` is in the suggestion set produces the chip `'React'` (canonical wins — `TagsInput.tsx:157` case-insensitively matches typed input against existing suggestions).
   - **At type-time with no matching suggestion**: typing `react` when no `React`/`REACT` chip exists yet adds verbatim `react` as a new tag.
   - **Same-field within one save**: `TagsInput.tsx:143` blocks duplicates via case-sensitive `includes` — so within a single save action, `'React'` and `'react'` typed in sequence would both land as separate chips on the chip list (the second wouldn't dedupe). On submit, both go to the DB; on next read, the suggestion endpoint collapses them, but the agency's saved row still holds two entries until they're manually cleaned.

   **Net behaviour**: a single agency might end up with both `'React'` and `'react'` in one tag array. The next page-load's autocomplete shows one. Cleanup is per Mat brief §1.2 — explicitly accepted, no admin tool. The LLM-tolerant matching layer (Spec #6) handles downstream scoring fine.

   **Test assertion (§8)**: AC-INV-8 — given `agency.techCapabilities = ['React', 'react']`, the per-agency suggestion endpoint returns exactly one entry `'React'` (the first-saved casing).

2. **Slug proliferation per agency** (separate from case-folding above): an agency could end up with semantic near-duplicates (`reactjs`, `react.js`, `React Native`). Mitigation: per Mat brief §1.2, accepted — the user explicitly rejected a cleanup tool. The agency self-curates. Spec #6 scoring is typo-tolerant.
3. **Cross-pollination invariant must not break**: when PartnerAdmin types `LangGraph` on Case Study A and then opens Agency Profile, autocomplete must include `LangGraph` (per US-T1 happy path step 6). This requires the per-agency suggestion endpoint to read from **both** `agency.techCapabilities` and the union of the agency's `caseStudy.technologiesUsed`. Tested in §8.
4. **Tenant-wide leak via the RFP suggestion endpoint**: if the route is misconfigured (e.g., wrong feature gate), a partner could observe other agencies' slugs. Mitigated by reusing the existing `prm.rfp.create` backend RBAC feature (OM-staff-only). No new feature key needed.

   **Sub-note (Nm1) on portal endpoint role admission**: both `partner_admin` AND `partner_member` hold the `prm.agency.view` feature (verified `src/modules/prm/setup.ts:50,80`). Both can therefore reach `GET /api/prm/portal/agency/[id]/tag-suggestions`. This is intentional — the endpoint is read-only, and `partner_member` legitimately needs autocomplete suggestions when viewing (e.g., reading the agency profile or case-study form in read-only state). Write paths (PATCH/POST) remain gated by `prm.agency.edit` (partner_admin only). AC-INV-1 covers the cross-AGENCY isolation guarantee; cross-ROLE access is correctly admissive.
5. **Legacy UUID-shaped values in existing rows (M4)**: today's `Agency.services` / `Agency.techCapabilities` validator required UUIDs (`dictionaryIdArray`). Whether any agency has ever held UUID-shaped strings is uncertain (no UI has written them; routes accept them in theory but no caller emits them). To future-proof: the suggestion endpoints filter values matching the UUID regex out of the candidate list before union (`§5.1.1` step 5; `§5.1.2` step 5). Cost: one regex test per element in a small array. Without this, an autocomplete chip rendering `'7a4b...'` would be a visible regression — far less surprising to filter at the source. **Note**: filtering at suggestion time does NOT remove the value from storage; if a future need arises (`grep`, audit), the underlying jsonb still holds the legacy UUIDs.
6. **`updateAgencyPortalSchema` schema relaxation on services / techCapabilities**: today the portal schema requires `z.string().uuid()` for elements; the form has no UI to send these values so the path is effectively unreachable today. Switching to `openTagSlugArray` opens the path. **Verification**: grep for "techCapabilities" / "services" in `src/modules/prm/api/portal/agency` — the existing portal PATCH route accepts the schema but the P3 form never sends these fields. No client breaks.

## 4. Data Model

**No entity changes. No migration.**

Confirmed by inspection of `src/modules/prm/data/entities.ts`:

| Column | Entity | Type | Already-jsonb-string-array? |
|---|---|---|---|
| `services` | Agency (53-57) | `jsonb` default `'[]'` | ✓ |
| `tech_capabilities` | Agency (59-60) | `jsonb` default `'[]'` | ✓ |
| `technologies_used` | CaseStudy (1094-1096) | `jsonb` default `'[]'` | ✓ |
| `services_delivered` | CaseStudy (1098-1100) | `jsonb` default `'[]'` | ✓ |
| `required_capabilities` | Rfp (555-557) | `jsonb` default `'[]'` | ✓ |

`industries` (Agency 53-54) is **unchanged** — stays closed-vocab.

## 5. API Contracts

### 5.1 New: tag suggestion endpoint(s)

**Decision (Open Question #1 resolved):** **two endpoints**, not one with a `?scope=` param.

Rationale:
- Per-agency endpoint and tenant-wide endpoint have **different RBAC gates** (`portal.partner.access` vs. `prm.rfp.create`), different scopes (agency-scoped vs. tenant-scoped query), and different cardinalities (~tens of slugs vs. ~hundreds). Combining them under one route would force the handler to branch on auth shape (customer auth vs. user auth) — two route files is simpler.
- This matches OM conventions (each handler is single-purpose, RBAC declared on `metadata` per-route).

#### 5.1.1 `GET /api/prm/portal/agency/[id]/tag-suggestions`

**Auth**: portal customer auth (`requireCustomerAuth`) + `requireCustomerFeature(['prm.agency.view'])` — mirrors the existing `/api/prm/portal/agency/[id]/route.ts` GET handler (line 82). (Earlier draft cited `portal.partner.access`; corrected — the per-agency GET pattern uses `prm.agency.view`.)

**Scope guard**: the route MUST enforce the same org-equality check the existing portal agency GET uses — there is **no `getCallerAgencyId` helper** in this codebase (earlier draft cited one that does not exist). The actual pattern at `src/modules/prm/api/portal/agency/[id]/route.ts:93`:

```ts
const agency = await agencyService.findById(params.id, { tenantId: auth.tenantId })
if (!agency) return 404
if (agency.organizationId !== auth.orgId) return 404  // tenant-scope guard
```

This is sufficient because the `prm_agencies_organization_uniq` DB constraint enforces 1-org → 1-agency (one customer org has at most one agency record per tenant). A `partner_admin` whose `auth.orgId` matches `agency.organizationId` is by construction a member of that agency — no separate `AgencyMember` lookup is needed. Return `404` (not `403`) on mismatch to match the existing route's leakage discipline (don't disclose existence).

**Query schema**:
```ts
const querySchema = z.object({
  field: z.enum(['technologies', 'services']),
})
```

**Response**:
```ts
{
  ok: true,
  items: Array<{ value: string, label: string }>  // value === label for free-form slugs
}
```

**Handler logic** (pseudocode — implementation phase will reify):
```
1. requireCustomerAuth + requireCustomerFeature(['prm.agency.view'])
2. agency = agencyService.findById(params.id, { tenantId: auth.tenantId })
   if !agency || agency.organizationId !== auth.orgId → 404
3. case studies = em.find(CaseStudy, {
       agencyId: agency.id,
       organizationId: agency.organizationId,   // CaseStudy has organization_id + agency_id, NOT tenant_id
       deletedAt: null
   })
4. if field === 'technologies':
     candidates = [...agency.techCapabilities, ...caseStudies.flatMap(cs => cs.technologiesUsed)]
   else (services):
     candidates = [...agency.services, ...caseStudies.flatMap(cs => cs.servicesDelivered)]
5. candidates = candidates.filter(s => !UUID_RE.test(s.trim()))   // M4: drop legacy UUID-shaped values from closed-vocab era
6. union = unique-preserving-first-casing(candidates)             // 'React' wins over later 'react'/'REACT' in the same agency's history
7. return items sorted alphabetically (case-insensitive, locale-aware)
```

> **Perf TODO (deferred)**: this materialises every non-deleted case study + its tag arrays into the JS heap. At v1 scale (≤ tens of case studies × ≤ tens of tags per agency) this is fine. If the agency-scoped row count crosses ~500, switch to Postgres `SELECT DISTINCT UNNEST(technologies_used) FROM prm_case_studies WHERE …` — one query, one column projection. Tracked in §14.

**Caching** (Open Question #2 resolved): **no read-through cache in v1.** Rationale:
- Per-agency union is small (typically <50 slugs even for prolific case-study authors).
- Query is two `findOne` + `find` calls on indexed columns (`agency_id`, `tenant_id`).
- Same pattern as `/api/prm/portal/dictionaries/[key]/entries` — uncached today, fine.
- Adding cache means adding invalidation (subscribers on every agency / case-study write). That's strictly worse churn for v1.
- If perf becomes an issue in v2, the existing `libraryCache.ts` pattern is the template (tag-based, with subscribers on writes).

**OpenAPI metadata**: required (every route). Follows the existing `openApi` shape on `/api/prm/portal/dictionaries/[key]/entries`.

#### 5.1.2 `GET /api/prm/tag-suggestions`

**Auth**: backend staff auth (`requireAuth: true`) + `requireFeatures: ['prm.rfp.create']` — same gate as B-RFP `/api/prm/rfp` POST.

**Query schema**:
```ts
const querySchema = z.object({
  field: z.literal('technologies'),  // services not exposed here in v1 — RFP only uses tech
})
```

**Why only `technologies`?**: the RFP form's `requiredCapabilities` field semantically corresponds to "technologies the responding agency must have." Per Mat brief §1.2 (RFP table row), this is the only tenant-wide need.

**Response**: same shape as 5.1.1.

**Handler logic**:
```
1. requireAuth + requireFeatures(['prm.rfp.create'])
2. agencies = em.find(Agency, { tenantId: auth.tenantId, status: 'active', deletedAt: null })
3. caseStudies = em.find(CaseStudy, {
       agencyId: { $in: agencies.map(a => a.id) },     // tenant-scoping via the Agency.id list — CaseStudy has no tenant_id column
       deletedAt: null
   })
4. candidates = [
       ...agencies.flatMap(a => a.techCapabilities ?? []),
       ...caseStudies.flatMap(cs => cs.technologiesUsed ?? []),
   ]
5. candidates = candidates.filter(s => !UUID_RE.test(s.trim()))   // M4 — drop legacy UUID-shaped values
6. union = unique-preserving-first-casing(candidates)
7. return items sorted alphabetically (case-insensitive, locale-aware)
```

**Caching**: same as 5.1.1 — none in v1. Tenant-wide query is still bounded (~hundreds of slugs at the user's known scale). The handler runs **once on B-RFP form mount**, not per-keystroke (see §6 standardised pre-load pattern), so the per-request cost is amortised across the entire form session.

> **Perf TODO (deferred)**: two `em.find` calls then JS flatMap. If tenant grows to thousands of case studies, switch to one Postgres query: `SELECT DISTINCT UNNEST(technologies_used) FROM prm_case_studies cs JOIN prm_agencies a ON cs.agency_id = a.id WHERE a.tenant_id = $1 AND cs.deleted_at IS NULL UNION SELECT DISTINCT UNNEST(tech_capabilities) FROM prm_agencies WHERE tenant_id = $1 AND deleted_at IS NULL`. Tracked in §14.

### 5.2 Validator changes

`src/modules/prm/data/validators.ts`:

**Before** (line 17):
```ts
const dictionaryIdArray = z.array(z.string().uuid()).default([])
```

**After**: the existing constant stays (still used by `industries`), and one new constant is introduced for open vocab:

```ts
const dictionaryIdArray = z.array(z.string().uuid()).default([])
// NEW — open per-agency vocab. Trim + non-empty + per-element max 80 chars + array cap with i18n key.
const openTagSlugArray = z
  .array(z.string().trim().min(1).max(80))
  .max(50, 'prm.errors.tagArrayTooLarge')   // NM2 — message arg threads through createCrudFormError → i18n
  .default([])
```

**Array cap rationale (M1):** `.max(50)` per array bounds DOS / data-bloat surface. Without it, a caller can POST 10K-element arrays of 80-char strings (~800KB request × 2 jsonb serialisations). 50 is well above realistic agency tag counts (the user's stated mental model is "type-and-enter as you remember capabilities" — agencies in the wild hold ≤ 30 distinct slugs in practice) and matches the loose end of OM's existing slug-array conventions (`gallery_attachment_ids.max(20)`, `attached_case_study_ids.max(5)`).

**Validator swaps**:

| Schema | Field | Before | After |
|---|---|---|---|
| `updateAgencyBackendSchema` (line ~52) | `services` | `dictionaryIdArray.optional()` | `openTagSlugArray.optional()` |
| `updateAgencyBackendSchema` (line ~53) | `techCapabilities` | `dictionaryIdArray.optional()` | `openTagSlugArray.optional()` |
| `updateAgencyPortalSchema` (line ~109) | `services` | `dictionaryIdArray.optional()` | `openTagSlugArray.optional()` |
| `updateAgencyPortalSchema` (line ~110) | `techCapabilities` | `dictionaryIdArray.optional()` | `openTagSlugArray.optional()` |
| `slugStringArray` (line 811, used by CaseStudy + MarketingMaterial — lines 829-830 + 930-945) | element shape | `z.string().min(1).max(80)` | `z.string().trim().min(1).max(80)` — M2 |
| `slugStringArray` (line 811) | array cap | none | `.max(50, 'prm.errors.tagArrayTooLarge')` — M2/M1 parity (NM2 wired) |
| `rfpDraftBase.required_capabilities` (line 564) | element shape + cap | `z.array(z.string()).default([])` (no min, no max, no trim, no cap) | `openTagSlugArray` (full pattern) — M6 |

**On the `industries` / `dictionaryIdArray` columns**: untouched. They remain `z.array(z.string().uuid())` because `industries` still resolves to dictionary row IDs.

**M2 motivation (trim parity + NM1 scope expansion)**: today `slugStringArray` does NOT `.trim()`. With `openTagSlugArray` adding `.trim()`, the two write paths would normalise differently — an agency that POSTs `'  React  '` on its profile saves `'React'`, but the same string on a case study saves `'  React  '` verbatim. The per-agency suggestion endpoint reads from both surfaces, so both `'React'` and `'  React  '` would surface as separate autocomplete entries. Tightening `slugStringArray` in the same commit avoids the asymmetry.

**Callsite audit (NM1)**: `slugStringArray` has **4** callsites:
- `createCaseStudySchema` line 829 — `technologiesUsed`
- `updateCaseStudySchema` line 830 — `servicesDelivered`
- `createMarketingMaterialSchema` line 930 — `topics`
- `updateMarketingMaterialSchema` line 945 — `topics`

The tightening (`.trim()` + array `.max(50)`) therefore also touches `MarketingMaterial.topics`. **BC for MarketingMaterial**: `topics` is a closed-vocab dictionary (Spec #7 §5.3) — entries are clean slug-format strings (`'webinar'`, `'case-study'`, etc.) with no whitespace and ≤ 20 entries per material. The tightening is safely a no-op for it; surfaces as a free benefit (whitespace-only or huge topic payloads now rejected for marketing material too). Tested by §8.2 validator unit tests (one MarketingMaterial case added).

**BC impact (CaseStudy)**: any existing case-study row whose tag array literally holds leading/trailing whitespace would now fail re-save. We're betting that no such rows exist (the form UI never let users type whitespace-only values, and the legacy dictionary entries had clean slugs). If a regression is detected during smoke, fall back to "normalise on read" in the suggestion handler (cheap escape hatch — strings get trimmed during the `unique-preserving-first-casing` step; not in v1 unless smoke shows it).

**M6 motivation (RFP tightening)**: `required_capabilities` is OM-staff-authored via B-RFP. The validator was permissive (`z.array(z.string())`) since B-RFP staff are trusted. But the field shape is the same as agency tags — and now TagsInput emits trimmed `≥1` strings client-side. Tightening server-side closes the gap (`'', '   ', huge-strings` no longer accepted) and lets the same regression test that covers `openTagSlugArray` cover RFP capabilities for free.

### 5.3 Existing route contracts: no shape changes, but element-validation tightens for RFP

| Route | Field validation change |
|---|---|
| `/api/prm/agency/[id]` PATCH | element relaxes (uuid → open slug). Still array shape. |
| `/api/prm/portal/agency/[id]` PATCH | element relaxes (uuid → open slug). |
| `/api/prm/portal/case-study/[id]` PUT, `/api/prm/portal/case-study` POST | element tightens (gets `.trim()`); array gets `.max(50)`. **BC verified** — see §5.2 M2 motivation. |
| `/api/prm/rfp` POST/PATCH | `required_capabilities` element tightens (`z.string()` → trimmed `.min(1).max(80)`); array gets `.max(50)`. **BC**: existing valid RFP drafts pass (trimmed, ≤ 80 chars per slug, ≤ 50 elements). The widening previously documented in this section ("only a relaxation") was wrong with respect to the M2/M6 additions — the spec now both relaxes Agency and tightens CaseStudy + RFP. |

All field names + array shapes are unchanged — only element-level rules adjust.

### 5.4 No deprecation of `/api/prm/portal/dictionaries/[key]/entries`

The existing dictionary endpoint stays. After this spec ships, the forms no longer call it for `services` / `technologies` — those calls move to the new suggestion endpoint. But the endpoint itself is **not deprecated** because:
- `industries` (Agency closed-dictionary) is still fetched from it.
- `topics` (MarketingMaterial closed-dictionary, Spec #7 §5.3) is still fetched from it.
- The whitelist (`PRM_DICTIONARY_KEYS = ['topics', 'industries', 'services', 'technologies']`) stays unchanged — the seeded `services` and `technologies` dictionaries continue to populate; they're just unused by the affected forms. Bounded tech debt per Matom.

## 6. UI Changes (diff sketches — no code in spec)

> **Pre-load standardisation (M3)**: all four surfaces (P8, P3, B1, B-RFP) load suggestions **once on form mount** via a single `apiCall`, then narrow case-insensitively client-side via `TagsInput`. None of them issue per-keystroke server calls. This matches P8's existing behaviour (static `suggestions={...}` after a one-shot fetch in `caseStudyForm.tsx`) and avoids the N+1 debounced loadOptions pattern the previous draft of this spec implied for B1/B-RFP. Rationale: per-agency arrays are small (< 50 elements), client-side filtering is instant, and the autocomplete bandwidth difference between fetch-once and fetch-per-keystroke is two orders of magnitude. Cache is unnecessary because each form session triggers exactly one server hit.

### 6.1 Backend B1 (`src/modules/prm/backend/prm/[id]/page.tsx`)

**Status tab (`statusSchema`)**: no change. Tier / status / contract / NDA / onboarded / partnershipStartDate stay as today.

**Profile tab (`profileSchema`)**: extend with two new fields, both type `tags` (CrudForm native `tags` field — confirmed available at `node_modules/@open-mercato/ui/src/backend/CrudForm.tsx:148`).

```
profileSchema gains:
  services:        openTagSlugArray.optional()         (mirrors the validator)
  techCapabilities: openTagSlugArray.optional()
```

**Pre-load pattern (M3 + NB1 fix):** fetch suggestions ONCE on tab mount via `useEffect`, store as `CrudFieldOption[]` in component state, then pass to the field definitions via the **`options`** prop (NOT `suggestions` — verified at `node_modules/@open-mercato/ui/src/backend/CrudForm.tsx:3698-3713`: the `'tags'` field reads `options` directly and only wires `loadSuggestions` to `TagsInput` when `loadOptions` is supplied; the `builtin?.suggestions` prop is consumed by `combobox` only). Going `options`-only (no `loadOptions`) means `TagsInput` never gets a per-keystroke `loadSuggestions` callback — client-side filtering only. Pseudo:

```ts
type CrudFieldOption = { value: string; label: string }
const [tagOptions, setTagOptions] = useState<{ services: CrudFieldOption[]; technologies: CrudFieldOption[] }>(
  { services: [], technologies: [] }
)

useEffect(() => {
  Promise.all([
    apiCall<{ ok: true; items: CrudFieldOption[] }>(`/api/prm/agency/${agencyId}/tag-suggestions?field=technologies`),
    apiCall<{ ok: true; items: CrudFieldOption[] }>(`/api/prm/agency/${agencyId}/tag-suggestions?field=services`),
  ])
    .then(([techRes, svcRes]) => setTagOptions({
      technologies: techRes.result?.items ?? [],
      services: svcRes.result?.items ?? [],
    }))
    .catch(() => { /* silent degrade — type-and-enter still works */ })
}, [agencyId])
```

CrudForm field config (the `useMemo` over `tagOptions` ensures CrudForm re-renders with new options when state populates):

```ts
const fields = useMemo<CrudBuiltinField[]>(() => ([
  // ... other Profile-tab fields
  {
    id: 'techCapabilities',
    label: t('prm.agencies.fields.techCapabilities', 'Technologies'),
    type: 'tags',
    options: tagOptions.technologies,   // STATIC array; no loadOptions = TagsInput skips per-keystroke loadSuggestions
    description: t('prm.agencies.fields.techCapabilities.help', 'Open vocabulary — type to add new.'),
  },
  {
    id: 'services',
    label: t('prm.agencies.fields.services', 'Services'),
    type: 'tags',
    options: tagOptions.services,
    description: t('prm.agencies.fields.services.help', 'Open vocabulary — type to add new.'),
  },
]), [tagOptions, t])
```

> **Why this works**: CrudForm's tag branch (line 3704) maps `options` → TagsInput's `suggestions` (the static client-side filter set). Line 3705-3712 wires `loadSuggestions` ONLY if `loadOptions` is a function. By passing static `options` without `loadOptions`, we get exactly the M3-target behaviour: one fetch on mount, zero fetches per keystroke, client-side narrow against the cached array.

> **Endpoint response shape adjustment**: the three suggestion endpoints already return `{ ok, items: Array<{ value, label }> }` (§5.1.1 response section). That shape IS `CrudFieldOption[]`. Implementer can wire `.result?.items` directly into `setTagOptions` with no remapping.

**Auth surface (OQ-#6 resolved)**: B1 is a backend (OM-staff) page, so it uses a **third backend-only suggestion endpoint** at `GET /api/prm/agency/[id]/tag-suggestions`. Auth: `requireAuth: true` + `requireFeatures: ['prm.agency.read']` (the same feature the existing backend agency GET uses). Handler shares logic with §5.1.1 (the function body can be factored into a shared helper in the implementation phase — three routes calling one library function).

`initialValues` and the submit-side payload mapping gain both fields. The submit handler passes them straight through (arrays).

Open Question #3 resolved: **CrudForm DOES ship a TagsInput field type** (`type: 'tags'`, native suggestions plumbing — verify exact prop name in implementation). No escape-hatch needed. The B1 Profile tab stays inside CrudForm.

### 6.2 Portal P3 (`src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx`)

Currently reads `techCapabilities` + `services` into `agency` state but renders **no inputs** for them. The form is hand-rolled (not CrudForm) — direct JSX with `<Input />` / `<Textarea />` / `<select>`. Extend the form state and JSX:

```
form state gains:
  technologies:    string[]
  services:        string[]
  techSuggestions: TagsInputOption[]     // M3 — pre-loaded once on mount
  svcSuggestions:  TagsInputOption[]     // M3 — pre-loaded once on mount

useEffect on agencyId resolution → Promise.all(two GETs to /api/prm/portal/agency/<id>/tag-suggestions?field=technologies|services)
→ silently degrade on failure (.catch(() => {}) — type-and-enter still works).

Two new <TagsInput /> blocks (the same primitive used by caseStudyForm.tsx today),
passed `suggestions={techSuggestions}` / `suggestions={svcSuggestions}` (static — TagsInput's `suggestions` prop is static
client-side filter set; per-keystroke `loadSuggestions` is only wired when supplied as a separate prop).
allowCustomValues={true} (or omitted — that's the TagsInput default).

Submit body gains:
  techCapabilities: form.technologies,
  services:         form.services,
```

> **Note on P3 vs B1 prop names**: P3 uses `<TagsInput />` directly, where `suggestions={TagsInputOption[]}` is the correct static-filter prop (the primitive's native API). B1 uses CrudForm's tag field type, where `options={CrudFieldOption[]}` is the correct prop (CrudForm internally maps `options` to TagsInput's `suggestions`). Same semantic — different wrapper conventions.

The existing `partner_member` read-only ACL is preserved automatically: the entire form is gated by the `agency._prm?.status === 'historical'` check + the portal-side `ApiInterceptor` on PATCH; `partner_member` lacks the `portal.prm.agency.write` feature so the route rejects 403. No new gate needed.

### 6.3 Portal P8 — Case Study form (`caseStudyForm.tsx`)

**Already follows the static pre-load pattern (M3 baseline)** — `useEffect` on mount populates `suggestions={...}` state, narrows client-side. The two surgical changes:

1. `fetchDictionaryEntries('technologies' | 'services')` (line 62) is **replaced** with a call to the new per-agency portal suggestion endpoint. New helper:
   ```
   async function fetchAgencyTagSuggestions(
     agencyId: string,
     field: 'technologies' | 'services'
   ): Promise<TagsInputOption[]>
   ```
   It hits `/api/prm/portal/agency/<agencyId>/tag-suggestions?field=<field>` directly. Returns the same `TagsInputOption[]` shape so the call sites at lines 98-102 don't change.

   **Nm2 cleanup — single GET, not double**: the earlier draft proposed resolving caller agency via `/api/prm/portal/me` first, then calling the suggestion endpoint. That's wasteful — `caseStudyForm.tsx` already has the agency id in scope (the form is rendered inside a route that resolves it from `useTenantContext` / the case-study record). Drop the `/api/prm/portal/me` round-trip; pass the agency id as an argument to the helper from the existing form context. One GET per field, two GETs per form open.
2. The two `<TagsInput />` blocks at lines 243-250 and 255-262 change `allowCustomValues={false}` → `allowCustomValues={true}` (or remove — same default).

The silent-degrade `.catch(() => {})` at line 104 stays — if the suggestion endpoint fails the form still works (degraded UX: no autocomplete chips, but type-and-enter still functions because `allowCustomValues=true`).

### 6.4 Backend B-RFP (`rfpFormConfig.tsx`)

The `requiredCapabilities` field at lines 360-367 is currently `type: 'text'` with a `description` telling the user to comma-separate. Change to `type: 'tags'` (CrudForm native) with **static `options` pre-load (M3 + NB1 fix)** — one fetch on form mount, zero per-keystroke server calls:

```ts
// In the parent component (or wherever rfpFormConfig is hydrated for a session):
const [capabilityOptions, setCapabilityOptions] = useState<CrudFieldOption[]>([])

useEffect(() => {
  apiCall<{ ok: true; items: CrudFieldOption[] }>('/api/prm/tag-suggestions?field=technologies')
    .then(res => setCapabilityOptions(res.result?.items ?? []))
    .catch(() => { /* silent degrade */ })
}, [])

// Field definition consumes the static array via `options` (NOT `suggestions`):
{
  id: 'requiredCapabilities',
  label: t('prm.rfp.fields.requiredCapabilities', 'Required capabilities'),
  type: 'tags',
  options: capabilityOptions,   // CrudForm wires this to TagsInput's `suggestions` (static); no loadOptions = no per-keystroke fire
  description: t(
    'prm.rfp.fields.requiredCapabilities.help',
    'Suggestions from the network — type to add new.',
  ),
},
```

**Coordinated form-state changes (Nm3 reminder)** — these must land together in commit 6, not piecemeal, or `rfpFormSchema.parse(...)` will reject the literal `''` from `RFP_FORM_INITIAL`:

| Identifier | Before | After |
|---|---|---|
| `rfpFormSchema.requiredCapabilities` (line 47) | `z.string().optional()` | `z.array(z.string()).default([])` |
| `RFP_FORM_INITIAL.requiredCapabilities` | `''` | `[]` |
| `rfpToFormValues` (line 128) | `rfp.requiredCapabilities.join(', ')` | `rfp.requiredCapabilities` (passthrough array) |
| `rfpFormValuesToPayload` (line 140) | comma-split | `values.requiredCapabilities` (already array) |
| `rfpFormValuesToPatchPayload` (line 180) | comma-split | `values.requiredCapabilities` (already array) |

All five identifiers change in the same commit.

**Form-state schema (`rfpFormSchema`, line 47)**: `requiredCapabilities: z.string().optional()` becomes `requiredCapabilities: z.array(z.string()).default([])`.

**`RFP_FORM_INITIAL`**: `requiredCapabilities: ''` becomes `requiredCapabilities: []`.

**`rfpToFormValues` (line 128)**: `rfp.requiredCapabilities.join(', ')` becomes `rfp.requiredCapabilities` (passthrough array).

**`rfpFormValuesToPayload` (line 140)** and **`rfpFormValuesToPatchPayload` (line 180)**: drop the comma-split — `required_capabilities: values.requiredCapabilities` (already an array).

**Open Question #4 resolved (saved-draft compat)**: existing saved RFP drafts have `requiredCapabilities: string[]` on the DB side (the server-side validator was always `z.array(z.string())`). The comma-split lived only in the form-state translator. Re-loading a saved draft after the form-state change works correctly because `rfpToFormValues` now passes the array straight through. No data migration. Verified by reading `validators.ts:558`.

### 6.5 Out-of-scope UI surfaces (explicit no-ops)

- `B7` RFP show / list pages — read-only renderings of the same `requiredCapabilities` array. They emit `{requiredCapabilities.join(', ')}` for display, which works identically with the new shape.
- `B8` CaseStudy backend admin — does not edit tags (it edits the publication flag). Untouched.
- `B-Agency` create page (`src/modules/prm/backend/prm/new/page.tsx` or equivalent) — `createAgencySchema` does not include tag fields by design (Spec #1 §1.3.2: profile fields are partner-side, not OM-staff-side). Untouched.

## 7. Atomic Commit Plan (Phase 1 — ship together)

Mat estimated ~5 commits; I refine to **6** for sharper review hygiene (suggestion endpoints split by auth surface, since they live under different RBAC features).

**Phase 1 — Open-vocab tag fields** (single phase per Mat §8 — no partial-ship value; cross-pollination promise must land atomically).

| # | Title | Files | Test surface |
|---|---|---|---|
| 1 | `refactor(prm/validators): open-vocab Agency + array caps + RFP/CaseStudy trim tightening` | `data/validators.ts` — add `openTagSlugArray` (trim, min(1), max(80), array max(50)); add `.trim()` + `.max(50)` to `slugStringArray`; replace RFP `required_capabilities` with `openTagSlugArray`; swap on Agency backend + portal schemas. | Jest unit tests in §8.2: BC for Agency, tightening for CaseStudy + RFP. |
| 2 | `feat(prm): portal tag-suggestion endpoint (per-agency union)` | NEW `api/portal/agency/[id]/tag-suggestions/route.ts` + i18n keys + shared helper for the union-and-filter logic. | Integration spec §8.1 blocks 1, 2, 4, 5, 6. |
| 3 | `feat(prm): backend per-agency tag-suggestion endpoint (B1 driver)` | NEW `api/agency/[id]/tag-suggestions/route.ts` (staff auth, `prm.agency.read`) — calls the same shared helper from commit 2. | Integration spec §8.1 (re-uses block-1 assertions under staff auth). |
| 4 | `feat(prm): backend tenant-wide tag-suggestion endpoint (B-RFP driver)` | NEW `api/tag-suggestions/route.ts` (staff auth, `prm.rfp.create`) — tenant-scoping via Agency join. | Integration spec §8.1 block 3. |
| 5 | `feat(prm/portal): P8 case-study tags become open-vocab` | `frontend/[orgSlug]/portal/case-studies/caseStudyForm.tsx` — swap suggestion source from dictionary endpoint to new per-agency portal endpoint; `allowCustomValues=true`. | Manual smoke (§8.4 step 2). |
| 6 | `feat(prm/portal+backend): P3 own-agency + B1 Profile + B-RFP capabilities → TagsInput` | `frontend/[orgSlug]/portal/agency/page.tsx` (P3 hand-rolled form gets two TagsInput blocks with static pre-load) + `backend/prm/[id]/page.tsx` (B1 Profile tab extends profileSchema + static pre-load `useEffect`) + `backend/prm/rfp/_shared/rfpFormConfig.tsx` (TagsInput swap + array round-trip in translators) + Playwright spec `__integration__/TC-PRM-OPEN-VOCAB-TAGS-001.spec.ts`. | Playwright spec §8.1 covers HTTP/RBAC/isolation. Manual smoke §8.4. |

Each commit is independently revertable. Commit order is now: **validators (1) → endpoints (2-4) → UI (5-6)**. The validator commit lands first so any concurrent runtime activity between merge and rollout sees consistent validation rules (no window where a UI ships a payload the validator still rejects). Commits 2-4 ship the read endpoints; commits 5-6 wire the UI. Reverting 5-6 leaves backend intact (forms degrade to closed-vocab); reverting 1-4 reverts UI too (forms fail fast on validator).

## 8. Test Strategy

**Open Question #5 resolved**: **one Playwright integration spec for the per-agency boundary invariant + tenant-wide endpoint behaviour**, plus targeted Jest unit tests on validators (BC + tightening).

> **Test-shape rationale**: this change introduces three new HTTP routes with RBAC + cross-tenant isolation requirements. That's an HTTP+DB+RBAC integration concern — the appropriate test layer is Playwright `__integration__/` (the rebuilt tenant-per-spec suite under SPEC-2026-05-09b, live at `src/modules/prm/__integration__/`). The validator changes are pure schema-level — Jest unit tests cover them. **No e2e UI Playwright** is added: the form changes are mechanical (state-shape swap + TagsInput wiring); no bug class surfaces in UI that isn't already caught by the route-level test + manual smoke. This honours the user's standing rule against defaulting to e2e UI Playwright.

### 8.1 New Playwright integration spec — M7 + NB2

**File**: `src/modules/prm/__integration__/TC-PRM-OPEN-VOCAB-TAGS-001.spec.ts`

**Fixture**: tenant-per-spec per SPEC-2026-05-09b (composes `@open-mercato/core/helpers/integration/*` + `src/modules/prm/testing/integration/*`). Bootstraps a fresh tenant via the `mercato test:bootstrap-tenant` CLI subprocess pattern.

**NB2 fixture limitation — known upstream gap.** `bootstrap-test-tenant.ts` does NOT currently fire PRM's `onTenantCreated` hook, so `partner_admin` / `partner_member` CustomerRoles aren't seeded in worker tenants. All existing PRM portal smoke specs (`TC-PRM-PORTAL-AGENCY-001.spec.ts` and 6 siblings) ship as `test.skip` with this exact root cause documented. This spec follows the same convention:

- **Blocks that require `partner_admin` auth** → ship as `test.skip` with the existing portal-spec comment template. They get un-skipped in a follow-up commit when the upstream fixture seeding lands (tracked as a dependency, not blocking this spec).
- **Blocks that can prove the same behaviour via staff-auth-reachable surfaces** → run live against the backend per-agency endpoint (`/api/prm/agency/[id]/tag-suggestions`, `prm.agency.read`) and the tenant-wide endpoint (`/api/prm/tag-suggestions`, `prm.rfp.create`). The shared helper (§13: `lib/tagSuggestions.ts`) means both endpoints exercise the same code path that the portal route uses — proving union/UUID-filter/casing logic via staff auth is equivalent at the library layer.

**Live blocks (run on current fixture):**

| # | Block | Auth | Setup | Assert |
|---|---|---|---|---|
| 3 | tenant-wide RFP suggestions (AC-INV-6) | OM staff, `prm.rfp.create` | Tenant T1, agencies A + B. A: `techCapabilities = ['React']`, case study with `technologiesUsed = ['LangGraph']`. B: `techCapabilities = ['Vue']`, case study with `technologiesUsed = ['TensorFlow']`. | `GET /api/prm/tag-suggestions?field=technologies` → items value-set `{ 'LangGraph', 'React', 'TensorFlow', 'Vue' }` (sorted case-insensitive). |
| 5 | first-write-wins casing (AC-INV-8, M5) | OM staff, `prm.agency.read` | Tenant T2, agency A with `techCapabilities = ['React', 'react']` (in that order). | `GET /api/prm/agency/A/tag-suggestions?field=technologies` → items contain exactly one entry, value `'React'` (`unique-preserving-first-casing`). |
| 6 | legacy UUID filter (AC-INV-9, M4) | OM staff, `prm.agency.read` | Tenant T3, agency A with `techCapabilities = ['7a4b8c9d-1234-5678-9abc-def012345678', 'GoLang']`. | `GET /api/prm/agency/A/tag-suggestions?field=technologies` → items value-set `{ 'GoLang' }`. UUID filtered out. |
| 7 | max-array cap (AC-INV-7, M1) | OM staff, `prm.agency.edit_admin_fields` (or whichever feature gates backend agency PATCH) | Tenant T4, agency A. | `PATCH /api/prm/agency/A` with `techCapabilities = [...51 strings]` → **400** with Zod validation error message containing `prm.errors.tagArrayTooLarge` (or whichever key is wired). |
| 8 | RFP capabilities tightening (AC-VAL-3, M6) | OM staff, `prm.rfp.create` | Tenant T5. | `POST /api/prm/rfp` with `required_capabilities: ['', '  ', 'x']` → **400**. `required_capabilities: ['x', 'y', ...51 entries]` → **400**. `required_capabilities: ['LangGraph', 'PyTorch']` → **200**. |

**Skipped blocks (test.skip; un-skip when fixture lands):**

| # | Block | Auth (when un-skipped) | Setup | Assert |
|---|---|---|---|---|
| 1 | per-agency portal union (AC-INV-2 portal path) | `partner_admin` of A | Tenant T1 from block 3 reused | `GET /api/prm/portal/agency/A/tag-suggestions?field=technologies` → items value-set `{ 'LangGraph', 'React' }` (proves the portal endpoint reads via shared helper and respects org-scoping). |
| 2 | cross-agency isolation via portal (AC-INV-1 portal path) | `partner_admin` of B | as block 1 | Same endpoint targeting agency A → **404** (the route returns 404 not 403 per scope-guard discipline). |
| 4 | cross-pollination live via portal (AC-INV-2) | `partner_admin` of A | block 1, then save case study with `technologiesUsed = ['MLflow']` via portal case-study POST | Re-call block-1 endpoint → items now contain `'MLflow'`. |

Skip comment template (one source of truth, applied to each `test.skip(...)` block):

```ts
// Skipped: bootstrap-test-tenant.ts does not currently fire PRM's onTenantCreated
// hook in worker tenants, so the partner_admin CustomerRole is not seeded and the
// portal auth path cannot be exercised. Un-skip when SPEC-2026-05-09b's upstream
// fixture seeding is completed (matches the test.skip pattern used by
// TC-PRM-PORTAL-AGENCY-001 and siblings).
```

**Why Playwright over Jest-with-real-DB**: the suite already encodes the tenant-per-spec bootstrap + auth/feature-grant scaffolding. Re-implementing in Jest would duplicate `src/modules/prm/testing/integration/*` for no isolation benefit. Test SHAPE is API-integration (Playwright `request` fixture, not browser `page`) — honours the user's standing rule against defaulting to e2e UI Playwright.

**Coverage rationale**: live blocks (3, 5, 6, 7, 8) prove the shared helper logic + the validator at all enforcement points. The skipped blocks (1, 2, 4) add no NEW behavioral coverage — they re-prove via the portal auth surface what the live blocks already prove via staff auth. Their value is **demonstrating the portal endpoint composes correctly with `requireCustomerAuth` + `requireCustomerFeature(['prm.agency.view'])` + the org-equality scope guard**, which is currently unprovable in CI but will become provable once the fixture lands. Scaffolding them now avoids spec churn at un-skip time.

### 8.2 Jest unit tests (validators)

Cases on `src/modules/prm/data/__tests__/validators.test.ts` (or the existing PRM unit-test file — implementer locates exact path):

- **BC for Agency**: `updateAgencyBackendSchema` accepts both `services: ['7a4b...uuid']` (legacy payload, still valid because UUIDs are ≤80-char trimmed strings) AND `services: ['LangGraph']` (free-form). Same for `updateAgencyPortalSchema`.
- **Tightening for CaseStudy (M2)**: `createCaseStudySchema` rejects `technologiesUsed: ['  ']` (whitespace-only after trim), rejects `technologiesUsed: [...51 strings]` (over array cap, with i18n key `prm.errors.tagArrayTooLarge` surfaced).
- **Tightening for MarketingMaterial (NM1)**: `createMarketingMaterialSchema` + `updateMarketingMaterialSchema` reject `topics: ['  ']` and `topics: [...51 strings]`. Establishes the scope expansion is covered.
- **Tightening for RFP (M6)**: RFP create rejects `required_capabilities: ['']` (empty after trim), rejects `required_capabilities: [...51 strings]` with i18n-key error.

### 8.3 No per-form unit tests for the UI changes

Per the bounded-tech-debt rule. The form-state changes are mechanical; a regression here surfaces immediately in either §8.1's HTTP-level assertions (round-trip) or §8.4 manual smoke (one minute of human verification). Adding component-level Jest tests for `caseStudyForm.tsx` doesn't catch a bug class that integration doesn't.

### 8.4 Manual smoke checklist (post-merge)

1. PartnerAdmin opens P3, types `LangGraph` into Technologies, saves. Re-opens form → `LangGraph` is a chip; autocomplete shows it on retype.
2. Same PartnerAdmin opens P8 (new case study), types `Lang` in Technologies → autocomplete suggests `LangGraph`.
3. OM staff opens B-RFP, types `Lang` in Required Capabilities → autocomplete suggests `LangGraph` (tenant-wide).
4. OM staff opens B1 (Agency A), Profile tab → sees the two new fields populated with current values; can save edits.
5. Edge case smoke (case-handling per M5): PartnerAdmin types `React`, saves, then on the next open types `react` → chip resolves to `React` (canonical wins); types `REACT` while no prior `React` exists yet → chip is `REACT` (verbatim, first-write-wins).
6. Edge case smoke (array cap per M1): PartnerAdmin attempts to add a 51st technology chip → save fails with a user-visible validation error referencing the 50-tag limit. (Add to i18n: `prm.errors.tagArrayTooLarge`.)

## 9. Rollback Strategy

The change is **purely additive at the storage and contract layer**. Rollback paths:

1. **Revert all 6 commits**: storage is fine (slugs already there). Forms revert to closed-vocab. Validator tightens back to uuid. Risk: any free-form slugs entered between merge and revert will fail uuid validation on the next save. Mitigation: an emergency `sed` migration to delete the offending rows, OR a hotfix that drops the validator tightening only.
2. **Revert UI commits only (4-6) leaving backend (1-3)**: forms revert to closed-vocab, but the suggestion endpoints stay reachable and the validator stays loose. Stable intermediate state.
3. **Disable the new suggestion endpoints only**: forms degrade gracefully to no-suggestions (per the existing `.catch(() => {})` in caseStudyForm.tsx:104-107 — same pattern propagated to the other forms). User types blind, save still works because the validator and storage accept anything.

The graceful-degrade path (option 3) is the answer to Mat's §10 spec-deviation question about "what if the suggestion endpoint times out" — already covered in US-T3 failure path. No new logic needed; the existing `silently-degrade` pattern is the contract.

## 10. Open Questions

### 10.1 Resolved (Mat's five)

| # | Question | Resolution (location in spec) |
|---|---|---|
| 1 | Suggestion API shape — one endpoint with `?field=...` or two? | **Two endpoints, two RBAC gates.** §5.1. Per-agency portal endpoint + tenant-wide backend endpoint live under different auth surfaces; combining would muddy the handler. |
| 2 | Suggestion API caching strategy. | **No cache in v1.** §5.1. Small arrays, indexed columns; cache adds invalidation churn for no measurable win. v2 may revisit via `libraryCache` pattern. |
| 3 | CrudForm TagsInput support — does it ship? | **Yes — `type: 'tags'` native, `loadOptions` plumbing already present** (CrudForm.tsx:148, 3698-3713). No escape-hatch needed. B1 Profile tab stays inside CrudForm. §6.1. |
| 4 | RFP form-state translator migration — saved drafts? | **No data migration needed.** Saved RFP drafts already have `requiredCapabilities: string[]` server-side (validator was always `z.array(z.string())`). The comma-split lived only in the form-state translator. Round-trip post-deploy works. §6.4. |
| 5 | Test surface — single integration spec or per-form units? | **One integration spec for the per-agency boundary invariant**, plus two targeted validator-tightening regression tests. §8. |

### 10.2 New (surfaced during spec drafting + adversarial review)

| # | Question | Resolution |
|---|---|---|
| 6 | The B1 Profile tab (backend, OM-staff) needs a tag-suggestion source. Reuse the portal endpoint with staff auth? Or ship a third backend-only route? | **Ship a third backend-only route**, `GET /api/prm/agency/[id]/tag-suggestions`, gated on `prm.agency.read`. Same handler logic as the portal route (extracted into a shared library helper that all three routes call); different auth surface. Listed in §7 commit 3. Rationale: OM convention is single-purpose routes per auth surface. (Adversarial review pushed back on whether `prm.agency.read` was too broad — verified against `src/modules/prm/acl.ts`: features are `prm.agency.read`, `prm.agency.read_admin_fields`, `prm.agency.edit`, `prm.agency.edit_admin_fields`. The `_admin_fields` variants gate sensitive columns like contract status, not tag arrays. `prm.agency.read` is the correct gate.) |
| 7 | When PartnerAdmin removes a chip from their profile, does the suggestion list update on next page load? | Yes — the suggestion endpoint is read-distinct from saved rows on every call. No cache. The user-facing behavior matches US-T2 (typo disappears when last referent removed). Soft-deleted case studies are excluded via `deletedAt: null` filter; restoring a soft-deleted case study re-introduces its tags to the suggestion union (round-trip behaviour, mentioned in AC-INV-3). |
| 8 | (Surfaced by adversarial review M5.) Within one save action, can a user end up with both `'React'` and `'react'` chips in the same agency's tag array? | Yes — `TagsInput` enforces case-sensitive `includes` duplicate-blocking within a single form session (`TagsInput.tsx:143`), so a user can type both casings and both chips appear. On save, the array stores both. On next page load, the suggestion endpoint collapses them to one via `unique-preserving-first-casing`. Documented precisely in §3.4 risk #1 + AC-INV-8. This is intentional ("verbatim casing preserved" per Matom proxy lesson) — the user has not asked for case-insensitive deduplication; Spec #6 LLM scoring is downstream and case-tolerant. |

No open questions remain that require user judgment. DRAFT can advance to READY after standard pre-flip adversarial review per Memory rule.

## 11. Inline Amendments to Parent Specs

Done atomically with this commit (the spec file is the durable source-of-truth; the parent specs only get a header pointer):

1. `.ai/specs/SPEC-2026-04-23-agency-foundation.md` — 2-line pointer at the top under the existing reconciliation block.
2. `.ai/specs/SPEC-2026-04-23-case-studies-marketing.md` — same.
3. `.ai/specs/SPEC-2026-04-23-rfp-broadcast-response.md` — same.
4. `app-spec/app-spec.md` §1.4 — inline edits to the Agency Profile + Case Study field-definition table (lines 224, 232, 238, 242) + a note in the Dictionaries paragraph that the `services` + `technologies` dictionary seeds are inert for these forms but kept for `industries` + `topics` (which still consume them).
5. `app-spec/app-spec.md` §3 Master Data Plan (around line 1343, "tech_capabilities" / "services" dictionary rows) — annotate that these two dictionaries are inert with respect to the affected forms post-this-spec; rows remain seeded for non-form-consumer paths (e.g., any future read-side analytics that wants the curated set). Per adversarial review m1.

The pointers do not rewrite the parent spec content. The parent spec's original text remains, marked as superseded by this spec for the affected passages.

## 12. Acceptance Criteria

### 12.1 Domain invariants (Vernon-style)

- [ ] **AC-INV-1**: Per-agency tag suggestions never leak across agencies on portal surfaces. (Tested in §8.1 block 2 — 404 returned on cross-agency probe.)
- [ ] **AC-INV-2**: A slug saved on Agency A's profile appears in Agency A's case-study autocomplete on the next page load, and vice versa (cross-pollination promise). (Tested in §8.1 block 4.)
- [ ] **AC-INV-3**: A slug deleted from the last row that referenced it disappears from autocomplete on the next page load. Soft-deleted case studies' tags are excluded; restoring a soft-deleted case study re-introduces them (read-distinct via `deletedAt: null` filter; round-trip behaviour falls out of the no-cache decision).
- [ ] **AC-INV-4**: Legacy seeded-dictionary slugs (`react`, `aws`, etc.) saved before this spec continue to round-trip on save without rename or normalization. (Verbatim casing per Matom resolution.)
- [ ] **AC-INV-5**: `industries` (Agency, CaseStudy) remains closed-dictionary. The `/api/prm/portal/dictionaries/[key]/entries` endpoint continues to serve it.
- [ ] **AC-INV-6**: The tenant-wide tag-suggestion endpoint (`GET /api/prm/tag-suggestions`) is reachable only by users with `prm.rfp.create`. (Tested in §8.1 block 3.)
- [ ] **AC-INV-7**: Tag arrays at write-time cap at 50 elements; the 51st element triggers Zod validation `400`. (M1 — tested in §8.1 block 7.)
- [ ] **AC-INV-8**: When an agency's tag array holds `['React', 'react']` (saved in that order), the per-agency suggestion endpoint returns exactly one entry `'React'` (`unique-preserving-first-casing`). Same-field same-save casing duplicates land in storage; suggestion endpoint collapses on read. (M5 — tested in §8.1 block 5.)
- [ ] **AC-INV-9**: Legacy UUID-shaped values present in `agency.services` / `agency.techCapabilities` from the closed-vocab era are filtered out of suggestion endpoint responses. (M4 — tested in §8.1 block 6.)

### 12.2 Business criteria (Cagan-style, lifted from Mat brief §8)

- [ ] **AC-BIZ-1**: A new PartnerAdmin can describe a capability missing from the OM seed (`LangGraph`) without contacting OM staff. (US-T1.)
- [ ] **AC-BIZ-2**: An OM Partnership Manager can draft an RFP using language that maps to real agency capabilities (tenant-wide suggestions surface the actual vocabulary). (US-T3.)
- [ ] **AC-BIZ-3**: TagsInput's whitespace-only / empty-string entry is rejected client-side (existing TagsInput behavior — verify it still works after the swap).
- [ ] **AC-BIZ-4**: Existing case-study rows with seeded-dictionary slugs continue to save without rename. (US-T4.)
- [ ] **AC-BIZ-5**: RFP edit page round-trips arrays that were saved when the form was still comma-text. (§6.4.)

### 12.3 Validator BC + tightening

- [ ] **AC-VAL-1**: `updateAgencyBackendSchema` and `updateAgencyPortalSchema` accept BOTH `services: ['<uuid>']` (legacy payload, since UUID strings are ≤80-char trimmed strings) AND `services: ['some-free-form-slug']` after the swap. The framing here is **future-proofing**, not strict BC — no live caller emits UUID payloads today (verified §3.4 risk #6), but the relaxation ensures any legacy data round-trips. Tested via Jest unit tests in §8.2.
- [ ] **AC-VAL-2**: `slugStringArray` (used by `createCaseStudySchema` + `updateCaseStudySchema` lines 829-830 AND `createMarketingMaterialSchema` + `updateMarketingMaterialSchema` lines 930-945 — NM1 audit) rejects whitespace-only elements (M2 `.trim()` + `.min(1)`), rejects elements > 80 chars, and rejects arrays > 50 elements with i18n-keyed error `prm.errors.tagArrayTooLarge` (NM2). Tested in §8.2 — one CaseStudy case + one MarketingMaterial.topics case.
- [ ] **AC-VAL-3**: `rfpDraftBase.required_capabilities` rejects whitespace-only elements, elements > 80 chars, and arrays > 50 elements (M6 tightening to `openTagSlugArray`). Tested in §8.1 block 8 + §8.2.

### 12.4 Inline-amendment hygiene

- [ ] **AC-DOC-1**: All three parent specs (`agency-foundation`, `case-studies-marketing`, `rfp-broadcast-response`) carry a 2-line pointer block at the top referencing this spec.
- [ ] **AC-DOC-2**: `app-spec/app-spec.md` §1.4 reflects open-vocab for `services` + `tech_capabilities` + `technologies` (CaseStudy) with a `(see SPEC-2026-05-11)` annotation. `industries` annotation is unchanged.
- [ ] **AC-DOC-3**: `app-spec/app-spec.md` §3 Master Data Plan (around line 1343) annotates that the `tech_capabilities` and `services` dictionary entries are inert for the affected forms post this spec. (m1.)

## 13. Surface Inventory

**Touched (must change):**

| File | Why |
|---|---|
| `src/modules/prm/api/portal/agency/[id]/tag-suggestions/route.ts` | NEW — per-agency portal endpoint (§5.1.1) |
| `src/modules/prm/api/agency/[id]/tag-suggestions/route.ts` | NEW — per-agency backend endpoint (B1 driver) |
| `src/modules/prm/api/tag-suggestions/route.ts` | NEW — tenant-wide backend endpoint (B-RFP driver, §5.1.2) |
| `src/modules/prm/lib/tagSuggestions.ts` (or similar) | NEW — shared helper for the union-and-UUID-filter logic; called by all three routes above |
| `src/modules/prm/data/validators.ts` | Add `openTagSlugArray` (trim + min(1) + max(80) + array `.max(50, 'prm.errors.tagArrayTooLarge')`); swap on `updateAgencyBackendSchema` + `updateAgencyPortalSchema` for `services` + `techCapabilities`; tighten `slugStringArray` with `.trim()` + `.max(50, 'prm.errors.tagArrayTooLarge')` — cascades to CaseStudy AND MarketingMaterial.topics callsites (lines 829-830 + 930-945, NM1); tighten `rfpDraftBase.required_capabilities` to `openTagSlugArray`. (M1+M2+M6+NM1+NM2) |
| `src/modules/prm/backend/prm/[id]/page.tsx` | Extend `profileSchema`; Profile-tab gains two CrudForm `tags` fields with static pre-load via `useEffect` (M3) |
| `src/modules/prm/frontend/[orgSlug]/portal/agency/page.tsx` | Extend form state; render two TagsInput blocks with static pre-load; extend submit payload |
| `src/modules/prm/frontend/[orgSlug]/portal/case-studies/caseStudyForm.tsx` | Swap suggestion source from dictionary endpoint to new per-agency portal endpoint; `allowCustomValues=true` (already pre-loads on mount — pattern preserved) |
| `src/modules/prm/backend/prm/rfp/_shared/rfpFormConfig.tsx` | `requiredCapabilities` becomes `type: 'tags'`; schema + initial value + `rfpToFormValues` + `rfpFormValuesToPayload` + `rfpFormValuesToPatchPayload` all switch from string to array; static pre-load from tenant-wide endpoint via `useEffect` |
| `src/modules/prm/i18n/en.json` | New keys: `prm.agencies.fields.techCapabilities`, `prm.agencies.fields.services`, `prm.agencies.fields.techCapabilities.help`, `prm.agencies.fields.services.help`, `prm.rfp.fields.requiredCapabilities.help`, `prm.errors.tagArrayTooLarge` (max(50) Zod message), plus optional re-wording of the existing `prm.portal.caseStudies.form.technologies.placeholder` / `services.placeholder` to match the new "type to add new" semantics |
| `src/modules/prm/__integration__/TC-PRM-OPEN-VOCAB-TAGS-001.spec.ts` | NEW — Playwright spec (§8.1), tenant-per-spec fixture |
| `src/modules/prm/data/__tests__/validators.test.ts` (or wherever PRM validator tests live — implementer locates exact path) | New cases: BC for Agency (uuid + free-form both accepted), tightening for CaseStudy (`.trim()`, `max(50)`), tightening for RFP (`required_capabilities` rejects empty/whitespace, max(50)) |
| `app-spec/app-spec.md` | §1.4 field-definition table annotations + §3 Master Data Plan annotation (line ~1343, m1) |
| `.ai/specs/SPEC-2026-04-23-agency-foundation.md`, `case-studies-marketing.md`, `rfp-broadcast-response.md` | Header pointer "AMENDED BY SPEC-2026-05-11" — already in place (verified pre-revision) |

**Explicit no-ops (do NOT touch):**

| File | Why no-op |
|---|---|
| `src/modules/prm/data/entities.ts` | No column change — already jsonb string arrays |
| `src/modules/prm/migrations/` | No migration needed |
| `src/modules/prm/lib/rfpEligibility.ts` | Eligibility does not consume capabilities; verified §3.2 |
| `src/modules/prm/lib/llmScoringDraft.ts` | Spec #6 scoring is downstream; typo-tolerant by design |
| `src/modules/prm/lib/technologiesDictionarySeed.ts`, `servicesDictionarySeed.ts` | Bounded tech debt — seeds keep producing rows; forms just don't query them |
| `src/modules/prm/api/portal/dictionaries/[key]/entries/route.ts` | Whitelist + endpoint preserved (`industries`, `topics` still consume) |
| `src/modules/prm/setup.ts` | Continues to call the inert seeds; no change |
| `src/modules/prm/search.ts`, `ce.ts`, `translations.ts`, `notifications.ts`, `events.ts` | None reference these columns; verified §3.1 |
| `src/modules/prm/lib/rfpService.ts`, `caseStudyService.ts`, `agencyService.ts` | All pass arrays through verbatim; no logic change needed |
| `src/modules/prm/api/agency/route.ts`, `api/portal/agency/[id]/route.ts`, `api/portal/case-study/[id]/route.ts`, `api/rfp/route.ts`, `api/portal/rfp/[id]/route.ts` | DTOs already emit the underlying string arrays; unchanged |
| `src/modules/prm/backend/prm/rfp/[id]/page.tsx` (RFP show page) | Read-only renderer; `requiredCapabilities.join(', ')` works for any array |
| `src/modules/prm/backend/prm/marketing-materials/*` | Uses `topics` dictionary, untouched |
| `industries` field on Agency + CaseStudy (anywhere) | Closed-vocab stays |

## 14. Risk & BC Acceptance

- **Validator changes are mixed and intentional**:
  - **Agency tag fields relax** (uuid → open slug) — future-proofing, no live client emits uuid payloads.
  - **CaseStudy `slugStringArray` tightens** (`.trim()` + array `.max(50)`) — BC-verified, no UI ever wrote whitespace-only values; falls back to read-time normalisation if smoke surfaces an exception.
  - **RFP `required_capabilities` tightens** (`z.array(z.string())` → `openTagSlugArray`) — rejects only payloads no live B-RFP user emits (form already produces trimmed non-empty strings).
- **DOS / data-bloat surface capped** — `.max(50)` array cap on all three open-vocab arrays per M1.
- **No cache, no invalidation churn** per §5.1. v2 may revisit; perf-deferred Postgres UNNEST swap also tracked here.
- **Storage is unchanged** — pure UX + validation policy shift.
- **Cross-spec validation clean** — §3.2 surfaced only the three Mat-flagged specs.
- **Test surface bounded and lives in the right layer** — one Playwright spec in the live PRM `__integration__/` suite (rebuilt 2026-05-09 under SPEC-2026-05-09b, tenant-per-spec) covering HTTP + RBAC + isolation; Jest unit tests for validator BC + tightening. No e2e UI Playwright — form changes are mechanical and don't introduce a bug class that route-level + manual smoke doesn't catch.
- **Adversarial review pass (2026-05-11 rev2)**: B1, B2, M1, M2, M3, M4, M5, M6, M7 all addressed.
- **Second adversarial review pass (2026-05-11 rev3)**: NB1, NB2, NM1, NM2, NM3, Nm1, Nm2, Nm3 all addressed; 11/15 rev2 findings reconfirmed closed. Findings + responses in §15 changelog.
- **Known dependency (out of scope, but worth flagging)**: full Playwright partner_admin coverage for blocks 1/2/4 is gated on the upstream `bootstrap-test-tenant.ts` seeding fix (existing PRM portal smokes are also `test.skip`-ed for this reason). Live coverage of the shared helper + validator behaviours proceeds via staff auth on the backend per-agency endpoint + tenant-wide endpoint + agency PATCH.

### 14.1 Perf-deferred follow-ups (POST-MVP candidates)

1. **Postgres `UNNEST` for tag suggestions** — current handler materialises rows + JS flatMap. Acceptable for v1 scale; revisit when an agency crosses ~500 case studies or a tenant crosses ~10K.
2. **Optional cache** — if suggestion endpoints become hot (e.g., a B-RFP user opens many forms in succession), apply the `libraryCache.ts` pattern (tag-based invalidation on Agency / CaseStudy writes).
3. **GIN indexes** on the jsonb tag columns — only needed if a `WHERE technologies_used @> '[...]'` query path is added downstream.

## 15. Changelog

| Date | Change |
|---|---|
| 2026-05-11 | Initial DRAFT, decomposed from Mat brief 2026-05-10. Five Open Questions resolved in-spec; two new questions surfaced + answered (OQ-#6 backend tag-suggestion route for B1; OQ-#7 chip-remove update semantics). Cross-spec validation pass clean. Ready for adversarial review pre-flip to READY. |
| 2026-05-11 (rev2) | Adversarial review pass (fresh-context reviewer). 2 BLOCKERS + 7 MAJORS + 6 MINORS surfaced, all addressed: **B1** pseudocode `tenantId` filter on CaseStudy (column doesn't exist) → swapped for `organizationId` scoping; tenant-wide endpoint joins via `Agency.tenantId`. **B2** removed reference to non-existent `getCallerAgencyId` helper; documented the real `agency.organizationId === auth.orgId` pattern + 1-org-1-agency invariant from `prm_agencies_organization_uniq`. **M1** added `.max(50)` array cap on `openTagSlugArray` + `slugStringArray` + RFP `required_capabilities`. **M2** added `.trim()` to `slugStringArray` for write-time parity with Agency. **M3** standardised P3 + B1 + B-RFP onto P8's static-pre-load-on-mount pattern (no per-keystroke server calls). **M4** added server-side UUID-regex filter in suggestion handlers (legacy closed-vocab values dropped). **M5** rewrote §3.4 risk #1 with the actual TagsInput case-handling behaviour + added AC-INV-8. **M6** tightened RFP `required_capabilities` validator (was `z.array(z.string())`, now `openTagSlugArray`). **M7** moved integration test from Jest sibling-style to Playwright `__integration__/TC-PRM-OPEN-VOCAB-TAGS-001.spec.ts` (PRM Playwright suite is LIVE under SPEC-2026-05-09b tenant-per-spec, verified 13 specs present including `TC-PRM-PORTAL-AGENCY-001.spec.ts`). Minors: app-spec L1343 amendment added (m1); field-name canonical labels picked (m2); AC-INV-3 soft-delete round-trip clarified (m3); UNNEST perf TODO inlined into §5.1.1/§5.1.2 + §14.1 (m4); `prm.agency.read` gating confirmed correct after acl.ts grep (not `_admin_fields` — those gate sensitive contract/NDA columns, not tags) (m5); AC-VAL-1 reframed as future-proofing not strict BC (m6). Stale memory entry on PRM Playwright suite state corrected. |
| 2026-05-11 (flip) | DRAFT → READY. Two fresh-context adversarial passes (rev2 + rev3) consumed 15 + 8 findings respectively (23 total, all addressed). User accepted spec for implementation; pre-flip review depth deemed sufficient. Implementation orchestrator may dispatch. |
| 2026-05-11 (rev3) | Second-pass adversarial review (second fresh-context reviewer against rev2). 11/15 prior findings cleanly closed; 2 NEW BLOCKERS + 3 NEW MAJORS + 3 NEW MINORS surfaced and addressed: **NB1** CrudForm `'tags'` field does not consume `suggestions` prop (verified `CrudForm.tsx:3698-3713`) — switched §6.1 + §6.4 to **static `options: CrudFieldOption[]`** (CrudForm passes this directly to TagsInput's `suggestions` and skips wiring `loadSuggestions` when `loadOptions` is absent, giving the M3-target behaviour cleanly; NM3 dissolves). **NB2** partner_admin Playwright auth currently blocked by upstream `bootstrap-test-tenant.ts` not firing PRM's `onTenantCreated` hook — restructured §8.1 so the 5 behaviours provable via staff auth (blocks 3, 5, 6, 7, 8) run LIVE against the backend per-agency endpoint + tenant-wide endpoint + backend PATCH, and the 3 portal-specific behaviours (blocks 1, 2, 4) ship as `test.skip` with the standard PRM portal-spec skip comment template, un-skipped in a follow-up commit when upstream fixture seeding lands. **NM1** extended §5.2 callsite audit to cover `MarketingMaterial.topics` (validators.ts:930+945) — `slugStringArray` tightening cascades there; BC-safe (topics is closed dict) but now explicitly in AC-VAL-2 + §8.2 test scope. **NM2** wired `'prm.errors.tagArrayTooLarge'` as the `.max(50)` message argument on `openTagSlugArray` + `slugStringArray` so `createCrudFormError` surfaces a translated key. **Nm1** documented partner_member admittance to the portal suggestion endpoint (both roles hold `prm.agency.view`; read-only access intentional). **Nm2** dropped the wasteful `/api/prm/portal/me` resolve in §6.3 — agency id passed in from existing form context, one GET per field. **Nm3** RFP `RFP_FORM_INITIAL` + patch payload + form-state schema changes explicitly tabled in §6.4 as a coordinated five-identifier change in commit 6. Spec is rev3-clean per second-pass reviewer. |

---

## Execution Plan

> Structured for `om-implement-spec` and `om-auto-create-pr` consumption. Single phase, atomic commits, validation gate per phase end.

### Phase 1 — Open-Vocabulary Tag Fields

Commits 1-6 per §7 above. Order is now **validators (1) → endpoints (2-4) → UI (5-6)** so the validator + read paths exist before any UI commit can hit them.

**Final commit order**:

1. Commit 1 (validators — all three changes: open-vocab Agency, slugStringArray trim+cap, RFP tightening). Lands first; backend only.
2. Commit 2 (portal per-agency suggestion endpoint).
3. Commit 3 (backend per-agency suggestion endpoint, B1 driver).
4. Commit 4 (tenant-wide suggestion endpoint, B-RFP driver).
5. Commit 5 (P8 case-study form swap — depends on commit 2).
6. Commit 6 (P3 + B1 + B-RFP UI bundle + Playwright spec — depends on commits 2/3/4).

### Validation gate (run after Phase 1 lands, before PR opens)

- [ ] `yarn generate` (no entity changes — should be no-op, but run anyway for structural cache purge)
- [ ] `yarn typecheck` — zero errors
- [ ] `yarn jest --testPathPattern='src/modules/prm.*validators'` — validator BC + tightening cases green (§8.2)
- [ ] `yarn jest --testPathPattern='src/modules/prm'` — full PRM Jest scope green; pre-existing failures (e.g., `llmScoringDraft.test.ts` model-id mismatch documented in SPEC-2026-05-10) are not regressed
- [ ] `yarn test:integration:ephemeral --grep "TC-PRM-OPEN-VOCAB-TAGS-001"` — new Playwright spec green under tenant-per-spec fixture (requires `OM_PRM_WIC_IMPORT_SECRET` env var per AGENTS.md test environment note)
- [ ] `yarn lint` — zero new warnings on touched files
- [ ] i18n key presence: every new `t(...)` call has a matching entry in `i18n/en.json` (including `prm.errors.tagArrayTooLarge` for the new array-cap Zod message)
- [ ] Manual smoke checklist §8.4 — six steps run by hand against a dev tenant (added cases 5 + 6 for M5/M1 edge behaviour)

### Out of scope for Phase 1 (deferred / future-ready hooks)

- Tenant-wide tag-suggestion endpoint for `services` (only `technologies` is exposed in §5.1.2). Add when a B-something form needs it.
- Cache layer on suggestion endpoints — v2 if perf data warrants (§14.1 perf-deferred follow-ups).
- Postgres `SELECT DISTINCT UNNEST(...)` swap on suggestion handlers — current materialise + JS flatMap is fine at v1 scale (§14.1).
- Migration of `lib/technologiesDictionarySeed.ts` + `lib/servicesDictionarySeed.ts` to "no-op stubs" — bounded tech debt per Matom; revisit if no other consumer surfaces.
- GIN indexes on `agency.services` / `agency.tech_capabilities` / `case_study.technologies_used` — only needed for contains-search queries.
- App-spec `app-spec/app-spec.md` line 1056 AC ("Case study requires minimum fields: at least one `industries`, at least one `technologies`") — current validator does NOT enforce `.min(1)` on these arrays; this spec doesn't add it either. Either tighten in a separate spec or strike the AC. (Surfaced as OOS by adversarial review.)
- i18n keys for silent-degrade flash on suggestion-endpoint failure — existing `.catch(() => {})` pattern preserved (no flash today); B-RFP staff users see no feedback. Worth a follow-up if "why isn't autocomplete working" becomes a question.

### Spec status post-implementation

After Phase 1 lands and the validation gate passes, this spec moves to status `IMPLEMENTED`. Per Memory rule, the DRAFT → READY flip BEFORE implementation requires a fresh-context adversarial review (om-cto subagent, no session history). That review is a later step, not in this spec's scope.
