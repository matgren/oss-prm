/**
 * `safeEmit` — best-effort wrapper around the typed PRM event emitter.
 *
 * Domain mutations (e.g. `Agency.updateAgency`, `AgencyMemberService.invite`) emit a
 * cluster of follow-up events after a successful flush. If the event bus is
 * unavailable (transport down, queue saturated, subscriber registration error)
 * we MUST NOT roll the persistence back — the user-visible mutation already
 * committed. Pre-fix, every call site swallowed errors via
 * `.catch(() => undefined)` which silently dropped audit-grade telemetry on the
 * floor. This helper preserves the swallow semantics while routing the
 * underlying error through the resolved logger so operators can see it.
 *
 * Logger resolution:
 * - First try `container.resolve('logger')` if a container is provided (request-
 *   scoped). The OM platform conventionally registers a Pino-shaped logger here.
 * - Fall back to `console.warn` if the container is absent or the logger
 *   registration fails — never throw from this helper.
 */
import { emitPrmEvent, type PrmEventId } from '../events'

type ContainerLike = {
  resolve?: <T = unknown>(name: string) => T
}

type LoggerLike = {
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

function resolveLogger(container: ContainerLike | null | undefined): LoggerLike {
  if (!container || typeof container.resolve !== 'function') return console
  try {
    const logger = container.resolve<LoggerLike>('logger')
    if (logger && (typeof logger.warn === 'function' || typeof logger.error === 'function')) {
      return logger
    }
  } catch {
    // resolution failure is expected outside the request scope
  }
  return console
}

export async function safeEmit(
  eventId: PrmEventId,
  payload: Record<string, unknown>,
  options?: {
    container?: ContainerLike | null
    /** Free-form context surfaced in the warning log when emission fails. */
    context?: Record<string, unknown>
    /** When true (default), failures are downgraded to a warn entry rather than logged as errors. */
    silent?: boolean
  },
): Promise<void> {
  try {
    await emitPrmEvent(eventId, payload as never)
  } catch (err) {
    const logger = resolveLogger(options?.container ?? null)
    const message =
      err instanceof Error
        ? `[prm] event emission failed for "${eventId}": ${err.message}`
        : `[prm] event emission failed for "${eventId}": ${String(err)}`
    const detail = {
      eventId,
      ...(options?.context ?? {}),
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    }
    const sink = options?.silent === false ? logger.error : logger.warn
    if (typeof sink === 'function') {
      sink.call(logger, message, detail)
    } else if (typeof console.warn === 'function') {
      console.warn(message, detail)
    }
  }
}

export default safeEmit
