/**
 * Test-only fault injection seam for RFP publish.
 *
 * RFP publish writes the RFP status update + N broadcast inserts in a single
 * `em.flush()`. Spec #5 §9.1 #4 (partial-insert rollback) requires proof that
 * if the broadcast batch fails mid-flush, the surrounding transaction
 * rollbacks every write — no orphan broadcasts, RFP stays at status `draft`.
 *
 * The proof is exercised by throwing *before* `em.flush()` runs, so the DB
 * never sees the broadcast inserts nor the RFP status update.
 *
 * Production wires the no-op `nullBroadcastFailureInjector` in `di.ts`.
 * Tests construct `RfpService` with `failingBroadcastFailureInjector` to
 * exercise the rollback path. Production code path therefore has zero
 * knowledge of test mode — no `process.env.*` read, no `if (NODE_ENV === ...)`
 * branch, just a polymorphic no-op interface call that the optimizer can
 * inline away.
 *
 * Replaces the prior `OM_PRM_TEST_INJECT_BROADCAST_INSERT_FAIL` env-var seam
 * (SPEC-2026-05-09b Phase 0b — eject env-var-gated fault injection).
 */
export interface BroadcastFailureInjector {
  /**
   * Called once after broadcast `em.persist()` calls and *before* the publish
   * `em.flush()`. Default impl is a no-op; throwing here aborts the publish
   * with the surrounding transaction rolling back all writes.
   */
  beforePublishFlush(): void
}

/**
 * Production injector — strict no-op. Default for the DI container.
 */
export const nullBroadcastFailureInjector: BroadcastFailureInjector = {
  beforePublishFlush(): void {
    // Intentionally empty. Production code path runs this every publish.
  },
}

/**
 * Test injector — throws unconditionally to exercise §9.1 #4 rollback proof.
 * Construct `RfpService(em, failingBroadcastFailureInjector)` from the test
 * to wire the failure path. Never registered in `di.ts` — only ever used in
 * `__tests__/`.
 */
export const failingBroadcastFailureInjector: BroadcastFailureInjector = {
  beforePublishFlush(): never {
    throw new Error(
      'BroadcastFailureInjector: simulated DB error on broadcast batch flush',
    )
  },
}
