import { getPartnershipYearWindow } from '../lib/partnershipYear'

describe('getPartnershipYearWindow', () => {
  it('returns null when partnershipStartDate is null', () => {
    expect(getPartnershipYearWindow({ partnershipStartDate: null }, new Date('2026-05-10T00:00:00Z'))).toBeNull()
  })

  it('returns null when partnershipStartDate is undefined', () => {
    expect(getPartnershipYearWindow({ partnershipStartDate: undefined }, new Date('2026-05-10T00:00:00Z'))).toBeNull()
  })

  it('returns Year 1 when asOf is the anchor date', () => {
    const w = getPartnershipYearWindow(
      { partnershipStartDate: new Date('2025-08-15T00:00:00Z') },
      new Date('2025-08-15T00:00:00Z'),
    )
    expect(w).toEqual({
      start: new Date(Date.UTC(2025, 7, 15)),
      end: new Date(Date.UTC(2026, 7, 15)),
      yearNumber: 1,
    })
  })

  it('returns Year 1 when asOf is before the anchor date', () => {
    const w = getPartnershipYearWindow(
      { partnershipStartDate: new Date('2025-08-15T00:00:00Z') },
      new Date('2024-01-01T00:00:00Z'),
    )
    expect(w?.yearNumber).toBe(1)
    expect(w?.start).toEqual(new Date(Date.UTC(2025, 7, 15)))
  })

  it('returns Year 2 for the example in the spec', () => {
    // Spec §6: anchor 2025-08-15 + asOf 2026-09-01 → Year 2
    const w = getPartnershipYearWindow(
      { partnershipStartDate: new Date('2025-08-15T00:00:00Z') },
      new Date('2026-09-01T00:00:00Z'),
    )
    expect(w).toEqual({
      start: new Date(Date.UTC(2026, 7, 15)),
      end: new Date(Date.UTC(2027, 7, 15)),
      yearNumber: 2,
    })
  })

  it('end-of-window is exclusive — asOf on the rollover day is the new year', () => {
    const w = getPartnershipYearWindow(
      { partnershipStartDate: new Date('2025-08-15T00:00:00Z') },
      new Date('2026-08-15T00:00:00Z'),
    )
    expect(w?.yearNumber).toBe(2)
    expect(w?.start).toEqual(new Date(Date.UTC(2026, 7, 15)))
  })

  it('leap-year anchor (Feb 29) rolls over on Feb 28 of non-leap years', () => {
    const w = getPartnershipYearWindow(
      { partnershipStartDate: new Date('2024-02-29T00:00:00Z') },
      new Date('2025-03-01T00:00:00Z'),
    )
    expect(w?.yearNumber).toBe(2)
    // Date.UTC clamps Feb 29 → Feb 28 in non-leap years.
    expect(w?.start).toEqual(new Date(Date.UTC(2025, 1, 28)))
    expect(w?.end).toEqual(new Date(Date.UTC(2026, 1, 28)))
  })

  it('handles asOf many years after anchor', () => {
    const w = getPartnershipYearWindow(
      { partnershipStartDate: new Date('2020-01-15T00:00:00Z') },
      new Date('2026-07-01T00:00:00Z'),
    )
    expect(w?.yearNumber).toBe(7)
    expect(w?.start).toEqual(new Date(Date.UTC(2026, 0, 15)))
    expect(w?.end).toEqual(new Date(Date.UTC(2027, 0, 15)))
  })
})
