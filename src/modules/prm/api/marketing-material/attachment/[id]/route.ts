import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { deletePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'
import { MarketingMaterial } from '../../../../data/entities'

/**
 * Remove an attachment row owned by a marketing material in the caller's
 * organization. Refuses to delete the row that is currently the material's
 * `primary_attachment_id` (would orphan the required FK on the material).
 *
 * Used by the edit form's per-file ✕ button. Files still attached to a draft
 * (`recordId` is the form's draftRecordId) are also deletable here as long
 * as the row carries the same tenant/org as the caller.
 */
export const metadata = {
  DELETE: { requireAuth: true, requireFeatures: ['prm.marketing_material.write'] },
}

const PRM_MATERIAL_ENTITY_ID = 'prm:marketing_material'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function DELETE(req: Request, ctx: RouteContext) {
  const params = await Promise.resolve(ctx.params)
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const att = await em.findOne(Attachment, {
    id: params.id,
    entityId: PRM_MATERIAL_ENTITY_ID,
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
  } as any)
  if (!att) {
    return NextResponse.json({ ok: false, error: 'Attachment not found' }, { status: 404 })
  }

  // Block deletion if this attachment is the primary on a saved material.
  const primaryOwner = await em.findOne(MarketingMaterial, {
    primaryAttachmentId: att.id,
    organizationId: auth.orgId,
  } as any)
  if (primaryOwner) {
    return NextResponse.json(
      { ok: false, error: 'Cannot delete the primary attachment. Set another file as primary first.' },
      { status: 409 },
    )
  }

  const partitionCode = att.partitionCode
  const storagePath = att.storagePath
  const storageDriver = att.storageDriver

  em.remove(att)
  await em.flush()
  await deletePartitionFile(partitionCode, storagePath, storageDriver)

  return NextResponse.json({ ok: true })
}

const deleteDoc: OpenApiMethodDoc = {
  summary: 'Delete a non-primary marketing-material attachment',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 200, description: 'Deleted' },
    { status: 404, description: 'Not found' },
    { status: 409, description: 'Refused — attachment is the material primary' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM marketing-material attachment deletion',
  methods: { DELETE: deleteDoc },
}
