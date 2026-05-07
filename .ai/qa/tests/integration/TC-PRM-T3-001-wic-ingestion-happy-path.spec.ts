import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import { createAgencyFixture, deleteAgencyIfExists, resetPrmState } from '@/modules/prm/testing/integration'

const baseUrl = process.env.BASE_URL || 'http://localhost:3000'

/**
 * The shipped `apiRequest` helper does not support custom request headers — it
 * hard-codes Authorization + Content-Type. WIC service routes need
 * X-Om-Import-Secret + X-Om-Request-Timestamp + X-Om-Idempotency-Key, so this
 * test uses Playwright's `request.fetch` directly. Tracked as an OM-side
 * follow-up: extend `apiRequest` to forward arbitrary headers.
 */
async function wicServicePost(
  request: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  options: { headers: Record<string, string>; data?: unknown },
) {
  const init: { method: string; headers: Record<string, string>; data?: unknown } = {
    method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  }
  if (method === 'POST' && options.data !== undefined) init.data = options.data
  return request.fetch(`${baseUrl}${path}`, init)
}

/**
 * TC-PRM-T3-001 — Spec #4 (WIC Ingestion) §9 IT-1 happy path + select security guards.
 *
 * Mandatory per the user's brief (hard-halt rule #4): WIC ingestion is a service-identity
 * API surface — without an integration test the contract is unverifiable. Covers:
 *
 *   - T1: 1-row batch accepted end-to-end (request → AgencyMember resolved → WicContribution
 *     committed → response shape correct).
 *   - T3: github_profile not in any active AgencyMember → audit log row.
 *   - T7: timestamp outside ±5min window → 408.
 *   - T8: bad shared secret → 401.
 *
 * Edge cases T2 (malformed_month), T4 (supersession), T5 (idempotent replay), T6 (replay
 * with different payload), T9-T15 are exercised by the unit tests in
 * `src/modules/prm/__tests__/wicImportService.test.ts` and
 * `src/modules/prm/__tests__/serviceAuthMiddleware.test.ts`. Tracked for full integration
 * coverage in `.ai/specs/POST-MVP-FOLLOW-UPS.md`.
 *
 * Prerequisites:
 *   - `OM_PRM_WIC_IMPORT_SECRET` set in the running app's env. The fixture .env in this
 *     repo ships a known dev/test value (see `.env.example` for the production guidance).
 */

const WIC_SECRET = 'dev-wic-secret-for-local-and-integration-tests-1234567890'

function uuidv4(): string {
  // RFC 4122 v4. Crypto-strong is overkill for tests; deterministic randomness is fine.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

async function patchAgencyOnboarded(
  request: APIRequestContext,
  token: string,
  agencyId: string,
): Promise<void> {
  // PATCH the admin-only fields so the agency clears WIC's onboarded+active gate.
  const response = await apiRequest(request, 'PATCH', `/api/prm/agency/${agencyId}`, {
    token,
    data: { onboarded: true, status: 'active' },
  })
  expect(
    response.status(),
    `PATCH /api/prm/agency/${agencyId} should return 200; got ${response.status()}`,
  ).toBe(200)
}

async function inviteMemberWithGithub(
  request: APIRequestContext,
  token: string,
  agencyId: string,
  githubProfile: string,
  emailSeed: string,
): Promise<{ agencyMemberId: string }> {
  const response = await apiRequest(request, 'POST', `/api/prm/agency/${agencyId}/invite`, {
    token,
    data: {
      firstName: 'WIC',
      lastName: 'Tester',
      email: `wic-${emailSeed}@example.test`,
      githubProfile,
      roleSlug: 'partner_admin',
    },
  })
  const body = await readJsonSafe<{ agencyMemberId?: string }>(response)
  expect(
    response.status(),
    `POST /api/prm/agency/${agencyId}/invite should return 201; got ${response.status()} body=${JSON.stringify(body)}`,
  ).toBe(201)
  expect(body?.agencyMemberId, 'invite response missing agencyMemberId').toBeTruthy()
  return { agencyMemberId: body!.agencyMemberId! }
}

test.describe('TC-PRM-T3-001: WIC ingestion happy path + security guards', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('T1 — POST batch accepts a row that resolves to an active member (happy path)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)
    const agencyId = await createAgencyFixture(request, token, {
      name: `WIC T3 ${suffix}`,
      slug: `wic-t3-${suffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })

    try {
      await patchAgencyOnboarded(request, token, agencyId)
      const githubHandle = `wic-${suffix}`
      await inviteMemberWithGithub(request, token, agencyId, githubHandle, suffix)

      const batchId = uuidv4()
      const idempotencyKey = uuidv4()
      const response = await wicServicePost(
        request,
        'POST',
        `/api/prm/service/wic/imports/${batchId}`,
        {
          headers: {
            'X-Om-Import-Secret': WIC_SECRET,
            'X-Om-Request-Timestamp': nowIso(),
            'X-Om-Idempotency-Key': idempotencyKey,
          },
          data: {
            script_version: '1.0-agent',
            month: '2026-03',
            rows: [
              {
                row_index: 0,
                github_profile: githubHandle,
                person_display_name: 'WIC Tester',
                contribution_month: '2026-03-01',
                wic_level: 'L2',
                wic_score: 42.5,
                contribution_count: 7,
                bounty_bonus: 10,
                computed_at: '2026-04-02T08:30:00Z',
              },
            ],
          },
        },
      )

      const body = await readJsonSafe<{
        import_batch_id?: string
        accepted_count?: number
        rejected_count?: number
        per_row?: Array<{ row_index: number; status: string; contribution_id?: string }>
      }>(response)
      expect(
        response.status(),
        `POST should return 200; got ${response.status()} body=${JSON.stringify(body)}`,
      ).toBe(200)
      expect(body?.import_batch_id).toBe(batchId)
      expect(body?.accepted_count).toBe(1)
      expect(body?.rejected_count).toBe(0)
      expect(body?.per_row?.length).toBe(1)
      expect(body?.per_row?.[0]?.status).toBe('accepted')
      expect(body?.per_row?.[0]?.contribution_id).toBeTruthy()
    } finally {
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })

  test('T3 — unresolvable github_profile lands in audit log (rejected)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)
    const agencyId = await createAgencyFixture(request, token, {
      name: `WIC T3-3 ${suffix}`,
      slug: `wic-t3-3-${suffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })
    try {
      await patchAgencyOnboarded(request, token, agencyId)

      const batchId = uuidv4()
      const idempotencyKey = uuidv4()
      const response = await wicServicePost(
        request,
        'POST',
        `/api/prm/service/wic/imports/${batchId}`,
        {
          headers: {
            'X-Om-Import-Secret': WIC_SECRET,
            'X-Om-Request-Timestamp': nowIso(),
            'X-Om-Idempotency-Key': idempotencyKey,
          },
          data: {
            script_version: '1.0-agent',
            month: '2026-03',
            rows: [
              {
                row_index: 0,
                github_profile: `ghost-${suffix}`,
                contribution_month: '2026-03-01',
                wic_level: 'L1',
                wic_score: 1,
                computed_at: '2026-04-02T08:30:00Z',
              },
            ],
          },
        },
      )
      const body = await readJsonSafe<{
        accepted_count?: number
        rejected_count?: number
        per_row?: Array<{ status: string; rejection_reason?: string }>
      }>(response)
      expect(response.status()).toBe(200)
      expect(body?.accepted_count).toBe(0)
      expect(body?.rejected_count).toBe(1)
      expect(body?.per_row?.[0]?.status).toBe('rejected')
      expect(body?.per_row?.[0]?.rejection_reason).toBe('unknown_github_profile')
    } finally {
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })

  test('T7 — timestamp outside ±5min window returns 408', async ({ request }) => {
    const batchId = uuidv4()
    const response = await wicServicePost(
      request,
      'POST',
      `/api/prm/service/wic/imports/${batchId}`,
      {
        headers: {
          'X-Om-Import-Secret': WIC_SECRET,
          'X-Om-Request-Timestamp': nowIso(-10 * 60 * 1000), // 10min ago
          'X-Om-Idempotency-Key': uuidv4(),
        },
        data: { script_version: '1.0-agent', month: '2026-03', rows: [] },
      },
    )
    expect(response.status()).toBe(408)
  })

  test('T8 — bad X-Om-Import-Secret returns 401 on POST', async ({ request }) => {
    const batchId = uuidv4()
    const response = await wicServicePost(
      request,
      'POST',
      `/api/prm/service/wic/imports/${batchId}`,
      {
        headers: {
          'X-Om-Import-Secret': 'wrong-secret',
          'X-Om-Request-Timestamp': nowIso(),
          'X-Om-Idempotency-Key': uuidv4(),
        },
        data: { script_version: '1.0-agent', month: '2026-03', rows: [] },
      },
    )
    expect(response.status()).toBe(401)
  })

  test('T8b — bad X-Om-Import-Secret returns 401 on GET profiles', async ({ request }) => {
    const response = await wicServicePost(
      request,
      'GET',
      '/api/prm/service/wic/profiles',
      {
        headers: {
          'X-Om-Import-Secret': 'wrong-secret',
          'X-Om-Request-Timestamp': nowIso(),
        },
      },
    )
    expect(response.status()).toBe(401)
  })

  test('T9 — GET profiles happy path returns onboarded active members', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)
    const agencyId = await createAgencyFixture(request, token, {
      name: `WIC T9 ${suffix}`,
      slug: `wic-t9-${suffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })
    try {
      await patchAgencyOnboarded(request, token, agencyId)
      const githubHandle = `wic-t9-${suffix}`
      await inviteMemberWithGithub(request, token, agencyId, githubHandle, `t9-${suffix}`)

      const response = await wicServicePost(
        request,
        'GET',
        '/api/prm/service/wic/profiles',
        {
          headers: {
            'X-Om-Import-Secret': WIC_SECRET,
            'X-Om-Request-Timestamp': nowIso(),
          },
        },
      )
      const body = await readJsonSafe<{
        month?: string
        profiles?: Array<{ agency_member_id: string; github_profile: string; agency_slug: string }>
      }>(response)
      expect(response.status()).toBe(200)
      expect(body?.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
      const seeded = (body?.profiles ?? []).find((p) => p.github_profile === githubHandle)
      expect(seeded, 'seeded github_profile must appear in roster').toBeTruthy()
      expect(seeded?.agency_slug).toBe(`wic-t9-${suffix}`)
    } finally {
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })

  test('B10 — audit-log GET + POST resolve round-trip (US6.4)', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = Date.now().toString(36)
    const agencyId = await createAgencyFixture(request, token, {
      name: `WIC B10 ${suffix}`,
      slug: `wic-b10-${suffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })
    try {
      await patchAgencyOnboarded(request, token, agencyId)

      // Create an audit log row by POSTing a batch with an unresolvable github_profile.
      const batchId = uuidv4()
      const importResponse = await wicServicePost(
        request,
        'POST',
        `/api/prm/service/wic/imports/${batchId}`,
        {
          headers: {
            'X-Om-Import-Secret': WIC_SECRET,
            'X-Om-Request-Timestamp': nowIso(),
            'X-Om-Idempotency-Key': uuidv4(),
          },
          data: {
            script_version: '1.0-agent',
            month: '2026-03',
            rows: [
              {
                row_index: 0,
                github_profile: `b10-ghost-${suffix}`,
                contribution_month: '2026-03-01',
                wic_level: 'L1',
                wic_score: 1,
                computed_at: '2026-04-02T08:30:00Z',
              },
            ],
          },
        },
      )
      expect(importResponse.status()).toBe(200)
      const importBody = await readJsonSafe<{
        per_row?: Array<{ status: string; audit_log_id?: string }>
      }>(importResponse)
      const auditLogId = importBody?.per_row?.[0]?.audit_log_id
      expect(auditLogId, 'audit log id must be returned for rejected row').toBeTruthy()

      // GET /api/prm/wic/audit-log — default filter (resolved=false).
      const listResponse = await apiRequest(request, 'GET', '/api/prm/wic/audit-log', { token })
      expect(listResponse.status()).toBe(200)
      const listBody = await readJsonSafe<{
        items?: Array<{ id: string; rejectionReason: string; resolvedAt: string | null }>
      }>(listResponse)
      const ourRow = listBody?.items?.find((r) => r.id === auditLogId)
      expect(ourRow, 'rejected row must appear in default open-issues view').toBeTruthy()
      expect(ourRow?.rejectionReason).toBe('unknown_github_profile')
      expect(ourRow?.resolvedAt).toBeNull()

      // POST resolve.
      const resolveResponse = await apiRequest(
        request,
        'POST',
        `/api/prm/wic/audit-log/${auditLogId}/resolve`,
        {
          token,
          data: { action: 'accepted_after_fix', note: 'Backfilled member offline' },
        },
      )
      expect(resolveResponse.status()).toBe(200)
      const resolveBody = await readJsonSafe<{
        auditLog?: { resolutionAction?: string; resolvedAt?: string }
      }>(resolveResponse)
      expect(resolveBody?.auditLog?.resolutionAction).toBe('accepted_after_fix')
      expect(resolveBody?.auditLog?.resolvedAt).toBeTruthy()

      // Re-resolving must 409.
      const reResolve = await apiRequest(
        request,
        'POST',
        `/api/prm/wic/audit-log/${auditLogId}/resolve`,
        {
          token,
          data: { action: 'ignored' },
        },
      )
      expect(reResolve.status()).toBe(409)

      // After resolution: default open-issues view must NOT show the row.
      const listAfter = await apiRequest(request, 'GET', '/api/prm/wic/audit-log', { token })
      const afterBody = await readJsonSafe<{ items?: Array<{ id: string }> }>(listAfter)
      const afterMatch = afterBody?.items?.find((r) => r.id === auditLogId)
      expect(afterMatch, 'resolved row must not appear in default open-issues view').toBeFalsy()

      // resolved=true filter must include it.
      const resolvedListResponse = await apiRequest(
        request,
        'GET',
        '/api/prm/wic/audit-log?resolved=true',
        { token },
      )
      const resolvedListBody = await readJsonSafe<{
        items?: Array<{ id: string; resolutionAction: string }>
      }>(resolvedListResponse)
      const resolvedMatch = resolvedListBody?.items?.find((r) => r.id === auditLogId)
      expect(resolvedMatch?.resolutionAction).toBe('accepted_after_fix')
    } finally {
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })
})
