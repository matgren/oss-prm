import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'

/**
 * POST /api/prm/test-fixtures/reset — TEST-ONLY fixture seam.
 *
 * TRUNCATEs every PRM-owned table in the current schema so subsequent
 * Playwright specs in the same ephemeral run start from a clean PRM slice.
 * Closes the cross-spec test-isolation bleed where Agencies seeded by
 * upstream specs (T0/T1/T2/T3) leak into `TC-PRM-T5-001 §9.1 #1`'s eligibility
 * evaluation and inflate the broadcast set from `[A, B]` to `[A, B, +leftovers]`.
 *
 * Privacy / safety contract — same as the sibling `agency-member-link` seam:
 *   - Auth: staff Bearer JWT with `prm.agency.invite_admin`. Reuses the
 *     production feature so the seam can never widen authorisation.
 *   - Gate: `OM_PRM_TEST_FIXTURES_ENABLED=1`. Without that env this returns
 *     `404 Not found`, byte-identical to a non-existent route — production
 *     deployments leak no signal. The integration runner sets this in the
 *     ephemeral env via the test config.
 *
 * Scope:
 *   - TRUNCATEs ONLY tables owned by the PRM module (i.e. `prm_*` rows).
 *     Non-PRM tables (organizations, customer_users, customer_user_invitations,
 *     customer_roles, customer_user_roles, etc.) are intentionally untouched —
 *     those are seeded once per ephemeral run by the bootstrap step and the
 *     suite depends on that state surviving across specs.
 *   - Single `TRUNCATE ... RESTART IDENTITY CASCADE` statement covering every
 *     PRM table in `data/entities.ts`. CASCADE is safe because no non-PRM
 *     table FKs into a PRM table (PRM is leaf-only by the OM "no direct ORM
 *     relationships between modules" rule).
 *
 * Tracked under POST-MVP follow-ups (test isolation for Playwright
 * integration tests).
 */

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.agency.invite_admin'] },
}

/**
 * PRM-owned tables. Derived from `@Entity({ tableName: ... })` annotations
 * in `src/modules/prm/data/entities.ts`. Order is mostly cosmetic — TRUNCATE
 * with CASCADE handles dependencies — but keeping child→parent reads better
 * for humans grepping through the seam later.
 */
const PRM_TABLES = [
  'prm_agency_members',
  'prm_prospect_candidate_index',
  'prm_rfp_response_scores',
  'prm_rfp_responses',
  'prm_rfp_broadcasts',
  'prm_rfps',
  'prm_license_deals',
  'prm_prospects',
  'prm_agencies',
  'prm_case_studies',
  'prm_marketing_materials',
  'prm_wic_contributions',
  'prm_wic_import_audit_log',
  'prm_service_idempotency_key',
] as const

function fixturesEnabled(): boolean {
  return process.env.OM_PRM_TEST_FIXTURES_ENABLED === '1'
}

function notFound(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  if (!fixturesEnabled()) return notFound()

  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const knex = em.getKnex()

  // Single statement so Postgres handles dependency order internally and
  // RESTART IDENTITY resets any sequence side-effects. CASCADE is defensive —
  // PRM has no non-PRM FK pointing into it, but if a future migration adds
  // one we'd rather TRUNCATE the dependent than fail mysteriously.
  const tableList = PRM_TABLES.join(', ')
  await knex.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`)

  return NextResponse.json(
    {
      ok: true,
      truncatedTables: [...PRM_TABLES],
    },
    { status: 200 },
  )
}

const successSchema = z.object({
  ok: z.literal(true),
  truncatedTables: z.array(z.string()),
})
const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Test-only — TRUNCATE every PRM-owned table',
  description:
    'TEST-ONLY route. TRUNCATEs every PRM-owned table (prm_*) so Playwright integration specs start from a clean PRM slice. Non-PRM tables (organizations, customer_users, customer_roles, ...) are untouched. Gated by OM_PRM_TEST_FIXTURES_ENABLED=1; returns 404 otherwise.',
  tags: ['PRM Test Fixtures'],
  responses: [
    { status: 200, description: 'PRM tables truncated', schema: successSchema },
  ],
  errors: [
    { status: 401, description: 'Authentication required', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Disabled (OM_PRM_TEST_FIXTURES_ENABLED unset)', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Test-only — TRUNCATE PRM tables',
  description:
    'Resets the PRM slice so Playwright integration specs do not leak rows into siblings. Disabled by default (OM_PRM_TEST_FIXTURES_ENABLED=1).',
  methods: { POST: postDoc },
}
