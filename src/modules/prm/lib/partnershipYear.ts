/**
 * Partnership-year window helper (Spec SPEC-2026-05-10).
 *
 * Single source of truth for "what window does MIN aggregate over, and which
 * partnership year are we in?" The dashboard route, MIN route, and any future
 * tier-evaluation worker MUST call this helper rather than computing calendar-
 * year windows directly. See spec §3.2.
 *
 * The Agency entity stores `partnershipStartDate` as a nullable date — when
 * null, callers fall back to calendar year and surface a banner asking OM
 * staff to set the anchor.
 */

export type PartnershipYearWindow = {
  /** Inclusive UTC start of the window. */
  start: Date
  /** Exclusive UTC end of the window. */
  end: Date
  /** 1 = first partnership year (the one containing `partnershipStartDate`). */
  yearNumber: number
}

type AgencyAnchor = { partnershipStartDate?: Date | null }

/**
 * Returns the partnership-year window containing `asOf`. `null` if the
 * agency has no `partnershipStartDate`.
 *
 * Leap-year semantics: when the anchor is Feb 29, subsequent year boundaries
 * fall on Feb 28 of non-leap years (`Date.UTC` clamps month overflow).
 *
 * `asOf` strictly before `partnershipStartDate` returns Year 1 (the window
 * starting on the anchor). This lets callers query "what's the current
 * partnership year?" without first checking the date order.
 */
export function getPartnershipYearWindow(
  agency: AgencyAnchor,
  asOf: Date,
): PartnershipYearWindow | null {
  const anchor = agency.partnershipStartDate ?? null
  if (anchor == null) return null

  const anchorUtc = toUtcMidnight(anchor)
  const asOfUtc = toUtcMidnight(asOf)

  // Quick exit: asOf is before the anchor → Year 1.
  if (asOfUtc < anchorUtc) {
    return {
      start: anchorUtc,
      end: addYears(anchorUtc, 1),
      yearNumber: 1,
    }
  }

  // Walk forward year-by-year. Cheap (worst case a few decades).
  let yearNumber = 1
  let start = anchorUtc
  let end = addYears(start, 1)
  while (asOfUtc >= end) {
    yearNumber += 1
    start = end
    end = addYears(anchorUtc, yearNumber)
  }
  return { start, end, yearNumber }
}

function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Adds `years` to `d`, clamping Feb 29 → Feb 28 in non-leap target years.
 * Naive `Date.UTC(y+1, 1, 29)` overflows to March 1; we explicitly clamp so
 * a Feb 29 anchor rolls over on Feb 28 of non-leap years (per spec §6).
 */
function addYears(d: Date, years: number): Date {
  const targetYear = d.getUTCFullYear() + years
  const month = d.getUTCMonth()
  const day = d.getUTCDate()
  const candidate = new Date(Date.UTC(targetYear, month, day))
  // If the resulting date drifted into a later month, clamp to the last day of the intended month.
  if (candidate.getUTCMonth() !== month) {
    return new Date(Date.UTC(targetYear, month + 1, 0))
  }
  return candidate
}
