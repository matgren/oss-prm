# PRM WIC Commands with Undo — Run Plan

Source spec: `.ai/specs/SPEC-2026-04-23-wic-ingestion.md` §4.1 (Commands & Events) + §10.7 (undo by default).

## Goal

Implement the three undoable Commands declared in PRM Spec #4 §4 — `RecordWicContributionCommand`, `SupersedeWicContributionCommand`, `ResolveWicImportAuditLogCommand` — each with `execute` + `undo`, and refactor `wicImportService.ts` + the audit-log resolve route handler to delegate the atomic write to those commands. Closes the v2 deferral in `wicImportService.ts:69-71` and the operational n8n-rollback gap surfaced by the post-mvp-beta-t3 spec audit.

The "why": n8n is an external automated import pipeline. If it floods bad rows, OM PartnerOps needs a deterministic rollback path on the audit-log surface. Without `undo`, ops has no recovery short of manual SQL.

## Scope

In scope:

1. New command modules under `src/modules/prm/commands/wic/` with `execute` + `undo`.
2. Refactor of `processWicRow` / `processWicBatch` in `src/modules/prm/lib/wicImportService.ts` to invoke the commands.
3. Refactor of `src/modules/prm/api/wic/audit-log/[id]/resolve/route.ts` to invoke `ResolveWicImportAuditLogCommand.execute`.
4. Registration of new compensation events in `src/modules/prm/events.ts`:
   - `prm.wic.contribution_recorded.undone`
   - `prm.wic.contribution_superseded.undone`
   - `prm.wic_import.resolved.undone`
5. Per-command unit tests (`__tests__/wic*Command.test.ts`).
6. Removal of the "Aspirational … deferred to v2" comment block (lines 69-71 of `wicImportService.ts`).

Non-goals (do NOT touch):

- `.ai/specs/POST-MVP-FOLLOW-UPS.md` (DS migration agent owns the lock).
- Any spec under `.ai/specs/SPEC-*.md`.
- `src/modules/prm/frontend/[orgSlug]/portal/*.tsx` (DS migration agent's territory).
- `src/modules/prm/testing/integration/` (test-isolation agent's territory).
- HTTP shape of `POST /api/prm/service/wic/imports/[batchId]` and `POST /api/prm/wic/audit-log/[id]/resolve` — must remain identical.
- Table-name divergence (§10.5 is out-of-scope follow-up).

## Implementation Plan

### Phase 1: Compensation events + RecordWicContributionCommand

- Register the three `*.undone` compensation events in `src/modules/prm/events.ts`.
- Create `src/modules/prm/commands/wic/recordWicContribution.ts` with `execute(args, ctx)` + `undo(args, ctx)`.
  - `execute`: builds a new `WicContribution` row from snapshotted member data + emits `prm.wic.contribution_recorded`. Returns the new row's id.
  - `undo`: sets `archivedAt = now()` on the contribution, emits `prm.wic.contribution_recorded.undone`. Idempotent — undo of an already-archived row is a no-op.
- Unit tests at `src/modules/prm/__tests__/wicRecordContributionCommand.test.ts`:
  - `execute` happy path (DB insert + event emitted)
  - `undo` happy path (archivedAt set + compensation event)
  - `undo` idempotency (second undo is a no-op)

### Phase 2: SupersedeWicContributionCommand

- Create `src/modules/prm/commands/wic/supersedeWicContribution.ts` with `execute` + `undo`.
  - `execute`: sets `previous.supersededById = newContributionId` + `previous.archivedAt = now()`, emits `prm.wic.contribution_superseded`.
  - `undo`: clears `supersededById` + `archivedAt` on the previous row, emits `prm.wic.contribution_superseded.undone`. Idempotent.
- Unit tests at `src/modules/prm/__tests__/wicSupersedeContributionCommand.test.ts`:
  - `execute` happy path
  - `undo` happy path (un-supersede + compensation event)
  - `undo` idempotency (second undo is no-op)
  - Supersession-of-supersession safety (undo of inner supersession in a chain doesn't corrupt outer)

### Phase 3: ResolveWicImportAuditLogCommand

- Create `src/modules/prm/commands/wic/resolveWicImportAuditLog.ts` with `execute` + `undo`.
  - `execute`: writes `resolvedAt`/`resolutionAction`/`resolvedByUserId`/`resolutionNote`, emits `prm.wic_import.resolved`.
  - `undo`: clears the four fields back to `null`, emits `prm.wic_import.resolved.undone`. Idempotent — undo of an unresolved row is a no-op.
- Unit tests at `src/modules/prm/__tests__/wicResolveAuditLogCommand.test.ts`:
  - `execute` happy path
  - `undo` happy path (fields cleared + compensation event)
  - `undo` idempotency

### Phase 4: Service + route refactor

- Refactor `src/modules/prm/lib/wicImportService.ts`:
  - `processWicRow` invokes `RecordWicContributionCommand.execute` for the new row + `SupersedeWicContributionCommand.execute` for supersession (when `previous` exists).
  - Remove the "Aspirational … deferred to v2" comment block (lines 69-71).
  - Existing `wicImportService.test.ts` (8 tests) must still pass — the refactor preserves observable behavior.
- Refactor `src/modules/prm/api/wic/audit-log/[id]/resolve/route.ts` to invoke `ResolveWicImportAuditLogCommand.execute`. HTTP shape unchanged.
- DI registration in `src/modules/prm/di.ts` only if commands need explicit container resolution (initial design uses pure functions like the existing `wicImportService`, which doesn't go through DI — so likely no di.ts changes needed). Re-evaluate after Phase 1.

### Phase 5: Validation gate + PR

- `yarn typecheck`
- `yarn jest src/modules/prm` — must show 482 baseline + ~12-20 new = ≥494 passing.
- `yarn build`
- Open PR via `gh pr create` against develop with labels `review`, `feature`.

## Risks

- The `findOneWithDecryption` / `findWithDecryption` call sites in `wicImportService.ts` need to remain consistent with command-internal find calls, otherwise we double-load rows.
- Compensation events are NEW event IDs — they're additive (Spec #4 §4.2 frozen-list rule allows additive changes). Need to add to `events.ts` and document the choice in the PR body since the spec is silent on event names for two of the three compensations (only `prm.wic.contribution_recorded.undone` is named; the others say "compensation event" without an id).
- The refactor cannot drop or rename `prm.wic.contribution_recorded` / `prm.wic.contribution_superseded` / `prm.wic_import.resolved` (frozen cross-spec contract).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Compensation events + RecordWicContributionCommand

- [x] 1.1 Register three `*.undone` compensation events in `src/modules/prm/events.ts` — 481e2ab
- [x] 1.2 Create `src/modules/prm/commands/wic/recordWicContribution.ts` with execute + undo — 481e2ab
- [x] 1.3 Add unit tests at `src/modules/prm/__tests__/wicRecordContributionCommand.test.ts` (7 tests; full PRM suite 482→489) — 481e2ab

### Phase 2: SupersedeWicContributionCommand

- [ ] 2.1 Create `src/modules/prm/commands/wic/supersedeWicContribution.ts` with execute + undo
- [ ] 2.2 Add unit tests at `src/modules/prm/__tests__/wicSupersedeContributionCommand.test.ts`

### Phase 3: ResolveWicImportAuditLogCommand

- [ ] 3.1 Create `src/modules/prm/commands/wic/resolveWicImportAuditLog.ts` with execute + undo
- [ ] 3.2 Add unit tests at `src/modules/prm/__tests__/wicResolveAuditLogCommand.test.ts`

### Phase 4: Service + route refactor

- [ ] 4.1 Refactor `wicImportService.ts` to delegate to commands; remove v2-deferral comment
- [ ] 4.2 Refactor audit-log resolve route to invoke `ResolveWicImportAuditLogCommand.execute`
- [ ] 4.3 Verify 482-baseline tests still pass

### Phase 5: Validation gate + PR

- [ ] 5.1 Run `yarn typecheck`
- [ ] 5.2 Run `yarn jest src/modules/prm` (target ≥494)
- [ ] 5.3 Run `yarn build`
- [ ] 5.4 Open PR with `review` + `feature` labels and post summary comment
