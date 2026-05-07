import type { Agency } from '../data/entities'
import { AGENCY_TIERS, type AgencyTier } from '../data/validators'

/**
 * RFP eligibility evaluator (Spec #5 §2 / §9.6 R2).
 *
 * Pure function — extracted from `RfpService` so the matching rules can be
 * unit-tested in isolation and a future v2 perf rewrite (push more of the
 * filter into SQL) doesn't have to bring the entire service along.
 *
 * Inputs:
 *   - `filter` — the RFP's `eligibility_filter` enum + companion fields.
 *   - `agencies` — the candidate roster. Caller is expected to pre-filter to
 *     `status='active' AND onboarded=true AND deleted_at IS NULL` at the SQL
 *     layer (the cheap part). This function applies the harder JSON-array
 *     intersections + tier comparisons in app code.
 *
 * Returns the subset of `agencies` that pass the filter.
 *
 * Filter semantics:
 *   - `all_active`     — every (already pre-filtered) Agency passes.
 *   - `by_min_tier`    — Agency.tier ≥ filter.minTier in TIER_ORDER below.
 *   - `explicit`       — Agency.id ∈ filter.explicitAgencyIds.
 *
 * Tier ordering (lowest → highest, FROZEN):
 *   `om_agency` < `ai_native` < `ai_native_expert` < `ai_native_core`.
 *
 * Hot-path note: at v1 (~tens-to-hundreds of agencies) the O(N) loop is well
 * within the §9.6 #27 perf-smoke target (publish < 2s P95 at 500 agencies).
 * Above ~5k agencies, push the tier filter into SQL via a `WHERE tier = ANY(...)`
 * with the precomputed list of acceptable tiers.
 */

export type RfpEligibilityFilterInput =
  | { kind: 'all_active' }
  | { kind: 'by_min_tier'; minTier: AgencyTier }
  | { kind: 'explicit'; explicitAgencyIds: string[] }

const TIER_ORDER: ReadonlyArray<AgencyTier> = AGENCY_TIERS

function tierRank(tier: string): number {
  return TIER_ORDER.indexOf(tier as AgencyTier)
}

export function evaluateRfpEligibility(
  filter: RfpEligibilityFilterInput,
  agencies: ReadonlyArray<Pick<Agency, 'id' | 'tier'>>,
): Agency['id'][] {
  switch (filter.kind) {
    case 'all_active':
      return agencies.map((a) => a.id)
    case 'by_min_tier': {
      const minRank = tierRank(filter.minTier)
      if (minRank < 0) return []
      return agencies.filter((a) => tierRank(a.tier) >= minRank).map((a) => a.id)
    }
    case 'explicit': {
      const allow = new Set(filter.explicitAgencyIds)
      return agencies.filter((a) => allow.has(a.id)).map((a) => a.id)
    }
  }
}

/**
 * Adapter that translates the persisted shape (RFP entity columns) into the
 * input the pure evaluator expects. Centralises the mapping so callers (route
 * + service) only know about the high-level intent.
 */
export function toEligibilityFilterInput(rfp: {
  eligibilityFilter: string
  minTier?: string | null
  explicitAgencyIds?: string[] | null
}): RfpEligibilityFilterInput {
  if (rfp.eligibilityFilter === 'all_active') return { kind: 'all_active' }
  if (rfp.eligibilityFilter === 'by_min_tier') {
    if (!rfp.minTier) {
      throw new Error('toEligibilityFilterInput: by_min_tier requires minTier')
    }
    return { kind: 'by_min_tier', minTier: rfp.minTier as AgencyTier }
  }
  if (rfp.eligibilityFilter === 'explicit') {
    const ids = rfp.explicitAgencyIds ?? []
    if (ids.length === 0) {
      throw new Error('toEligibilityFilterInput: explicit requires non-empty explicitAgencyIds')
    }
    return { kind: 'explicit', explicitAgencyIds: ids }
  }
  throw new Error(`toEligibilityFilterInput: unknown eligibility_filter "${rfp.eligibilityFilter}"`)
}
