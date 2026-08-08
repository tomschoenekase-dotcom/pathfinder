import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DisposableMigrationRefusal,
  buildDisposableChildEnv,
  parseDisposableMigrationArgs,
  redactDatabaseOutput,
  runDisposableMigration,
  validateDisposableDatabaseUrl,
} from './lib/disposable-prisma-migration.mjs'

const database = 'pathfinder_disposable_test'
const password = 'secret-value'
const url = `postgresql://postgres:${password}@127.0.0.1:55439/${database}`
const argv = ['--database', database, '--confirm-database', database]

function expectRefusal(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof DisposableMigrationRefusal)
    assert.match(error.message, pattern)
    assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i)
    assert.doesNotMatch(error.message, /secret-value/)
    return true
  })
}

test('requires matching explicit database confirmations and a disposable name', () => {
  assert.deepEqual(parseDisposableMigrationArgs(argv), { database })
  expectRefusal(() => parseDisposableMigrationArgs([]), /both required/)
  expectRefusal(() => parseDisposableMigrationArgs(['--database']), /requires a value/)
  expectRefusal(
    () =>
      parseDisposableMigrationArgs([
        '--database',
        database,
        '--database',
        database,
        '--confirm-database',
        database,
      ]),
    /accepted once/,
  )
  expectRefusal(
    () =>
      parseDisposableMigrationArgs([
        '--database',
        database,
        '--confirm-database',
        'pathfinder_disposable_other',
      ]),
    /does not match/,
  )
  expectRefusal(
    () => parseDisposableMigrationArgs(['--database', 'pathfinder_test', '--confirm-database', 'pathfinder_test']),
    /prefix/,
  )
})

test('accepts only exact loopback PostgreSQL targets with explicit port and path', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '[::1]']) {
    const target = validateDisposableDatabaseUrl(
      `postgresql://postgres:${password}@${host}:55439/${database}`,
      database,
    )
    assert.equal(target.database, database)
  }

  for (const host of [
    '0.0.0.0',
    '127.1',
    '2130706433',
    '0x7f000001',
    '127.0.0.2',
    '127.0.0.1.evil.example',
    'localhost.',
    'foo.localhost',
    '%6cocalhost',
    '10.0.0.1',
    '192.168.1.2',
    '[::]',
    '[::ffff:127.0.0.1]',
    'db.example.com',
  ]) {
    expectRefusal(
      () =>
        validateDisposableDatabaseUrl(
          `postgresql://postgres:${password}@${host}:55439/${database}`,
          database,
        ),
      /loopback|malformed/,
    )
  }
})

test('rejects missing ports, alternate protocols, query options, fragments, and path tricks', () => {
  const invalid = [
    `postgresql://postgres:${password}@127.0.0.1/${database}`,
    `http://postgres:${password}@127.0.0.1:55439/${database}`,
    `postgresql://postgres:${password}@127.0.0.1:55439/${database}?host=db.example.com`,
    `postgresql://postgres:${password}@127.0.0.1:55439/${database}#external`,
    `postgresql://postgres:${password}@127.0.0.1:55439/${database}/extra`,
    `postgresql://postgres:${password}@127.0.0.1:55439/pathfinder%5fdisposable%5ftest`,
  ]

  for (const candidate of invalid) {
    expectRefusal(() => validateDisposableDatabaseUrl(candidate, database), /port|PostgreSQL|query|database/)
  }
})

test('pins localhost to numeric loopback', () => {
  const target = validateDisposableDatabaseUrl(
    `postgresql://postgres:${password}@localhost:55439/${database}`,
    database,
  )
  assert.equal(new URL(target.canonicalUrl).hostname, '127.0.0.1')
})

test('removes inherited URL variants and unsafe Node or Prisma overrides', () => {
  const child = buildDisposableChildEnv(
    {
      Database_Url: 'external-primary',
      DIRECT_DATABASE_URL: 'external-direct',
      NODE_OPTIONS: '--require unsafe.js',
      Node_Path: 'unsafe',
      Force_Color: '3',
      no_color: '0',
      PRISMA_QUERY_ENGINE_BINARY: 'unsafe-engine',
      PRISMA_CONFIG_PATH: 'unsafe-config',
      PGHOST: 'external.example',
      PGSERVICEFILE: 'unsafe-service',
      PATHFINDER_DISPOSABLE_DATABASE_URL: url,
      PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
      SAFE_VALUE: 'retained',
    },
    url,
  )

  assert.equal(child.DATABASE_URL, url)
  assert.equal(child.DIRECT_DATABASE_URL, url)
  assert.equal(child.SAFE_VALUE, 'retained')
  assert.equal(Object.keys(child).filter((key) => key.toLowerCase() === 'database_url').length, 1)
  assert.equal(child.NODE_OPTIONS, undefined)
  assert.equal(child.Node_Path, undefined)
  assert.equal(child.NO_COLOR, '1')
  assert.equal(child.FORCE_COLOR, '0')
  assert.equal(Object.keys(child).filter((key) => key.toLowerCase() === 'force_color').length, 1)
  assert.equal(child.PRISMA_QUERY_ENGINE_BINARY, undefined)
  assert.equal(child.PRISMA_CONFIG_PATH, undefined)
  assert.equal(child.PGHOST, undefined)
  assert.equal(child.PGSERVICEFILE, undefined)
  assert.equal(child.PATHFINDER_DISPOSABLE_DATABASE_URL, undefined)
})

test('redacts URLs and credential tokens from child output', () => {
  const credentialUrl = `postgresql://secret-role:${password}@127.0.0.1:55439/${database}`
  const target = validateDisposableDatabaseUrl(credentialUrl, database)
  const output = redactDatabaseOutput(
    `authentication failed for user secret-role at ${credentialUrl}; password=${password}; postgresql://other:other@db.example.com:5432/db`,
    target.sensitiveTokens,
  )
  assert.doesNotMatch(output, /secret-role|secret-value|db\.example\.com|postgresql:\/\//)
})

test('malformed percent escapes in credentials cannot bypass validation or leak', () => {
  const candidate = `postgresql://postgres:bad%value@127.0.0.1:55439/${database}`
  const target = validateDisposableDatabaseUrl(candidate, database)
  const output = redactDatabaseOutput(`failure ${candidate}`, target.sensitiveTokens)
  assert.doesNotMatch(output, /bad%value|postgresql:\/\//)
})

test('refuses before spawn without opt-in or with an external incident replay', () => {
  let spawnCalls = 0
  const spawnSyncImpl = () => {
    spawnCalls += 1
    return { status: 0, stdout: '', stderr: '' }
  }

  expectRefusal(
    () =>
      runDisposableMigration({
        argv,
        env: { PATHFINDER_DISPOSABLE_DATABASE_URL: url },
        spawnSyncImpl,
      }),
    /must equal 1/,
  )
  expectRefusal(
    () =>
      runDisposableMigration({
        argv,
        env: {
          PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
          PATHFINDER_DISPOSABLE_DATABASE_URL:
            `postgresql://postgres:${password}@db.example.com:5432/${database}`,
          DATABASE_URL: url,
          DIRECT_DATABASE_URL: 'postgresql://configured-external.invalid/db',
        },
        spawnSyncImpl,
      }),
    /loopback/,
  )
  assert.equal(spawnCalls, 0)
})

test('spawns Prisma through Node without a shell and forces both child targets', () => {
  const writes = { stdout: '', stderr: '' }
  let invocation
  const status = runDisposableMigration({
    argv,
    env: {
      PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
      PATHFINDER_DISPOSABLE_DATABASE_URL: url,
      DATABASE_URL: 'postgresql://inherited:bad@external.example:5432/wrong',
      direct_database_url: 'postgresql://inherited:bad@external.example:5432/wrong',
    },
    repoRoot: 'C:\\safe-repo',
    stdout: { write: (value) => (writes.stdout += value) },
    stderr: { write: (value) => (writes.stderr += value) },
    spawnSyncImpl: (...args) => {
      invocation = args
      return { status: 0, stdout: `connected ${url}\n`, stderr: '' }
    },
  })

  assert.equal(status, 0)
  assert.equal(invocation[0], process.execPath)
  assert.match(invocation[1][0], /prisma[\\/]build[\\/]index\.js$/)
  assert.deepEqual(invocation[1].slice(1, 3), ['migrate', 'deploy'])
  assert.equal(invocation[2].shell, false)
  assert.equal(invocation[2].windowsHide, true)
  assert.equal(invocation[2].env.DATABASE_URL, invocation[2].env.DIRECT_DATABASE_URL)
  assert.equal(invocation[2].env.DATABASE_URL, url)
  assert.doesNotMatch(writes.stdout, /secret-value|postgresql:\/\//)
})

test('returns child failures and never exposes spawn error details', () => {
  const writes = { stdout: '', stderr: '' }
  const status = runDisposableMigration({
    argv,
    env: {
      PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
      PATHFINDER_DISPOSABLE_DATABASE_URL: url,
    },
    stdout: { write: (value) => (writes.stdout += value) },
    stderr: { write: (value) => (writes.stderr += value) },
    spawnSyncImpl: () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error(`could not start with ${url}`),
    }),
  })

  assert.equal(status, 1)
  assert.match(writes.stderr, /could not be started safely/)
  assert.doesNotMatch(writes.stderr, /secret-value|postgresql:\/\//)
})
