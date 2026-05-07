/**
 * Tier rank lookup for `MarketingMaterial` visibility (Spec #7 §3.4).
 *
 * The `min_tier_rank` column on `prm_marketing_materials` is maintained by
 * the application (not a Postgres `GENERATED ALWAYS AS (...) STORED` column,
 * which has portability gotchas across MikroORM minor versions).
 *
 * Tier rank ordering — `om_agency = 1 < ai_native = 2 < ai_native_expert = 3
 * < ai_native_core = 4`. Same lookup used by Spec #1 conceptually for tier
 * progression, surfaced here so the SQL filter (`min_tier_rank <= :viewer_rank`)
 * can run as a numeric comparison.
 */
import { AGENCY_TIERS, type AgencyTier } from '../data/validators'

export const TIER_RANK: Record<AgencyTier, number> = {
  om_agency: 1,
  ai_native: 2,
  ai_native_expert: 3,
  ai_native_core: 4,
}

export function tierRank(tier: string | null | undefined): number | null {
  if (!tier) return null
  if (!isAgencyTier(tier)) return null
  return TIER_RANK[tier]
}

export function isAgencyTier(value: string): value is AgencyTier {
  return (AGENCY_TIERS as readonly string[]).includes(value)
}
