import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'
const externalServers =
  process.env.PLAYWRIGHT_DASHBOARD_BASE_URL || process.env.PLAYWRIGHT_VISITOR_BASE_URL
// Playwright clears outputDir before a run. Keep each invocation's proof separate
// so later visual work cannot erase screenshots referenced by retained evidence.
// Config is loaded again in worker processes. Inherit one ID for this invocation.
const artifactRunId =
  (process.env.TORCHIKO_VISUAL_ARTIFACT_RUN_ID ??= `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`)
const artifactDirectory = `../../artifacts/mobile-visual/${artifactRunId}`

export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  outputDir: `${artifactDirectory}/results`,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${artifactDirectory}/report` }]],
  use: {
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  ...(externalServers
    ? {}
    : {
        webServer: [
          {
            command: 'pnpm --dir ../web dev',
            url: `${visitorBaseUrl}/dev-fixtures/visitor-chat`,
            env: { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '' },
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
          {
            command: 'pnpm dev',
            url: `${dashboardBaseUrl}/dev-fixtures/portal-home`,
            env: {
              NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
              TORCHIKO_VISUAL_FIXTURES_ENABLED: '1',
            },
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
        ],
      }),
  projects: [
    { name: 'phone-390x844', use: { viewport: { width: 390, height: 844 } } },
    { name: 'tablet-820x1180', use: { viewport: { width: 820, height: 1180 } } },
    { name: 'desktop-1440x900', use: { viewport: { width: 1440, height: 900 } } },
  ],
  metadata: { dashboardBaseUrl, visitorBaseUrl },
})
