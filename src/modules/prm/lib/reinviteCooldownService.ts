import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import type { RateLimitResult } from '@open-mercato/shared/lib/ratelimit/types'

/**
 * Per `(agency_id, lower(email))` re-invite cooldown.
 *
 * Resolved from `@open-mercato/shared/lib/ratelimit` per PROXY-GATE-RESOLUTIONS §Q5.
 * Spec defaults: 1 invite per recipient per 10 minutes (kept tunable via env).
 *
 * Failure mode: when the rate-limiter is disabled (no Redis, no env config), the
 * underlying `RateLimiterMemory` still enforces the cap. If the platform is fully
 * disabled (`globalConfig.enabled = false`), `consume` returns `allowed: true` —
 * we accept that as a documented operational fallback (R12 mitigation).
 */
export class ReinviteCooldownService {
  /** Window during which the same recipient cannot be re-invited. */
  static readonly DEFAULT_WINDOW_SECONDS = 10 * 60

  private readonly windowSeconds: number

  constructor(windowSeconds?: number) {
    const envOverride = Number(process.env.PRM_REINVITE_COOLDOWN_SECONDS ?? '')
    this.windowSeconds = Number.isFinite(envOverride) && envOverride > 0
      ? envOverride
      : windowSeconds ?? ReinviteCooldownService.DEFAULT_WINDOW_SECONDS
  }

  /** Build the canonical key shared between backend and portal invite paths. */
  buildKey(agencyId: string, email: string): string {
    return `prm:invite:${agencyId}:${email.trim().toLowerCase()}`
  }

  /**
   * Attempt to consume one invite slot for `(agency_id, email)`.
   *
   * @returns `allowed=false` when the recipient is still inside the cooldown window;
   *          inspect `retryAfterSeconds` for the structured 429 response.
   */
  async consume(
    rateLimiter: RateLimiterService | null | undefined,
    agencyId: string,
    email: string,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (!rateLimiter) {
      // Documented fallback (R12) — rate limiting unavailable in the runtime.
      return { allowed: true, retryAfterSeconds: 0 }
    }
    const result: RateLimitResult = await rateLimiter.consume(
      this.buildKey(agencyId, email),
      {
        points: 1,
        duration: this.windowSeconds,
        blockDuration: this.windowSeconds,
        keyPrefix: 'prm-invite',
      },
    )
    return {
      allowed: result.allowed,
      retryAfterSeconds: result.allowed ? 0 : Math.ceil(result.msBeforeNext / 1000),
    }
  }
}

export default ReinviteCooldownService
