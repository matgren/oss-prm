import { expect, test } from '@playwright/test'
import {
  apiRequest,
  getAuthToken,
  readJsonSafe,
} from '@open-mercato/core/testing/integration'
import {
  createAgencyFixture,
  createLicenseDealFixture,
  deleteAgencyIfExists,
  deleteLicenseDealIfExists,
} from '@/modules/prm/testing/integration'

test.describe('TC-PRM-SMOKE-001: PRM fixture wire-up', () => {
  test('createAgencyFixture seeds an Agency that GET returns', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const uniqueSuffix = Date.now().toString(36)
    const agencyId = await createAgencyFixture(request, token, {
      name: `Smoke Agency ${uniqueSuffix}`,
      slug: `smoke-${uniqueSuffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })
    try {
      const getResponse = await apiRequest(request, 'GET', `/api/prm/agency/${agencyId}`, { token })
      const body = await readJsonSafe<{ ok: true; agency?: { id: string; name: string } }>(getResponse)
      expect(getResponse.status(), `GET /api/prm/agency/${agencyId} should return 200`).toBe(200)
      expect(body?.agency?.id).toBe(agencyId)
      expect(body?.agency?.name).toBe(`Smoke Agency ${uniqueSuffix}`)
    } finally {
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })

  test('createLicenseDealFixture seeds a LicenseDeal that GET returns', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const uniqueSuffix = Date.now().toString(36)
    const licenseDealId = await createLicenseDealFixture(request, token, {
      clientCompanyName: `Smoke Client ${uniqueSuffix}`,
      monthlyLicenseAmount: 500,
    })
    try {
      const getResponse = await apiRequest(request, 'GET', `/api/prm/license-deal/${licenseDealId}`, { token })
      const body = await readJsonSafe<{ ok: true; licenseDeal?: { id: string } }>(getResponse)
      expect(getResponse.status(), `GET /api/prm/license-deal/${licenseDealId} should return 200`).toBe(200)
      expect(body?.licenseDeal?.id).toBe(licenseDealId)
    } finally {
      await deleteLicenseDealIfExists(request, token, licenseDealId)
    }
  })
})
