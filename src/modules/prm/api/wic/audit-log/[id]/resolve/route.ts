import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { WIC_RESOLUTION_ACTIONS } from '../../../../../data/validators'
import {
  execute as executeResolve,
  isWicAuditLogAlreadyResolvedError,
  isWicAuditLogNotFoundError,
} from '../../../../../commands/wic/resolveWicImportAuditLog'

/**
 * POST /api/prm/wic/audit-log/[id]/resolve — B10 row action (Spec #4 §3.4 + §6.2).
 *
 * RBAC: prm.wic.resolve. Marks an audit-log row as resolved with one of three actions.
 * Re-resolving an already-resolved row returns 409 (use a future `unresolve` command for that).
 *
 * The atomic write + `prm.wic_import.resolved` event emit is delegated to
 * `ResolveWicImportAuditLogCommand.execute` (Spec §4.1). The handler stays thin:
 * auth + Zod + sentinel-error → status mapping. Undo of a resolution is owned by
 * the command's `undo` (used by the future B10 unresolve action — see Spec §10.7
 * "undo by default").
 */

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.wic.resolve'] },
}

const resolveSchema = z.object({
  action: z.enum(WIC_RESOLUTION_ACTIONS),
  note: z.string().max(2000).nullable().optional(),
})

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> | { id: string } }) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.sub) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const params = await Promise.resolve(ctx.params)
  const id = params?.id
  if (!id) {
    return NextResponse.json({ ok: false, error: 'Missing audit-log id' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Body is not valid JSON' }, { status: 400 })
  }
  const parsed = resolveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  // Tenant-only scope — see comment in `audit-log/route.ts` for rationale.
  // WIC audit-log is tenant-wide by design (Spec §6.1) and adding an
  // `organizationId` filter here would break staff users whose `auth.orgId`
  // (staff org) does not match the audit-log row's `organizationId` (the
  // singleton-resolved Agency org). The command is org-aware for decryption
  // helpers but the lookup itself is keyed by id+tenant.
  try {
    const result = await executeResolve(
      {
        tenantId: auth.tenantId,
        organizationId: auth.orgId ?? auth.tenantId,
        auditLogId: id,
        action: parsed.data.action,
        resolvedByUserId: auth.sub,
        note: parsed.data.note ?? null,
      },
      { em, container },
    )
    return NextResponse.json({
      ok: true,
      auditLog: {
        id: result.auditLogId,
        resolvedAt: result.resolvedAt,
        resolutionAction: result.resolutionAction,
        resolvedByUserId: result.resolvedByUserId,
        resolutionNote: result.resolutionNote,
      },
    })
  } catch (err) {
    if (isWicAuditLogNotFoundError(err)) {
      return NextResponse.json({ ok: false, error: 'Audit log row not found' }, { status: 404 })
    }
    if (isWicAuditLogAlreadyResolvedError(err)) {
      return NextResponse.json(
        { ok: false, error: 'Already resolved', resolvedAt: err.resolvedAt },
        { status: 409 },
      )
    }
    throw err
  }
}

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const postDoc: OpenApiMethodDoc = {
  summary: 'Resolve a WIC audit-log row (B10 row action)',
  description: 'Marks an audit-log row resolved with one of three actions. RBAC: prm.wic.resolve.',
  tags: ['PRM WIC'],
  requestBody: { schema: resolveSchema, description: 'Resolution action + optional note.' },
  responses: [
    {
      status: 200,
      description: 'OK',
      schema: z.object({
        ok: z.literal(true),
        auditLog: z.object({
          id: z.string().uuid(),
          resolvedAt: z.string(),
          resolutionAction: z.string(),
          resolvedByUserId: z.string().uuid().nullable(),
          resolutionNote: z.string().nullable(),
        }),
      }),
    },
  ],
  errors: [
    { status: 400, description: 'Validation failed', schema: errorSchema },
    { status: 401, description: 'Unauthenticated', schema: errorSchema },
    { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Audit log row not found', schema: errorSchema },
    { status: 409, description: 'Already resolved', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM WIC — resolve audit-log row',
  description: 'B10 row-action endpoint.',
  methods: { POST: postDoc },
}

export const __wicAuditLogResolveTesting = { resolveSchema }
