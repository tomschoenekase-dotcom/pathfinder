import { defineConfig } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const externalServer = Boolean(process.env.PLAYWRIGHT_DASHBOARD_BASE_URL)

export default defineConfig({
  testDir: './tests/dashboard-performance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: '../../test-results/dashboard-performance',
  reporter: [['list']],
  use: {
    baseURL: dashboardBaseUrl,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  ...(externalServer
    ? {}
    : {
        webServer: {
          command: 'pnpm dev',
          url: `${dashboardBaseUrl}/dev-fixtures/dashboard-performance`,
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
            TORCHIKO_VISUAL_FIXTURES_ENABLED: '1',
          },
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
})
