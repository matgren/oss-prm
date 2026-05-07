import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { attributeLicenseDealSchema } from '../../../../data/validators'
import type { LicenseDealService } from '../../../../lib/licenseDealService'
import { runInlineSaga } from '../../../../lib/attributionSaga'
import { isPrmDomainError, toPrmErrorBody } from '../../../../lib/errors'
import { summariseLicenseDeal } from '../../route'

/**
 * Backend `POST /api/prm/license-deal/{id}/attribute` (Spec #3 §3.1.1).
 *
 * Single attribution commit: applies the discriminated input, transitions
 * `pending → signed`, fires the saga via `prm.license_deal.attributed`. Returns
 * `202 Accepted` with `{ correlationKey, emittedEvents }`.
 *
 * The platform's wildcard event-trigger subscriber picks up the emitted event
 * and runs the seeded `prm.license_deal.attribution_saga` definition. We also
 * run the inline saga synchronously (idempotent) so the response reflects the
 * fully-applied state — convenient for tests and for the v1 portal MIN widget
 * which doesn't yet subscribe to SSE.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.license_deal.write'] },
}

function extractId(req: Request): string | null {
  try {
    const segments = new URL(req.url).pathname.split('/').filter(Boolean)
    const idx = segments.findIndex((s) => s === 'license-deal')
    return idx >= 0 && segments[idx + 1] ? decodeURIComponent(segments[idx + 1]) : null
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const id = extractId(req)
  if (!id) return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = attributeLicenseDealSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const service = container.resolve('licenseDealService') as LicenseDealService
  try {
    const result = await service.attribute(id, parsed.data, {
      tenantId: auth.tenantId,
      actor: { type: 'user', userId: auth.sub ?? 'unknown' },
    })

    // Inline saga — idempotent. Drives Path A markProspectWon synchronously so
    // the API caller sees a fully-resolved aggregate without waiting for the
    // workflow runtime. The platform's wildcard subscriber will also fire the
    // saga; the activity handler is read-before-write idempotent so the second
    // run is a no-op.
    const em = container.resolve('em') as EntityManager
    await runInlineSaga(
      {
        licenseDealId: result.licenseDeal.id,
        tenantId: result.licenseDeal.tenantId,
        organizationId: result.licenseDeal.organizationId,
        attributionPath: result.licenseDeal.attributionPath as 'A' | 'B' | 'C' | 'none',
        attributionSource: result.licenseDeal.attributionSource as 'prospect' | 'rfp' | 'direct',
        prospectId: result.licenseDeal.prospectId ?? null,
        rfpId: result.licenseDeal.rfpId ?? null,
        attributedAgencyId: result.licenseDeal.attributedAgencyId ?? null,
        competingProspectIdsToRetire:
          parsed.data.attribution_path === 'A' ? parsed.data.competing_prospect_ids_to_retire : [],
        correlationKey: result.correlationKey,
      },
      { em, container: container as unknown as Parameters<typeof runInlineSaga>[1]['container'] },
    )

    // Re-fetch so we serialise the saga's snapshot writes too.
    const refreshed = await service.findById(result.licenseDeal.id, { tenantId: auth.tenantId })
    return NextResponse.json(
      {
        ok: true,
        licenseDealId: result.licenseDeal.id,
        sagaCorrelationKey: result.correlationKey,
        emittedEvents: result.emittedEvents,
        licenseDeal: summariseLicenseDeal(refreshed ?? result.licenseDeal),
      },
      { status: 202 },
    )
  } catch (err) {
    if (isPrmDomainError(err)) {
      return NextResponse.json(toPrmErrorBody(err), { status: err.status })
    }
    throw err
  }
}

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.any()).optional() }),
  ]),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Attribute a license deal (Path A / B / C)',
  description: 'Single attribution commit. Transitions `pending → signed`, fires the saga, returns 202 with correlationKey + emitted events.',
  tags: ['PRM Backend'],
  requestBody: { schema: attributeLicenseDealSchema, description: 'Discriminated attribution input' },
  responses: [
    {
      status: 202,
      description: 'Accepted (saga running async)',
      schema: z.object({
        ok: z.literal(true),
        licenseDealId: z.string().uuid(),
        sagaCorrelationKey: z.string(),
        emittedEvents: z.array(z.string()),
        licenseDeal: z.record(z.string(), z.any()),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'License deal / Prospect / Agency / RFP not found', schema: errorSchema },
    { status: 409, description: 'Attribution frozen / status conflict / Path-B locked RFP', schema: errorSchema },
    { status: 422, description: 'attribution_reasoning required for override', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Attribute a license deal',
  methods: { POST: postDoc },
}
