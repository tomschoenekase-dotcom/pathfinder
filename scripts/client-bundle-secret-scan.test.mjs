import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLIENT_BUNDLE_SECRET_CANARIES,
  assertSecretCanaryRegistryCoversConfig,
  buildSecretCanaryEnvironment,
  discoverNextClientBundleTargets,
  scanClientBundleTargets,
} from './lib/client-bundle-secret-scan.mjs'

const temporaryRoots = []

async function fixtureRoot(prefix = 'pathfinder-client-bundle-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function target(root, options = {}) {
  return {
    application: options.application ?? 'web',
    root,
    label: options.label ?? 'apps/web/.next/static',
    required: options.required ?? true,
    ...(options.prerenderOnly ? { prerenderOnly: true } : {}),
  }
}

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('the canary registry covers every secret-shaped config key without stale entries', async () => {
  const source = await readFile(new URL('../packages/config/src/env.ts', import.meta.url), 'utf8')
  assert.deepEqual(assertSecretCanaryRegistryCoversConfig(source), [
    'ANTHROPIC_API_KEY',
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SECRET',
    'DATABASE_URL',
    'DIRECT_DATABASE_URL',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'INTEGRATION_ENCRYPTION_KEY',
    'OPENAI_API_KEY',
    'REDIS_URL',
    'RESEND_API_KEY',
    'RESEND_WEBHOOK_SECRET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
  ])
  assert.throws(
    () => assertSecretCanaryRegistryCoversConfig(source.replace('DATABASE_URL:', 'NEW_PASSWORD:')),
    /missing: NEW_PASSWORD.*stale: DATABASE_URL/u,
  )
})

test('the build environment replaces server credentials and removes build-service tokens', () => {
  const environment = buildSecretCanaryEnvironment({
    TURBO_TOKEN: 'must-not-survive',
    GITHUB_TOKEN: 'must-not-survive',
    DATABASE_URL: 'must-be-replaced',
    SAFE_VALUE: 'retained',
  })
  assert.equal(environment.TURBO_TOKEN, undefined)
  assert.equal(environment.GITHUB_TOKEN, undefined)
  assert.equal(environment.SAFE_VALUE, 'retained')
  assert.equal(environment.DATABASE_URL, CLIENT_BUNDLE_SECRET_CANARIES.DATABASE_URL.value)
  assert.equal(environment.NEXT_TELEMETRY_DISABLED, '1')
})

test('clean static, public, and prerender outputs pass without scanning server JavaScript', async () => {
  const root = await fixtureRoot()
  const staticRoot = join(root, '.next', 'static')
  const publicRoot = join(root, 'public')
  const appRoot = join(root, '.next', 'server', 'app')
  await mkdir(join(staticRoot, 'chunks'), { recursive: true })
  await mkdir(publicRoot, { recursive: true })
  await mkdir(appRoot, { recursive: true })
  await writeFile(join(staticRoot, 'chunks', 'app.js'), 'console.log("public")')
  await writeFile(join(publicRoot, 'sw.js'), 'self.addEventListener("fetch",()=>{})')
  await writeFile(join(appRoot, 'index.rsc'), 'public payload')
  await writeFile(join(appRoot, 'server.js'), CLIENT_BUNDLE_SECRET_CANARIES.OPENAI_API_KEY.marker)
  assert.deepEqual(
    await scanClientBundleTargets([
      target(staticRoot),
      target(publicRoot, { label: 'apps/web/public', required: false }),
      target(appRoot, {
        label: 'apps/web/.next/server/app',
        required: false,
        prerenderOnly: true,
      }),
    ]),
    { applications: 1, scannedFiles: 3, targets: 3 },
  )
})

for (const [kind, path, label] of [
  ['static', '.next/static/chunks/app.js', 'apps/web/.next/static'],
  ['public', 'public/widget.js', 'apps/web/public'],
  ['prerender', '.next/server/app/index.rsc', 'apps/web/.next/server/app'],
]) {
  test(`a canary leak in ${kind} output fails with an unambiguous redacted path`, async () => {
    const root = await fixtureRoot()
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true })
    const entry = CLIENT_BUNDLE_SECRET_CANARIES.OPENAI_API_KEY
    await writeFile(file, `window.value=${JSON.stringify(entry.marker)}`)
    const scanRoot = path.startsWith('.next/static')
      ? join(root, '.next', 'static')
      : path.startsWith('public')
        ? join(root, 'public')
        : join(root, '.next', 'server', 'app')
    await assert.rejects(
      scanClientBundleTargets([target(scanRoot, { label, prerenderOnly: path.endsWith('.rsc') })]),
      (error) => {
        assert.match(error.message, new RegExp(`canary:OPENAI_API_KEY in ${label}`, 'u'))
        assert.equal(error.message.includes(entry.marker), false)
        assert.equal(error.message.includes(entry.value), false)
        return true
      },
    )
  })
}

test('hardcoded provider credentials fail without echoing the match', async () => {
  const root = await fixtureRoot()
  await mkdir(join(root, 'chunks'), { recursive: true })
  const credentials = [
    `sk-proj-${'A'.repeat(32)}`,
    'redis://:THIS_IS_A_HARDCODED_PASSWORD_12345@cache.example.test:6379',
    'rediss://:THIS_IS_ANOTHER_HARDCODED_PASSWORD_67890@cache.example.test:6380',
  ]
  await writeFile(
    join(root, 'chunks', 'literal.js'),
    credentials.map((credential) => JSON.stringify(credential)).join('\n'),
  )
  await assert.rejects(scanClientBundleTargets([target(root)]), (error) => {
    assert.match(error.message, /pattern:openai-api-key/u)
    assert.equal(error.message.match(/pattern:credentialed-database-url/gu)?.length, 2)
    for (const credential of credentials) assert.equal(error.message.includes(credential), false)
    return true
  })
})

test('public identifiers and browser-safe endpoints are not treated as secrets', async () => {
  const root = await fixtureRoot()
  await writeFile(
    join(root, 'public.js'),
    [
      `pk_test_${'A'.repeat(32)}`,
      `phc_${'B'.repeat(32)}`,
      `sb_publishable_${'C'.repeat(32)}`,
      'https://public-key@o0.ingest.sentry.io/123',
      'https://example.test/public',
    ].join('\n'),
  )
  await assert.doesNotReject(scanClientBundleTargets([target(root)]))
})

test('missing, empty, and symbolic-link roots fail closed', async (context) => {
  const empty = await fixtureRoot()
  await assert.rejects(
    scanClientBundleTargets([target(join(empty, 'missing'))]),
    /root is missing/u,
  )
  await assert.rejects(scanClientBundleTargets([target(empty)]), /contains no files/u)

  const outside = await fixtureRoot('pathfinder-client-bundle-outside-')
  await writeFile(join(outside, 'secret.js'), 'public')
  try {
    await symlink(outside, join(empty, 'linked'), 'junction')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      context.skip('Windows symlink creation is unavailable without Developer Mode')
      return
    }
    throw error
  }
  await assert.rejects(scanClientBundleTargets([target(empty)]), /Refusing symbolic link/u)
})

test('Next application discovery includes every configured app and all deliverable target classes', async () => {
  const repository = await fixtureRoot('pathfinder-client-bundle-repo-')
  for (const application of ['alpha', 'beta']) {
    const appRoot = join(repository, 'apps', application)
    await mkdir(appRoot, { recursive: true })
    await writeFile(
      join(appRoot, application === 'alpha' ? 'next.config.ts' : 'next.config.mjs'),
      '',
    )
  }
  const targets = await discoverNextClientBundleTargets(repository)
  assert.equal(targets.length, 8)
  assert.deepEqual([...new Set(targets.map(({ application }) => application))], ['alpha', 'beta'])
  assert.equal(targets.filter(({ required }) => required).length, 2)
  assert.equal(targets.filter(({ prerenderOnly }) => prerenderOnly).length, 4)
})
