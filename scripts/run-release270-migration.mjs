// Staging-only manual runner. This module is inert on import; historical predeploy
// commands are unchanged. Operational use needs separately reviewed fresh proofs.
import assert from 'node:assert/strict'
import path from 'node:path'
import { open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  EXPECTED,
  assertStagingSchemaReadAdmission,
  readMigrationManifest,
  readStagingApplicationPolicy,
} from './run-staging-migration-predeploy.mjs'
import { assertRelease270Manifest } from './lib/release270-migration-contract.mjs'
import {
  assertRelease270StagingAdmission,
  assertRelease270StagingPreserved,
  release270CutoffHash,
} from './lib/release270-staging-admission.mjs'
import { readRelease270Snapshot } from './lib/release270-readback.mjs'
import {
  assertRelease269StagingRedis,
  readRelease269StagingQueues,
} from './lib/release269-queue-readback.mjs'
import { release269MigrationChildEnvironment } from './run-release269-migration.mjs'

export function assertRelease270RuntimeTarget(environment, releaseSha) {
  assert.equal(environment.RAILWAY_ENVIRONMENT, 'staging', 'release270-production-forbidden')
  assert.equal(assertStagingSchemaReadAdmission(environment).releaseSha, releaseSha)
  assertRelease269StagingRedis(environment)
}

export async function runRelease270({
  environment,
  releaseSha,
  approval,
  proof,
  inspectSource,
  readSnapshot,
  withLock,
  deploy,
  record,
  now = Date.now,
}) {
  assertRelease270RuntimeTarget(environment, releaseSha)
  assert.equal(typeof record, 'function', 'release270-durable-journal-required')
  const inspect = async () => {
    const source = await inspectSource()
    assert.equal(source.head, releaseSha)
    assert.equal(source.status, '', 'release270-dirty-source')
    assertRelease270Manifest(source.manifest)
    return source
  }
  const source = await inspect()
  let armed = false
  let verified
  try {
    const result = await withLock(async (lockPid, guard) => {
      assert.ok(
        guard && typeof guard.assertHeld === 'function' && guard.signal,
        'release270-lock-guardian-required',
      )
      const before = await readSnapshot(lockPid)
      const admit = (snapshot) =>
        assertRelease270StagingAdmission({
          environment,
          releaseSha,
          sourceHead: source.head,
          sourceStatus: source.status,
          approval,
          proof,
          manifest: source.manifest,
          before: snapshot,
          now: now(),
        })
      assert.match(
        proof.rehearsedNewSecurityHash ?? '',
        /^[a-f0-9]{64}$/u,
        'release270-new-security-proof-required',
      )
      const admitted = admit(before)
      await record('before', before)
      if (admitted.state === 'complete270') {
        assert.equal(
          before.newSecurityHash,
          proof.rehearsedNewSecurityHash,
          'release270-new-security-mismatch',
        )
        await guard.assertHeld()
        verified = {
          phase: 'verified-no-pending',
          evidence: { releaseSha, cutoffHash: release270CutoffHash(before) },
        }
        return {
          changed: false,
          state: 'complete270',
          applicationHeld: readStagingApplicationPolicy(environment).hold,
        }
      }
      const immediate = await readSnapshot(lockPid)
      assert.equal(
        release270CutoffHash(immediate),
        release270CutoffHash(before),
        'release270-prewrite-drift',
      )
      await inspect()
      admit(immediate)
      await record('armed', {
        releaseSha,
        pending: admitted.pending,
        cutoffHash: release270CutoffHash(immediate),
      })
      await guard.assertHeld()
      admit(immediate)
      armed = true
      await deploy({ signal: guard.signal })
      await guard.assertHeld()
      const after = await readSnapshot(lockPid)
      assertRelease270StagingPreserved(before, after, source.manifest, proof, { now: now() })
      assert.equal(
        after.newSecurityHash,
        proof.rehearsedNewSecurityHash,
        'release270-new-security-mismatch',
      )
      await record('after', after)
      await inspect()
      const repeated = await readSnapshot(lockPid)
      assertRelease270StagingPreserved(before, repeated, source.manifest, proof, { now: now() })
      assert.equal(
        release270CutoffHash(repeated),
        release270CutoffHash(after),
        'release270-repeat-drift',
      )
      await guard.assertHeld()
      verified = {
        phase: 'verified',
        evidence: {
          releaseSha,
          state: 'complete270',
          noPendingMigrations: true,
          cutoffHash: release270CutoffHash(repeated),
        },
      }
      return { changed: true, state: 'complete270', applicationHeld: true }
    })
    // A failed lock transaction/commit must never leave a verified journal entry.
    await record(verified.phase, verified.evidence)
    return result
  } catch (error) {
    if (!armed) throw error
    await record('outcome-unknown', { releaseSha, reconciliationRequired: true })
    throw new Error('release270-outcome-unknown-stop-and-reconcile')
  }
}

export async function withRelease270Lock(database, action) {
  return database.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRawUnsafe(
        'SELECT pg_backend_pid() AS pid, pg_try_advisory_xact_lock(20261029,270) AS acquired',
      )
      assert.equal(row.acquired, true, 'release270-migration-lock-busy')
      assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0)
      const controller = new AbortController()
      let stopped = false,
        lost = false,
        pending = Promise.resolve()
      const assertHeld = async () => {
        assert.equal(lost, false, 'release270-migration-lock-lost')
        try {
          const [probe] = await tx.$queryRawUnsafe(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=20261029 AND objid=270 AND objsubid=2 AND granted) AS held",
          )
          assert.equal(probe.held, true, 'release270-migration-lock-lost')
        } catch {
          lost = true
          controller.abort()
          throw new Error('release270-migration-lock-lost')
        }
      }
      const timer = setInterval(() => {
        if (!stopped)
          pending = pending.then(() => (stopped ? undefined : assertHeld())).catch(() => {})
      }, 1000)
      try {
        const result = await action(row.pid, { signal: controller.signal, assertHeld })
        await assertHeld()
        return result
      } finally {
        stopped = true
        clearInterval(timer)
        await pending
        controller.abort()
      }
    },
    { timeout: 900_000, maxWait: 10_000 },
  )
}

// A detached Linux process group includes Prisma's schema-engine subprocess.
// Killing just the Node parent could leave an orphan migration engine writing.
export async function spawnRelease270Migration({
  cli,
  prismaDirectory,
  environment,
  signal,
  spawnChild = spawn,
}) {
  assert.equal(process.platform, 'linux', 'release270-hosted-linux-runner-required')
  signal.throwIfAborted()
  await new Promise((resolve, reject) => {
    const child = spawnChild(
      process.execPath,
      [cli, 'migrate', 'deploy', '--schema', path.join(prismaDirectory, 'schema.prisma')],
      {
        env: environment,
        cwd: prismaDirectory,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        detached: true,
      },
    )
    let failed = false
    const stop = () => {
      failed = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(stop, 120_000)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const finish = (error) => {
      if (error) stop()
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      error ? reject(new Error('release270-child-failed')) : resolve()
    }
    child.once('error', () => finish(true))
    child.once('exit', (code, exitSignal) => finish(failed || code !== 0 || Boolean(exitSignal)))
  })
}

async function boundedJson(file, expectedHash) {
  assert.ok(typeof file === 'string' && file.length > 0, 'release270-proof-file-required')
  const raw = await readFile(file)
  assert.ok(raw.length <= 16 * 1024 * 1024, 'release270-proof-too-large')
  if (expectedHash !== undefined) {
    assert.match(expectedHash, /^[a-f0-9]{64}$/u)
    assert.equal(
      createHash('sha256').update(raw).digest('hex'),
      expectedHash,
      'release270-proof-file-seal',
    )
  }
  return JSON.parse(raw.toString('utf8'))
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      'release-sha': { type: 'string' },
      approval: { type: 'string' },
      proof: { type: 'string' },
      'proof-sha256': { type: 'string' },
      'consumer-evidence': { type: 'string' },
      receipt: { type: 'string' },
      readback: { type: 'boolean', default: false },
    },
  })
  const releaseSha = values['release-sha']
  assertRelease270RuntimeTarget(environment, releaseSha)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const prismaDirectory = path.join(root, 'packages/db/prisma')
  assert.ok(
    !environment.PATHFINDER_PRISMA_DIR ||
      path.resolve(environment.PATHFINDER_PRISMA_DIR) === prismaDirectory,
  )
  const git = (...argv) =>
    execFileSync('git', argv, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    }).trim()
  const inspectSource = async () => ({
    head: git('rev-parse', 'HEAD'),
    status: git('status', '--porcelain', '--untracked-files=all'),
    manifest: await readMigrationManifest(prismaDirectory),
  })
  const source = await inspectSource()
  assert.equal(source.head, releaseSha)
  assert.equal(source.status, '')
  assertRelease270Manifest(source.manifest)
  assert.match(
    values['proof-sha256'] ?? '',
    /^[a-f0-9]{64}$/u,
    'release270-reviewed-proof-seal-required',
  )
  const proof = await boundedJson(values.proof, values['proof-sha256'])
  assert.ok(values.receipt, 'release270-private-journal-required')
  const receiptPath = path.resolve(values.receipt)
  assert.ok(
    !receiptPath.startsWith(root) && receiptPath !== root,
    'release270-journal-outside-checkout-required',
  )
  const handle = await open(receiptPath, 'wx', 0o600)
  const record = async (phase, evidence) => {
    await handle.writeFile(`${JSON.stringify({ kind: 'release270-staging', phase, evidence })}\n`)
    await handle.sync()
    console.log(JSON.stringify({ kind: 'release270-staging', phase, releaseSha }))
  }
  let database, lockDatabase
  try {
    const require = createRequire(path.join(root, 'packages/db/package.json'))
    const { PrismaClient } = require('@prisma/client')
    const jobsRequire = createRequire('/migration-jobs/package.json')
    const Redis = jobsRequire('ioredis')
    const clean = release269MigrationChildEnvironment(
      environment,
      releaseSha,
      'staging',
    ).environment
    database = new PrismaClient({ datasourceUrl: clean.DIRECT_DATABASE_URL })
    lockDatabase = new PrismaClient({ datasourceUrl: clean.DIRECT_DATABASE_URL })
    const readSnapshot = (lockPid) =>
      readRelease270Snapshot({
        database,
        releaseSha,
        databaseResource: EXPECTED.databaseResourceId,
        lockPid,
        trustedConsumerInventoryHash: proof.trustedConsumerInventoryHash,
        readConsumers: () => boundedJson(values['consumer-evidence']),
        readQueues: () =>
          readRelease269StagingQueues({
            environment,
            releaseSha,
            createConnection: (url, options) => new Redis(url, options),
            preserveDormantQueues: true,
          }),
      })
    if (values.readback) {
      await record('readback-only', await readSnapshot())
      return
    }
    const result = await runRelease270({
      environment,
      releaseSha,
      approval: values.approval,
      proof,
      inspectSource,
      readSnapshot,
      withLock: (action) => withRelease270Lock(lockDatabase, action),
      record,
      deploy: async ({ signal }) => {
        await inspectSource().then((current) => {
          assert.equal(current.head, releaseSha)
          assert.equal(current.status, '')
          assertRelease270Manifest(current.manifest)
        })
        await spawnRelease270Migration({
          cli: require.resolve('prisma/build/index.js'),
          prismaDirectory,
          environment: clean,
          signal,
        })
      },
    })
    if (result.applicationHeld) process.exitCode = 2
  } finally {
    try {
      const disconnected = await Promise.allSettled([
        database?.$disconnect(),
        lockDatabase?.$disconnect(),
      ])
      assert.ok(
        disconnected.every((result) => result.status === 'fulfilled'),
        'release270-disconnect-failed',
      )
    } finally {
      await handle.close()
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('release270-staging-stopped; inspect private journal and reconcile before retry')
    process.exitCode = 1
  })
}
