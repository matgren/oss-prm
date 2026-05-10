import { AGENCY_TIERS, type AgencyTier } from '../data/validators'

/**
 * Static tier-requirements registry (Spec #2 §2 — wip-scoreboard).
 *
 * The App Spec §1.4.7 calls for a `tier_requirements` table seeded by Spec #1; that
 * seed was deferred (see SPEC-2026-04-23-agency-foundation.md changelog "Deferred").
 * For Phase 2 we ship the registry as an in-code constant — it is read-only static
 * data and the dashboard tier-progress widget consumes it through this helper.
 *
 * If a future spec promotes this to a DB table, the helper signature stays stable;
 * only the implementation switches from constant lookup to a query.
 *
 * Numbers are illustrative defaults derived from the App Spec; exact thresholds will
 * be tuned by OM PartnerOps post-launch via a follow-up settings UI.
 */
export type TierRequirement = {
  tier: AgencyTier
  /** Minimum WIP (qualified prospect) count required to unlock this tier. */
  minWip: number
  /** Minimum monthly WIC contribution count required to unlock this tier. */
  minMonthlyWic: number
  /**
   * Minimum MIN (attributed enterprise licenses) per partnership year — the
   * third KPI rail in tier evaluation. Values derived from App Spec §1.4
   * tier-thresholds table.
   */
  minYearlyMin: number
  /** Display rank (used to compute pct-to-next-tier and order in widgets). */
  rank: number
}

const REQUIREMENTS: Readonly<Record<AgencyTier, TierRequirement>> = {
  om_agency: { tier: 'om_agency', minWip: 0, minMonthlyWic: 0, minYearlyMin: 1, rank: 0 },
  ai_native: { tier: 'ai_native', minWip: 5, minMonthlyWic: 1, minYearlyMin: 2, rank: 1 },
  ai_native_expert: { tier: 'ai_native_expert', minWip: 15, minMonthlyWic: 3, minYearlyMin: 5, rank: 2 },
  ai_native_core: { tier: 'ai_native_core', minWip: 40, minMonthlyWic: 8, minYearlyMin: 5, rank: 3 },
}

export function getTierRequirement(tier: AgencyTier): TierRequirement {
  return REQUIREMENTS[tier]
}

export function listTierRequirements(): TierRequirement[] {
  return AGENCY_TIERS.map((t) => REQUIREMENTS[t])
}

/**
 * Returns the next tier above `current`, or null if `current` is already the top tier.
 */
export function getNextTier(current: AgencyTier): TierRequirement | null {
  const cur = REQUIREMENTS[current]
  const next = AGENCY_TIERS.map((t) => REQUIREMENTS[t]).find((r) => r.rank === cur.rank + 1)
  return next ?? null
}

/**
 * Compute pct-to-next-tier given current WIP + monthly WIC totals.
 * Returns 1.0 when at top tier or thresholds already met.
 */
export function computeTierProgress(input: {
  current: AgencyTier
  currentWip: number
  currentMonthlyWic: number
  /** Optional — when omitted, MIN does not bound pctToNext. */
  currentYearlyMin?: number
}): {
  current: TierRequirement
  next: TierRequirement | null
  /** 0..1, fraction toward next tier across all 3 metrics (whichever is lagging). */
  pctToNext: number
} {
  const current = REQUIREMENTS[input.current]
  const next = getNextTier(input.current)
  if (!next) {
    return { current, next: null, pctToNext: 1 }
  }
  const wipPct = next.minWip > 0 ? Math.min(1, input.currentWip / next.minWip) : 1
  const wicPct =
    next.minMonthlyWic > 0 ? Math.min(1, input.currentMonthlyWic / next.minMonthlyWic) : 1
  const minPct =
    input.currentYearlyMin == null || next.minYearlyMin === 0
      ? 1
      : Math.min(1, input.currentYearlyMin / next.minYearlyMin)
  return { current, next, pctToNext: Math.min(wipPct, wicPct, minPct) }
}
