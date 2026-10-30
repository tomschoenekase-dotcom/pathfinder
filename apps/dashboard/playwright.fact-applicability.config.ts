import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const runId = (process.env.TORCHIKO_AUTHORING_RUN_ID ??= randomUUID())
export default defineConfig({
  testDir: './tests/visual',
  testMatch: 'fact-applicability.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  outputDir: `../../../qa/authoring-browser-01/${runId}/results`,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `../../../qa/authoring-browser-01/${runId}/report` }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:56346',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    colorScheme: 'light',
  },
  projects: [320, 820, 1440, 1920].map((width) => ({
    name: `width-${width}`,
    use: { viewport: { width, height: width === 320 ? 720 : 1000 } },
  })),
})
