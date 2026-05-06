import { Client } from 'pg'

const PRM_TABLES = [
  'prm_license_deals',
  'prm_prospect_candidate_index',
  'prm_prospects',
  'prm_agency_members',
  'prm_agencies',
] as const

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for PRM integration helpers. ' +
        'Run inside the ephemeral runner (yarn test:integration:ephemeral) or export DATABASE_URL.',
    )
  }
  return url
}

/**
 * TRUNCATE all PRM-owned tables (CASCADE) so a smoke test starts from a clean
 * PRM state. Does not touch core tables — safe to call between tests in the
 * ephemeral integration runner. Caller is responsible for re-seeding any
 * fixtures the test needs.
 */
export async function resetPRMState(): Promise<void> {
  const client = new Client({ connectionString: resolveDatabaseUrl() })
  await client.connect()
  try {
    const tableList = PRM_TABLES.map((name) => `"${name}"`).join(', ')
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`)
  } finally {
    await client.end()
  }
}

/**
 * Placeholder for Phase 4. Inserts a minimal Agency + a partner-admin user
 * record so portal-flow smokes can authenticate as an agency partner.
 * Not implemented yet — Phase 4 will fill this in once the partner-admin
 * portal auth flow is wired through the test harness.
 */
export async function seedAgencyForTesting(_options: {
  agencyName?: string
  agencySlug?: string
  partnerAdminEmail?: string
}): Promise<{ agencyId: string; agencySlug: string; partnerAdminEmail: string }> {
  throw new Error('seedAgencyForTesting is not yet implemented — see Phase 4 of the run plan.')
}
