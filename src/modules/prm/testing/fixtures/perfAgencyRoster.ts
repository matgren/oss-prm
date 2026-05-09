/**
 * 500-agency synthetic roster generator (Spec #5 §9.6 #27 — perf smoke).
 *
 * Pure data generator — no I/O, no DB, no HTTP. Builds a deterministic
 * `Agency`-shaped roster previously consumed by a bulk-seed test route
 * (deleted on 2026-05-09 alongside the env-var-gated PRM test suite —
 * see SPEC-2026-05-09b). Kept as a generator so a future workers=1
 * perf smoke can reuse the deterministic shape without re-engineering
 * the tier/industry mix.
 *
 * Why a dedicated fixture (vs. a loop of `createAgencyFixture`):
 *   - 500 sequential `POST /api/prm/agency` calls take ~30-60s in the
 *     ephemeral runner — the smoke would spend 30x its perf budget on
 *     setup before it even measures the publish path.
 *   - We want a stable shape across re-runs so the assertion on the
 *     known-eligible agency stays deterministic across the test's lifetime.
 *
 * Tier distribution (FROZEN by this fixture for reproducibility — change
 * by minting a new generator if you need a different mix):
 *   - om_agency        — 50% = 250
 *   - ai_native        — 30% = 150
 *   - ai_native_expert — 15% =  75
 *   - ai_native_core   —  5% =  25
 *                              ----
 *                              500
 *
 * Industries / services: round-robin across the seeded `dictionaries` values
 * (`INDUSTRIES_DICTIONARY_SEED` / `SERVICES_DICTIONARY_SEED`) so every Agency
 * has 1-3 industries and 1-3 services. The eligibility evaluator's v1 filter
 * does not match on industries directly (Spec §5.1: filter is
 * `all_active | by_min_tier | explicit`), but populating the columns exercises
 * the wider read path — JSONB serialisation + decryption hooks — so the
 * smoke's wall-clock includes everything `evaluateRfpEligibility` would face
 * in production.
 *
 * Headquarters country: rotates US / GB / DE / PL / FR / IN so the country
 * column has variety; not asserted on directly but mirrors the real production
 * mix.
 *
 * Onboarded + status: every Agency lands `status='active'` AND `onboarded=true`,
 * which is what the `RfpService.publish` SQL pre-filter requires (Spec §6.1
 * analog). A small slice (5%) is `onboarded=false` so the SQL pre-filter has
 * something to actually filter — defence in depth against a bug that drops
 * the WHERE clause and broadcasts to everyone.
 *
 * Reusability: callers requiring a different size or tier mix should pass
 * `size` (and a future `tierWeights`) via the options arg. Future perf work
 * (e.g. 5k agencies for the §8.1 R2 "above ~5k push tier filter into SQL"
 * trigger) reuses this generator with `size: 5000`.
 */

import { randomUUID } from 'node:crypto'
import { AGENCY_TIERS, type AgencyTier } from '../../data/validators'

/** Headquarters country rotation. Not exhaustive — just enough variety. */
const HQ_COUNTRIES = ['US', 'GB', 'DE', 'PL', 'FR', 'IN'] as const

/**
 * Industries copy of `INDUSTRIES_DICTIONARY_SEED.value[]` — duplicated here
 * (instead of imported) so this fixture has zero coupling to the seed-side
 * code path. If the dictionary list ever changes, the smoke continues to seed
 * stable agency rows and a future test can verify the dictionary entries
 * separately.
 */
const INDUSTRIES = [
  'saas',
  'e-commerce',
  'fintech',
  'healthtech',
  'edtech',
  'manufacturing',
  'media-entertainment',
  'government-public-sector',
  'non-profit',
  'other',
] as const

const SERVICES = [
  'custom-web-development',
  'mobile-app-development',
  'ai-ml-integration',
  'data-engineering',
  'devops-cloud-infrastructure',
  'ui-ux-design',
  'product-strategy-consulting',
  'quality-assurance',
  'cybersecurity',
  'technical-training',
] as const

/** Tier weights summing to 100. FROZEN by this fixture for reproducibility. */
const TIER_PERCENT: ReadonlyArray<{ tier: AgencyTier; pct: number }> = [
  { tier: 'om_agency', pct: 50 },
  { tier: 'ai_native', pct: 30 },
  { tier: 'ai_native_expert', pct: 15 },
  { tier: 'ai_native_core', pct: 5 },
]

export type PerfAgencyRow = {
  /** Pre-minted UUID — bulk-seed seam inserts as-is so the test can pin
   *  expectations on a known-eligible agency. */
  id: string
  organizationId: string
  name: string
  slug: string
  tier: AgencyTier
  status: 'active'
  onboarded: boolean
  headquartersCountry: string
  industries: string[]
  services: string[]
  techCapabilities: string[]
}

export type PerfAgencyRoster = {
  agencies: ReadonlyArray<PerfAgencyRow>
  /** Per-tier counts for assertions in the smoke. */
  countsByTier: Record<AgencyTier, number>
  /** Subset of `agencies.id` that pass `by_min_tier=ai_native_expert AND
   *  onboarded=true AND status='active'`. The smoke uses this as the
   *  expected broadcast set. */
  eligibleIdsByMinTier: Record<AgencyTier, string[]>
  /** Pre-picked "spot-check" agency: a known `ai_native_core` agency that
   *  must always appear in any `by_min_tier=ai_native|ai_native_expert|
   *  ai_native_core` broadcast. Lets the smoke assert on a known id rather
   *  than only on count. */
  spotCheckAgencyId: string
}

/**
 * Compute per-tier counts that sum exactly to `size` from the FROZEN
 * `TIER_PERCENT` mix. Largest-remainder distribution so 500 → 250/150/75/25
 * cleanly and arbitrary `size` (e.g. 503) still distributes without rounding
 * errors. Internal: exported for the unit test only.
 */
export function tierCountsForSize(size: number): Record<AgencyTier, number> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`tierCountsForSize: size must be a positive integer, got ${size}`)
  }
  const raw = TIER_PERCENT.map((t) => ({ tier: t.tier, exact: (t.pct / 100) * size }))
  const floored = raw.map((r) => ({ tier: r.tier, n: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }))
  let allocated = floored.reduce((s, r) => s + r.n, 0)
  // Distribute the remainder (size - allocated) to the largest fractional parts.
  const remainder = size - allocated
  const sorted = [...floored].sort((a, b) => b.frac - a.frac)
  for (let i = 0; i < remainder; i++) {
    sorted[i % sorted.length]!.n += 1
  }
  const out = {} as Record<AgencyTier, number>
  for (const t of AGENCY_TIERS) out[t] = 0
  for (const f of floored) out[f.tier] = f.n
  return out
}

/**
 * Build a 500-agency synthetic roster.
 *
 * `slugPrefix` MUST be unique per test run to avoid colliding with prior
 * roster seeds in the same DB. The smoke passes a timestamp-derived prefix.
 * Slugs satisfy `^[a-z0-9]+(?:-[a-z0-9]+)*$` (Spec #1 invariant).
 *
 * The generator is deterministic given a fixed `slugPrefix` — every run
 * produces the same UUIDs would NOT be true (UUIDs come from `randomUUID()`),
 * so the spot-check agency is identified by its position (e.g. "first
 * `ai_native_core`") and the caller pins the id from the returned roster.
 */
export function buildPerfAgencyRoster(options: {
  slugPrefix: string
  size?: number
  /** Defaults to false — flip every 20th onboarded=false to exercise the
   *  publish-side SQL pre-filter. */
  withSomeNonOnboarded?: boolean
}): PerfAgencyRoster {
  const size = options.size ?? 500
  const counts = tierCountsForSize(size)
  const slugPrefix = options.slugPrefix
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugPrefix)) {
    throw new Error(
      `buildPerfAgencyRoster: slugPrefix "${slugPrefix}" must match ^[a-z0-9]+(?:-[a-z0-9]+)*$`,
    )
  }

  // Build the tier-tagged slot order: 250 om_agency, then 150 ai_native, etc.
  // Position-based assignment keeps the spot-check deterministic: the first
  // ai_native_core slot is always at index `counts.om_agency + counts.ai_native
  // + counts.ai_native_expert`, and that's the agency we pin as the
  // spot-check id.
  const slots: AgencyTier[] = []
  for (const tier of AGENCY_TIERS) {
    for (let i = 0; i < counts[tier]; i++) slots.push(tier)
  }
  if (slots.length !== size) {
    throw new Error(
      `buildPerfAgencyRoster: tier-slot count ${slots.length} !== requested size ${size}`,
    )
  }

  const agencies: PerfAgencyRow[] = []
  const eligibleIdsByMinTier: Record<AgencyTier, string[]> = {
    om_agency: [],
    ai_native: [],
    ai_native_expert: [],
    ai_native_core: [],
  }
  let spotCheckAgencyId: string | null = null

  for (let idx = 0; idx < slots.length; idx++) {
    const tier = slots[idx]!
    const id = randomUUID()
    const organizationId = randomUUID()

    // Onboarded slice: 95% onboarded, 5% NOT onboarded. The 5% must NOT
    // appear in any broadcast — exercises the SQL pre-filter.
    const onboarded = options.withSomeNonOnboarded ? idx % 20 !== 0 : true

    // Slot-determined industry/service spread so every dictionary entry
    // gets used. Two-of-ten per agency keeps the JSON column size realistic
    // (small Agencies typically pick 1-3 industries).
    const industries = [INDUSTRIES[idx % INDUSTRIES.length]!, INDUSTRIES[(idx + 3) % INDUSTRIES.length]!]
    const services = [SERVICES[idx % SERVICES.length]!, SERVICES[(idx + 2) % SERVICES.length]!]

    const country = HQ_COUNTRIES[idx % HQ_COUNTRIES.length]!
    const slug = `${slugPrefix}-${idx.toString(36).padStart(3, '0')}`
    const name = `Perf-${slugPrefix} #${idx} (${tier})`

    const row: PerfAgencyRow = {
      id,
      organizationId,
      name,
      slug,
      tier,
      status: 'active',
      onboarded,
      headquartersCountry: country,
      industries,
      services,
      techCapabilities: [],
    }
    agencies.push(row)

    if (onboarded) {
      // Compute eligibility per the same TIER_ORDER as `evaluateRfpEligibility`.
      const tierRank = AGENCY_TIERS.indexOf(tier)
      for (const minTier of AGENCY_TIERS) {
        const minRank = AGENCY_TIERS.indexOf(minTier)
        if (tierRank >= minRank) eligibleIdsByMinTier[minTier].push(id)
      }
    }

    // Pin the spot-check agency to the first `ai_native_core` we mint that
    // is also onboarded — guarantees it lands in every by_min_tier set
    // ≤ ai_native_core.
    if (spotCheckAgencyId === null && tier === 'ai_native_core' && onboarded) {
      spotCheckAgencyId = id
    }
  }

  if (!spotCheckAgencyId) {
    throw new Error(
      'buildPerfAgencyRoster: no onboarded ai_native_core agency was generated; ' +
        'spot-check pin would be undefined. Adjust tier mix or withSomeNonOnboarded.',
    )
  }

  return {
    agencies,
    countsByTier: counts,
    eligibleIdsByMinTier,
    spotCheckAgencyId,
  }
}
