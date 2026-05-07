import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import {
  requireCustomerAuth,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { draftRfpResponseSchema } from '../../../../../../data/validators'
import { PrmDomainError } from '../../../../../../lib/errors'
import type { AgencyMemberService } from '../../../../../../lib/agencyMemberService'
import type { RfpService } from '../../../../../../lib/rfpService'
import {
  assertBroadcastedOrNotFound,
  RfpVisibilityNotFoundError,
  rfpNotFoundResponse,
} from '../../../../../../lib/rfpVisibility'

/**
 * POST /api/prm/portal/rfp/{id}/response/draft (Spec #5 §3.2 / US5.4 step 2/5).
 *
 * Auto-save endpoint for the P10 response form. Idempotent upsert by
 * `(rfp_id, agency_id)` — first POST creates the row + stamps
 * `submitted_by_member_id`; subsequent POSTs only update content fields.
 *
 * Rate-limit (R7): 4 req/s per CustomerUser. The client debounces at 500ms,
 * which keeps a fast typist below the cap; the server rate-limit catches
 * pathological cases (multi-tab, browser key-repeat) before they flood the
 * event bus.
 *
 * Visibility gate runs before any write — silent 404 (invariant #15).
 */
// Customer-portal route — auth is enforced inside the handler via
// `requireCustomerAuth` (customer JWT). The framework `/api/[...slug]`
// catch-all rejects requests without a *staff* JWT by default; setting
// `requireAuth: false` on each method defers auth to the handler so the
// customer JWT path can run.
export const metadata = {
  POST: { requireAuth: false },
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> | { id: string } },
) {
  let auth
  try {
    auth = await requireCustomerAuth(req)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(auth, ['portal.partner.access'], rbac)
  } catch (resp) {
    if (resp instanceof Response) return resp
    throw resp
  }

  // Optional rate-limit (4 req/s per CustomerUser). Disabled in tests / in envs
  // without a configured limiter — same fallback contract as
  // ReinviteCooldownService.
  let rateLimiter: RateLimiterService | null = null
  try {
    rateLimiter = container.resolve('rateLimiterService') as RateLimiterService
  } catch {
    rateLimiter = null
  }
  if (rateLimiter) {
    const result = await rateLimiter.consume(`prm:rfp-draft:${auth.sub}`, {
      points: 4,
      duration: 1,
      blockDuration: 1,
      keyPrefix: 'prm-rfp-draft',
    })
    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.msBeforeNext / 1000) || 1
      return NextResponse.json(
        { ok: false, error: { code: 'rate_limited', message: 'Too many draft saves — slow down.' } },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSec),
            'X-RateLimit-Limit': '4',
            'X-RateLimit-Remaining': String(result.remainingPoints),
          },
        },
      )
    }
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    )
  }
  const parsed = draftRfpResponseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const params = await Promise.resolve(ctx.params)
  const memberService = container.resolve('agencyMemberService') as AgencyMemberService
  const member = await memberService.findByCustomerUserId(auth.sub, { tenantId: auth.tenantId })
  if (!member) return rfpNotFoundResponse()

  const em = container.resolve('em') as EntityManager
  try {
    await assertBroadcastedOrNotFound(params.id, member.agencyId, em, {
      organizationId: auth.orgId,
    })
  } catch (err) {
    if (err instanceof RfpVisibilityNotFoundError) return rfpNotFoundResponse()
    throw err
  }

  const rfpService = container.resolve('rfpService') as RfpService
  try {
    const { response, emitted } = await rfpService.upsertResponseDraft(
      params.id,
      member.agencyId,
      member.id,
      parsed.data,
      { organizationId: auth.orgId },
    )
    return NextResponse.json({
      ok: true,
      id: response.id,
      status: response.status,
      lastUpdatedAt: response.lastUpdatedAt.toISOString(),
      emitted,
    })
  } catch (err) {
    if (err instanceof PrmDomainError) {
      return NextResponse.json(
        { ok: false, error: { code: err.code, message: err.message } },
        { status: err.status },
      )
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
  summary: 'Save (or auto-save) an RFP response draft',
  description:
    'Idempotent upsert by (rfp_id, agency_id). First call stamps submitted_by_member_id. Emits prm.rfp_response.draft_saved only on content-hash change.',
  tags: ['PRM Portal'],
  requestBody: {
    contentType: 'application/json',
    schema: draftRfpResponseSchema,
  },
  responses: [
    {
      status: 200,
      description: 'Draft saved',
      schema: z.object({
        ok: z.literal(true),
        id: z.string().uuid(),
        status: z.enum(['draft', 'submitted']),
        lastUpdatedAt: z.string(),
        emitted: z.boolean(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Missing portal.partner.access', schema: errorSchema },
    { status: 404, description: 'Not visible (silent 404 — uniform body)', schema: errorSchema },
    { status: 409, description: 'RFP no longer accepting draft updates', schema: errorSchema },
    { status: 429, description: 'Rate limited (4 req/s per CustomerUser)', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Portal RFP response — draft auto-save',
  methods: { POST: postDoc },
}
