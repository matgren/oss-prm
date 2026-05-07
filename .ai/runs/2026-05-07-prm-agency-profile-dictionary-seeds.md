# Run plan — `prm-agency-profile-dictionary-seeds`

**Slug:** `prm-agency-profile-dictionary-seeds`
**Branch:** `feat/prm-agency-profile-dictionary-seeds`
**Target:** `develop`
**Base commit:** `a317ea7` (origin/develop at start of run)
**Skill:** `om-superpowers:om-auto-create-pr`
**Source spec:** `.ai/specs/SPEC-2026-04-23-agency-foundation.md` (§1.2 / §2 / §5.5 M3 / §11)

## Goal

Close the lone "MISSING" finding from the post-mvp-beta-t3 spec audit: Spec #1
declares `industries`, `services`, and `technologies` dictionary seeds in M3 / §11,
but only `topics` (Spec #7) is currently seeded. Without these three picklists the
B1 staff Agency form and P3 portal Agency form fall back to free-text, defeating
the dictionary-backed validation Spec #1 §3.1 mandates.

This run installs the three seeds following the existing `topicsDictionarySeed.ts`
pattern verbatim — no new convention, no entity changes.

## Scope

In:
- `src/modules/prm/lib/industriesDictionarySeed.ts` (new)
- `src/modules/prm/lib/servicesDictionarySeed.ts` (new)
- `src/modules/prm/lib/technologiesDictionarySeed.ts` (new)
- `src/modules/prm/setup.ts` (wire all three seeds into both `onTenantCreated` + `seedDefaults`)
- `src/modules/prm/__tests__/setupIndustriesDictionary.test.ts` (new)
- `src/modules/prm/__tests__/setupServicesDictionary.test.ts` (new)
- `src/modules/prm/__tests__/setupTechnologiesDictionary.test.ts` (new)

Non-goals (explicit):
- No changes to Agency entity or validators (Spec #1 §3.1 documents the
  deliberate slug-tag-array convention).
- No changes to the Agency forms (B1 / P3) — those still accept slug arrays;
  the picklist UI swap is a separate concern owned by the dictionaries module.
- No backend page to manage these dictionaries — the `dictionaries` module's
  B14 page already covers this.
- No edits to `.ai/specs/POST-MVP-FOLLOW-UPS.md` (DS migration agent owns the lock).
- No edits to `.ai/specs/SPEC-*.md`.
- No edits to `src/modules/prm/frontend/[orgSlug]/portal/*.tsx` (DS migration agent territory).

## Curation choices

Spec #1 §5.5 M3 + §11 declare the seed dictionaries but DO NOT pin specific
entries. The audit recorded this gap as "the actual dictionary seed function is
missing from PR #1's M3 deliverable" — there is no canonical entry list to copy.

Therefore the v1 seeds below are opinionated starter sets; admins extend or
prune via the `dictionaries` module B14 page. Each seed file ships a comment
"v1 seed — admins can extend via dictionaries module B14 page".

- **industries (10 entries)**: SaaS, E-commerce, FinTech, HealthTech, EdTech,
  Manufacturing, Media & Entertainment, Government & Public Sector, Non-profit, Other.
- **services (10 entries)**: Custom Web Development, Mobile App Development,
  AI/ML Integration, Data Engineering, DevOps & Cloud Infrastructure, UI/UX Design,
  Product Strategy & Consulting, Quality Assurance, Cybersecurity, Technical Training.
- **technologies (16 entries)**: React, Vue, Angular, Node.js, Python, Ruby, Go,
  Java, .NET, AWS, GCP, Azure, PostgreSQL, MongoDB, Kubernetes, Docker.

All slugs kebab-case (`saas`, `e-commerce`, `fintech`, `node-js`, `dot-net`, etc.).

## Implementation Plan

### Phase 1: Three seed files + per-seed tests (Tests-with-code gate)

- 1.1 Create `src/modules/prm/lib/industriesDictionarySeed.ts` mirroring
  `topicsDictionarySeed.ts` shape: `INDUSTRIES_DICTIONARY_SEED` array, exported
  `seedIndustriesDictionary(em, scope)` that upserts the `industries` Dictionary
  and entries idempotently. Include the v1-seed/B14 admin comment.
  Land with its test `__tests__/setupIndustriesDictionary.test.ts` (3 cases:
  canonical-slug-list, first-call seed, idempotent — mirroring the actual
  `setupTopicsDictionary.test.ts` shape).

- 1.2 Same for services: `lib/servicesDictionarySeed.ts` +
  `__tests__/setupServicesDictionary.test.ts`.

- 1.3 Same for technologies: `lib/technologiesDictionarySeed.ts` +
  `__tests__/setupTechnologiesDictionary.test.ts`. Note: the dictionary KEY is
  `technologies` (Spec #1 §5.5 M3 / §11), even though the Agency entity column
  is `tech_capabilities` (Spec #1 §3.1 — preserved for jsonb portability).

### Phase 2: Wire into `setup.ts`

- 2.1 Edit `src/modules/prm/setup.ts` to import the three new seeds and call
  them from both `onTenantCreated` and `seedDefaults`, mirroring how
  `seedTopicsDictionary` is called today. Order: roles → workflow → topics →
  industries → services → technologies (ordering immaterial — independent
  dictionaries — but topics first preserves the existing call order to keep the
  diff minimal).

### Phase 3: Validation gate

- 3.1 `yarn typecheck`.
- 3.2 `yarn jest src/modules/prm` — expect baseline ≥482 + 9 new = ≥491 passing.
- 3.3 `yarn build`.

### Phase 4: PR + auto-review pass

- 4.1 Open PR against `develop` with labels `review`, `feature`. Body documents
  curation choices, the audit gap closed, and the
  POST-MVP-FOLLOW-UPS-not-edited note (DS migration agent has the lock).
- 4.2 Run `auto-review-pr` autofix pass; apply any blockers as new commits.
- 4.3 Post the comprehensive summary comment.

## Risks

- **Curation disagreement.** The reviewer may want different entries than the
  v1 list. Mitigation: the seeds are idempotent and the B14 page lets admins
  prune/extend without code change. PR body explicitly invites reviewer
  sanity-check on the curated lists.
- **Dictionary key collision.** If any tenant already has a dictionary keyed
  `industries` / `services` / `technologies` (created out-of-band via B14), the
  seed will detect it via `findOne(Dictionary, { key })` and skip creation —
  same idempotency guard as the topics seed.
- **`tech_capabilities` column vs `technologies` dictionary key.** Documented
  in Spec #1 §3.1 — the column name is preserved for jsonb portability but the
  dictionary key matches the spec text and the case-study `technologies_used`
  field convention. PR body calls this out.
- **POST-MVP-FOLLOW-UPS.md lock.** DS migration agent owns the file. PR body
  notes "no existing entry to remove — this closes a gap discovered by audit".

## Backward compatibility

- Pure additive change. No entity edits, no migration, no API change.
- `setup.ts` invocation order changes are additive — new calls appended after
  the existing topics seed call.
- Idempotent — safe to re-run `seedDefaults` on existing tenants.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Seed files + per-seed tests

- [x] 1.1 Industries seed + test — 8ee5e32
- [x] 1.2 Services seed + test — b6d0a71
- [x] 1.3 Technologies seed + test — c1524b3

### Phase 2: Wire into setup.ts

- [x] 2.1 Import + invoke all three seeds in `onTenantCreated` + `seedDefaults` — a5fbb5e

### Phase 3: Validation gate

- [ ] 3.1 `yarn typecheck`
- [ ] 3.2 `yarn jest src/modules/prm` (≥491 passing)
- [ ] 3.3 `yarn build`

### Phase 4: PR + auto-review

- [ ] 4.1 Open PR + labels + summary body
- [ ] 4.2 `auto-review-pr` autofix pass
- [ ] 4.3 Comprehensive summary comment

## Changelog

- 2026-05-07 — plan drafted; branch claimed off `origin/develop` @ `a317ea7`.
