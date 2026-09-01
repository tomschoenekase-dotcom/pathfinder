import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(
  repositoryRoot,
  'docs',
  'system-state',
  'torchiko-current-truth.json',
)
const statePath = path.join(repositoryRoot, 'docs', 'system-state', 'TORCHIKO_STATE_OF_SYSTEM.md')
const matrixPath = path.join(
  repositoryRoot,
  'docs',
  'system-state',
  'TORCHIKO_CAPABILITY_MATRIX.md',
)
const backlogPath = path.join(repositoryRoot, 'docs', 'system-state', 'TORCHIKO_AUDIT_BACKLOG.md')
const founderControlRoomPath = path.join(repositoryRoot, 'docs', 'founder-control-room.md')
const execFileAsync = promisify(execFile)

const allowedStatuses = new Set([
  'implemented-external-gated',
  'implemented-sandbox-proven-live-gated',
  'implemented-provider-dark-proven-live-gated',
  'partially-implemented-policy-gated',
  'proven-locally',
  'proven-provider-dark-locally',
])

async function loadTruth() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

test('current-truth manifest has unique evidence-backed capabilities', async () => {
  const truth = await loadTruth()
  assert.equal(truth.schemaVersion, 1)
  assert.match(truth.asOf, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(Array.isArray(truth.authority.doesNotProve))
  assert.ok(truth.authority.doesNotProve.includes('production deployment'))
  assert.ok(truth.authority.doesNotProve.includes('live billing'))

  const staging = truth.hostedStagingSnapshot
  assert.match(staging.releaseSha, /^[a-f0-9]{40}$/)
  for (const service of ['web', 'dashboard', 'worker']) {
    assert.match(
      staging.services[`${service}DeploymentId`],
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      `${service} has an exact Railway deployment ID`,
    )
    assert.equal(
      staging.services[`${service}DeploymentStatus`],
      'SUCCESS',
      `${service} deployment is successful`,
    )
    assert.equal(
      staging.services[`${service}InstanceStatus`],
      'RUNNING',
      `${service} instance is running`,
    )
    assert.match(
      staging.services[`${service}ImageDigest`],
      /^sha256:[a-f0-9]{64}$/,
      `${service} has an immutable image digest`,
    )
  }
  assert.equal(staging.migrationLedger.applied, staging.migrationLedger.expected)
  assert.equal(staging.migrationLedger.admissionsOpen, 0)
  assert.equal(staging.stagingProfile.passed, staging.stagingProfile.expected)
  assert.equal(staging.stagingProfile.failed, 0)
  assert.equal(staging.stagingProfile.blocked, 0)
  assert.equal(staging.productionTouched, false)
  assert.ok((await stat(path.resolve(repositoryRoot, staging.evidence))).isFile())

  const ids = truth.capabilities.map((capability) => capability.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(ids, [
    'founder-operating-conversation',
    'founder-directive-task-handoff',
    'guest-prompt-integrity',
    'release-evidence',
    'golden-venue-lifecycle',
    'native-guest-read',
    'crm-pipeline',
    'outreach-operations',
    'stripe-billing',
    'gmail-correspondence',
    'local-staging-infrastructure',
    'operational-usage-evidence',
    'first-week-account-learning',
    'privacy-retention',
    'customer-access-execution',
    'claim-attribution-calibration',
    'agent-operational-trust-evidence',
    'agent-runtime-routing',
    'agent-workforce-credibility',
    'identity-vocabulary',
    'support-knowledge-correction',
    'semantic-venue-update-draft',
  ])

  for (const capability of truth.capabilities) {
    assert.ok(allowedStatuses.has(capability.status), `${capability.id} has a governed status`)
    assert.ok(capability.summary.length >= 40, `${capability.id} has a useful summary`)
    assert.ok(capability.remaining.length >= 30, `${capability.id} states remaining work`)
    assert.ok(capability.evidence.length >= 3, `${capability.id} has plural evidence`)
    for (const relativePath of capability.evidence) {
      const evidencePath = path.resolve(repositoryRoot, relativePath)
      assert.ok(
        evidencePath.startsWith(`${repositoryRoot}${path.sep}`),
        `${capability.id} evidence stays inside the repository`,
      )
      assert.ok((await stat(evidencePath)).isFile() || (await stat(evidencePath)).isDirectory())
    }
  }
})

test('dynamic repository facts agree with all current-state documents', async () => {
  const truth = await loadTruth()
  const migrationRoot = path.resolve(repositoryRoot, truth.dynamicFacts.migrationDirectory)
  const migrationEntries = await readdir(migrationRoot, { withFileTypes: true })
  const migrationCount = migrationEntries.filter((entry) => entry.isDirectory()).length
  assert.ok(migrationCount > 0)

  const [stateDocument, capabilityMatrix, auditBacklog] = await Promise.all([
    readFile(statePath, 'utf8'),
    readFile(matrixPath, 'utf8'),
    readFile(backlogPath, 'utf8'),
  ])
  for (const document of [stateDocument, capabilityMatrix, auditBacklog]) {
    assert.match(document, /torchiko-current-truth\.json/)
    assert.match(document, new RegExp(`\\b${migrationCount} migrations\\b`))
    assert.match(document, new RegExp(`Current-truth overlay[^\\n]*${truth.asOf}`))
    for (const match of document.matchAll(/bounded (\d{4}-\d{2}-\d{2}) snapshot/gu)) {
      assert.equal(match[1], truth.asOf)
    }
  }
  assert.match(stateDocument, new RegExp(truth.hostedStagingSnapshot.releaseSha.slice(0, 8)))
  assert.match(auditBacklog, new RegExp(truth.hostedStagingSnapshot.releaseSha))
  for (const document of [stateDocument, capabilityMatrix]) {
    for (const capability of truth.capabilities) {
      assert.match(document, new RegExp(`\\b${capability.id}\\b`))
    }
  }
})

test('security inventory counts agree with the executable source boundaries', async () => {
  const [{ stdout: bypassOutput }, { stdout: rawSqlOutput }, stateDocument, auditBacklog] =
    await Promise.all([
      execFileAsync(process.execPath, ['scripts/verify-tenant-bypass-boundary.mjs'], {
        cwd: repositoryRoot,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync(process.execPath, ['scripts/verify-raw-sql-boundary.mjs'], {
        cwd: repositoryRoot,
        maxBuffer: 1024 * 1024,
      }),
      readFile(statePath, 'utf8'),
      readFile(backlogPath, 'utf8'),
    ])

  const bypass = bypassOutput.match(
    /Verified (\d+) tenant-isolation bypass calls across (\d+) approved production files\./,
  )
  const rawSql = rawSqlOutput.match(
    /Verified (\d+) raw SQL operations: (\d+) reads, (\d+) writes\./,
  )
  assert.ok(bypass, 'tenant bypass verifier emits a count summary')
  assert.ok(rawSql, 'raw SQL verifier emits a count summary')

  const [, bypassCalls, bypassFiles] = bypass
  const [, rawSqlOperations, rawSqlReads, rawSqlWrites] = rawSql
  assert.match(
    stateDocument,
    new RegExp(
      `${bypassCalls} approved bypass calls in ${bypassFiles} production files and ${rawSqlOperations} raw-SQL operations \\(${rawSqlReads} reads, ${rawSqlWrites} writes\\)`,
    ),
  )
  assert.match(
    auditBacklog,
    new RegExp(
      `${bypassCalls} approved bypasses across ${bypassFiles} production files; ${rawSqlOperations} raw-SQL operations`,
    ),
  )
})

test('local staging image truth is content-addressed and stale blockers stay retired', async () => {
  const truth = await loadTruth()
  const compose = await readFile(
    path.resolve(repositoryRoot, truth.dynamicFacts.composeFile),
    'utf8',
  )
  const imageLines = compose
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('image:'))
  assert.equal(imageLines.length, truth.dynamicFacts.expectedLocalServiceImages)
  for (const imageLine of imageLines) {
    assert.match(imageLine, /@sha256:[a-f0-9]{64}$/)
  }

  const [stateDocument, capabilityMatrix, auditBacklog, founderControlRoom] = await Promise.all([
    readFile(statePath, 'utf8'),
    readFile(matrixPath, 'utf8'),
    readFile(backlogPath, 'utf8'),
    readFile(founderControlRoomPath, 'utf8'),
  ])
  const currentDocuments = `${stateDocument}\n${capabilityMatrix}\n${auditBacklog}\n${founderControlRoom}`
  for (const retiredClaim of [
    'No current, retained, realistic end-to-end venue onboarding/publish/chat/report evidence.',
    'No CRM, billing collection, inbound email, or general outbound communication system.',
    'There is no implemented CRM, sales pipeline, outreach sequence engine',
    'Pin floating MinIO/ClamAV tags.',
    'Local compose uses floating MinIO `latest` and ClamAV `stable` tags',
    'CRM and outreach basically do not exist',
    'the public app has no privacy page',
    'the marketing privacy link is broken',
    'Uncommitted capability tranche',
    'Prove the uncommitted migration tranche',
    'but no route exists',
    'No surface switches reads',
    'implement a bounded read-switch executor',
    'has no runtime switch executor',
    'read-switch execution remains unavailable',
  ]) {
    assert.ok(!currentDocuments.includes(retiredClaim), `retired claim absent: ${retiredClaim}`)
  }
})
