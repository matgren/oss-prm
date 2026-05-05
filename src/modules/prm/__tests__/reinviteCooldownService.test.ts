import { ReinviteCooldownService } from '../lib/reinviteCooldownService'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import type { RateLimitResult } from '@open-mercato/shared/lib/ratelimit/types'

function makeMockLimiter(impl: (key: string) => Promise<RateLimitResult>): RateLimiterService {
  return {
    consume: jest.fn(async (key: string) => impl(key)),
    get: jest.fn(),
    delete: jest.fn(),
    penalty: jest.fn(),
    reward: jest.fn(),
    block: jest.fn(),
    destroy: jest.fn(),
    trustProxyDepth: 1,
  } as unknown as RateLimiterService
}

describe('ReinviteCooldownService', () => {
  it('builds canonical (agency_id, lower(email)) keys', () => {
    const svc = new ReinviteCooldownService()
    expect(svc.buildKey('a-1', 'Foo@Example.COM')).toBe('prm:invite:a-1:foo@example.com')
    expect(svc.buildKey('a-1', '   alice@bar.io  ')).toBe('prm:invite:a-1:alice@bar.io')
  })

  it('returns allowed when no rate-limiter is wired (operational fallback R12)', async () => {
    const svc = new ReinviteCooldownService(60)
    const res = await svc.consume(null, 'a-1', 'foo@example.com')
    expect(res).toEqual({ allowed: true, retryAfterSeconds: 0 })
  })

  it('forwards consume + maps msBeforeNext when rejected', async () => {
    const svc = new ReinviteCooldownService(600)
    const limiter = makeMockLimiter(async () => ({
      allowed: false,
      remainingPoints: 0,
      msBeforeNext: 30_000,
      consumedPoints: 1,
    }))
    const res = await svc.consume(limiter, 'a-1', 'foo@example.com')
    expect(res.allowed).toBe(false)
    expect(res.retryAfterSeconds).toBe(30)
    expect(limiter.consume).toHaveBeenCalledWith('prm:invite:a-1:foo@example.com', expect.objectContaining({
      points: 1,
      duration: 600,
    }))
  })

  it('returns retryAfterSeconds=0 when allowed', async () => {
    const svc = new ReinviteCooldownService()
    const limiter = makeMockLimiter(async () => ({
      allowed: true,
      remainingPoints: 0,
      msBeforeNext: 0,
      consumedPoints: 1,
    }))
    const res = await svc.consume(limiter, 'a-1', 'bob@example.com')
    expect(res).toEqual({ allowed: true, retryAfterSeconds: 0 })
  })
})
