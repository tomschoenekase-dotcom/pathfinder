import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, copyFile, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildDisposableChildEnv,
  redactDatabaseOutput,
  runDisposableMigration,
  validateDisposableDatabaseUrl,
} from './lib/disposable-prisma-migration.mjs'

const runIntegration = process.env.RUN_VENUE_PACKAGE_DUPLICATE_MIGRATION_INTEGRATION === '1'
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsRoot = path.join(repositoryRoot, 'packages', 'db', 'prisma', 'migrations')
const targetMigration = '20260809070000_add_venue_package_duplicate_analyses'

function capturedWriter() {
  return {
    value: '',
    write(chunk) {
      this.value += String(chunk)
      return true
    },
  }
}

function requireTarget() {
  assert.equal(
    process.env.PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS,
    '1',
    'PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS must equal 1',
  )
  const database = process.env.PATHFINDER_DISPOSABLE_DATABASE
  assert.match(
    database ?? '',
    /^pathfinder_disposable_[a-z0-9_]+$/u,
    'PATHFINDER_DISPOSABLE_DATABASE must confirm a pathfinder_disposable_* target',
  )
  return validateDisposableDatabaseUrl(process.env.PATHFINDER_DISPOSABLE_DATABASE_URL, database)
}

async function createLegacyMigrationTree() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'pathfinder-legacy-migrations-'))
  const prismaRoot = path.join(temporaryRoot, 'prisma')
  const temporaryMigrations = path.join(prismaRoot, 'migrations')
  await mkdir(temporaryMigrations, { recursive: true })
  await copyFile(
    path.join(repositoryRoot, 'packages', 'db', 'prisma', 'schema.prisma'),
    path.join(prismaRoot, 'schema.prisma'),
  )
  await copyFile(
    path.join(migrationsRoot, 'migration_lock.toml'),
    path.join(temporaryMigrations, 'migration_lock.toml'),
  )

  const migrationNames = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en-US'))
  const legacyMigrations = migrationNames.filter((name) => name < targetMigration)
  assert.equal(legacyMigrations.length, 43, 'Expected exactly 43 legacy migrations')
  assert.equal(
    migrationNames.includes(targetMigration),
    true,
    `Expected migration ${targetMigration} to remain in the current migration tree`,
  )

  for (const migrationName of legacyMigrations) {
    await cp(
      path.join(migrationsRoot, migrationName),
      path.join(temporaryMigrations, migrationName),
      { recursive: true },
    )
  }
  return {
    temporaryRoot,
    schemaPath: path.join(prismaRoot, 'schema.prisma'),
    currentMigrationCount: migrationNames.length,
  }
}

function runPrismaDeploy(schemaPath, target) {
  const prismaCli = path.join(
    repositoryRoot,
    'packages',
    'db',
    'node_modules',
    'prisma',
    'build',
    'index.js',
  )
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', schemaPath],
    {
      cwd: path.dirname(schemaPath),
      env: buildDisposableChildEnv(process.env, target.canonicalUrl),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  const output = redactDatabaseOutput(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    target.sensitiveTokens,
  )
  assert.equal(result.error, undefined, `Prisma deploy failed to start:\n${output}`)
  assert.equal(result.status, 0, `Prisma deploy failed:\n${output}`)
  return output
}

async function prismaClient(target) {
  const clientModule = await import(
    pathToFileURL(
      path.join(
        repositoryRoot,
        'packages',
        'db',
        'node_modules',
        '@prisma',
        'client',
        'default.js',
      ),
    ).href
  )
  return new clientModule.PrismaClient({ datasourceUrl: target.canonicalUrl })
}

test(
  'populated legacy venue packages fail closed after the semantic-analysis migration',
  { skip: !runIntegration, timeout: 120_000 },
  async () => {
    const target = requireTarget()
    const { temporaryRoot, schemaPath, currentMigrationCount } = await createLegacyMigrationTree()
    let client
    try {
      client = await prismaClient(target)
      await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE')
      await client.$executeRawUnsafe('CREATE SCHEMA public')
      await client.$disconnect()
      client = undefined

      const legacyDeployOutput = runPrismaDeploy(schemaPath, target)
      assert.match(legacyDeployOutput, /43 migrations found/u)
      assert.doesNotMatch(legacyDeployOutput, new RegExp(targetMigration, 'u'))

      client = await prismaClient(target)
      const suffix = randomUUID()
      const tenantId = `migration-contract-tenant-${suffix}`
      const venueId = `migration-contract-venue-${suffix}`
      const packageId = `migration-contract-package-${suffix}`
      const draftKey = randomUUID()
      const approvalCommandKey = randomUUID()
      const payloadHash = 'a'.repeat(64)
      const baseDigest = 'b'.repeat(64)
      const warningDigest = 'c'.repeat(64)
      const validationReport = { errors: [], warnings: [] }
      const previewPlan = {
        schemaVersion: 1,
        payloadHash,
        baseDigest,
        mode: 'ADDITIVE_V1',
        warningDigest,
        report: validationReport,
        changes: {
          places: { add: [], change: [], remove: [], unchanged: 0 },
          knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
        },
      }

      await client.$executeRawUnsafe(
        `INSERT INTO tenants (id, name, slug, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        tenantId,
        tenantId,
        tenantId,
      )
      await client.$executeRawUnsafe(
        `INSERT INTO venues (id, tenant_id, name, slug, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        venueId,
        tenantId,
        venueId,
        venueId,
      )
      await client.$executeRawUnsafe(
        `INSERT INTO venue_packages (
           id, tenant_id, venue_id, draft_key, schema_version, payload,
           payload_hash, base_digest, validation_report, preview_plan, status,
           created_by, approved_by, approved_at, approved_command_key,
           approval_warning_digest, approved_warning_codes, updated_at
         ) VALUES (
           $1, $2, $3, $4::uuid, 1, $5::jsonb,
           $6, $7, $8::jsonb, $9::jsonb, 'APPROVED',
           $10, $11, CURRENT_TIMESTAMP, $12::uuid,
           $13, '[]'::jsonb, CURRENT_TIMESTAMP
         )`,
        packageId,
        tenantId,
        venueId,
        draftKey,
        JSON.stringify({ schemaVersion: 1, places: [], knowledgeEntries: [] }),
        payloadHash,
        baseDigest,
        JSON.stringify(validationReport),
        JSON.stringify(previewPlan),
        `migration-contract-creator-${suffix}`,
        `migration-contract-approver-${suffix}`,
        approvalCommandKey,
        warningDigest,
      )
      await client.$disconnect()
      client = undefined

      const firstStdout = capturedWriter()
      const firstStderr = capturedWriter()
      const migrationEnv = {
        ...process.env,
        PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
        PATHFINDER_DISPOSABLE_DATABASE_URL: target.canonicalUrl,
      }
      const migrationArgs = ['--database', target.database, '--confirm-database', target.database]
      assert.equal(
        runDisposableMigration({
          argv: migrationArgs,
          env: migrationEnv,
          repoRoot: repositoryRoot,
          stdout: firstStdout,
          stderr: firstStderr,
        }),
        0,
        firstStderr.value,
      )
      assert.match(firstStdout.value, new RegExp(`Applying migration .*${targetMigration}`, 'u'))

      client = await prismaClient(target)
      const rows = await client.$queryRawUnsafe(
        `SELECT status, approved_by, validation_report, preview_plan
         FROM venue_packages
         WHERE id = $1 AND tenant_id = $2 AND venue_id = $3`,
        packageId,
        tenantId,
        venueId,
      )
      assert.equal(rows.length, 1)
      const stored = rows[0]
      assert.equal(stored.status, 'APPROVED')
      assert.match(stored.approved_by, /^migration-contract-approver-/u)
      assert.equal(stored.validation_report.semanticDuplicateScan.status, 'INCOMPLETE')
      assert.equal(stored.preview_plan.report.semanticDuplicateScan.status, 'INCOMPLETE')
      assert.equal(
        stored.validation_report.errors.some((issue) => issue.code === 'SEMANTIC_SCAN_INCOMPLETE'),
        true,
      )
      assert.equal(
        stored.preview_plan.report.errors.some(
          (issue) => issue.code === 'SEMANTIC_SCAN_INCOMPLETE',
        ),
        true,
      )
      assert.equal(
        stored.validation_report.errors.length > 0 ||
          stored.validation_report.semanticDuplicateScan.status !== 'COMPLETE',
        true,
        'Backfilled validation evidence must force approval rejection',
      )
      assert.equal(
        stored.preview_plan.report.errors.length > 0 ||
          stored.preview_plan.report.semanticDuplicateScan.status !== 'COMPLETE',
        true,
        'Backfilled preview evidence must force apply rejection',
      )

      await assert.rejects(
        client.$executeRawUnsafe(
          `UPDATE venue_packages SET validation_report = '{}'::jsonb WHERE id = $1`,
          packageId,
        ),
        /venue package revision content is immutable/u,
      )
      await assert.rejects(
        client.$executeRawUnsafe('DELETE FROM venue_packages WHERE id = $1', packageId),
        /venue package revisions are immutable/u,
      )

      const secondStdout = capturedWriter()
      const secondStderr = capturedWriter()
      assert.equal(
        runDisposableMigration({
          argv: migrationArgs,
          env: migrationEnv,
          repoRoot: repositoryRoot,
          stdout: secondStdout,
          stderr: secondStderr,
        }),
        0,
        secondStderr.value,
      )
      assert.match(secondStdout.value, /No pending migrations to apply\./u)
      const migrationCount = await client.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
         FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      )
      assert.deepEqual(migrationCount, [{ count: currentMigrationCount }])
    } finally {
      if (client) await client.$disconnect()
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  },
)
