import { defineConfig } from '@playwright/test'

const artifactDirectory = process.env.TORCHIKO_VISUAL_ARTIFACT_DIR ?? '../../artifacts/guest-webkit'

export default defineConfig({
  testDir: './tests/visual',
  testMatch: [
    'guest-visit.spec.ts',
    'guest-webkit-viewport.spec.ts',
    'visitor-route-composer.spec.ts',
    'accessibility-depth.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  outputDir: `${artifactDirectory}/results`,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${artifactDirectory}/report` }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000',
    browserName: 'webkit',
    colorScheme: 'light',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'phone-320x568',
      use: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'phone-390x844',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'landscape-844x390',
      use: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'tablet-820x1180',
      use: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
    },
    { name: 'desktop-1440x900', use: { viewport: { width: 1440, height: 900 } } },
  ],
})
