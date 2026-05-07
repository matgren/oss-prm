import { expect, test } from '@playwright/test'
import { getAuthToken, readJsonSafe } from '@open-mercato/core/testing/integration'
import {
  bootPartnerAgencyWithMembers,
  customerApiRequest,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-003 — Spec #1 §9 IT-3 admin-only field 403 from portal.
 *
 * Source: SPEC-2026-04-23-agency-foundation.md §9 IT-3, POST-MVP-FOLLOW-UPS.md
 *   "Playwright integration tests (deferred) → T0 Agency Foundation → IT-3".
 *
 * Scenario (US1.3, US2.1, invariant #6):
 *   PartnerAdmin's `PATCH /api/prm/portal/agency/{id}` may carry editable
 *   fields (name, description, website, etc.) but MUST NOT be allowed to
 *   write the admin-only fields enumerated in `ADMIN_ONLY_AGENCY_FIELDS`:
 *   `tier`, `status`, `contractSigned`, `ndaSigned`, `onboarded` (plus
 *   snake_case mirrors for older clients). The route layer enforces this
 *   as the second leg of invariant #6's dual enforcement (the API
 *   `ApiInterceptor` is the first leg).
 *
 * Expected behaviour (per `api/portal/agency/[id]/route.ts`):
 *   - 403 with envelope `{ ok: false, error: { code: 'admin_only_field', … } }`
 *   - `details.fields` enumerates the offending keys.
 *   - The diagnostic event `prm.agency.admin_field_access_rejected` is
 *     emitted (covered by the unit-test `adminFieldInterceptor.test.ts`;
 *     not asserted here — this spec verifies the HTTP contract).
 *
 * We exercise the most security-sensitive admin-only field — `tier`. A
 * partner promoting their own Agency to a higher tier would unlock
 * cross-Agency reads (e.g. P11 marketing library is tier-gated), so the
 * 403 here is load-bearing.
 *
 * The test also asserts that, despite the rejection, GET still returns the
 * pre-attempt tier — confirming the 403 is short-circuited BEFORE any DB
 * write occurs.
 */
test.describe('TC-PRM-T0-003: Spec #1 §9 IT-3 — Admin-only field 403 from portal', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('PartnerAdmin PATCH portal/agency with `tier` returns 403 admin_only_field; tier unchanged', async ({
    request,
  }) => {
    const staffToken = await getAuthToken(request, 'admin')
    const suffix = `t0-003-${Date.now().toString(36)}`

    // Boot Agency seeded at tier=om_agency so we can meaningfully check the
    // attempted write (tier=ai_native_core) does not land.
    const agency = await bootPartnerAgencyWithMembers(request, staffToken, {
      suffix,
      tier: 'om_agency',
    })

    // ---- Step 1: confirm the partner_admin can read their own agency
    // (sanity gate — without this we couldn't distinguish "403 because
    // admin-only field" from "403 because the route doesn't see them").
    //
    // Note: partner_admin role carries `prm.agency.read_admin_fields` per
    // `setup.ts` (the seed under `PARTNER_ROLE_DEFINITIONS`), so the
    // `_prm` admin block IS present in the GET response — admin-fields
    // are READABLE from the portal but NOT WRITABLE (the inverse of the
    // invariant #6 contract: read OK, write 403). We capture the seeded
    // tier here so we can prove the rejected PATCH did not silently
    // mutate the row.
    const preReadResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/agency/${agency.agencyId}`,
      { customerToken: agency.admin.token },
    )
    const preBody = await readJsonSafe<{
      ok?: true
      agency?: { id?: string; name?: string; _prm?: { tier?: string } }
    }>(preReadResponse)
    expect(preReadResponse.status(), JSON.stringify(preBody)).toBe(200)
    expect(preBody?.agency?.id).toBe(agency.agencyId)
    expect(
      preBody?.agency?._prm?.tier,
      'pre-PATCH tier must match the seeded value (om_agency)',
    ).toBe('om_agency')

    // ---- Step 2: PATCH with the admin-only `tier` field — MUST 403.
    const patchResponse = await customerApiRequest(
      request,
      'PATCH',
      `/api/prm/portal/agency/${agency.agencyId}`,
      {
        customerToken: agency.admin.token,
        data: {
          // Editable field — included to prove the route is reaching the
          // admin-only-field check (and not some earlier validation gate).
          name: `Renamed Agency ${suffix}`,
          // Admin-only field — invariant #6 reject path.
          tier: 'ai_native_core',
        },
      },
    )
    expect(
      patchResponse.status(),
      'PATCH portal/agency with admin-only `tier` MUST return 403',
    ).toBe(403)

    const patchBody = await readJsonSafe<{
      ok?: boolean
      error?: { code?: string; message?: string; details?: { fields?: string[] } }
    }>(patchResponse)
    expect(patchBody?.error?.code, JSON.stringify(patchBody)).toBe('admin_only_field')
    expect(patchBody?.error?.details?.fields).toContain('tier')

    // ---- Step 3: GET again — both `tier` AND `name` unchanged.
    // The 403 is short-circuited BEFORE any DB write, so the editable field
    // (`name`) bundled in the same body MUST NOT have leaked through, AND
    // `tier` MUST remain at the seeded value (proving the admin-only write
    // truly didn't land).
    const postReadResponse = await customerApiRequest(
      request,
      'GET',
      `/api/prm/portal/agency/${agency.agencyId}`,
      { customerToken: agency.admin.token },
    )
    const postBody = await readJsonSafe<{
      ok?: true
      agency?: { id?: string; name?: string; _prm?: { tier?: string } }
    }>(postReadResponse)
    expect(postReadResponse.status(), JSON.stringify(postBody)).toBe(200)
    expect(
      postBody?.agency?._prm?.tier,
      'admin-only `tier` field MUST NOT have been written by the rejected PATCH',
    ).toBe('om_agency')
    expect(
      postBody?.agency?.name,
      'editable field bundled with admin-only field MUST NOT have been persisted',
    ).toBe(preBody?.agency?.name)
  })
})
