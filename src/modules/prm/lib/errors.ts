/**
 * PRM-typed error codes used by the route layer to translate domain failures into
 * structured `{ error: { code, message } }` envelopes.
 *
 * Codes are FROZEN once shipped — downstream specs may bind UI flows to them.
 */
export const PRM_ERROR_CODES = {
  AGENCY_SLUG_TAKEN: 'agency_slug_taken',
  AGENCY_NOT_FOUND: 'agency_not_found',
  AGENCY_DELETE_BLOCKED: 'agency_delete_blocked',
  AGENCY_HISTORICAL: 'agency_historical',
  ADMIN_ONLY_FIELD: 'admin_only_field',
  CANNOT_DEACTIVATE_SELF: 'cannot_deactivate_self',
  ROLE_NOT_SELF_ASSIGNABLE: 'role_not_self_assignable',
  GITHUB_PROFILE_CONFLICT: 'github_profile_conflict',
  EMAIL_ALREADY_MEMBER: 'email_already_member',
  INVITE_COOLDOWN_ACTIVE: 'invite_cooldown_active',
  ROLE_SLUG_NOT_SEEDED: 'role_slug_not_seeded',
  VALIDATION_FAILED: 'validation_failed',
  FORBIDDEN: 'forbidden',
  // Spec #2 — wip-scoreboard. FROZEN once shipped (cross-spec contract).
  PROSPECT_NOT_FOUND: 'prospect_not_found',
  INVALID_TRANSITION: 'invalid_transition',
  WON_IS_OM_ONLY: 'won_is_om_only',
  NOT_AUTHOR_OR_ADMIN: 'not_author_or_admin',
  STATUS_CONFLICT: 'status_conflict',
  LOST_REASON_REQUIRED: 'lost_reason_required',
  AGENCY_MEMBER_NOT_FOUND: 'agency_member_not_found',
  // Spec #3 — attribution-loop. FROZEN once shipped (cross-spec contract for Specs #5/#6).
  LICENSE_DEAL_NOT_FOUND: 'license_deal_not_found',
  LICENSE_IDENTIFIER_TAKEN: 'license_identifier_taken',
  ATTRIBUTION_FROZEN: 'attribution_frozen',
  PATH_B_LOCKED_RFP: 'path_b_locked_rfp',
  ATTRIBUTION_REASONING_REQUIRED: 'attribution_reasoning_required',
  INVALID_ATTRIBUTION: 'invalid_attribution',
  RFP_NOT_AVAILABLE: 'rfp_not_available',
  GOLDEN_RULE_DEFAULT_MISMATCH: 'golden_rule_default_mismatch',
  CHURNED_IS_TERMINAL: 'churned_is_terminal',
  STATUS_CHANGE_NOT_ALLOWED: 'status_change_not_allowed',
  // Spec #5 — rfp-broadcast-response. FROZEN once shipped.
  RFP_NOT_FOUND: 'rfp_not_found',
  RFP_BROADCAST_NOT_FOUND: 'rfp_broadcast_not_found',
  RFP_RESPONSE_NOT_FOUND: 'rfp_response_not_found',
  RFP_NOT_DRAFT: 'rfp_not_draft',
  NOT_FOUND: 'not_found',
  // Spec #6 — rfp-scoring-selection. FROZEN once shipped.
  CHANGE_REASON_REQUIRED: 'change_reason_required',
  RFP_NOT_ACCEPTING_SCORES: 'rfp_not_accepting_scores',
  RESPONSE_NOT_SUBMITTED: 'response_not_submitted',
  NO_SCORED_RESPONSES: 'no_scored_responses',
  WINNER_NOT_SCORED: 'winner_not_scored',
  PATH_B_SIGNED_DEAL_LOCK: 'path_b_signed_deal_lock',
  INVALID_RFP_TRANSITION: 'invalid_rfp_transition',
  CLOSE_REASON_REQUIRED: 'close_reason_required',
  DEADLINE_IN_PAST: 'deadline_in_past',
  LLM_UNAVAILABLE: 'llm_unavailable',
  // Spec #7 — case-studies-marketing. FROZEN once shipped.
  CASE_STUDY_NOT_FOUND: 'case_study_not_found',
  CASE_STUDY_PUBLISHED_GUARD: 'case_study_published_guard',
  CASE_STUDY_NOT_DELETED: 'case_study_not_deleted',
  CASE_STUDY_FORBIDDEN_FIELD: 'case_study_forbidden_field',
  CASE_STUDY_INVALID_PUBLISH_STATE: 'case_study_invalid_publish_state',
  MARKETING_MATERIAL_NOT_FOUND: 'marketing_material_not_found',
  MARKETING_MATERIAL_INVALID_TIER: 'marketing_material_invalid_tier',
  MARKETING_MATERIAL_NOT_PUBLISHED: 'marketing_material_not_published',
} as const

export type PrmErrorCode = (typeof PRM_ERROR_CODES)[keyof typeof PRM_ERROR_CODES]

export class PrmDomainError extends Error {
  constructor(
    public readonly code: PrmErrorCode,
    message: string,
    public readonly status: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PrmDomainError'
  }
}

/**
 * Tag-based type guard for `PrmDomainError`.
 *
 * **Why not `err instanceof PrmDomainError`?** Under Next.js Turbopack
 * production bundling the service-side chunk and the route-side chunk can
 * each receive their own copy of `PrmDomainError`. The prototype chains
 * diverge, so an error thrown from `RfpService.publish` does not satisfy
 * `instanceof PrmDomainError` when caught in the route handler — even
 * though `err.name === 'PrmDomainError'` and the error's structural shape
 * (`code`, `status`, `message`) is identical. The route handler then falls
 * through to its `throw err` branch and Next.js surfaces a bare 500 with
 * `body=null`, masking the intended structured envelope (e.g. 409
 * `validation_failed`).
 *
 * Jest does not reproduce this because ts-jest puts all module copies in
 * one CommonJS graph, so prototype identity holds. Production-shaped
 * builds (Turbopack, Webpack server bundles) can split the same class
 * across chunks.
 *
 * The guard checks the tag name + a minimal structural shape so a
 * sibling-chunk `PrmDomainError` is recognised correctly. It deliberately
 * keeps the surface narrow — no string matching of error messages, no
 * pattern matching on stack traces. If something walks like a
 * `PrmDomainError` and quacks like a `PrmDomainError` (`name`, `code`,
 * numeric `status`), it is treated as one.
 */
export function isPrmDomainError(err: unknown): err is PrmDomainError {
  if (!err || typeof err !== 'object') return false
  if (err instanceof PrmDomainError) return true
  const candidate = err as {
    name?: unknown
    code?: unknown
    status?: unknown
    message?: unknown
  }
  return (
    candidate.name === 'PrmDomainError' &&
    typeof candidate.code === 'string' &&
    typeof candidate.status === 'number' &&
    typeof candidate.message === 'string'
  )
}

/** Standard envelope used by all PRM routes for error responses. */
export function toPrmErrorBody(err: PrmDomainError): {
  ok: false
  error: { code: PrmErrorCode; message: string; details?: Record<string, unknown> }
} {
  return {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  }
}

/**
 * Convenience helper used at the route layer to map MikroORM unique-violation errors
 * into the L-010 privacy-preserving envelope without revealing the conflicting Agency.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as any).code
  // Postgres SQLSTATE 23505 = unique_violation. MikroORM surfaces the original `code`.
  return code === '23505' || (err as any).constraintName !== undefined
}

/**
 * L-010 privacy-preserving message used when the GitHub-profile global UNIQUE trips.
 * Never reveals which Agency owns the conflicting profile.
 */
export const GITHUB_PROFILE_CONFLICT_MESSAGE =
  'A profile with this GitHub handle is already active in our partner network. Please contact OM PartnerOps if you believe this is in error.'

/**
 * Extract a user-facing message from an error thrown by `apiCallOrThrow` against a PRM route.
 *
 * `@open-mercato/ui`'s `raiseCrudError` only unpacks `data.error` when it is a string
 * or `data.message` at the top level; PRM routes use the structured envelope
 * `{ ok: false, error: { code, message } }` (see `toPrmErrorBody`), so the parser falls
 * through to the generic `"Request failed (NNN)"` placeholder. The original payload is
 * preserved on the thrown Error via `...data` spread, so we can recover the nested
 * message here. See `Documents/OM/ISSUE_LOG.md` ISSUE-006 for the upstream-side fix.
 */
export function extractPrmErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const nested = (err as { error?: { message?: unknown } }).error
    if (nested && typeof nested === 'object' && typeof (nested as { message?: unknown }).message === 'string') {
      const m = (nested as { message: string }).message.trim()
      if (m) return m
    }
    const direct = (err as { message?: unknown }).message
    if (typeof direct === 'string' && direct.trim() && !/^Request failed \(\d+\)$/.test(direct)) {
      return direct
    }
  }
  return fallback
}
