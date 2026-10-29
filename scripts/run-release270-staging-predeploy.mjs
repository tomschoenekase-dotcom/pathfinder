// Code-only staging gate. Fixed image artifacts; no migration CLI or subprocess.
import assert from 'node:assert/strict'
import path from 'node:path'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readMigrationManifest } from './run-staging-migration-predeploy.mjs'
import {
  APPLICATION_SOURCE_FILES,
  APPLICATION_MODULE_URL,
  verifyRelease270ApplicationArtifacts,
  assertRelease270ApplicationTarget,
  assertRelease270ApplicationReceipt,
  readRelease270ApplicationSnapshot,
  admitRelease270Application,
} from './lib/release270-application-admission.mjs'

export const APPLICATION_ARTIFACT_ROOT = '/admission'
async function boundedFile(file, max) {
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= max,
      'release270-application-file-size',
    )
    const bytes = await handle.readFile()
    assert.ok(bytes.length <= max, 'release270-application-file-size')
    return bytes
  } finally {
    await handle.close()
  }
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  assert.equal(args.length, 0, 'release270-application-no-options')
  assert.equal(process.platform, 'linux', 'release270-application-linux-required')
  assert.equal(
    import.meta.url,
    pathToFileURL(
      path.join(APPLICATION_ARTIFACT_ROOT, 'scripts/run-release270-staging-predeploy.mjs'),
    ).href,
    'release270-application-executable-location',
  )
  assert.equal(
    APPLICATION_MODULE_URL,
    pathToFileURL(
      path.join(APPLICATION_ARTIFACT_ROOT, 'scripts/lib/release270-application-admission.mjs'),
    ).href,
    'release270-application-library-location',
  )
  // Validate origin/controls before artifact/dependency reads or opening a client.
  assert.equal(environment.RAILWAY_ENVIRONMENT, 'staging', 'release270-application-staging-only')
  assert.equal(
    environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS,
    '0',
    'release270-application-opt-in-must-be-zero',
  )
  assert.equal(
    environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD,
    '0',
    'release270-application-hold-must-be-zero',
  )
  assert.ok(
    !environment.NODE_OPTIONS && !environment.NODE_PATH,
    'release270-application-node-overrides',
  )
  for (const [key, value] of Object.entries(environment)) {
    if (/^prisma_.*(?:engine|binary|library)/iu.test(key))
      assert.ok(
        key === 'PRISMA_QUERY_ENGINE_LIBRARY' && value === '/app/prisma-engine/query-engine.node',
        'release270-application-engine-override',
      )
  }
  const root = APPLICATION_ARTIFACT_ROOT
  const sourceFiles = {}
  for (const name of APPLICATION_SOURCE_FILES)
    sourceFiles[name] = await boundedFile(path.join(root, name), 8 * 1024 * 1024)
  const artifacts = verifyRelease270ApplicationArtifacts({
    sealBytes: await boundedFile(path.join(root, 'release270-image-seal.json'), 64 * 1024),
    receiptBytes: await boundedFile(
      path.join(root, 'release270-application-release.json'),
      128 * 1024,
    ),
    referenceBytes: await boundedFile(
      path.join(root, 'release270-reference.json'),
      16 * 1024 * 1024,
    ),
    expectedSealSha256: environment.PATHFINDER_RELEASE270_IMAGE_SEAL_SHA256,
    sourceFiles,
    manifest: await readMigrationManifest(path.join(root, 'packages/db/prisma')),
  })
  assertRelease270ApplicationTarget(environment, artifacts)
  assertRelease270ApplicationReceipt(artifacts)
  const require = createRequire(path.join(root, 'packages/db/package.json'))
  const { PrismaClient } = require('@prisma/client')
  const connection = new URL(environment.DIRECT_DATABASE_URL)
  connection.searchParams.set('connection_limit', '1')
  connection.searchParams.set('connect_timeout', '5')
  connection.searchParams.set('pool_timeout', '5')
  const database = new PrismaClient({ datasourceUrl: connection.toString() })
  try {
    const result = await admitRelease270Application({
      environment,
      artifacts,
      readSnapshot: () => readRelease270ApplicationSnapshot(database),
    })
    // Aggregate finite identity only; no URL, raw row, artifact or provider payload.
    console.log(JSON.stringify(result))
    return result
  } finally {
    await database.$disconnect()
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('release270-application-admission-stopped')
    process.exitCode = 1
  })
}
