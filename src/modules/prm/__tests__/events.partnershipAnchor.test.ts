import eventsConfig from '../events'

/**
 * Structural assertion: the partnership-anchor event added in SPEC-2026-05-10
 * must be present in the FROZEN-additive PRM event registry. Cross-spec
 * subscribers (downstream cache invalidators, future tier-evaluation workers)
 * bind to this ID verbatim — renaming or removing it is a breaking change.
 */
describe('PRM events — partnership-anchor (SPEC-2026-05-10)', () => {
  it('declares prm.agency.partnership_anchor_changed in the registry', () => {
    const ids = eventsConfig.events.map((d) => d.id)
    expect(ids).toContain('prm.agency.partnership_anchor_changed')
  })

  it('marks the event as broadcast-capable (clientBroadcast + portalBroadcast)', () => {
    const entry = eventsConfig.events.find(
      (d) => d.id === 'prm.agency.partnership_anchor_changed',
    )
    expect(entry).toBeDefined()
    expect(entry?.clientBroadcast).toBe(true)
    expect(entry?.portalBroadcast).toBe(true)
  })

  it('is distinct from prm.agency.onboarding_state_changed (no payload overlap by ID)', () => {
    // Anchor changes do NOT count as an onboarding state change — Spec #1's
    // cascade subscriber is intentionally NOT triggered by anchor edits.
    const ids = eventsConfig.events.map((d) => d.id)
    expect(ids).toContain('prm.agency.onboarding_state_changed')
    expect(ids).toContain('prm.agency.partnership_anchor_changed')
    expect(
      ids.filter((id) => id === 'prm.agency.partnership_anchor_changed').length,
    ).toBe(1)
  })
})
