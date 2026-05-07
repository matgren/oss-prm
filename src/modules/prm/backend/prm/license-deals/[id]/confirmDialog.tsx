'use client'
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { classifyDialogKey } from './reasonDialog'

/**
 * Copy bundle for the B5 confirm-only dialog (e.g. soft-delete).
 *
 * Mirrors `ReasonDialogCopy` but drops every field that only makes sense when
 * a textarea + length validation is present (placeholder, reasonLabel,
 * validationMessage). The dialog still honours the AGENTS keyboard convention:
 * Cmd/Ctrl+Enter confirms, Escape cancels.
 */
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
  /**
   * Visual variant for the confirm button. Defaults to `destructive` because
   * every current caller (soft-delete) is a destructive action.
   */
  variant?: 'destructive' | 'default'
  /** Test hook so callers can target the dialog deterministically. */
  testId?: string
}

/** Inline confirm-only modal dialog used by B5 soft-delete (and any future
 * confirm-only flows on this page).
 *
 * Behaviour:
 *   - Cmd/Ctrl+Enter confirms (when not busy) — re-uses `classifyDialogKey`
 *     from `reasonDialog.tsx` so the keyboard contract stays in lockstep.
 *   - Escape cancels.
 *   - Auto-focuses the confirm button when opened so keyboard shortcuts work
 *     without a stray click.
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
