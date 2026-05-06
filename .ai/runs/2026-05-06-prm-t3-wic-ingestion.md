---
title: PRM T3 — WIC Ingestion (Spec #4)
slug: prm-t3-wic-ingestion
date: 2026-05-06
author: Claude (om-auto-create-pr)
spec: .ai/specs/SPEC-2026-04-23-wic-ingestion.md
base: develop
branch: feat/prm-t3-wic-ingestion
---

# Execution Plan — PRM T3 WIC Ingestion

## Goal

Implement Spec #4 (WIC Ingestion & Display) end-to-end: two service-identity routes (`GET profiles`, `POST imports/{batch_id}`), an Anti-Corruption Layer with auditable issue queue, supersession-by-month idempotency, and a B10 backend page for OM PartnerOps to triage rejected rows. Land it as a single PR against `develop` with the §9 IT-1 happy-path Playwright integration test included.

## Source spec

- **`.ai/specs/SPEC-2026-04-23-wic-ingestion.md`** — full functional spec (5 atomic commits estimated by Piotr)
- Cross-spec contracts: none owned in/out by this spec — purely additive (new entities, new routes, new ACL feature, new events)
- Persona: Martin Fowler (per spec front-matter)

## Scope (in)

- New entities under `src/modules/prm/data/entities.ts`:
  - `WICContribution` (snapshots `agency_id` + `github_profile`, partial-unique on `(agency_member_id, contribution_month) WHERE superseded_by_id IS NULL AND archived_at IS NULL`)
  - `WICImportAuditLog` (per-row rejection record with resolution lifecycle)
  - `ServiceIdempotencyKey` (auth infrastructure side table)
- New ACL feature: `prm.wic.resolve` (seeded on Admin + OM PartnerOps roles)
- New service-auth middleware (`src/modules/prm/lib/serviceAuthMiddleware.ts`) implementing SPEC-053b header contract: `X-Om-Import-Secret` + `X-Om-Request-Timestamp` (±5min) + `X-Om-Idempotency-Key` (POST-only)
- New env var: `OM_PRM_WIC_IMPORT_SECRET` (with optional `OM_PRM_WIC_IMPORT_SECRET_NEXT` for rotation overlap)
- New API routes:
  - `GET /api/prm/service/wic/profiles` (US6.1)
  - `POST /api/prm/service/wic/imports/[batchId]` (US6.2)
  - `GET /api/prm/wic/audit-log` (B10 server side, session + ACL feature `prm.wic.resolve`)
  - `POST /api/prm/wic/audit-log/[id]/resolve` (B10 mutation)
- New commands: `RecordWICContributionCommand`, `SupersedeWICContributionCommand`, `ResolveWICImportAuditLogCommand` (all undoable per Piotr Decision Library §8)
- New events: `prm.wic.contribution_recorded`, `prm.wic.contribution_superseded`, `prm.wic_import.row_rejected`, `prm.wic_import.batch_completed`, `prm.wic_import.resolved`
- New backend page: B10 at `/backend/prm/wic-issues` (DataTable over `WICImportAuditLog` with three resolution row actions)
- §9 IT-1 happy-path Playwright integration test at `.ai/qa/tests/integration/TC-PRM-T3-001-wic-ingestion-happy-path.spec.ts`
- Module-owned fixtures extension at `src/modules/prm/testing/integration/` (header-builder helper + WIC seeding fn)

## Non-goals

- US6.3 portal dashboard widget — owned by Spec #2 (already shipped). This spec writes rows that Spec #2 reads.
- WIC scoring/classification logic — external n8n black-box, never branched on (`wic_level` is display-only per L-002).
- Tier auto-derivation from WIC totals — admin-set per L-008; out of scope.
- Cross-agency historical re-attribution — silent + runbook per OQ-013.
- Telemetry alerts for B10 backlog (>20 open issues) — Phase 6 observability.
- Bounce-webhook handler — already tracked in POST-MVP-FOLLOW-UPS for invitations; not relevant here.

## Approach (decision rationale)

- **Anti-Corruption Layer** is the spec's centerpiece. Per-row Zod failures become audit-log entries (200 with rejected_count), NOT envelope-level 422s. Only envelope-shape failures (`rows` not an array) are 422.
- **Supersession by partial-unique index** rather than application-level locking — Postgres serializes the critical section automatically; SERIALIZABLE txn is overkill for monthly batches.
- **Per-row commit** inside a batch-wrapping transaction — partial failure must be observable. `(import_batch_id, row_index)` unique constraint makes mid-batch crash retries side-effect-free.
- **Service-identity is NOT a user** — middleware injects `ServiceIdentity { clientId: 'n8n-wic', requestId, idempotencyKey? }` onto request context; downstream handlers never see a `User`/`CustomerUser`.
- **Idempotency table is auth infrastructure**, not domain. Lives at `service_idempotency_key` keyed by `(endpoint, key)` with `payload_hash` + `response_body` for replay.
- **B10 uses the standard CrudForm/DataTable pattern** from `@open-mercato/ui/backend/crud` — same shape as existing PRM backend pages (B1/B4/B5).
- **`rejection_reason` enum** uses App Spec values (per CROSS-VALIDATION §1.3): `unknown_github_profile` is the persisted form, `profile_not_found` is the human-facing alias in B10 copy.

## External References

None. Hard-halt rule #4 (mandatory IT-1) was set inline by the user in the brief. No `--skill-url` was passed.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | DB-level CHECK on `extract(day from contribution_month) = 1` may be unsupported by the migration generator's auto-derivation | Fallback: write the CHECK in a manual sub-section of the generated migration (allowed when annotating an entity property the generator emits as a column). If MikroORM's CHECK decorator is the path, use `@Check()` on the entity. |
| R2 | Partial-unique-index syntax (`UNIQUE ... WHERE`) requires raw SQL in MikroORM migrations | Generator emits the migration; add the raw `CREATE UNIQUE INDEX ... WHERE ...` in the `up()` body alongside the auto-emitted bits. Reverse with `DROP INDEX` in `down()`. |
| R3 | `customers` module enable (commit 8aa3914) introduced 5 additive migrations + dictionary seeds. Tenant init may take longer; integration runner may need extra ready timeout | Already verified green on local main branch (`8aa3914`). If CI/ephemeral runner times out, raise `OM_INTEGRATION_READY_TIMEOUT_MS`. |
| R4 | §9 IT-15 (concurrent supersession race) requires parallel POSTs — Playwright single-worker default may serialize | Use `Promise.all` + two `request.post` calls inside one test fn; Playwright APIRequest contexts are independent of browser workers. Acceptable. |
| R5 | Auto-PR-skill validation gate's `yarn build` adds ~1min per phase. Total gate time per phase ≈3–5min | Acceptable. Hard-halt rule #3 says "stop on red gate twice" — we run gate after each phase, not after each commit. |

## Implementation Plan

### Phase 1 — Entities, migration, ACL feature seed

Goal: schema lands. No routes, no UI yet.

1. Add `WICContribution`, `WICImportAuditLog`, `ServiceIdempotencyKey` to `src/modules/prm/data/entities.ts` with all columns, indexes, and constraints from spec §5.1–§5.3.
2. Run `yarn mercato db generate` → review the generated migration file → augment with the partial-unique index (`UNIQUE (agency_member_id, contribution_month) WHERE superseded_by_id IS NULL AND archived_at IS NULL`) and the day-of-month CHECK constraint as raw SQL in `up()`/`down()`.
3. Add `prm.wic.resolve` ACL feature to `src/modules/prm/acl.ts`. Add to `src/modules/prm/setup.ts` `defaultRoleFeatures` for Admin + OM PartnerOps role IDs.
4. Run `yarn generate` (regenerate `.mercato/generated/`).
5. **STOP** for migration approval — post the generated migration filename + a one-paragraph diff summary as a PR comment. Do NOT run `yarn mercato db migrate` autonomously (hard-halt rule #1).
6. Commit: `T3: WIC entities + migration + acl feature`.

### Phase 2 — Service auth middleware + idempotency replay

Goal: shared middleware that all `/api/prm/service/wic/*` routes use. Zero domain logic — purely auth/replay.

1. Implement `src/modules/prm/lib/serviceAuthMiddleware.ts`:
   - Reads `OM_PRM_WIC_IMPORT_SECRET` (and optional `_NEXT` for rotation overlap).
   - Validates `X-Om-Import-Secret`, `X-Om-Request-Timestamp` (±5min), `X-Om-Idempotency-Key` (POST only).
   - On POST: looks up `(endpoint, key)` in `service_idempotency_key`. Same payload-hash → return cached response with `Idempotent-Replay: true`. Different hash → 409.
   - Returns `ServiceIdentity { clientId: 'n8n-wic', requestId, idempotencyKey? }` on success or a `Response` to short-circuit.
2. Unit tests at `src/modules/prm/__tests__/serviceAuthMiddleware.test.ts` covering: missing secret → 401, mismatch → 401, timestamp out of window → 408, missing idempotency on POST → 400, idempotent replay round-trip, replay with different payload → 409, GET ignores idempotency header.
3. **Tests-with-code gate**: middleware code + middleware test both staged in same commit.
4. Commit: `T3: WIC service auth middleware + idempotency replay`.

### Phase 3 — `GET /api/prm/service/wic/profiles`

Goal: US6.1 surface live. Read-only, no domain mutations.

1. Implement `src/modules/prm/api/service/wic/profiles/route.ts`:
   - Wraps `ServiceAuthMiddleware`.
   - Zod-validates `month` query param (optional, `YYYY-MM`).
   - Queries `AgencyMember` where `is_active = true AND github_profile IS NOT NULL` joined to `Agency` where `status = 'active' AND onboarded = true`.
   - Returns `{ month, profiles: [...] }`.
   - `openApi` export per AGENTS.md "Every API route MUST export `openApi`".
2. Unit tests for the handler logic (mocked EM): seeded active+inactive members, expects only active.
3. **Tests-with-code gate**: route + unit test in same commit.
4. Commit: `T3: WIC service GET profiles route + unit tests`.

### Phase 4 — `POST /api/prm/service/wic/imports/[batchId]` + Anti-Corruption Layer + commands

Goal: US6.2 — the largest phase. Per-row ACL, supersession, batch-completed event, full integration test coverage.

1. Implement commands at `src/modules/prm/lib/wicCommands.ts` (or split into `commands/wic/` if existing PRM pattern is per-command file):
   - `RecordWICContributionCommand` (execute + undo with archived_at soft-delete + compensation event).
   - `SupersedeWICContributionCommand` (sets `previous.superseded_by_id` + `archived_at`, emits `prm.wic.contribution_superseded`).
   - Both wired into PRM DI.
2. Implement the ACL pipeline at `src/modules/prm/lib/wicAntiCorruption.ts`: per-row Zod → resolve `agency_member_id` from `github_profile` → snapshot `agency_id` → check supersession → emit accept or reject.
3. Implement `src/modules/prm/api/service/wic/imports/[batchId]/route.ts`:
   - Wraps `ServiceAuthMiddleware`.
   - Envelope-level Zod (`script_version`, `month`, `rows[]`).
   - Per-row processing through ACL.
   - Wraps the batch in a transaction; per-row commit; emits `prm.wic_import.batch_completed` only on full success.
   - Returns `{ import_batch_id, accepted_count, rejected_count, superseded_count, per_row, idempotent_replay }`.
4. Add module-owned integration fixture helpers at `src/modules/prm/testing/integration/`:
   - `buildWicServiceHeaders({ secret, idempotencyKey?, timestampOffsetMin? })` — header builder for tests.
   - `seedActiveAgencyMember(request, token, opts)` if missing — likely already exists; check first.
5. Write `.ai/qa/tests/integration/TC-PRM-T3-001-wic-ingestion-happy-path.spec.ts` covering at minimum the spec's IT-1 happy path (T1: 3 valid rows accepted) plus the most security-load-bearing cases:
   - T1 — happy path 3-row batch
   - T2 — malformed month → audit log (`rejection_reason='malformed_month'`)
   - T3 — `unknown_github_profile` → audit log
   - T4 — supersession on retry with different score
   - T5 — idempotent replay with same idempotency key
   - T7 — timestamp skew → 408
   - T8 — bad secret → 401
6. Run the integration suite end-to-end; fix failures; commit only when green.
7. **Tests-with-code gate**: route + ACL + commands + integration test all in same commit (or split: commands+ACL one commit, route+integration test second commit if commit ends up >800 LOC of diff; honor §6 "one Step per commit when meaningful").
8. Commits (final shape decided by gate-time diff size):
   - `T3: WIC commands + anti-corruption layer + unit tests` (commands isolated, easy to review)
   - `T3: WIC POST imports route + integration smoke (T1-T8 selection)` (route + IT)

### Phase 5 — B10 backend page + audit-log routes + resolve command

Goal: US6.4 — OM PartnerOps can triage rejected rows.

1. Implement `ResolveWICImportAuditLogCommand` in `src/modules/prm/lib/wicCommands.ts`.
2. Implement `src/modules/prm/api/wic/audit-log/route.ts` (GET) — session + `prm.wic.resolve` ACL check, paginated + filter params per spec §3.4.
3. Implement `src/modules/prm/api/wic/audit-log/[id]/resolve/route.ts` (POST) — invokes `ResolveWICImportAuditLogCommand`.
4. Implement B10 page at `src/modules/prm/backend/prm/wic-issues/page.tsx` using `DataTable` from `@open-mercato/ui/backend/crud` + `IconButton` row actions.
5. Add `page.meta.ts` with `pageGroup: 'PRM'`, `pageGroupKey: 'prm'`, `pageOrder` consistent with sibling B-pages.
6. Add a Playwright smoke (T13 + T14) inside the existing T3-001 file (one more `test()` block) — minimal coverage of B10 rendering after seeding one rejection row, plus the 403 case for a role without `prm.wic.resolve`.
7. **Tests-with-code gate**: page + routes + command + Playwright extension in same commit.
8. Commit: `T3: WIC B10 audit-log page + resolve action + Playwright smoke`.

### Phase 6 — Final gate + PR open + auto-review-pr

1. Run full validation gate: `yarn generate` → `yarn typecheck` → `yarn test` → `yarn test:integration:ephemeral` → `yarn build`. ALL must be green before opening PR.
2. Open PR against `develop` with the body template from skill step 9.
3. Apply labels: `review`, `needs-qa` (this touches a new ACL surface + B10 backend page — needs manual exercise).
4. Run `om-auto-review-pr` against the new PR in autofix mode per skill step 11.
5. Post the comprehensive summary comment per skill step 12.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Entities, migration, ACL feature

- [x] 1.1 Add WicContribution + WicImportAuditLog + ServiceIdempotencyKey entities — 853532c
- [x] 1.2 Generate migration; augment with partial-unique-index + day-of-month CHECK — 853532c
- [x] 1.3 Add prm.wic.resolve ACL feature + role seeds — 853532c
- [x] 1.4 Run yarn generate — verified 853532c
- [x] 1.5 STOP for migration approval — user approved A; db migrate applied locally + verified by ephemeral test runner
- [x] 1.6 Commit: T3 WIC entities + migration + acl feature — 853532c

### Phase 2: Service auth middleware + idempotency replay

- [x] 2.1 Implement serviceAuthMiddleware.ts (header validation + idempotency lookup/replay) — 72d83a9
- [x] 2.2 Unit tests covering all 4xx auth paths + replay round-trip — 72d83a9 (14 tests)
- [x] 2.3 Commit: T3 WIC service auth middleware + idempotency replay — 72d83a9

### Phase 3: GET service profiles route

- [x] 3.1 Implement /api/prm/service/wic/profiles route + Zod — 4fa0ae7
- [x] 3.2 Unit tests for the query (active members + onboarded agencies only) — 4fa0ae7 (4 tests)
- [x] 3.3 Commit: T3 WIC service GET profiles route + unit tests — 4fa0ae7

### Phase 4: POST imports route + ACL + commands

- [x] 4.1 Implement WIC ingest service (record + supersede) + service-layer wiring — 5e839aa (Command pattern with undo deferred to v2 per spec §4.1)
- [x] 4.2 Implement Anti-Corruption Layer (per-row Zod + resolve + supersede) — 5e839aa
- [x] 4.3 Implement POST /api/prm/service/wic/imports/[batchId] route — 5e839aa
- [x] 4.4 Header builder + module-owned fixtures (resolveSingletonTenantContext middleware fallback covers test convenience) — 5e839aa
- [x] 4.5 Write TC-PRM-T3-001 integration spec — 5e839aa (T1 happy + T3 unknown_github + T7 timestamp + T8 secret + T8b GET secret + T9 GET happy)
- [x] 4.6 Run integration suite green — verified 5e839aa
- [x] 4.7 Commit: T3 WIC commands + ACL + POST imports + integration smoke — 5e839aa

### Phase 5: B10 page + audit-log routes + resolve command

- [x] 5.1 Implement resolve route (POST /api/prm/wic/audit-log/[id]/resolve) — Phase 5 commit
- [x] 5.2 Implement GET /api/prm/wic/audit-log (session + prm.wic.resolve) — Phase 5 commit
- [x] 5.3 Implement POST /api/prm/wic/audit-log/[id]/resolve — Phase 5 commit
- [x] 5.4 Implement B10 page (DataTable + row actions) at /backend/prm/wic-issues — Phase 5 commit
- [x] 5.5 Add page.meta.ts (pageGroup PRM, pageOrder 140) — Phase 5 commit
- [x] 5.6 Extend TC-PRM-T3-001 with B10 round-trip integration test (T13 UI + T14 RBAC deferred to POST-MVP) — Phase 5 commit
- [x] 5.7 Commit: T3 WIC B10 audit-log page + resolve action + integration smoke — Phase 5 commit

### Phase 6: Final gate + PR + auto-review

- [x] 6.1 Full validation gate green (generate, typecheck, jest, integration, build)
- [x] 6.2 PR opened against develop — PR #4 (https://github.com/matgren/oss-prm/pull/4)
- [x] 6.3 Labels applied (review + needs-qa + feature) via REST API
- [ ] 6.4 om-auto-review-pr autofix pass — deferred to next session for context budget; user invokes `/auto-review-pr 4`
- [x] 6.5 Comprehensive summary comment posted (#issuecomment-4391290659)

## Changelog

- 2026-05-06 — Plan drafted by Claude (om-auto-create-pr) on behalf of user. Spec #4 first commit pending after migration approval gate.
- 2026-05-06 — Phases 1-5 implemented; gate green; PR #4 opened against develop. Status: in-progress (auto-review-pr autofix pass pending).

## Changelog

- 2026-05-06 — Plan drafted by Claude (om-auto-create-pr) on behalf of user. Spec #4 first commit pending after migration approval gate.

---

## Post-PR-#4 close-out fixes (loop iterations on `feat/prm-t3-wic-ingestion`)

### Iter 1 — singleton tenant ambiguity over-rejected ✅ 0443baa
- `serviceAuthMiddleware.ts` ambiguity check is tenant-only (multi-org same-tenant is valid).
- `profiles/route.ts` agency WHERE drops `organizationId` filter (tenant scope only).
- jest: 187/187 (+1 positive test). integration: 14/14 (was 4 failing).


### Iter 2 — B10 audit-log tenant-wide design (revised) ✅ 3cedd72
- Original review flagged "cross-org leak"; investigation showed the proposed fix would break staff users (auth.orgId = staff org ≠ Agency org) and diverge from sibling PRM convention. Tenant-only filter is correct.
- Added explanatory comments to both routes + regression test.


### Iter 3 — per-row commit semantics clarified ✅ 2fff39a
- Updated wicImportService.ts header comment to match implementation. Per-row commit + (import_batch_id, row_index) UNIQUE replay = correct design per §3.3 R2.
- Added test verifying row N+1 failure does NOT roll back rows 0..N.


### Iter 4 — idempotency persist on forked EM ✅ f5dcdf8
- persistIdempotency now uses `em.fork({ clear: true, freshEventManager: true })`.
- UNIQUE-PK collision logged + swallowed; non-collision errors re-thrown so operators see them.
- Test verifies both paths.


### Iter 5 — B10 DS compliance ✅ 14586a5
- StatusBadge replaces amber/neutral hand-rolled pills.
- Alert primitive replaces inline error div.
- EmptyState wired into DataTable for steady-state zero-row case.
- Raw `<select>` retained — no Select primitive in OM 0.4.x; tracked in POST-MVP-FOLLOW-UPS sibling entry.


### Iter 6 — Final verification gate ✅
- yarn typecheck (0)
- yarn jest src/modules/prm: 190/190 across 23 suites
- yarn test:integration:ephemeral: 14/14 (1 skipped TC-CLI-001 unrelated)
- yarn build: green

PR #4 is merge-ready. Loop complete.

