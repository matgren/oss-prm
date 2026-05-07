import rfpReopenedDeadlineExpiryWorker, {
  metadata as workerMetadata,
} from '../workers/rfp-reopened-deadline-expiry'

describe('RfpReopenedDeadlineExpiry worker', () => {
  it('exposes a cron + queue declaration in metadata', () => {
    expect(workerMetadata.queue).toBe('prm-rfp-deadline-expiry')
    expect(workerMetadata.cron).toBe('*/15 * * * *')
    expect(workerMetadata.concurrency).toBe(1)
  })

  it('delegates to RfpService.sweepExpiredReopenedDeadlines and returns the count', async () => {
    const sweep = jest.fn(async () => ['rfp-A', 'rfp-B', 'rfp-C'])
    const fakeService = { sweepExpiredReopenedDeadlines: sweep }
    const ctx = {
      resolve: <T = unknown>(name: string): T => {
        if (name === 'rfpService') return fakeService as unknown as T
        throw new Error(`unexpected resolve("${name}")`)
      },
    }
    const result = await rfpReopenedDeadlineExpiryWorker(undefined, ctx)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(result.expiredCount).toBe(3)
    expect(result.expiredIds).toEqual(['rfp-A', 'rfp-B', 'rfp-C'])
  })

  it('returns zero when service is unavailable (graceful degradation)', async () => {
    const ctx = {
      resolve: <T = unknown>(name: string): T => {
        if (name === 'rfpService') return null as unknown as T
        throw new Error(`unexpected resolve("${name}")`)
      },
    }
    const result = await rfpReopenedDeadlineExpiryWorker(undefined, ctx)
    expect(result.expiredCount).toBe(0)
    expect(result.expiredIds).toEqual([])
  })
})
