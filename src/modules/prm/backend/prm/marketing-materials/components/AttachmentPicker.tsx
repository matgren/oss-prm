'use client'
import * as React from 'react'
import { Star, Upload, X } from 'lucide-react'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export type PickerFile = {
  id: string
  fileName: string
  fileSize: number
  mimeType?: string
  url?: string
  /**
   * `staged`: just uploaded in this session against the form's draftRecordId.
   *           Will be rebound to the material on save.
   * `bound`:  already attached to a saved material. Removing one of these
   *           records the id in `removedBoundIds` so the parent can ship it
   *           in `removedAttachmentIds[]` on PUT.
   */
  source: 'staged' | 'bound'
}

export type PickerValue = {
  primaryAttachmentId: string | null
  attachments: PickerFile[]
  removedBoundIds: string[]
}

export const emptyPickerValue = (): PickerValue => ({
  primaryAttachmentId: null,
  attachments: [],
  removedBoundIds: [],
})

type UploadResponse = {
  ok?: boolean
  error?: string
  attachment?: {
    id: string
    fileName: string
    fileSize: number
    mimeType: string
    url: string
  }
}

function humanSize(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let x = n
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function AttachmentPicker({
  value,
  onChange,
  draftRecordId,
  disabled,
}: {
  value: PickerValue
  onChange: (next: PickerValue) => void
  draftRecordId: string
  disabled?: boolean
}) {
  const t = useT()
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const uploadFiles = React.useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || disabled) return
      const list = Array.from(files)
      if (!list.length) return
      setError(null)
      setUploading(true)
      try {
        let next = value
        for (const file of list) {
          const fd = new FormData()
          fd.set('draftRecordId', draftRecordId)
          fd.set('file', file)
          const { result: json } = await apiCallOrThrow<UploadResponse>(
            '/api/prm/marketing-material/upload',
            {
              method: 'POST',
              body: fd,
              credentials: 'same-origin',
            },
            {
              errorMessage: t(
                'prm.backend.marketingMaterials.attachments.uploadFailed',
                'Upload failed.',
              ),
            },
          )
          if (!json?.ok || !json.attachment) {
            throw new Error(
              json?.error ||
                t('prm.backend.marketingMaterials.attachments.uploadFailed', 'Upload failed.'),
            )
          }
          const attachment: PickerFile = {
            id: json.attachment.id,
            fileName: json.attachment.fileName,
            fileSize: json.attachment.fileSize,
            mimeType: json.attachment.mimeType,
            url: json.attachment.url,
            source: 'staged',
          }
          next = {
            primaryAttachmentId: next.primaryAttachmentId ?? attachment.id,
            attachments: [...next.attachments, attachment],
            removedBoundIds: next.removedBoundIds,
          }
        }
        onChange(next)
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('prm.backend.marketingMaterials.attachments.uploadFailed', 'Upload failed.'),
        )
      } finally {
        setUploading(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [disabled, draftRecordId, onChange, t, value],
  )

  const promotePrimary = (id: string) => {
    if (id === value.primaryAttachmentId) return
    onChange({ ...value, primaryAttachmentId: id })
  }

  const removeAttachment = (file: PickerFile) => {
    const remaining = value.attachments.filter((a) => a.id !== file.id)
    let nextPrimary = value.primaryAttachmentId
    if (nextPrimary === file.id) {
      nextPrimary = remaining[0]?.id ?? null
    }
    onChange({
      primaryAttachmentId: nextPrimary,
      attachments: remaining,
      removedBoundIds:
        file.source === 'bound'
          ? [...value.removedBoundIds, file.id]
          : value.removedBoundIds,
    })
  }

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    const files = event.dataTransfer?.files
    void uploadFiles(files)
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex flex-wrap items-center gap-3 rounded-md border border-dashed px-4 py-4 transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-border/70 bg-muted/20'
        }`}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
        >
          <Upload className="h-4 w-4" />
          {uploading
            ? t('prm.backend.marketingMaterials.attachments.uploading', 'Uploading…')
            : t('prm.backend.marketingMaterials.attachments.choose', 'Choose files')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t(
            'prm.backend.marketingMaterials.attachments.dropHint',
            'Drag and drop files here, or click to choose. The first file is the primary download — click ★ to change.',
          )}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          disabled={disabled || uploading}
          onChange={(event) => void uploadFiles(event.target.files)}
        />
      </div>

      {error ? (
        <Alert variant="destructive" className="text-xs">
          {error}
        </Alert>
      ) : null}

      {value.attachments.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {value.attachments.map((file) => {
            const isPrimary = file.id === value.primaryAttachmentId
            return (
              <li
                key={file.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <button
                  type="button"
                  aria-label={
                    isPrimary
                      ? t('prm.backend.marketingMaterials.attachments.isPrimary', 'Primary download')
                      : t('prm.backend.marketingMaterials.attachments.makePrimary', 'Set as primary')
                  }
                  onClick={() => promotePrimary(file.id)}
                  disabled={disabled || isPrimary}
                  /* DS-SKIP: decorative gold-star icon, not a status semantic */
                  className={`shrink-0 rounded p-1 transition-colors ${
                    isPrimary
                      ? 'text-amber-500'
                      : 'text-muted-foreground hover:text-amber-500'
                  } ${disabled || isPrimary ? '' : 'cursor-pointer'}`}
                >
                  <Star className="h-4 w-4" fill={isPrimary ? 'currentColor' : 'none'} />
                </button>
                <div className="min-w-0 flex-1 truncate">
                  {file.url ? (
                    <a
                      className="truncate underline hover:no-underline"
                      href={file.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {file.fileName}
                    </a>
                  ) : (
                    <span className="truncate">{file.fileName}</span>
                  )}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {humanSize(file.fileSize)}
                  </span>
                  {isPrimary ? (
                    <StatusBadge variant="warning" className="ml-2">
                      {t('prm.backend.marketingMaterials.attachments.primary', 'Primary')}
                    </StatusBadge>
                  ) : null}
                </div>
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('prm.backend.marketingMaterials.attachments.remove', 'Remove')}
                  onClick={() => removeAttachment(file)}
                  disabled={disabled || (isPrimary && value.attachments.length > 1)}
                  title={
                    isPrimary && value.attachments.length > 1
                      ? t(
                          'prm.backend.marketingMaterials.attachments.cannotRemovePrimary',
                          'Pick another file as primary first',
                        )
                      : undefined
                  }
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="text-xs text-muted-foreground">
          {t(
            'prm.backend.marketingMaterials.attachments.empty',
            'No files yet — at least one is required.',
          )}
        </div>
      )}
    </div>
  )
}
