import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc, OpenApiMethodDoc } from '@open-mercato/shared/lib/openapi'
import {
  Attachment,
  AttachmentPartition,
} from '@open-mercato/core/modules/attachments/data/entities'
import { storePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'
import {
  ensureDefaultPartitions,
  resolveDefaultPartitionCode,
} from '@open-mercato/core/modules/attachments/lib/partitions'
import {
  detectAttachmentMimeType,
  hasDangerousExecutableExtension,
  isActiveContentAttachment,
  sanitizeUploadedFileName,
} from '@open-mercato/core/modules/attachments/lib/security'
import {
  isMultipartRequestWithinUploadLimit,
  resolveAttachmentMaxBytes,
} from '@open-mercato/core/modules/attachments/lib/upload-limits'
import { buildAttachmentFileUrl } from '@open-mercato/core/modules/attachments/lib/imageUrls'

/**
 * Upload an attachment for a (possibly not-yet-saved) MarketingMaterial.
 *
 * Stores the file under the standard attachments partition and creates an
 * `Attachment` row keyed by entityId='prm:marketing_material' + a caller-
 * supplied `draftRecordId` (a UUID generated in the form). Once the
 * `MarketingMaterial` row is created, the service rebinds these rows to
 * `recordId = material.id`. A "lost" draft (page closed before save) leaves
 * orphan rows that a future cleanup job can sweep — acceptable for v1.
 *
 * Auth: PRM `prm.marketing_material.write` (not `attachments.manage`) — the
 * upload is gated on the PRM authoring permission, not the generic library
 * permission, so OM Marketing roles need no extra grants.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['prm.marketing_material.write'] },
}

const PRM_MATERIAL_ENTITY_ID = 'prm:marketing_material'

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId || !auth.orgId) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }
  const contentType = req.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json({ ok: false, error: 'Expected multipart/form-data' }, { status: 400 })
  }
  if (!isMultipartRequestWithinUploadLimit(req.headers.get('content-length'))) {
    return NextResponse.json({ ok: false, error: 'Attachment exceeds the maximum upload size.' }, { status: 413 })
  }

  const form = await req.formData()
  const draftRecordId = String(form.get('draftRecordId') || '')
  const file = form.get('file') as unknown as File | null
  if (!draftRecordId || !file) {
    return NextResponse.json({ ok: false, error: 'draftRecordId and file are required' }, { status: 400 })
  }
  if (!/^[0-9a-fA-F-]{8,64}$/.test(draftRecordId)) {
    return NextResponse.json({ ok: false, error: 'Invalid draftRecordId' }, { status: 400 })
  }

  if (hasDangerousExecutableExtension(file.name)) {
    return NextResponse.json({ ok: false, error: 'Executable file types are not allowed.' }, { status: 400 })
  }
  const maxBytes = resolveAttachmentMaxBytes()
  if (file.size > maxBytes) {
    return NextResponse.json({ ok: false, error: 'Attachment exceeds the maximum upload size.' }, { status: 413 })
  }

  const buf = Buffer.from(await file.arrayBuffer())
  const safeName = sanitizeUploadedFileName(file.name)
  const fileMimeType = detectAttachmentMimeType(buf, safeName, (file as { type?: string }).type)
  if (isActiveContentAttachment(buf, safeName, fileMimeType)) {
    return NextResponse.json({ ok: false, error: 'Active content uploads are not allowed.' }, { status: 400 })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  await ensureDefaultPartitions(em)
  const partitionCode = resolveDefaultPartitionCode(PRM_MATERIAL_ENTITY_ID)
  const partition = await em.findOne(AttachmentPartition, { code: partitionCode })
  if (!partition) {
    return NextResponse.json({ ok: false, error: 'Storage partition is not configured.' }, { status: 500 })
  }

  let stored
  try {
    stored = await storePartitionFile({
      partitionCode: partition.code,
      orgId: auth.orgId,
      tenantId: auth.tenantId,
      fileName: safeName,
      buffer: buf,
    })
  } catch (err) {
    console.error('[prm/marketing-material/upload] failed to persist file', err)
    return NextResponse.json({ ok: false, error: 'Failed to persist attachment.' }, { status: 500 })
  }

  const attachmentId = randomUUID()
  const att = em.create(Attachment, {
    id: attachmentId,
    entityId: PRM_MATERIAL_ENTITY_ID,
    recordId: draftRecordId,
    organizationId: auth.orgId,
    tenantId: auth.tenantId,
    fileName: safeName,
    mimeType: fileMimeType,
    fileSize: buf.length,
    partitionCode: partition.code,
    storageDriver: partition.storageDriver || 'local',
    storagePath: stored.storagePath,
    url: buildAttachmentFileUrl(attachmentId),
    storageMetadata: null,
  } as any)
  await em.persistAndFlush(att)

  return NextResponse.json(
    {
      ok: true,
      attachment: {
        id: att.id,
        fileName: att.fileName,
        fileSize: att.fileSize,
        mimeType: att.mimeType,
        url: att.url,
      },
    },
    { status: 201 },
  )
}

const responseSchema = z.object({
  ok: z.literal(true),
  attachment: z.object({
    id: z.string().uuid(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    url: z.string(),
  }),
})

const postDoc: OpenApiMethodDoc = {
  summary: 'Upload an attachment for a marketing material draft',
  description:
    'Stores a file in the default attachments partition and returns its id. Use the returned id as `primaryAttachmentId` (or in `extraAttachmentIds[]`) when creating/updating the material.',
  tags: ['PRM Backend Marketing'],
  responses: [
    { status: 201, description: 'Uploaded', schema: responseSchema },
    { status: 400, description: 'Bad request' },
    { status: 401, description: 'Unauthorized' },
    { status: 413, description: 'File too large' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  summary: 'PRM marketing-material attachment upload',
  methods: { POST: postDoc },
}
