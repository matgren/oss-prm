# Mat Brief — Open-Vocabulary Tag Fields for Agency + Case Study (+ RFP UX upgrade)

**Date:** 2026-05-10
**Author:** Mat (Marty Cagan)
**Status:** Draft — ready for Piotr Spec Orchestrator
**Type:** Amendment to two live functional specs — `SPEC-2026-04-23-agency-foundation.md` §3.1 and `SPEC-2026-04-23-case-studies-marketing.md` (tag-field policy). See §10 for the full deviation register.
**Proxy state at write-time:** Matom resolved all 5 launch-brief probe items; zero outstanding user-judgment questions for Mat. See §11.

---

## 1. Business Context

### 1.1 The user's pain (verbatim)

> "I find it terrible UX/UI still, they should be like tag cloud that users can add new tags in nice and easy way and we can clean them up in some dictionary or something in the backoffice if needed." — observed on Backend B1 Agency Profile tab, escalating from a prior session that landed closed-list `TagsInput` on Case Studies (PR #22, 2026-05-07).

Translation: the existing closed-vocabulary dictionary policy for `technologies` and `services` is blocking real-world data entry. Partner agencies and OM staff alike are friction-stopped from describing capabilities that don't happen to appear in the curated seed (16 technologies, 10 services). The cost of every "missing capability" interaction = partner emails OM, OM staff edits the dictionary, partner retries. The benefit (a tidy taxonomy) wasn't worth it.

### 1.2 The shift

| Aspect | Before (SPEC-2026-04-23 §3.1 + PR #22) | After (this amendment) |
|---|---|---|
| Vocabulary policy | Closed dictionary, OM-curated | Open, type-and-enter creates |
| Suggestion source | Global seeded dictionary | Per-agency union (own profile + own case studies) |
| Cross-agency visibility | All agencies see same dictionary | Each agency sees only its own slugs |
| Cleanup admin | (Not built) | None planned; agency self-curates by re-typing |
| Fields affected | `technologies` + `services` on CaseStudy (P8/B7) | Add same fields to Agency profile (B1 Profile tab + P3 portal); flip CaseStudy from closed to open; upgrade RFP `requiredCapabilities` from comma-text to TagsInput |
| `industries` field | Closed dictionary | **Unchanged — stays closed** (user explicit) |
| Eligibility/matching impact | None (capabilities not consumed by eligibility today) | None (same) |

### 1.3 Why this is worth doing now

- **Field already exists on the entity** — `agency.techCapabilities` and `agency.services` are jsonb columns on `prm_agencies` (entities.ts:53-60). They were intentionally scoped *out* of the Agency form by the 2026-05-07 PR ("picklist UI swap is a separate concern"). That separation has now lapsed: today the column exists, the seeds exist, but the agency-side form doesn't render either field. From a partner's perspective the columns might as well not exist.
- **Closed-vocab cost is asymmetric.** Adding a missing slug requires backend admin work. Removing a wrong slug requires either ignoring it or running a manual SQL cleanup. Per-agency open vocab gives the agency control over its own surface area and removes OM staff from the critical path.
- **Eligibility is tier-based today** (verified — `rfpEligibility.ts` consumes tier + explicit list only; `requiredCapabilities` is stored but unused in eligibility). So this change has **zero matching regression risk**. LLM-assisted scoring on RFP responses (`llmScoringDraft.ts`, Spec #6) is already typo-tolerant by design.

### 1.4 Non-goals (explicit scope cuts)

- ❌ No central tag-dictionary admin UI (user changed their mind mid-session: "not really, I change my mind").
- ❌ No tenant-wide tag normalization / deduplication / merge-rename tool.
- ❌ No slug-lowercase / no-whitespace constraint at storage layer. Trim only.
- ❌ No backfill of existing case-study slugs — they're already plain strings and will surface naturally as per-agency suggestions on next form load.
- ❌ No change to `industries` (Agency or CaseStudy) — stays closed-dictionary.
- ❌ No change to `compliance_tags`, `regions`, `languages` dictionaries. Those fields aren't part of this amendment.
- ❌ No deletion of the seeded `technologies` and `services` dictionary rows or seed code. Leave inert (bounded-tech-debt rule). Future migration may revisit.
- ❌ No new LLM matching pipeline for eligibility. (User-stated rationale relied on this; verified it doesn't exist; capabilities aren't consumed by eligibility today so the rationale doesn't need it.)

---

## 2. Ubiquitous Language Delta

These terms are amended relative to `SPEC-2026-04-23-agency-foundation.md` §3.1 and `SPEC-2026-04-23-case-studies-marketing.md` tag-field declarations:

| Term | Old definition (PRM app-spec §1.3) | New definition (this amendment) |
|---|---|---|
| `services` (Agency) | Dictionary slug array — closed vocab from `services` dictionary | Free-text slug array — per-agency open vocab; trim-only; suggestion source = own agency's slugs only |
| `tech_capabilities` (Agency) | Dictionary slug array — closed vocab from `technologies` dictionary | Free-text slug array — per-agency open vocab; same as above |
| `technologies_used` (CaseStudy) | Dictionary slug array — closed vocab | Free-text slug array — per-agency open vocab; suggestion source = the case study's owning agency |
| `services_delivered` (CaseStudy) | Dictionary slug array — closed vocab | Free-text slug array — per-agency open vocab; same as above |
| `required_capabilities` (RFP) | Free-text comma-separated → string array | Free-text slug array; UX upgraded to TagsInput; suggestion source = tenant-wide union of all agencies' tech tags (OM-staff form, no leak risk) |

No new terms introduced.

---

## 3. Identity Model (delta only)

Unchanged from `SPEC-2026-04-23-agency-foundation.md` §3.1 and the existing PRM identity model already encoded in the codebase (`partner_admin` / `partner_member` / `partnership_manager`).

| Persona | Field write rights (post-amendment) |
|---|---|
| OM Staff (`partnership_manager` etc.) | Agency profile tech/services on B1 (override available, per existing case-studies pattern). RFP capabilities on B-RFP. |
| Agency Admin (`partner_admin`) | Own Agency tech/services on P3 portal. Own Agency's case studies tech/services on P8 portal. |
| Agency Member (`partner_member`) | **Read only** for both Agency and CaseStudy tech/services. Mirrors current P3/P8 read-only policy for non-admins. |

---

## 4. Workflows Affected

This amendment touches three workflows already defined upstream. No new workflows; only field-policy changes inside existing ones.

### WF-A: Agency self-curates profile (P3, partial coverage today)

Journey: PartnerAdmin opens P3 → edits Profile → adds/removes tech + service tags → saves → tags appear instantly in autocomplete for own future case studies + own profile re-edits.

ROI: Reduces "I can't describe what we do" friction from "email OM and wait" to "type and tab." Estimated: removes ~1 OM-staff-touchpoint per onboarding agency and an unknown trickle thereafter.

Boundaries:
- Starts when: PartnerAdmin selects own Agency in P3.
- Ends when: Save returns 2xx and tag is visible on subsequent autocomplete.
- NOT this workflow: Industries (closed-dictionary), team-size, country.

Edge cases:
1. Two partner_admins on same Agency edit concurrently → optimistic concurrency token already enforced (`Agency.version`, entities.ts:111). Last-write wins on tags; one user sees 409 and re-tries.
2. PartnerAdmin types `React`, partner_member next week types `react` — both stored, both appear in suggestions. Acceptable (verbatim casing per Matom resolution); LLM downstream handles dedupe in scoring.
3. PartnerAdmin removes all tech tags then immediately re-types one — round-trip through DB; suggestion list reflects only what's in any saved row.

### WF-B: Agency creates Case Study (P8, exists)

Same flip — closed `allowCustomValues={false}` → open with per-agency suggestions. Cross-pollination: tech tags entered on the case study form populate the agency-profile autocomplete and vice versa.

### WF-C: OM staff drafts RFP brief (B-RFP, exists)

Capability field upgraded from comma-text to TagsInput; suggestions = tenant-wide union of every agency's tech tags + case-study tags. Form is OM-staff-only, so partner agencies can't see other agencies' tags via this surface.

---

## 5. User Stories

### US-T1: PartnerAdmin adds a missing technology to own agency

**As** a PartnerAdmin
**I want** to type a technology name (e.g. `LangGraph`) into my Agency Profile's Technologies field and press Enter to add it
**so that** OM can see what we actually work with without me having to email OM staff and wait for a dictionary update.

**Happy path:**
1. PartnerAdmin opens P3 (own Agency profile edit).
2. Clicks the Technologies field; sees autocomplete pre-populated with slugs ever saved on own Agency profile or any own case study.
3. Types `LangGraph` (not in autocomplete); presses Enter.
4. Chip appears; remaining tags unchanged.
5. Clicks Save. Server PATCH returns 2xx. Flash: "Profile saved."
6. PartnerAdmin re-opens the form (or any own case study form) and types `Lang` — `LangGraph` is now suggested.

**Alternate paths:**
- Types partial of existing tag (`Reac`) → autocomplete suggests `React`; PartnerAdmin selects it (no duplicate row created).
- Pastes comma-separated list (`React, Vue, Angular`) → TagsInput splits on commas; each becomes a chip.
- Hits backspace on empty input → removes last chip.

**Failure paths:**
- Server PATCH returns 409 (version mismatch — concurrent edit) → flash error; form re-loads latest; user re-applies edit. Standard `Agency.version` flow already in place.
- Server PATCH returns 4xx for any reason → original chips restored; error surfaced. No partial state.
- Network drop → submit button stays disabled state via `saving`; user retries on reconnect.

### US-T2: PartnerAdmin keeps capability list tidy without admin help

**As** a PartnerAdmin
**I want** typos I made on a case study to disappear from autocomplete after I remove them from every row that referenced them
**so that** my agency's suggestion list self-cleans without needing an admin merge tool.

**Happy path:**
1. PartnerAdmin earlier typed `reactt` on a case study; saved.
2. Today opens the case study; deletes `reactt` chip; saves.
3. Re-opens another own case study or own profile; types `react` — only `React` appears (assuming no other row still contains `reactt`). The typo is gone.

**Alternate paths:**
- Typo still referenced from a sibling row → it stays in autocomplete until that last row is updated or soft-deleted. User sees it persist and edits the offending row.

**Failure paths:**
- User can't find which row references a stale slug → they re-type a fresh tag and ignore the stale one. Cost: a stale suggestion lingers until it ages out. Acceptable per user's "no central cleanup" directive.

### US-T3: OM staff drafts an RFP with capability tags

**As** an OM Partnership Manager
**I want** to type required capabilities into an RFP form and see suggestions drawn from the network's actual capability vocabulary
**so that** I describe the RFP using language that maps to real agency profiles, not invented buzzwords.

**Happy path:**
1. Staff opens B-RFP create form; clicks Required Capabilities.
2. Autocomplete shows tenant-wide union of every agency's tech slugs and every case study's tech slugs.
3. Staff selects 3 chips, types one new chip (`MLflow`), saves.
4. RFP is persisted with all 4 slugs in `required_capabilities`. Tier-based eligibility filter runs unchanged.

**Alternate paths:**
- Staff opens the edit page on an RFP that was saved when the field was still comma-text — the existing array surfaces as chips (no backfill needed).
- Staff leaves the field empty → RFP saves with `required_capabilities: []` (already supported).

**Failure paths:**
- Suggestion endpoint times out → field still works, just without suggestions. Degrade gracefully (same pattern as current `caseStudyForm.tsx:104-107` silent-degrade).
- 4xx on save → field state preserved; user retries.

### US-T4: New PartnerAdmin lands on an Agency that already had legacy seed slugs

**As** a PartnerAdmin newly invited to an Agency that was provisioned before this amendment (case studies stamped with `react`, `aws`, etc. from the 16-entry seed)
**I want** those pre-existing slugs to appear in my autocomplete and continue to work on save
**so that** the amendment is invisible to data and doesn't lose information.

**Happy path:**
1. PartnerAdmin opens own Agency P3 profile (currently has 0 tech tags — admin never set them).
2. Suggestion list shows slugs pulled from own case studies' `technologies_used` (e.g. `react`, `aws`).
3. PartnerAdmin picks 2, saves. Profile now has `techCapabilities: ['react', 'aws']`.
4. Loads next session: same chips appear (no rename, no normalization).

**Alternate paths:** none — slugs are plain strings, server doesn't validate against any dictionary.

**Failure paths:** none specific to this story; same Agency PATCH failure mode as US-T1.

---

## 6. Cross-Story Impact Matrix

| Story | State change | Stories that depend | Conflict? |
|---|---|---|---|
| US-T1 (Agency tag add) | `agency.techCapabilities` / `agency.services` arrays grow | US-T2 (suggestion list), US-T3 (RFP suggestion union), US-T4 (legacy slug compat) | None — additive. New slugs surface in own-agency suggestions; tenant-wide RFP union also expands. |
| US-T2 (tag remove from row) | Array shrinks on one row | US-T1, US-T3 | None — suggestion lists naturally lose the slug if it was the last referent. Tenant-wide RFP union shrinks symmetrically. |
| US-T3 (OM staff RFP capabilities) | `rfp.required_capabilities` grows | None — `requiredCapabilities` is not consumed by eligibility, scoring is typo-tolerant. | None. |
| US-T4 (legacy slug compat) | Read-only | US-T1 (writes), US-T2 (reads) | None — verbatim string passthrough. |

**Conflict patterns checked:**
- ⚪ Race condition — no two stories mutate the same field concurrently with contradictory intent. `Agency.version` already guards.
- ⚪ Cascade storm — none. No subscriber fires on tag-array changes.
- ⚪ Stale precondition — none. No story assumes a particular set of slugs exists.
- ⚪ Orphaned reference — N/A (strings, not FKs).
- ⚪ Timing gap — none. Slugs are read on demand.

No new stories added, no contradictions, no missing domain events.

---

## 7. Platform Mapping (Phase 3 quick pass)

| Capability needed | OM provides? | Cost |
|---|---|---|
| TagsInput primitive with autocomplete + custom values | ✅ `@open-mercato/ui/backend/inputs/TagsInput` — same component caseStudyForm uses; just flip `allowCustomValues` to `true` | 0 |
| Suggestion API — per-agency union | ❌ — new endpoint, ~1 commit (`GET /api/prm/portal/agency/:id/tag-suggestions?field=technologies|services`) | 1 |
| Suggestion API — tenant-wide union (RFP) | ❌ — new endpoint, ~1 commit (`GET /api/prm/tag-suggestions?field=technologies`) | 1 |
| Agency profile B1 form rendering | ⚠️ — extend existing `profileSchema` + `CrudForm` fields in `backend/prm/[id]/page.tsx`. Need to add TagsInput as a `type: 'custom'` field if CrudForm doesn't yet ship it, else manual section | 1 |
| Agency P3 portal form | ⚠️ — extend existing P3 form (analog to caseStudyForm) | 1 |
| Case Study P8 portal form flip | ✅ — single line change: `allowCustomValues={true}` in caseStudyForm.tsx | 0 (1 commit anyway with regression tests) |
| RFP B-RFP capability field upgrade | ⚠️ — replace comma-text Input with TagsInput in `rfpFormConfig.tsx` (both create + edit + show pages) | 1 |
| Validation (Zod) — accept array of trimmed strings | ✅ — `z.array(z.string().trim().min(1)).max(50)` | 0 |
| Tests | ⚠️ — new unit tests on suggestion API + integration test for closed→open flip behaviour | 1 |

**Atomic-commit estimate (Ralph Loop, for Piotr's review):** ~5 commits if cleanly sliced. Piotr will refine in the technical spec.

---

## 8. Phasing

Single phase. No partial-ship value in splitting (e.g. shipping agency-side without case-study side would leave the cross-pollination promise broken). Piotr may still order commits for review hygiene.

**Phase 1 — Open-vocab tag fields (ship together):**
1. Suggestion API: per-agency union (one route, two field params).
2. Suggestion API: tenant-wide union (one route, one field param).
3. CaseStudy form flip + regression test for legacy-slug compat (US-T4).
4. Agency profile B1 + P3 forms — render new fields wired to suggestion API.
5. RFP B-RFP form — TagsInput upgrade + tenant-wide suggestions.

Acceptance criteria (Vernon-style, will be refined in technical spec):
- ✅ Existing case-study rows with seeded-dict slugs continue to save without rename (US-T4 happy path).
- ✅ Suggestion API never leaks tags from another agency (US-T1 + US-T2 cross-pollination check).
- ✅ Tenant-wide endpoint accessible only via B-RFP route auth (OM staff feature key).
- ✅ TagsInput trim-on-create works (whitespace-only input rejected client-side).
- ✅ RFP edit page round-trips arrays that were saved when the field was still comma-text.

---

## 9. Production Readiness Check

| Question | Answer |
|---|---|
| Would a client (OM PartnerOps) pay for this today? | Already paying for PRM; this fixes a known friction in the existing flow. |
| Can they run their business without this? | Yes, but with the existing "email OM to update dictionary" tax. |
| Is this end-to-end usable on ship? | Yes — single phase, all surfaces updated together. |
| Demo-ware risk? | Low. Real data already exists; this exposes hidden columns to the form and removes a gate. |

---

## 10. Spec Deviation Notes

This amendment supersedes the following passages in live specs:

### `SPEC-2026-04-23-agency-foundation.md` §3.1 (closed-vocab convention)
- Old: "Slug strings rather than dictionary FKs… [validated against dictionary entries]"
- New: Slug strings, free-form per-agency for `services` + `tech_capabilities`. Still slug strings (no schema change). Industries unchanged.

### `SPEC-2026-04-23-case-studies-marketing.md` (closed-list `TagsInput`)
- Old: `allowCustomValues={false}` on CaseStudy tech + service tags; suggestions from dictionary.
- New: `allowCustomValues={true}`; suggestions from per-agency union (same agency's profile + case studies).

### Inert seed code (no edit)
- `lib/servicesDictionarySeed.ts` and `lib/technologiesDictionarySeed.ts` stay on disk and stay called from `setup.ts`. They populate dictionaries that this amendment's forms no longer query. Bounded-tech-debt rule: leave for now; future spec may delete if no other module consumes them.

---

## 11. Matom Resolutions (auto-applied)

These were on the launch-brief probe list; Matom resolved each before reaching the user:

| Probe item | Resolution |
|---|---|
| Deletion-from-autocomplete semantics | Natural read-distinct-from-rows: tag disappears when last referent removed. No deletion endpoint needed. |
| RFP tenant-wide-suggestion default — competitor-leak concern | No leak. B-RFP form is OM-staff-only (backend route, auth gate). PartnerAdmin/PartnerMember never see the tenant-wide suggestion list. |
| P3 portal-form ACL — `partner_admin` vs `partner_member` writes | Mirror existing P3 profile ACL: `partner_admin` writes, `partner_member` read-only. No new ACL surface. |
| LLM matching pipeline existence | Verified: `rfpEligibility.ts` uses tier + explicit list only. `llmScoringDraft.ts` consumes responses for Spec #6 scoring, not eligibility. Free-form is safe regardless. |
| Backfill of existing closed-list slugs | None needed. Slugs are plain strings on jsonb arrays; they appear as suggestions automatically via read-distinct from rows. |

---

## 12. Open Questions for Piotr

These are technical-spec-shaped questions Piotr should answer in the formal spec:

1. **Suggestion API scoping** — single endpoint serving both `?field=technologies` and `?field=services` with one query each, or two endpoints? (Probably one with param.)
2. **Suggestion API caching** — per-agency response cache TTL? Or read-through every call given the small array sizes? (Small arrays favour no cache.)
3. **B1 Profile tab field type** — does `@open-mercato/ui/backend/CrudForm` ship a TagsInput field-type, or does this section need to drop out of CrudForm into a custom `<TagsInput />` block? (If the latter, Piotr decides whether to extend CrudForm or just escape-hatch.)
4. **RFP form `requiredCapabilities` migration** — switching from comma-string Input to TagsInput on B-RFP requires the form-state translator (`rfpFormValuesToPayload`) to stop splitting on commas. Confirm any saved RFP drafts with non-conformant payload shape (shouldn't be possible per current Zod schema, but worth a one-time grep).
5. **Test surface** — per Matom global rule "bounded tech debt", do we add a single integration test for the open-vocab flip, or per-form unit tests? (Lean to one integration spec exercising the per-agency boundary, since that's the only invariant worth catching regressions on.)

These don't need user input. Piotr's Spec Orchestrator can answer or escalate.

---

## 13. Handoff

**Next agent:** `om-cto` in Spec Orchestrator mode.

**Piotr's deliverable:** One technical spec (working title: `SPEC-2026-05-10-open-vocab-tags.md`) decomposing this amendment into atomic commits, gap-analysing against current code, and producing an execution plan that `om-implement-spec` can run.

**Cross-spec linkages Piotr must declare in the technical spec front-matter:**
- Amends: `SPEC-2026-04-23-agency-foundation.md` §3.1.
- Amends: `SPEC-2026-04-23-case-studies-marketing.md` (tag field policy).
- Touches: `SPEC-2026-04-23-rfp-broadcast-response.md` (`requiredCapabilities` field UX, not semantics).
- No touch: `SPEC-2026-04-23-rfp-scoring-selection.md` (eligibility / scoring code paths unchanged).

**Mat's job is done.** No further product input until Piotr returns the spec for user review.
