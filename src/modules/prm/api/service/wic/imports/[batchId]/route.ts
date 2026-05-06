import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { wicImportEnvelopeSchema } from '../../../../../data/validators'
import {
  processWicBatch,
  type WicProcessBatchResult,
} from '../../../../../lib/wicImportService'
import { authenticateServiceRequest } from '../../../../../lib/serviceAuthMiddleware'

/**
 * POST /api/prm/service/wic/imports/[batchId] — US6.2 (Spec #4 §3.3).
 *
 * Service-identity auth via ServiceAuthMiddleware. Per-row processing through the
 * Anti-Corruption Layer (`processWicBatch` → `processWicRow`). Per-row failures land
 * in `WicImportAuditLog`, NOT 422s. Only envelope-shape failures are 422.
 *
 * Idempotency replay (same `X-Om-Idempotency-Key` + same payload) is handled by
 * the middleware before this handler runs.
 */

export const metadata = {
  POST: { requireAuth: false },
}

const BATCH_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ENDPOINT = 'POST /api/prm/service/wic/imports'

type RouteCtx = { params: Promise<{ batchId: string }> | { batchId: string } }

function shapeRowResponse(rows: WicProcessBatchResult['rows']) {
  return rows.map((r) => {
    if (r.status === 'rejected') {
      return {
        row_index: r.rowIndex,
        status: 'rejected' as const,
        audit_log_id: r.auditLogId,
        rejection_reason: r.rejectionReason,
      }
    }
    if (r.status === 'superseded') {
      return {
        row_index: r.rowIndex,
        status: 'accepted' as const,
        contribution_id: r.contributionId,
        superseded_previous_contribution_id: r.previousContributionId,
      }
    }
    return {
      row_index: r.rowIndex,
      status: 'accepted' as const,
      contribution_id: r.contributionId,
    }
  })
}

export async function POST(req: Request, ctx: RouteCtx) {
  const params = await Promise.resolve(ctx.params)
  const batchId = params?.batchId
  if (!batchId || !BATCH_ID_REGEX.test(batchId)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid batch_id (must be UUIDv4)' },
      { status: 400 },
    )
  }

  // Read body once; pass to middleware for hashing AND to JSON.parse for handler.
  const bodyText = await req.text()

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const auth = await authenticateServiceRequest(req, {
    endpoint: ENDPOINT,
    em,
    bodyText,
  })
  if (!auth.ok) return auth.response

  // Envelope-level Zod (failures = 422; per-row failures live in the ACL).
  let parsedJson: unknown
  try {
    parsedJson = bodyText.length === 0 ? {} : JSON.parse(bodyText)
  } catch {
    return NextResponse.json({ ok: false, error: 'Body is not valid JSON' }, { status: 400 })
  }
  const envelope = wicImportEnvelopeSchema.safeParse(parsedJson)
  if (!envelope.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Envelope validation failed',
        details: envelope.error.flatten().fieldErrors,
      },
      { status: 422 },
    )
  }

  const tenantId = auth.identity.tenantId
  const organizationId = auth.identity.organizationId
  if (!tenantId || !organizationId) {
    return NextResponse.json(
      { ok: false, error: 'WIC tenant context unresolved' },
      { status: 503 },
    )
  }

  let result
  try {
    result = await processWicBatch(
      em,
      {
        importBatchId: batchId,
        envelopeMonth: envelope.data.month,
        scriptVersion: envelope.data.script_version,
        rawRows: envelope.data.rows,
        tenantId,
        organizationId,
      },
      container,
    )
  } catch (err) {
    // Surface the actual exception so test failures are actionable. Production should
    // tighten this to a generic 500 with a structured error code; tracked in
    // POST-MVP-FOLLOW-UPS.
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { ok: false, error: 'WIC batch processing failed', detail: message },
      { status: 500 },
    )
  }

  const responseBody = {
    import_batch_id: result.importBatchId,
    accepted_count: result.acceptedCount,
    rejected_count: result.rejectedCount,
    superseded_count: result.supersededCount,
    per_row: shapeRowResponse(result.rows),
    idempotent_replay: false,
  }

  // Persist idempotency for replay before responding.
  if (auth.persistIdempotency) {
    await auth.persistIdempotency({
      em,
      responseStatus: 200,
      responseBody,
    })
  }

  return NextResponse.json(responseBody, { status: 200 })
}

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const perRowSchema = z.object({
  row_index: z.number(),
  status: z.enum(['accepted', 'rejected']),
  contribution_id: z.string().uuid().optional(),
  superseded_previous_contribution_id: z.string().uuid().optional(),
  audit_log_id: z.string().uuid().optional(),
  rejection_reason: z.string().optional(),
})

const responseSchema = z.object({
  import_batch_id: z.string().uuid(),
  accepted_count: z.number(),
  rejected_count: z.number(),
  superseded_count: z.number(),
  per_row: z.array(perRowSchema),
  idempotent_replay: z.boolean(),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'WIC import batch (US6.2)',
  description:
    'Accepts a per-month batch of WIC contributions from the n8n classifier. Per-row failures land in WicImportAuditLog; envelope failures are 422.',
  tags: ['PRM WIC Service'],
  requestBody: { schema: wicImportEnvelopeSchema, description: 'Batch payload with per-row records.' },
  responses: [
    {
      status: 200,
      description: 'OK — batch processed (may contain rejections per-row)',
      schema: responseSchema,
    },
  ],
  errors: [
    { status: 400, description: 'Bad headers/JSON/batch_id', schema: errorSchema },
    { status: 401, description: 'Bad/missing X-Om-Import-Secret', schema: errorSchema },
    { status: 408, description: 'Timestamp outside ±5min window', schema: errorSchema },
    { status: 409, description: 'X-Om-Idempotency-Key reused with different payload', schema: errorSchema },
    { status: 422, description: 'Envelope validation failed', schema: errorSchema },
    { status: 503, description: 'WIC import secret / tenant context not configured', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM WIC service — batch import',
  description: 'Service-identity POST endpoint for n8n WIC monthly batch ingestion.',
  methods: { POST: postDoc },
}
