/**
 * `RfpResponseStatusChip` — success-tone chip on the RFP inbox row showing
 * whether the agency has responded (and whether the response is `submitted`
 * or still a `draft`).
 *
 * Renders OM `<StatusBadge variant="success">` so the chip is dark-mode
 * correct via `--status-success-{bg,text,border}` in `globals.css`.
 * Replaces a hand-rolled `bg-emerald-50 text-emerald-900` span (which had
 * `dark:` overrides — but the migration standardizes on the OM primitive
 * for consistency with the agency profile chips and to drop the dual-class
 * burden of maintaining `dark:` pairs by hand).
 *
 * Keeps the legacy `data-testid="rfp-badge-responded"` hook so the existing
 * Playwright fixtures (TC-PRM-T5-003 etc.) still match.
 */
import * as React from 'react'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'

export type RfpResponseStatus = 'draft' | 'submitted'

export type RfpResponseStatusChipProps = {
  status: RfpResponseStatus
  /** Optional translator. Falls back to English defaults when omitted. */
  t?: (key: string, fallback?: string) => string
}

const defaults: Record<RfpResponseStatus, { key: string; fallback: string }> = {
  submitted: { key: 'prm.portal.rfp.badge.submitted', fallback: 'Submitted' },
  draft: { key: 'prm.portal.rfp.badge.draft', fallback: 'Draft saved' },
}

export function RfpResponseStatusChip({ status, t }: RfpResponseStatusChipProps) {
  const entry = defaults[status]
  const label = t ? t(entry.key, entry.fallback) : entry.fallback
  return (
    <StatusBadge variant="success" className="text-[11px]">
      <span data-testid="rfp-badge-responded">{label}</span>
    </StatusBadge>
  )
}
