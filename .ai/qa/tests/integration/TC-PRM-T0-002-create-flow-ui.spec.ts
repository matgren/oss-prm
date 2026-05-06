import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/testing/integration'
import { login } from '@open-mercato/core/testing/integration/auth'
import {
  createAgencyFixture,
  createLicenseDealFixture,
  deleteAgencyIfExists,
  deleteLicenseDealIfExists,
} from '@/modules/prm/testing/integration'

/**
 * TC-PRM-T0-002 — Backend create-flow UI smoke.
 *
 * Regression coverage for the user-reported "loading hang on create" symptom:
 * after a successful POST the create page redirects to /backend/prm/<id>, and
 * the detail page must exit its loading state. If the detail GET hangs (or
 * the load function never resolves), the user sees `<LoadingMessage>` forever
 * and cannot edit the freshly-created entity.
 *
 * Two flows covered:
 *   1. Agency create (CrudForm at /backend/prm/new → detail at /backend/prm/<id>)
 *   2. LicenseDeal create (CrudForm at /backend/prm/license-deals/new → detail
 *      at /backend/prm/license-deals/<id>)
 *
 * Both must (a) navigate to the detail URL post-submit and (b) reach a
 * post-load DOM marker (Profile/Members tabs for Agency, Overview section
 * for LicenseDeal) within a generous timeout.
 */
test.describe('TC-PRM-T0-002: PRM create-flow UI smoke', () => {
  // BUG-PRM-UI-001: Agency CrudForm 'tier' defaultValue: 'om_agency' is not
  // applied to form state — submit blocked by "This field is required". Until
  // the form uses initialValues or the defaultValue prop is honored, this flow
  // can only proceed with explicit tier selection (which we do below).
  //
  // BUG-PRM-UI-002: Even after the form submits and redirect happens, the
  // detail page hangs on <LoadingMessage> because useParams() returns empty
  // and the load() useEffect short-circuits at `if (!id) return`. Marked
  // fixme until the fix lands; the assertions below are correct and will
  // start passing once the bug is fixed.
  test.fixme('Agency create UI flow reaches detail page (no loading hang)', async ({ page, request }) => {
    await login(page, 'admin')

    const uniqueSuffix = Date.now().toString(36)
    const agencyName = `Smoke Agency UI ${uniqueSuffix}`
    const agencySlug = `smoke-ui-${uniqueSuffix}`

    await page.goto('/backend/prm/new')
    await expect(page.getByRole('heading', { name: /create agency/i })).toBeVisible()

    await page.locator('[data-crud-field-id="name"] input').fill(agencyName)
    await page.locator('[data-crud-field-id="slug"] input').fill(agencySlug)
    await page.locator('[data-crud-field-id="tier"] select').selectOption('om_agency')
    await page.locator('[data-crud-field-id="headquartersCountry"] input').fill('US')
    await page.getByRole('button', { name: 'Create' }).first().click()

    await page.waitForURL(/\/backend\/prm\/[0-9a-f-]{36}$/, { timeout: 15_000 })

    const detailUrl = page.url()
    const agencyId = detailUrl.split('/').pop() ?? ''
    expect(agencyId).toMatch(/^[0-9a-f-]{36}$/)

    await expect(page.getByRole('button', { name: /^profile$/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: agencyName })).toBeVisible()

    const token = await getAuthToken(request, 'admin')
    await deleteAgencyIfExists(request, token, agencyId)
  })

  // BUG-PRM-UI-002: see comment above. This is the LicenseDeal half — same
  // hang on detail page after redirect.
  test.fixme('LicenseDeal create UI flow reaches detail page (no loading hang)', async ({ page, request }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
    page.on('requestfailed', (req) => consoleErrors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`))

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
    expect(licenseDealId).toMatch(/^[0-9a-f-]{36}$/)

    try {
      await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible({ timeout: 10_000 })
      await expect(page.getByRole('heading', { name: new RegExp(licenseIdentifier) })).toBeVisible()
    } catch (err) {
      // Diagnostic dump for the loading-hang bug.
      console.log('=== LICENSE-DEAL DETAIL HANG DIAGNOSTICS ===')
      console.log('URL:', page.url())
      console.log('Console errors:', JSON.stringify(consoleErrors, null, 2))
      const visibleText = await page.locator('main').innerText().catch(() => '<unable to read main>')
      console.log('main text:', visibleText)
      throw err
    }

    const token = await getAuthToken(request, 'admin')
    await deleteLicenseDealIfExists(request, token, licenseDealId)
  })

  // BUG-PRM-UI-002: confirms hang reproduces via direct URL too — the bug is
  // in the detail page itself, not in the redirect path.
  test.fixme('Direct GET on Agency detail URL renders post-load (isolates redirect-vs-page bug)', async ({ page, request }) => {
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

  // BUG-PRM-UI-002 (LicenseDeal half).
  test.fixme('Direct GET on LicenseDeal detail URL renders post-load (isolates redirect-vs-page bug)', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const uniqueSuffix = Date.now().toString(36)
    const licenseDealId = await createLicenseDealFixture(request, token, {
      clientCompanyName: `Direct Client ${uniqueSuffix}`,
      monthlyLicenseAmount: 500,
    })

    const apiTraffic: string[] = []
    page.on('response', (resp) => {
      const url = resp.url()
      if (url.includes('/api/prm/')) {
        apiTraffic.push(`${resp.status()} ${resp.request().method()} ${url}`)
      }
    })
    const consoleMsgs: string[] = []
    page.on('console', (msg) => consoleMsgs.push(`${msg.type()}: ${msg.text()}`))
    page.on('pageerror', (err) => consoleMsgs.push(`pageerror: ${err.message}`))

    try {
      await login(page, 'admin')
      await page.goto(`/backend/prm/license-deals/${licenseDealId}`)

      try {
        await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible({ timeout: 15_000 })
      } catch (err) {
        console.log('=== DIRECT-GET LICENSE-DEAL DIAGNOSTICS ===')
        console.log('Test URL:', `/backend/prm/license-deals/${licenseDealId}`)
        console.log('Page URL:', page.url())
        console.log('PRM API traffic:', JSON.stringify(apiTraffic, null, 2))
        const last = consoleMsgs.slice(-15)
        console.log('Last 15 console msgs:', JSON.stringify(last, null, 2))
        const main = await page.locator('main').innerText().catch(() => '<unable>')
        console.log('main text:', main)
        // also check what useParams yields by reading route from react-router
        const rscParams = await page.evaluate(() => {
          const path = window.location.pathname
          const segs = path.split('/').filter(Boolean)
          return { path, segs, lastSeg: segs[segs.length - 1] }
        })
        console.log('Window pathname segments:', rscParams)
        throw err
      }
    } finally {
      await deleteLicenseDealIfExists(request, token, licenseDealId)
    }
  })
})
