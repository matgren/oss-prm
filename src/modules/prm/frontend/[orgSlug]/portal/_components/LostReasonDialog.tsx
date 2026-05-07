/**
 * `LostReasonDialog` — inline confirm-card for marking a PRM prospect as lost.
 *
 * Renders an `<Alert variant="destructive">` (DS semantic destructive tokens —
 * dark-mode-aware via `--status-error-{bg,text,border}` in `globals.css`) so
 * the card is readable in both themes. Replaces an earlier hand-rolled
 * `border-rose-300 bg-rose-50` `<section>` that had no `dark:` overrides.
 *
 * Keeps the OM dialog keyboard contract:
 *   - `Escape` cancels (calls `onCancel`).
 *   - `Cmd/Ctrl + Enter` submits (calls `onConfirm(reason)`), but only when
 *     `reason.trim().length >= 10` and not currently `submitting`. The
 *     min-length guard mirrors the on-button `disabled` rule and prevents
 *     a keyboard shortcut from bypassing the audit-trail invariant.
 *
 * Extracted into its own file so the unit test can import it without dragging
 * in the parent page's transitive `@open-mercato/ui/backend/detail` ESM chain
 * (which `ts-jest` cannot transform under the project's current jest config).
 */
import * as React from 'react'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'

const MIN_REASON_LENGTH = 10

export type LostReasonDialogProps = {
  reason: string
  onReasonChange: (next: string) => void
  onConfirm: (reason: string) => void
  onCancel: () => void
  submitting?: boolean
  /** Optional translator. Falls back to English defaults when omitted. */
  t?: (key: string, fallback?: string) => string
}

const defaults = {
  title: 'Mark prospect as lost',
  help: 'A reason of at least 10 characters is required for audit purposes.',
  placeholder: 'Why are we losing this prospect?',
  cancel: 'Cancel',
  confirm: 'Mark lost',
  saving: 'Saving…',
}

function tx(t: LostReasonDialogProps['t'], key: string, fallback: string): string {
  return t ? t(key, fallback) : fallback
}

export function LostReasonDialog({
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  submitting,
  t,
}: LostReasonDialogProps) {
  const reasonReady = reason.trim().length >= MIN_REASON_LENGTH

  return (
    <Alert
      variant="destructive"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onCancel()
          return
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          // Same gate as the disabled-state on the button — keyboard
          // intent must not skip the min-length / busy invariant.
          if (reasonReady && !submitting) onConfirm(reason)
        }
      }}
    >
      <AlertTitle>{tx(t, 'prm.portal.prospects.detail.lostDialog.title', defaults.title)}</AlertTitle>
      <AlertDescription className="mb-2">
        {tx(t, 'prm.portal.prospects.detail.lostDialog.help', defaults.help)}
      </AlertDescription>
      <Textarea
        className="min-h-20 w-full"
        value={reason}
        placeholder={tx(t, 'prm.portal.prospects.detail.lostDialog.placeholder', defaults.placeholder)}
        onChange={(event) => onReasonChange(event.target.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tx(t, 'prm.portal.prospects.detail.lostDialog.cancel', defaults.cancel)}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!reasonReady || submitting}
          onClick={() => onConfirm(reason)}
        >
          {submitting
            ? tx(t, 'prm.portal.prospects.detail.lostDialog.saving', defaults.saving)
            : tx(t, 'prm.portal.prospects.detail.lostDialog.confirm', defaults.confirm)}
        </Button>
      </div>
    </Alert>
  )
}

/**
 * Pure-function classifier mirroring the dialog's `onKeyDown` so the keyboard
 * contract can be unit-tested without DOM. Same shape as
 * `classifyDialogKey` from `prm/backend/license-deals/[id]/reasonDialog.tsx`.
 */
export function classifyLostReasonKey(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean },
  state: { reason: string; submitting?: boolean },
): 'cancel' | 'submit' | 'noop' {
  if (event.key === 'Escape') return 'cancel'
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    const ready = state.reason.trim().length >= MIN_REASON_LENGTH
    if (ready && !state.submitting) return 'submit'
    return 'noop'
  }
  return 'noop'
}
