const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { mkdirSync } = require('node:fs')
const { defineConfig, devices } = require('../../apps/dashboard/node_modules/@playwright/test')

const realStack = process.env.TORCHIKO_DISTRIBUTION_REAL_STACK === '1'
const webOrigin = process.env.TORCHIKO_DISTRIBUTION_WEB_ORIGIN ?? (realStack ? 'https://localhost:4173' : 'http://127.0.0.1:4173')
const fixtureOrigin = process.env.TORCHIKO_DISTRIBUTION_FIXTURE_ORIGIN ?? (realStack ? 'https://127.0.0.1:4174' : 'http://127.0.0.1:4174')
const evidenceDirectory = path.resolve(__dirname, '../../../qa/distribution')
const repositoryRoot = path.resolve(__dirname, '../..')
const runId = process.env.TORCHIKO_DISTRIBUTION_RUN_ID ??= `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
const runDirectory = path.join(evidenceDirectory, 'playwright', runId)
mkdirSync(runDirectory, { recursive: true })
const webProxyPort = Number(process.env.TORCHIKO_DISTRIBUTION_WEB_PROXY_PORT ?? 4175)
const fixtureControlPort = Number(process.env.TORCHIKO_DISTRIBUTION_CONTROL_PORT ?? 4176)
const fixtureManifest = process.env.TORCHIKO_DISTRIBUTION_FIXTURE_MANIFEST ?? path.join(evidenceDirectory, 'real-fixture.json')
const fixtureControlToken = process.env.TORCHIKO_DISTRIBUTION_CONTROL_TOKEN ?? `${randomUUID()}${randomUUID()}`
process.env.TORCHIKO_DISTRIBUTION_REQUEST_LOG = path.join(runDirectory, 'cross-origin-requests.jsonl')
process.env.TORCHIKO_DISTRIBUTION_CONTROL_TOKEN = fixtureControlToken
const sharedWebServerEnv = {
  TORCHIKO_DISTRIBUTION_WEB_ORIGIN: webOrigin,
  TORCHIKO_DISTRIBUTION_TLS_PFX: process.env.TORCHIKO_DISTRIBUTION_TLS_PFX ?? '',
  TORCHIKO_DISTRIBUTION_TLS_PFX_PASSWORD: process.env.TORCHIKO_DISTRIBUTION_TLS_PFX_PASSWORD ?? 'distribution-fixture-only',
  TORCHIKO_DISTRIBUTION_WEB_PROXY_TARGET: `http://127.0.0.1:${webProxyPort}`,
  TORCHIKO_DISTRIBUTION_REQUEST_LOG: process.env.TORCHIKO_DISTRIBUTION_REQUEST_LOG,
}

if (realStack && (
  new URL(webOrigin).protocol !== 'https:' || new URL(webOrigin).hostname !== 'localhost' ||
  new URL(fixtureOrigin).protocol !== 'https:' || new URL(fixtureOrigin).hostname !== '127.0.0.1' ||
  !process.env.TORCHIKO_DISTRIBUTION_TLS_PFX ||
  !process.env.DATABASE_URL || !process.env.INTERNAL_POLICY_TOKEN ||
  !process.env.CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY ||
  new URL(process.env.DATABASE_URL).hostname !== '127.0.0.1' || new URL(process.env.DATABASE_URL).port !== '57905' ||
  new URL(process.env.DATABASE_URL).pathname !== '/pathfinder_disposable_distribution_a5'
)) {
  throw new Error('Real-stack mode requires HTTPS localhost + 127.0.0.1 origins, the local PFX, exact task-owned loopback A5 DATABASE_URL, internal policy token, and fixture Clerk keys supplied by the operator.')
}

const webServers = realStack
  ? [
      {
        command: `node server.js`,
        cwd: path.resolve(__dirname, '../../apps/web/.next/standalone/apps/web'),
        url: `http://127.0.0.1:${webProxyPort}/widget.js`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
          HOSTNAME: '0.0.0.0',
          PORT: String(webProxyPort),
          DATABASE_URL: process.env.DATABASE_URL,
          DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
          INTERNAL_WEB_ORIGIN: `http://127.0.0.1:${webProxyPort}`,
          INTERNAL_POLICY_TOKEN: process.env.INTERNAL_POLICY_TOKEN,
          REDIS_URL: process.env.REDIS_URL ?? '',
          RAILWAY_ENVIRONMENT: 'preview',
          CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY,
          CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
          NEXT_PUBLIC_WEB_URL: webOrigin,
          WEBSITE_DISTRIBUTION_ENABLED: 'true',
          APP_DISTRIBUTION_ENABLED: 'true',
        },
      },
      {
        command: `node "${path.resolve(__dirname, 'tls-web-proxy.mjs')}"`,
        cwd: repositoryRoot,
        url: `${webOrigin}/widget.js`,
        reuseExistingServer: !process.env.CI,
        ignoreHTTPSErrors: true,
        timeout: 15_000,
        env: sharedWebServerEnv,
      },
      {
        command: `node "${path.resolve(__dirname, 'website-host/server.mjs')}"`,
        cwd: repositoryRoot,
        url: `${fixtureOrigin}/`,
        reuseExistingServer: !process.env.CI,
        ignoreHTTPSErrors: true,
        timeout: 15_000,
        env: { ...sharedWebServerEnv, TORCHIKO_FIXTURE_PORT: String(new URL(fixtureOrigin).port || 443) },
      },
      {
        command: `pnpm --dir packages/db exec tsx "${path.resolve(__dirname, 'fixture-db.ts')}" serve`,
        cwd: repositoryRoot,
        url: `http://127.0.0.1:${fixtureControlPort}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        env: {
          DATABASE_URL: process.env.DATABASE_URL,
          DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
          TORCHIKO_DISTRIBUTION_FIXTURE_MANIFEST: fixtureManifest,
          TORCHIKO_DISTRIBUTION_CONTROL_PORT: String(fixtureControlPort),
          TORCHIKO_DISTRIBUTION_CONTROL_TOKEN: fixtureControlToken,
        },
      },
    ]
  : [
      {
        command: `node "${path.resolve(__dirname, 'web-origin.mjs')}"`,
        cwd: repositoryRoot,
        url: `${webOrigin}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
      },
      {
        command: `node "${path.resolve(__dirname, 'website-host/server.mjs')}"`,
        cwd: repositoryRoot,
        url: `${fixtureOrigin}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
      },
    ]

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(runDirectory, 'report') }]],
  outputDir: path.join(runDirectory, 'results'),
  use: {
    baseURL: fixtureOrigin,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: webServers,
  projects: [
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone-390', use: { viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
  grep: realStack ? /@real/u : /@stub/u,
  metadata: { webOrigin, fixtureOrigin, realStack },
})
