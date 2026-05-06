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
  NOT_FOUND: 'not_found',
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
