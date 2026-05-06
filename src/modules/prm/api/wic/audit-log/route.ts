import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { WicImportAuditLog } from '../../../data/entities'
import { WIC_REJECTION_REASONS, WIC_RESOLUTION_ACTIONS } from '../../../data/validators'

/**
 * GET /api/prm/wic/audit-log — B10 server side (Spec #4 §3.4).
 *
 * Backend-only. Session cookie + `prm.wic.resolve` ACL feature. List/filter the
 * `WICImportAuditLog` rows for OM PartnerOps triage.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['prm.wic.resolve'] },
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  resolved: z.enum(['false', 'true', 'all']).default('false'),
  rejection_reason: z.enum(WIC_REJECTION_REASONS).optional(),
  import_batch_id: z.string().uuid().optional(),
})

function summarise(row: WicImportAuditLog) {
  return {
    id: row.id,
    importBatchId: row.importBatchId,
    rowIndex: row.rowIndex,
    rejectionReason: row.rejectionReason,
    rejectionDetail: row.rejectionDetail ?? null,
    resolvedAgencyId: row.resolvedAgencyId ?? null,
    rawPayload: row.rawPayload,
    scriptVersion: row.scriptVersion,
    month: row.month,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolutionAction: row.resolutionAction ?? null,
    resolutionNote: row.resolutionNote ?? null,
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const url = new URL(req.url)
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { page, pageSize, resolved, rejection_reason, import_batch_id } = parsed.data

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  // WIC audit-log is **tenant-wide** by design. Per Spec §6.1 WIC ingestion is
  // tenant-scoped (one tenant context per service-identity request); the
  // `organization_id` column on `prm_wic_import_audit_logs` is informational —
  // it captures whichever Agency Organization the singleton resolver pinned at
  // import time. Filtering reads by `organizationId` here would (a) hide rows
  // from staff users in tenants where the pinned Org differs from the staff Org,
  // and (b) diverge from the established PRM convention — `agency`, `prospects`,
  // and `license-deal` list routes all scope by `tenantId` only. Staff users see
  // every audit-log entry in their tenant; no cross-tenant leak.
  const where: Record<string, unknown> = { tenantId: auth.tenantId }
  if (resolved === 'false') where.resolvedAt = null
  else if (resolved === 'true') where.resolvedAt = { $ne: null }
  if (rejection_reason) where.rejectionReason = rejection_reason
  if (import_batch_id) where.importBatchId = import_batch_id

  const [items, total] = await findAndCountWithDecryption<WicImportAuditLog>(
    em,
    WicImportAuditLog,
    where as FilterQuery<WicImportAuditLog>,
    {
      orderBy: { createdAt: 'desc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
    { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
  )

  return NextResponse.json({
    ok: true,
    items: items.map(summarise),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

const auditRowSchema = z.object({
  id: z.string().uuid(),
  importBatchId: z.string().uuid(),
  rowIndex: z.number(),
  rejectionReason: z.string(),
  rejectionDetail: z.string().nullable(),
  resolvedAgencyId: z.string().uuid().nullable(),
  rawPayload: z.record(z.string(), z.unknown()),
  scriptVersion: z.string(),
  month: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedByUserId: z.string().uuid().nullable(),
  resolutionAction: z.string().nullable(),
  resolutionNote: z.string().nullable(),
})

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const getDoc: OpenApiMethodDoc = {
  summary: 'WIC import audit log (B10)',
  description: 'Backend list endpoint over WICImportAuditLog rows. RBAC: prm.wic.resolve.',
  tags: ['PRM WIC'],
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        items: z.array(auditRowSchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM WIC — audit log',
  description: 'B10 backend list endpoint for OM PartnerOps WIC triage.',
  methods: { GET: getDoc },
}

export const __wicAuditLogTesting = { listQuerySchema, summarise }

// Re-export so the resolve route can hold off building its own Zod.
export { WIC_RESOLUTION_ACTIONS } from '../../../data/validators'
