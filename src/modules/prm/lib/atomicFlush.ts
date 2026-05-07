/**
 * `withAtomicFlush` — local implementation of the SPEC-018 helper that the
 * framework documents at `@open-mercato/shared/lib/commands/flush` but does
 * not ship in the installed `@open-mercato/shared` 0.5.0 build.
 *
 * Behaviour matches the documented contract (see SPEC-018 + `core/AGENTS.md`
 * "Entity Update Safety"):
 *
 * - Run each `phase` callback in declaration order.
 * - Issue a single `em.flush()` after the last phase completes.
 * - When `options.transaction === true`, wrap the whole sequence in
 *   `em.transactional(async () => { await phase1(); await phase2(); ... })`,
 *   which under the MikroORM 6.x Postgres driver opens a real `BEGIN ... COMMIT`
 *   block and rolls every change back atomically if any phase (or the implicit
 *   final flush) throws.
 *
 * Migration note: when `@open-mercato/shared` ships the canonical helper, replace
 * this import with `import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'`.
 * The signature is identical, so call sites do not need to change.
 */
import type { EntityManager } from '@mikro-orm/postgresql'

export type AtomicFlushPhase = () => void | Promise<void>

export type AtomicFlushOptions = {
  /**
   * When true, wrap the phases + flush in a single DB transaction
   * (`em.transactional(...)`). A single phase that throws — including a
   * unique-constraint violation on the implicit final flush — rolls back
   * every other change in the same call.
   *
   * When false / unset, phases run sequentially and the helper issues a
   * single `em.flush()` at the end (still safer than ad-hoc multi-flush
   * pipelines because it guarantees one-shot UoW resolution, but no DB
   * transaction wrapping — match the documented contract).
   */
  transaction?: boolean
}

export async function withAtomicFlush(
  em: EntityManager,
  phases: AtomicFlushPhase[],
  options?: AtomicFlushOptions,
): Promise<void> {
  if (!Array.isArray(phases) || phases.length === 0) {
    // No-op — keep the contract permissive for empty pipelines.
    return
  }

  const runPhases = async (target: EntityManager): Promise<void> => {
    for (const phase of phases) {
      await phase()
    }
    await target.flush()
  }

  if (options?.transaction === true) {
    // `em.transactional` opens a real BEGIN/COMMIT block on Postgres and
    // rolls back on throw. The callback receives a transactional EM proxy,
    // but for our use case the request-scoped `em` is already the active
    // unit of work; we run phases against the original `em` reference so
    // the callsite's pre-built entities (created/persisted before the call)
    // remain on the same UoW.
    await em.transactional(async () => {
      await runPhases(em)
    })
    return
  }

  await runPhases(em)
}

export default withAtomicFlush
