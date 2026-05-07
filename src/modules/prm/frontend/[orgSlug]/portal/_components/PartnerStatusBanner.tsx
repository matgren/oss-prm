/**
 * `PartnerStatusBanner` — shared portal banner for historical PRM partnerships.
 *
 * Renders an `<Alert variant="warning">` (DS semantic warning tokens — dark-mode
 * aware via `--status-warning-{bg,text,border}` in `globals.css`) when the
 * partner's PRM status is `historical`; returns null otherwise.
 *
 * Replaces three near-identical hand-rolled `bg-amber-50 text-amber-900` divs
 * across `agency/page.tsx`, `dashboard/page.tsx`, and `members/page.tsx` that
 * were unreadable when the app's `.dark` cookie was set
 * (see `src/app/layout.tsx:40` for the dark-mode toggle).
 *
 * The component is i18n-aware via the optional `t` prop so each consumer
 * keeps its own translation key (`prm.portal.dashboard.banner.historical` vs
 * `prm.portal.agency.banner.historical` vs `prm.portal.members.banner.historical`).
 * When `t` is omitted, the English fallback is used (matches the legacy banners,
 * which were hardcoded English).
 */
import * as React from 'react'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'

export type PartnerStatusBannerProps = {
  /** Partner's PRM status — banner only renders when `'historical'`. */
  status?: string | null
  /**
   * Optional translation function — when provided, the banner reads the
   * `messageKey` translation; otherwise the English `message` fallback wins.
   */
  t?: (key: string, fallback?: string) => string
  /** i18n key for the banner text. Defaults to the agency variant. */
  messageKey?: string
  /** English fallback used when `t` is not supplied or returns the key. */
  message?: string
  /** Extra wrapper className (margin / spacing tweaks). */
  className?: string
}

const DEFAULT_MESSAGE =
  'Your partnership is historical — contact OM PartnerOps to reactivate.'

export function PartnerStatusBanner({
  status,
  t,
  messageKey = 'prm.portal.banner.partnerHistorical',
  message = DEFAULT_MESSAGE,
  className,
}: PartnerStatusBannerProps) {
  if (status !== 'historical') return null
  const text = t ? t(messageKey, message) : message
  return (
    <Alert variant="warning" className={className}>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}
