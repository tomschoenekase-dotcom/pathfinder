import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'

const docsRoot = new URL('../docs/', import.meta.url)
const execFile = promisify(execFileCallback)
const activeStopMarker =
  'Migration instruction status: INCIDENT STOP — DO NOT EXECUTE EXTERNAL DATABASE COMMANDS.'
const stagingOnlyMarker =
  'Migration instruction status: STAGING-ONLY AUTHORIZED — PRODUCTION COMMANDS REMAIN STOPPED.'
const historicalMarker = 'Migration instruction status: HISTORICAL — DO NOT EXECUTE.'
const inertArchiveMarker = '## Post-resolution external exercise archive — INERT, DO NOT EXECUTE'
const restrictedProductionMarker =
  'Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.'
const restrictedProductionRecords = new Set([
  'production-cutover-20260930.md',
  'production-cutover-20261001.md',
  'production-cutover-20261003.md',
  'production-cutover-20261010.md',
])

test('October 10 code-only exception binds the candidate without lifting the incident', async () => {
  const approval = await readFile(new URL('production-cutover-20261010.md', docsRoot), 'utf8')
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')
  const workflow = await readFile(new URL('staging-release-workflow.md', docsRoot), 'utf8')
  assert.equal(hasLeadingMarker(approval, restrictedProductionMarker), true)
  assert.match(approval, /483e6ac9f5d30d9076b17149bd38014f60e9d9eb/)
  assert.match(approval, /c3b40b11dea1b7922d0756e65eb522ecaed1608e/)
  assert.match(approval, /bfd0a8e427e44dce46219084e8ab5fefc728fdfe/)
  assert.match(approval, /no diff\s+against that base/)
  assert.match(approval, /final documentation-bearing SHA/)
  assert.match(approval, /incident remains ACTIVE by default/)
  assert.match(approval, /No hosted database migration, data repair, seed, reset/)
  assert.match(approval, /three-service admission/)
  assert.match(stop, /production-cutover-20261010\.md/)
  assert.match(workflow, /production-cutover-20261010\.md/)
  assert.deepEqual(findUnsafeInstructions(approval), [])
})

test('October 3 PR40 exception retains exact suffix, preservation and protected promotion gates', async () => {
  const approval = await readFile(new URL('production-cutover-20261003.md', docsRoot), 'utf8')
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')
  const workflow = await readFile(new URL('staging-release-workflow.md', docsRoot), 'utf8')
  assert.equal(hasLeadingMarker(approval, restrictedProductionMarker), true)
  assert.match(approval, /255 finished migrations and 280 public tables/)
  assert.match(approval, /267 finished migrations and 297 public tables/)
  assert.match(approval, /20261002090000_add_live_data_connectors/)
  assert.match(approval, /20261002121000_prospect_organization_merge/)
  assert.match(approval, /cbad930003f17d1953495a8d477a64b138b55db29022632aa20b93b2b8af2e00/)
  assert.match(approval, /36de18c960796e92e67699fe84958d80a88ba958fbf9b282c88a8236415ae5a0/)
  assert.match(approval, /incident remains ACTIVE by default/)
  assert.match(approval, /Drain writers before the release-bound backup/)
  assert.match(approval, /local PostgreSQL 17/)
  assert.match(approval, /ownership and privileges/)
  assert.match(approval, /original-column hashes/)
  assert.match(approval, /No seed, reset, restore over production or staging/)
  assert.match(approval, /verified-held exit 2/)
  assert.match(approval, /protected promotion gate/)
  assert.match(approval, /existing production migration entrypoint/)
  assert.match(approval, /never run a destructive[\s\S]*down migration/)
  assert.match(stop, /production-cutover-20261003\.md/)
  assert.match(workflow, /production-cutover-20261003\.md/)
  assert.deepEqual(findUnsafeInstructions(approval), [])
})

const unsafeInstructionPatterns = [
  ['production migration script', /\bdb:migrate:prod\b/i],
  ['non-disposable migration command', /\bdb:migrate(?!:disposable)\b(?::[a-z-]+)?/i],
  ['raw Prisma migration command', /\bprisma\s+migrate\s+(?:dev|deploy|reset|resolve|status)\b/i],
  ['raw Prisma database command', /\bprisma\s+db\s+(?:execute|push|seed)\b/i],
  ['Supabase database command', /\bsupabase\s+db\s+[a-z-]+\b/i],
  ['PostgreSQL command client', /(?:^|\s)psql(?:\s|$)/im],
  ['database seed command', /\bdb:seed\b/i],
  ['manual Supabase SQL execution', /Supabase\s+SQL\s+Editor/i],
  ['manual migration-file execution', /run\s+the\s+contents\s+of[^\n]*migration/i],
  [
    'SQL command block',
    /```sql[\s\S]*?\b(?:alter|create|delete|drop|insert|select|truncate|update)\b[\s\S]*?```/i,
  ],
  ['SQL inspection statement', /`select\s+[^`]*(?:from|current_database\s*\()[^`]*`/i],
  ['imperative migration step', /(?<![\w-])(?:apply|run)\s+(?:the\s+)?migration\b/i],
  ['embedding-dispatch write exercise', /EmbeddingDispatch[\s\S]{0,300}dispatch row is committed/i],
]

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function hasLeadingMarker(source, marker) {
  return new RegExp(`^# [^\\n]+\\r?\\n\\r?\\n> \\*\\*${escapeRegex(marker)}\\*\\*`).test(
    source.replace(/^\uFEFF/, ''),
  )
}

function findUnsafeInstructions(source) {
  return unsafeInstructionPatterns
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name)
}

test('the production incident stop remains active while staging is authority-gated', async () => {
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')

  assert.match(stop, /Production incident state: ACTIVE/)
  assert.match(stop, /Staging exception state: APPROVED/)
  assert.match(stop, /hard USD 10 spending ceiling/)
  assert.match(stop, /synthetic-only staging database/)
  assert.match(stop, /known production project reference is explicitly denied/)
  assert.match(stop, /Tom identifies the affected external project\/environment/)
  assert.match(stop, /authorizes a bounded read-only assessment plan/)
  assert.match(stop, /Tom explicitly approves the remediation, roll-forward, or rollback plan/)
  assert.match(stop, /every\s+external database inspection or write that plan authorizes/)
  assert.match(stop, /Only after that explicit production approval/)
  assert.doesNotMatch(stop, /Production incident state: RESOLVED/)
})

test('September 22 production exception is exact-plan scoped and retains every live gate', async () => {
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')
  const approval = await readFile(new URL('production-cutover-20260922.md', docsRoot), 'utf8')
  const workflow = await readFile(new URL('staging-release-workflow.md', docsRoot), 'utf8')
  for (const text of [stop, approval]) {
    assert.match(text, /2026-09-22T20:21:17Z/)
    assert.match(text, /zpacmfkomonxeqdiadtz/)
    assert.match(text, /210bac2872449ad19af4b3de65d473520e5d99177c77bfadf92b573d4be9e7ac/)
    assert.match(text, /fresh[\s\S]*backup[\s\S]*rehears/)
    assert.match(text, /No seed|no seed/)
    assert.match(text, /restore over production/)
    assert.match(text, /customer email/)
  }
  assert.match(stop, /not a blanket incident resolution/)
  assert.match(approval, /250 finished ledger rows and 267 public tables/)
  assert.match(approval, /No different commit may be substituted at promotion/)
  assert.match(approval, /110.*finished migrations/)
  assert.match(approval, /stop condition fired before the backup or any live write/)
  assert.match(approval, /owner approval are required before/)
  assert.match(workflow, /production-cutover-20260922\.md/)
})

test('active runbook admits only the reviewed staging wrapper', async () => {
  const staging = await readFile(new URL('railway-staging.md', docsRoot), 'utf8')
  const archiveOffset = staging.indexOf(inertArchiveMarker)

  assert.equal(hasLeadingMarker(staging, stagingOnlyMarker), true)
  assert.match(staging, /database-incident-stop\.md/)
  assert.notEqual(archiveOffset, -1)

  const activeRunbook = staging.slice(0, archiveOffset)
  const inertArchive = staging.slice(archiveOffset)
  const wrapperOccurrences = activeRunbook.match(/pnpm db:migrate:staging/gu) ?? []
  assert.equal(wrapperOccurrences.length, 1)
  assert.deepEqual(findUnsafeInstructions(activeRunbook.replace('pnpm db:migrate:staging', '')), [])
  assert.match(activeRunbook, /db:migrate:disposable/)
  assert.match(activeRunbook, /PATHFINDER_CONFIRM_STAGING_DATA_POLICY=synthetic-only/)
  assert.match(activeRunbook, /no greater than\s+10/)
  assert.ok(findUnsafeInstructions(inertArchive).some((finding) => finding.startsWith('SQL ')))
  assert.doesNotMatch(inertArchive.slice(inertArchiveMarker.length), /^## /m)
  assert.match(inertArchive, /Tom explicitly approves an incident\s+assessment/)
})

test('every retained historical database instruction is prominently deactivated', async () => {
  const { stdout } = await execFile('git', ['ls-files', 'docs'])
  const markdownPaths = new Set(
    stdout
      .split(/\r?\n/)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice('docs/'.length)),
  )
  // The release-specific guarded record is new and may not be tracked until review is complete.
  markdownPaths.add('production-cutover-20260930.md')
  markdownPaths.add('production-cutover-20261001.md')
  const unguarded = []

  for (const path of markdownPaths) {
    const source = await readFile(new URL(path.replaceAll('\\', '/'), docsRoot), 'utf8')
    const findings = findUnsafeInstructions(source)
    if (hasLeadingMarker(source, restrictedProductionMarker)) {
      assert.equal(
        restrictedProductionRecords.has(path),
        true,
        'only a named release-specific record may use this marker',
      )
    }
    if (findings.length === 0) continue

    if (
      !hasLeadingMarker(source, activeStopMarker) &&
      !hasLeadingMarker(source, stagingOnlyMarker) &&
      !hasLeadingMarker(source, historicalMarker) &&
      !hasLeadingMarker(source, restrictedProductionMarker)
    ) {
      unguarded.push(`${path}: ${findings.join(', ')}`)
    }
  }

  assert.deepEqual(unguarded, [])
})

test('the detector rejects an adversarial unguarded instruction fixture', () => {
  const fixtures = [
    [
      'From the release shell, run pnpm --filter @pathfinder/db db:migrate:prod.',
      ['production migration script', 'non-disposable migration command'],
    ],
    ['Run pnpm prisma migrate reset.', ['raw Prisma migration command']],
    ['Run pnpm prisma db push.', ['raw Prisma database command']],
    ['Run supabase db reset.', ['Supabase database command']],
    ['Connect with psql and inspect the target.', ['PostgreSQL command client']],
    ['```sql\nSELECT * FROM tenants;\n```', ['SQL command block']],
    ['Apply the migration from the release artifact.', ['imperative migration step']],
    [
      'Confirm the EmbeddingDispatch table, edit content, and verify the dispatch row is committed.',
      ['embedding-dispatch write exercise'],
    ],
  ]

  for (const [fixture, expected] of fixtures) {
    assert.deepEqual(findUnsafeInstructions(fixture), expected)
    assert.equal(hasLeadingMarker(fixture, activeStopMarker), false)
    assert.equal(hasLeadingMarker(fixture, historicalMarker), false)
  }
})

test('the detector does not treat hyphenated release-state prose as an instruction', () => {
  assert.deepEqual(
    findUnsafeInstructions('The one-run migration admission returned to zero after staging.'),
    [],
  )
})

test('September 30 approval is exact-scope, guarded, and preserves the ACTIVE incident default', async () => {
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')
  const priorApproval = await readFile(new URL('production-cutover-20260922.md', docsRoot), 'utf8')
  const approval = await readFile(new URL('production-cutover-20260930.md', docsRoot), 'utf8')
  const workflow = await readFile(new URL('staging-release-workflow.md', docsRoot), 'utf8')

  assert.match(stop, /Production incident state: ACTIVE/)
  assert.match(stop, /Restricted production cutover exception — approved 2026-09-30/)
  assert.match(stop, /incident state remains ACTIVE by default/)
  assert.match(stop, /110-to-250 approval remains historical and unchanged/)
  assert.match(priorApproval, /Restricted production cutover approval — 2026-09-22/)
  assert.match(priorApproval, /250 finished ledger rows and 267 public tables/)

  assert.equal(hasLeadingMarker(approval, restrictedProductionMarker), true)
  assert.match(approval, /Owner approval: \*\*APPROVED 2026-09-30\*\*/)
  assert.match(
    approval,
    /So how can you get it the update\. That was the whole point of this to get all the features we made live/,
  )
  assert.match(approval, /3ae05f50a864807dc02276a117cbff3a0bcd36cf/)
  assert.match(approval, /a420fa9ad506b5929285ef29f8ff49629d2e201f/)
  assert.match(approval, /78981a2d5bb0423b3ff9440f79f48757572afeb03229287a7b17fa7a0b1655fb/)
  assert.match(approval, /20260930100000_add_mcp_venue_appearance_capabilities/)
  assert.match(approval, /20261001090000_add_operator_oauth/)
  assert.match(approval, /252 finished migrations, 253 physical ledger rows, and 269 public tables/)
  assert.match(approval, /254 finished migrations and 255 physical ledger rows/)
  assert.match(approval, /rolled-back duplicate[\s\S]*preserve that historical row byte-for-byte/)
  assert.match(approval, /277 public tables/)
  assert.match(approval, /production rehearsal used a \*\*pre-drain\*\* archive/)
  assert.match(approval, /\*\*staging-only\*\* final archive/)
  assert.match(approval, /fresh PostgreSQL 17\.6 production backup \*\*after the drain\*\*/)
  assert.match(approval, /OPERATOR_OAUTH_ENABLED=false/)
  assert.match(approval, /MFA\/passkey/)
  assert.match(approval, /Wait for CI on all\s+three services before restoring autodeploy/)
  assert.match(approval, /No seed, reset, manual data edit, restore over production/)
  assert.match(approval, /production incident state remains ACTIVE before, during, and after/)

  assert.equal((approval.match(/pnpm --filter @pathfinder\/db db:migrate:prod/g) ?? []).length, 1)
  assert.deepEqual(findUnsafeInstructions(approval), [
    'production migration script',
    'non-disposable migration command',
  ])
  assert.match(workflow, /approved September 30 exception/)
  assert.match(
    workflow,
    /final docs-bearing SHA must pass full[\s\S]*exact three-service staging admission/,
  )

  const { stdout } = await execFile('git', ['ls-files', 'docs'])
  const paths = new Set(
    stdout
      .split(/\r?\n/)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice('docs/'.length)),
  )
  paths.add('production-cutover-20260930.md')
  paths.add('production-cutover-20261001.md')
  paths.add('production-cutover-20261003.md')
  const productionMentionFiles = []
  const canonicalInvocationFiles = []
  for (const path of paths) {
    const source = await readFile(new URL(path.replaceAll('\\', '/'), docsRoot), 'utf8')
    if (/\bdb:migrate:prod\b/i.test(source)) productionMentionFiles.push([path, source])
    if (/pnpm --filter @pathfinder\/db db:migrate:prod/.test(source))
      canonicalInvocationFiles.push(path)
  }
  assert.deepEqual(canonicalInvocationFiles, ['production-cutover-20260930.md'])
  for (const [path, source] of productionMentionFiles) {
    if (path === 'production-cutover-20260930.md') continue
    if (path === 'production-cutover-20261001.md' || path === 'production-cutover-20261003.md') {
      assert.equal(hasLeadingMarker(source, restrictedProductionMarker), true)
      continue
    }
    assert.equal(
      hasLeadingMarker(source, historicalMarker),
      true,
      `${path} has a historical command reference`,
    )
  }
})

test('October 1 operator exception admits only migration 255 with fresh preservation gates', async () => {
  const approval = await readFile(new URL('production-cutover-20261001.md', docsRoot), 'utf8')
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')
  const workflow = await readFile(new URL('staging-release-workflow.md', docsRoot), 'utf8')
  assert.equal(hasLeadingMarker(approval, restrictedProductionMarker), true)
  for (const text of [approval, stop]) {
    assert.match(text, /39557745827a2e86a3a76c1f389e05f65d78900c/)
    assert.match(text, /20261001100000_crm_receipt_and_execution_foundations/)
    assert.match(text, /7bd81064-588f-48a5-b138-1fc86691a09b/)
    assert.match(text, /zpacmfkomonxeqdiadtz/)
    assert.match(text, /incident (?:state )?remains ACTIVE by default/)
    assert.match(text, /fresh[\s\S]*post-drain[\s\S]*backup[\s\S]*rehearsal/)
    assert.match(text, /The whole goal is to just get it into production/)
    assert.match(text, /No seed, reset, restore over production/)
  }
  assert.match(approval, /254 finished migrations, 277 public tables/)
  assert.match(approval, /255 finished migrations, 280 public tables/)
  assert.match(approval, /rolled-back duplicate/)
  assert.match(approval, /weekly-digest historical[\s\S]*canonical schema fingerprint/)
  assert.match(approval, /original-column hashes and counts/)
  assert.match(approval, /policy-state row[\s\S]*empty admission-counter and arming tables/)
  assert.match(
    approval,
    /final docs-bearing SHA must pass full[\s\S]*exact three-service staging admission/,
  )
  assert.match(approval, /OPERATOR_OAUTH_ENABLED=false[\s\S]*OPERATOR_OAUTH_ENABLED=true/)
  assert.match(approval, /does not create a credential[\s\S]*enable a previously off flag/)
  assert.match(
    approval,
    /public-schema[\s\S]*does not claim a complete provider-platform restoration/,
  )
  assert.doesNotMatch(approval, /pnpm --filter @pathfinder\/db db:migrate:prod/)
  assert.deepEqual(findUnsafeInstructions(approval), [
    'production migration script',
    'non-disposable migration command',
  ])
  assert.match(workflow, /production-cutover-20261001\.md/)
  assert.match(workflow, /staging disabled and production[\s\S]*enabled/)
  assert.match(stop, /Production incident state: ACTIVE/)
  assert.doesNotMatch(stop, /Production incident state: RESOLVED/)
})
