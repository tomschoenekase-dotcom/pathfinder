import { defineConfig } from '@playwright/test'

const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'
const externalServer = Boolean(process.env.PLAYWRIGHT_VISITOR_BASE_URL)

export default defineConfig({
  testDir: './tests/visitor-launch',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  outputDir: '../../test-results/visitor-launch',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../playwright-report/visitor-launch' }],
  ],
  use: {
    baseURL: visitorBaseUrl,
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    screenshot: 'only-on-failure',
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
    {
      name: 'android-320-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 320, height: 568 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'android-390-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'mobile-safari-390-webkit',
      use: {
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'tablet-768-chromium',
      use: { browserName: 'chromium', viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    {
      name: 'desktop-1440-chromium',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
  metadata: { visitorBaseUrl },
})
