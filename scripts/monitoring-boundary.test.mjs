import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const runtimeConfigs = [
  'apps/web/instrumentation-client.ts',
  'apps/web/sentry.edge.config.ts',
  'apps/web/sentry.server.config.ts',
  'apps/dashboard/instrumentation-client.ts',
  'apps/dashboard/sentry.edge.config.ts',
  'apps/dashboard/sentry.server.config.ts',
  'apps/workers/src/sentry.ts',
]

test('every monitoring runtime applies the errors-only privacy boundary', async () => {
  for (const path of runtimeConfigs) {
    const source = await read(path)
    assert.match(source, /sanitizeMonitoringEvent/)
    assert.match(source, /beforeBreadcrumb:\s*\(\) => null/)
    assert.match(source, /beforeSendTransaction:\s*\(\) => null/)
    assert.match(source, /enableLogs:\s*false/)
    assert.match(source, /enableMetrics:\s*false/)
    assert.match(source, /maxBreadcrumbs:\s*0/)
    assert.match(source, /sendDefaultPii:\s*false/)
    assert.match(source, /sendClientReports:\s*false/)
    assert.match(source, /tracesSampleRate:\s*0/)
    assert.doesNotMatch(source, /replayIntegration|replayCanvasIntegration/)
  }
})

test('browser monitoring cannot reference server DSN or source-map credentials', async () => {
  for (const path of [
    'apps/web/instrumentation-client.ts',
    'apps/dashboard/instrumentation-client.ts',
  ]) {
    const source = await read(path)
    assert.match(source, /NEXT_PUBLIC_SENTRY_DSN/)
    assert.doesNotMatch(source, /process\.env\.SENTRY_DSN/)
    assert.doesNotMatch(source, /AUTH_TOKEN|SENTRY_ORG|SENTRY_.*_PROJECT/)
  }
})

test('worker monitoring is preloaded before the bundled entry', async () => {
  const [packageJson, dockerfile, tsupConfig] = await Promise.all([
    read('apps/workers/package.json'),
    read('Dockerfile.workers'),
    read('apps/workers/tsup.config.ts'),
  ])

  assert.match(packageJson, /node --require \.\/dist\/sentry\.js dist\/index\.js/)
  assert.match(
    dockerfile,
    /CMD \["node", "--require", "\.\/apps\/workers\/dist\/sentry\.js", "apps\/workers\/dist\/index\.js"\]/,
  )
  assert.match(tsupConfig, /'src\/index\.ts', 'src\/sentry\.ts'/)
})
