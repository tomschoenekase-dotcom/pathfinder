import { defineConfig } from '@playwright/test'

const integrationEnabled = process.env.RUN_ONBOARDING_CONNECTED_DB_INTEGRATION === '1'
const suppliedBaseURL = process.env.ONBOARDING_CONNECTED_BASE_URL
const baseURL = suppliedBaseURL ?? 'http://127.0.0.1:3002'

if (integrationEnabled) {
  if (!suppliedBaseURL) throw new Error('ONBOARDING_CONNECTED_BASE_URL is required')
  const parsed = new URL(suppliedBaseURL)
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password
  )
    throw new Error('ONBOARDING_CONNECTED_BASE_URL must be a credential-free loopback HTTP URL')
  if (!/\/pathfinder_disposable_onboarding_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? ''))
    throw new Error('The connected onboarding proof requires its exact disposable database')
}

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'onboarding-connected.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  outputDir: '../../test-results/onboarding-connected',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../playwright-report/onboarding-connected' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'connected-chromium', use: { viewport: { width: 820, height: 1180 } } }],
  metadata: { baseURL, fixtureAuthority: 'synthetic-test-session' },
})
