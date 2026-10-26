// Exact release-only CLI. Existing injected authentication is used operationally;
// no credentials, URLs, provider payloads or venue content are logged or persisted.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  readMigrationManifest,
  createMigrationChildEnvironment,
  exitStagingPredeployFailure,
} from './run-staging-migration-predeploy.mjs'
import { assertStagingReleaseIdentity } from './lib/staging-migration-admission.mjs'
import { assertRelease269Manifest } from './lib/release269-migration-contract.mjs'
import { release269Target, runRelease269 } from './lib/release269-runtime-admission.mjs'
import { readRelease269Snapshot } from './lib/release269-readback.mjs'
import { readRelease269StagingQueues } from './lib/release269-queue-readback.mjs'

export function release269PrismaDirectory(root, target, environment) {
  const pinned = path.join(root, 'packages/db/prisma')
  if (target === 'production') {
    assert.ok(
      !environment.PATHFINDER_PRISMA_DIR ||
        path.resolve(environment.PATHFINDER_PRISMA_DIR) === path.resolve(pinned),
      'release269-production-prisma-directory-refused',
    )
    return pinned
  }
  return environment.PATHFINDER_PRISMA_DIR ?? pinned
}

export function release269MigrationChildEnvironment(environment, releaseSha, target) {
  const clean = {}
  // Match the existing disposable runner's override exclusions. The staging
  // image's fixed query library is the only explicitly approved engine override.
  for (const [key, value] of Object.entries(environment)) {
    const lower = key.toLowerCase()
    if (
      [
        'node_options',
        'node_path',
        'prisma_config_path',
        'database_url',
        'direct_database_url',
      ].includes(lower)
    )
      continue
    if (/^prisma_.*(?:engine|binary|library)/i.test(key)) continue
    if (/^pg(?:host|port|database|user|password|service|passfile|options|ssl)/i.test(key)) continue
    clean[key] = value
  }
  clean.DATABASE_URL = environment.DATABASE_URL
  clean.DIRECT_DATABASE_URL = environment.DIRECT_DATABASE_URL
  if (target === 'staging') {
    assert.ok(
      !environment.PRISMA_QUERY_ENGINE_LIBRARY ||
        environment.PRISMA_QUERY_ENGINE_LIBRARY === '/app/prisma-engine/query-engine.node',
      'release269-staging-query-engine-refused',
    )
    if (environment.PRISMA_QUERY_ENGINE_LIBRARY)
      clean.PRISMA_QUERY_ENGINE_LIBRARY = environment.PRISMA_QUERY_ENGINE_LIBRARY
  }
  return createMigrationChildEnvironment(clean, releaseSha)
}

async function boundedJson(file, inline) {
  const source = file ? await readFile(file, 'utf8') : inline
  assert.ok(
    typeof source === 'string' && Buffer.byteLength(source) <= 131_072,
    'release269-proof-required',
  )
  return JSON.parse(source)
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: 'string', default: 'staging' },
      'release-sha': { type: 'string' },
      proof: { type: 'string' },
      'queue-proof': { type: 'string' },
      receipt: { type: 'string' },
      readback: { type: 'boolean', default: false },
      'preserve-dormant-queues': { type: 'boolean', default: false },
    },
  })
  const target = values.target
  const releaseSha =
    values['release-sha'] ??
    (target === 'staging' ? assertStagingReleaseIdentity(environment) : undefined)
  const resource = release269Target(environment, target, releaseSha)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const prismaDirectory = release269PrismaDirectory(root, target, environment)
  const require = createRequire(path.join(prismaDirectory, '../package.json'))
  const { PrismaClient } = require('@prisma/client')
  const queueResourceIdentity =
    environment.RELEASE269_QUEUE_RESOURCE_ID ?? environment.REDIS_RESOURCE_ID
  assert.ok(queueResourceIdentity, 'release269-queue-identity-required')
  if (environment.RELEASE269_QUEUE_RESOURCE_ID && environment.REDIS_RESOURCE_ID)
    assert.equal(
      environment.RELEASE269_QUEUE_RESOURCE_ID,
      environment.REDIS_RESOURCE_ID,
      'release269-queue-identity-mismatch',
    )
  if (target === 'production') assert.ok(values.receipt, 'release269-private-journal-required')
  if (values.readback) assert.ok(values.receipt, 'release269-private-readback-file-required')
  let journalStarted = false
  const record = async (phase, evidence) => {
    const line = `${JSON.stringify({ kind: 'release269-migration', phase, evidence })}\n`
    if (values.receipt) {
      if (!journalStarted) {
        await writeFile(values.receipt, line, { flag: 'wx', mode: 0o600 })
        journalStarted = true
      } else await appendFile(values.receipt, line)
    }
    // Only aggregate fingerprints and the execution phase go to provider logs.
    console.log(
      JSON.stringify({
        kind: 'release269-migration',
        phase,
        releaseSha,
        ...(evidence.dataHash
          ? { dataHash: evidence.dataHash, physicalLedgerHash: evidence.physicalLedgerHash }
          : {}),
      }),
    )
  }
  const database = new PrismaClient({ datasourceUrl: environment.DIRECT_DATABASE_URL })
  const scope = {
    target,
    releaseSha,
    databaseResource: resource,
    queueResourceIdentity,
  }
  const readSnapshot = () => readRelease269Snapshot(database, scope)
  try {
    if (values.readback) {
      const manifest = await readMigrationManifest(prismaDirectory)
      assertRelease269Manifest(manifest)
      await record('readback-only', await readSnapshot())
      return
    }
    const proof = await boundedJson(values.proof, environment.PATHFINDER_RELEASE269_PROOF_JSON)
    await runRelease269({
      target,
      releaseSha,
      environment,
      proof,
      record,
      readSnapshot,
      inspectSource: async () => {
        const manifest = await readMigrationManifest(prismaDirectory)
        assertRelease269Manifest(manifest)
        if (target === 'staging')
          return { head: assertStagingReleaseIdentity(environment), status: '', manifest }
        const git = (...argv) =>
          execFileSync('git', argv, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
        return {
          head: git('rev-parse', 'HEAD'),
          status: git('status', '--porcelain', '--untracked-files=all'),
          manifest,
        }
      },
      readQueues: async () => {
        if (target !== 'staging')
          return boundedJson(
            values['queue-proof'],
            environment.PATHFINDER_RELEASE269_QUEUE_PROOF_JSON,
          )
        const jobsRequire = createRequire('/migration-jobs/package.json')
        const Redis = jobsRequire('ioredis')
        return readRelease269StagingQueues({
          environment,
          releaseSha,
          createConnection: (url, options) => new Redis(url, options),
          preserveDormantQueues: values['preserve-dormant-queues'],
        })
      },
      deploy: async () => {
        const child = release269MigrationChildEnvironment(environment, releaseSha, target)
        const cli = require.resolve('prisma/build/index.js')
        // Suppress child diagnostics: a failed driver must never print its URL.
        // Before/armed journal entries persist and an unknown outcome stops here.
        await new Promise((resolve, reject) => {
          const process = spawn(
            globalThis.process.execPath,
            [cli, 'migrate', 'deploy', '--schema', path.join(prismaDirectory, 'schema.prisma')],
            {
              env: child.environment,
              cwd: prismaDirectory,
              stdio: 'ignore',
              shell: false,
              windowsHide: true,
            },
          )
          process.once('error', () => reject(new Error('release269-migration-child-failed')))
          process.once('exit', (code, signal) =>
            code === 0 && !signal
              ? resolve()
              : reject(new Error('release269-migration-child-failed')),
          )
        })
      },
    })
  } finally {
    await database.$disconnect()
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(exitStagingPredeployFailure)
}
