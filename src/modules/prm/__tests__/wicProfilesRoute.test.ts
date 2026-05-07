import { defaultMonth, listActiveProfiles } from '../api/service/wic/profiles/route'
import type { Agency, AgencyMember } from '../data/entities'

class FakeEm {
  constructor(
    public agencies: Partial<Agency>[],
    public members: Partial<AgencyMember>[],
  ) {}
  async find(cls: unknown, where: any, _opts?: unknown) {
    if ((cls as { name?: string })?.name === 'Agency') {
      return this.agencies.filter((a) => {
        if (where.status && a.status !== where.status) return false
        if (where.onboarded !== undefined && a.onboarded !== where.onboarded) return false
        if (where.deletedAt === null && a.deletedAt) return false
        return true
      })
    }
    if ((cls as { name?: string })?.name === 'AgencyMember') {
      return this.members.filter((m) => {
        if (where.isActive !== undefined && m.isActive !== where.isActive) return false
        if (where.deletedAt === null && m.deletedAt) return false
        if (where.agencyId?.$in && !where.agencyId.$in.includes(m.agencyId)) return false
        if (where.githubProfile?.$ne === null && m.githubProfile === null) return false
        return true
      })
    }
    return []
  }
}

describe('GET /api/prm/service/wic/profiles handler logic', () => {
  it('listActiveProfiles returns only active members of active onboarded agencies', async () => {
    const em = new FakeEm(
      [
        { id: 'a1', slug: 'acme', status: 'active', onboarded: true, deletedAt: null },
        { id: 'a2', slug: 'inactive-agency', status: 'historical', onboarded: true, deletedAt: null },
        { id: 'a3', slug: 'pre-onboard', status: 'active', onboarded: false, deletedAt: null },
      ],
      [
        { id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null },
        { id: 'm2', agencyId: 'a1', githubProfile: null, isActive: true, deletedAt: null },
        { id: 'm3', agencyId: 'a1', githubProfile: 'invitee', isActive: false, deletedAt: null },
        { id: 'm4', agencyId: 'a2', githubProfile: 'historical-user', isActive: true, deletedAt: null },
        { id: 'm5', agencyId: 'a3', githubProfile: 'pre-onboard-dev', isActive: true, deletedAt: null },
      ],
    )

    const profiles = await listActiveProfiles(em as any, { tenantId: 't1', organizationId: 'o1' })
    expect(profiles).toEqual([
      { agency_member_id: 'm1', github_profile: 'octocat', agency_slug: 'acme', is_active: true },
    ])
  })

  it('listActiveProfiles returns empty when no active onboarded agencies exist (quiet month)', async () => {
    const em = new FakeEm(
      [{ id: 'a1', slug: 'acme', status: 'historical', onboarded: true, deletedAt: null }],
      [{ id: 'm1', agencyId: 'a1', githubProfile: 'octocat', isActive: true, deletedAt: null }],
    )
    const profiles = await listActiveProfiles(em as any, { tenantId: 't1', organizationId: 'o1' })
    expect(profiles).toEqual([])
  })

  it('listActiveProfiles skips members with whitespace-only github_profile', async () => {
    const em = new FakeEm(
      [{ id: 'a1', slug: 'acme', status: 'active', onboarded: true, deletedAt: null }],
      [
        { id: 'm1', agencyId: 'a1', githubProfile: '   ', isActive: true, deletedAt: null },
        { id: 'm2', agencyId: 'a1', githubProfile: 'real-user', isActive: true, deletedAt: null },
      ],
    )
    const profiles = await listActiveProfiles(em as any, { tenantId: 't1', organizationId: 'o1' })
    expect(profiles.length).toBe(1)
    expect(profiles[0].github_profile).toBe('real-user')
  })

  it('defaultMonth returns YYYY-MM in UTC', () => {
    expect(defaultMonth(new Date('2026-04-23T10:00:00Z'))).toBe('2026-04')
    expect(defaultMonth(new Date('2026-12-31T23:59:00Z'))).toBe('2026-12')
    expect(defaultMonth(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01')
  })
})
