import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { resetPRMState } from './helpers/prm'

test.describe('TC-PRM-SMOKE-001: PRM helpers wiring', () => {
  test('resetPRMState clears prm_* tables without crashing', async () => {
    await resetPRMState()
    await resetPRMState()
  })

  test('admin can log in and reach the backend', async ({ page }) => {
    await login(page, 'admin')
    await expect(page).toHaveURL(/\/backend(?:\/|$)/)
  })
})
