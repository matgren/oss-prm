import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/testing/integration'
import { login } from '@open-mercato/core/testing/integration/auth'
import {
  createAgencyFixture,
  createLicenseDealFixture,
  deleteAgencyIfExists,
  deleteLicenseDealIfExists,
  resetPrmState,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-002 — Backend create-flow UI smoke.
 *
 * Regression coverage for two bugs found during user testing 2026-05-06:
 *
 * 1. BUG-PRM-UI-001 — Agency CrudForm `tier` select defaultValue not seeded
 *    into form state, causing submit to fail with "This field is required".
 *    Fix: Agency create page now passes `initialValues` to <CrudForm>.
 *
 * 2. BUG-PRM-UI-002 — Detail pages (Agency + LicenseDeal) hung indefinitely
 *    on <LoadingMessage> because they only checked `params.id` from
 *    `useParams()`, but the OM framework routes module pages through a
 *    catch-all `/backend/[...slug]`, so params arrive as
 *    `slug = ['prm', 'license-deals', '<uuid>']`. Fix: both detail pages now
 *    use a `resolveDynamicId(params)` helper that handles both shapes (the
 *    same pattern as the working core module pages — workflows, business_rules).
 *
 * Four sub-tests:
 *   - 2× create-flow happy paths (form fill → submit → redirect → detail loads)
 *   - 2× direct-URL detail loads (isolates the detail-page bug from the
 *     redirect path)
 */
test.describe('TC-PRM-T0-002: PRM create-flow UI smoke', () => {
  // Cross-spec test isolation — TRUNCATE PRM tables before each test.
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await resetPrmState(request, token)
  })

  test('Agency create UI flow reaches detail page (no loading hang)', async ({ page, request }) => {
    await login(page, 'admin')

    const uniqueSuffix = Date.now().toString(36)
    const agencyName = `Smoke Agency UI ${uniqueSuffix}`
    const agencySlug = `smoke-ui-${uniqueSuffix}`

    await page.goto('/backend/prm/new')
    await expect(page.getByRole('heading', { name: /create agency/i })).toBeVisible()

    await page.locator('[data-crud-field-id="name"] input').fill(agencyName)
    await page.locator('[data-crud-field-id="slug"] input').fill(agencySlug)
    await page.locator('[data-crud-field-id="headquartersCountry"] input').fill('US')
    await page.getByRole('button', { name: 'Create' }).first().click()

    await page.waitForURL(/\/backend\/prm\/[0-9a-f-]{36}$/, { timeout: 15_000 })

    const detailUrl = page.url()
    const agencyId = detailUrl.split('/').pop() ?? ''

    try {
      await expect(page.getByRole('button', { name: /^profile$/i })).toBeVisible({ timeout: 10_000 })
      await expect(page.getByRole('heading', { name: agencyName })).toBeVisible()
    } finally {
      const token = await getAuthToken(request, 'admin')
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })

  test('LicenseDeal create UI flow reaches detail page (no loading hang)', async ({ page, request }) => {
    await login(page, 'admin')

    const uniqueSuffix = Date.now().toString(36)
    const licenseIdentifier = `OM-SMOKE-${uniqueSuffix.toUpperCase()}`
    const clientCompany = `Smoke Client UI ${uniqueSuffix}`

    await page.goto('/backend/prm/license-deals/new')
    await expect(page.getByRole('heading', { name: /new license deal/i })).toBeVisible()

    await page.locator('[data-crud-field-id="licenseIdentifier"] input').fill(licenseIdentifier)
    await page.locator('[data-crud-field-id="clientCompanyName"] input').fill(clientCompany)
    await page.getByRole('button', { name: 'Create' }).first().click()

    await page.waitForURL(/\/backend\/prm\/license-deals\/[0-9a-f-]{36}$/, { timeout: 15_000 })

    const detailUrl = page.url()
    const licenseDealId = detailUrl.split('/').pop() ?? ''

    try {
      await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible({ timeout: 10_000 })
      await expect(page.getByRole('heading', { name: new RegExp(licenseIdentifier) })).toBeVisible()
    } finally {
      const token = await getAuthToken(request, 'admin')
      await deleteLicenseDealIfExists(request, token, licenseDealId)
    }
  })

  test('Direct GET on Agency detail URL renders post-load', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const uniqueSuffix = Date.now().toString(36)
    const agencyId = await createAgencyFixture(request, token, {
      name: `Direct Agency ${uniqueSuffix}`,
      slug: `direct-${uniqueSuffix}`,
      tier: 'om_agency',
      headquartersCountry: 'US',
    })

    try {
      await login(page, 'admin')
      await page.goto(`/backend/prm/${agencyId}`)

      await expect(page.getByRole('button', { name: /^profile$/i })).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('heading', { name: new RegExp(`Direct Agency ${uniqueSuffix}`) })).toBeVisible()
    } finally {
      await deleteAgencyIfExists(request, token, agencyId)
    }
  })

  test('Direct GET on LicenseDeal detail URL renders post-load', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const uniqueSuffix = Date.now().toString(36)
    const licenseDealId = await createLicenseDealFixture(request, token, {
      clientCompanyName: `Direct Client ${uniqueSuffix}`,
      monthlyLicenseAmount: 500,
    })

    try {
      await login(page, 'admin')
      await page.goto(`/backend/prm/license-deals/${licenseDealId}`)

      await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible({ timeout: 15_000 })
    } finally {
      await deleteLicenseDealIfExists(request, token, licenseDealId)
    }
  })
})
