/**
 * `OnboardingChips` — three success-tone chips for the agency profile header
 * showing whether the partner has signed Contract / NDA / been Onboarded.
 *
 * Renders OM `<StatusBadge variant="success">` (DS semantic success tokens —
 * dark-mode aware via `--status-success-{bg,text,border}` in `globals.css`).
 * Replaces hand-rolled `bg-emerald-50 text-emerald-800` chips that had no
 * `dark:` overrides and rendered as light-emerald-on-light-emerald in the
 * `.dark` cookie state.
 *
 * Each chip's text is i18n-aware via the optional `t` prop. The English
 * fallbacks ("Contract", "NDA", "Onboarded") match the legacy hard-coded
 * labels, so this is rendering-only in the default-locale case.
 *
 * Tone justification: all three chips signal a positive completion / trust
 * milestone — `success` is the only fit (vs `info` for neutral state, or
 * `warning` for unmet expectations). Same mapping the OM `customers` module
 * uses for "active" customers.
 */
import * as React from 'react'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'

export type OnboardingChipsProps = {
  contractSigned?: boolean
  ndaSigned?: boolean
  onboarded?: boolean
  /** Optional translator. Falls back to English defaults when omitted. */
  t?: (key: string, fallback?: string) => string
}

export function OnboardingChips({
  contractSigned,
  ndaSigned,
  onboarded,
  t,
}: OnboardingChipsProps) {
  const tx = (key: string, fallback: string) => (t ? t(key, fallback) : fallback)
  return (
    <>
      {contractSigned ? (
        <StatusBadge variant="success">
          {tx('prm.portal.agency.chip.contract', 'Contract')}
        </StatusBadge>
      ) : null}
      {ndaSigned ? (
        <StatusBadge variant="success">
          {tx('prm.portal.agency.chip.nda', 'NDA')}
        </StatusBadge>
      ) : null}
      {onboarded ? (
        <StatusBadge variant="success">
          {tx('prm.portal.agency.chip.onboarded', 'Onboarded')}
        </StatusBadge>
      ) : null}
    </>
  )
}
