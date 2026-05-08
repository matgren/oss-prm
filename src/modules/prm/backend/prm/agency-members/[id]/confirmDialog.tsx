'use client'
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'

/** Pure keyboard intent classifier — `Cmd/Ctrl+Enter` submits, `Escape` cancels.
 * Mirrors the AGENTS dialog convention. Inlined here to avoid cross-page coupling
 * with the license-deals dialog copy. */
type DialogKeyIntent = 'submit' | 'cancel' | 'none'
function classifyDialogKey(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
}): DialogKeyIntent {
  if (event.key === 'Escape') return 'cancel'
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') return 'submit'
  return 'none'
}

export type ConfirmDialogCopy = {
  title: string
  body: string
  cancel: string
  confirm: string
  saving: string
}

type ConfirmDialogProps = {
  open: boolean
  copy: ConfirmDialogCopy
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  variant?: 'destructive' | 'default'
  testId?: string
}

/** Confirm-only modal dialog used for the asymmetric "Deactivate member?"
 * gate (SPEC-2026-05-08 Phase 3). Reactivation skips this dialog and saves
 * directly — see backend page `[id]/page.tsx`.
 *
 * Behaviour mirrors the case-study soft-delete dialog convention:
 *   - Cmd/Ctrl+Enter confirms when not busy.
 *   - Escape cancels.
 *   - Auto-focuses the confirm button on open.
 */
export function ConfirmDialog({
  open,
  copy,
  busy,
  onConfirm,
  onCancel,
  variant = 'destructive',
  testId,
}: ConfirmDialogProps) {
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)

  React.useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => confirmRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])

  if (!open) return null

  function handleConfirm() {
    if (busy) return
    onConfirm()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => {
        const intent = classifyDialogKey(e)
        if (intent === 'cancel') {
          e.preventDefault()
          onCancel()
        } else if (intent === 'submit') {
          e.preventDefault()
          handleConfirm()
        }
      }}
    >
      <div className="w-full max-w-md rounded-md border bg-card p-4 shadow-lg">
        <h3 className="mb-2 text-sm font-semibold">{copy.title}</h3>
        <p className="mb-4 text-sm text-muted-foreground">{copy.body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={variant}
            disabled={busy}
            onClick={handleConfirm}
          >
            {busy ? copy.saving : copy.confirm}
          </Button>
        </div>
      </div>
    </div>
  )
}
