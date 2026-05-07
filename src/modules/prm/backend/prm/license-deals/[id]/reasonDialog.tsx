'use client'
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'

/** Minimum reason length enforced by both `reverseLicenseDealSchema` and
 * `unreverseLicenseDealStatusSchema` (`z.string().min(10)`). Centralised here so
 * the dialog UI matches the validator without re-encoding the literal. */
export const MIN_REASON_LENGTH = 10

/** Pure predicate — extracted so we can unit-test without rendering. */
export function isReasonValid(value: string): boolean {
  return value.trim().length >= MIN_REASON_LENGTH
}

/** Pure keyboard intent classifier — `Cmd/Ctrl+Enter` submits, `Escape` cancels.
 * Mirrors the AGENTS dialog convention so the page reads as plain dispatching. */
export type DialogKeyIntent = 'submit' | 'cancel' | 'none'
export function classifyDialogKey(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
}): DialogKeyIntent {
  if (event.key === 'Escape') return 'cancel'
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') return 'submit'
  return 'none'
}

export type ReasonDialogCopy = {
  title: string
  help: string
  placeholder: string
  reasonLabel: string
  cancel: string
  confirm: string
  saving: string
  validationMessage: string
}

type BaseReasonDialogProps = {
  open: boolean
  copy: ReasonDialogCopy
  busy: boolean
  /** Called with the trimmed reason once the user confirms with a valid value. */
  onConfirm: (reason: string) => void
  onCancel: () => void
  /** Optional extra slot rendered above the textarea (e.g. status select for unreverse). */
  children?: React.ReactNode
  /** When false, confirm button is disabled even if reason length is valid. */
  extraValid?: boolean
  /** Test hook so callers can target the dialog deterministically. */
  testId?: string
}

/** Inline modal dialog used by the B5 reverse / unreverse-status flows.
 *
 * Behaviour:
 *   - Cmd/Ctrl+Enter submits when reason >= 10 chars (and `extraValid !== false`).
 *   - Escape cancels.
 *   - Auto-focuses the textarea when opened so keyboard shortcuts work without a
 *     stray click.
 *   - Confirm button is disabled until the reason is valid; a hint surfaces the
 *     remaining-chars validation message after the user starts typing.
 */
export function ReasonDialog({
  open,
  copy,
  busy,
  onConfirm,
  onCancel,
  children,
  extraValid = true,
  testId,
}: BaseReasonDialogProps) {
  const [reason, setReason] = React.useState('')
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    if (open) {
      setReason('')
      // Defer focus so the textarea exists before we focus it.
      const id = window.setTimeout(() => textareaRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])

  if (!open) return null

  const reasonValid = isReasonValid(reason)
  const canConfirm = reasonValid && extraValid && !busy

  function handleConfirm() {
    if (!canConfirm) return
    onConfirm(reason.trim())
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
        <p className="mb-3 text-xs text-muted-foreground">{copy.help}</p>
        {children}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{copy.reasonLabel}</span>
          <Textarea
            ref={textareaRef}
            className="min-h-24"
            value={reason}
            placeholder={copy.placeholder}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {reason.length > 0 && !reasonValid ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {copy.validationMessage}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {busy ? copy.saving : copy.confirm}
          </Button>
        </div>
      </div>
    </div>
  )
}
