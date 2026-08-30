import { defineConfig } from '@playwright/test'

const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'
const externalServer = Boolean(process.env.PLAYWRIGHT_VISITOR_BASE_URL)

export default defineConfig({
  testDir: './tests/visitor-performance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: '../../test-results/visitor-performance',
  reporter: [['list']],
  use: {
    baseURL: visitorBaseUrl,
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  ...(externalServer
    ? {}
    : {
        webServer: {
          command: 'pnpm --dir ../web dev',
          url: `${visitorBaseUrl}/dev-fixtures/visitor-chat`,
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
            NEXT_PUBLIC_PWA_ENABLED: 'false',
          },
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
  projects: [
    { name: 'mobile-unthrottled', metadata: { networkProfile: 'unthrottled' } },
    { name: 'mobile-weak-4g', metadata: { networkProfile: 'weak-4g' } },
  ],
  metadata: { visitorBaseUrl },
})
