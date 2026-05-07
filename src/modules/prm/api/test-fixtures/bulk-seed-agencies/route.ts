import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { AGENCY_TIERS } from '../../../data/validators'

/**
 * POST /api/prm/test-fixtures/bulk-seed-agencies — TEST-ONLY fixture seam.
 *
 * Bulk-inserts an `Organization` + paired `Agency` row per item via raw SQL.
 * Used by the Spec #5 §9.6 #27 perf-smoke (`TC-PRM-T5-PERF-001-*`) which
 * needs 500 agencies in <1s to keep the smoke under its end-to-end wall-
 * clock budget. Looping `POST /api/prm/agency` would take ~30-60s and
 * dominate the smoke's runtime.
 *
 * Privacy / safety contract — same as the sibling `reset` /
 * `agency-member-link` seams:
 *   - Auth: staff Bearer JWT with `prm.agency.invite_admin` (the same
 *     production feature, so the seam cannot widen authorisation).
 *   - Gate: `OM_PRM_TEST_FIXTURES_ENABLED=1`. Without that env this
 *     returns `404 Not found`, byte-identical to a non-existent route.
 *
 * Scope:
 *   - Inserts paired `organizations` + `prm_agencies` rows in a single
 *     transaction. Caller pre-mints the ids in the request payload so
 *     downstream assertions can pin known agency ids.
 *   - The seam scopes every Organization to the caller's tenant
 *     (`auth.tenantId`). Slug uniqueness is on `(tenant_id, slug)`.
 *   - Does NOT insert AgencyMembers, CustomerUsers, invitations, or any
 *     side-effect rows. The perf-smoke does not need portal auth — it
 *     publishes the RFP via the staff token.
 *
 * Out-of-scope: events. The seam intentionally skips `prm.agency.created`
 * + `prm.agency.tier_changed` — emitting 500 events per perf run would
 * pollute the event log and inflate the smoke wall-clock. The smoke
 * measures the publish hot path, not the agency-create cold path.
 */

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.agency.invite_admin'] },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const agencyRowSchema = z.object({
  id: z.string().regex(UUID_RE),
  organizationId: z.string().regex(UUID_RE),
  name: z.string().min(1).max(255),
  slug: z.string().regex(SLUG_RE).max(255),
  tier: z.enum(AGENCY_TIERS),
  status: z.literal('active'),
  onboarded: z.boolean(),
  headquartersCountry: z
    .string()
    .min(2)
    .max(2)
    .regex(/^[A-Z]{2}$/),
  industries: z.array(z.string().min(1).max(64)).max(20),
  services: z.array(z.string().min(1).max(64)).max(20),
  techCapabilities: z.array(z.string().min(1).max(64)).max(20),
})

const bodySchema = z.object({
  agencies: z.array(agencyRowSchema).min(1).max(2000),
})

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

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const knex = em.getKnex()

  const tenantId = auth.tenantId
  const now = new Date()

  // Paired Organization + Agency rows. Single explicit transaction so a
  // partial failure (e.g. unique violation on tenant_slug) rolls everything
  // back — the perf-smoke would otherwise leave half the roster behind and
  // pollute follow-up tests.
  const orgRows = parsed.data.agencies.map((a) => ({
    id: a.organizationId,
    tenant_id: tenantId,
    name: a.name,
    slug: a.slug,
    is_active: true,
    parent_id: null,
    root_id: null,
    tree_path: null,
    depth: 0,
    ancestor_ids: JSON.stringify([]),
    child_ids: JSON.stringify([]),
    descendant_ids: JSON.stringify([]),
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }))

  const agencyRows = parsed.data.agencies.map((a) => ({
    id: a.id,
    tenant_id: tenantId,
    organization_id: a.organizationId,
    name: a.name,
    slug: a.slug,
    description: null,
    website_url: null,
    logo_url: null,
    headquarters_country: a.headquartersCountry,
    headquarters_city: null,
    team_size_bucket: null,
    industries: JSON.stringify(a.industries),
    services: JSON.stringify(a.services),
    tech_capabilities: JSON.stringify(a.techCapabilities),
    tier: a.tier,
    status: a.status,
    contract_signed: a.onboarded,
    nda_signed: a.onboarded,
    onboarded: a.onboarded,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    version: 1,
  }))

  try {
    await knex.transaction(async (trx) => {
      // Chunked inserts so we don't blow past Postgres' 65535 bind-param
      // limit. With ~12 columns per organization row, 2000 rows × 12 = 24k
      // params — already over the limit. 500-row chunks keep us safely under.
      const ORG_CHUNK = 500
      for (let i = 0; i < orgRows.length; i += ORG_CHUNK) {
        await trx('organizations').insert(orgRows.slice(i, i + ORG_CHUNK))
      }
      const AGENCY_CHUNK = 500
      for (let i = 0; i < agencyRows.length; i += AGENCY_CHUNK) {
        await trx('prm_agencies').insert(agencyRows.slice(i, i + AGENCY_CHUNK))
      }
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { ok: false, error: `Bulk seed failed: ${message}` },
      { status: 500 },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      insertedAgencies: agencyRows.length,
      insertedOrganizations: orgRows.length,
    },
    { status: 200 },
  )
}

const successSchema = z.object({
  ok: z.literal(true),
  insertedAgencies: z.number().int().nonnegative(),
  insertedOrganizations: z.number().int().nonnegative(),
})
const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Test-only — bulk-insert paired Organization + Agency rows',
  description:
    'TEST-ONLY route. Bulk-inserts 1-2000 paired Organization + PRM Agency rows in a single transaction so the Spec #5 §9.6 #27 perf-smoke can seed a 500-agency roster in <1s. Gated by OM_PRM_TEST_FIXTURES_ENABLED=1; returns 404 otherwise. Skips events on purpose — the perf-smoke measures publish, not agency-create.',
  tags: ['PRM Test Fixtures'],
  requestBody: { schema: bodySchema },
  responses: [
    { status: 200, description: 'Bulk seed succeeded', schema: successSchema },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Authentication required', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Disabled (OM_PRM_TEST_FIXTURES_ENABLED unset)', schema: errorSchema },
    { status: 500, description: 'Insert failed', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Test-only — bulk-seed agencies',
  description:
    'Bulk-inserts paired Organization + Agency rows for the Spec #5 §9.6 perf-smoke. Disabled by default (OM_PRM_TEST_FIXTURES_ENABLED=1).',
  methods: { POST: postDoc },
}
