import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'

const docsRoot = new URL('../docs/', import.meta.url)
const execFile = promisify(execFileCallback)
const activeStopMarker =
  'Migration instruction status: INCIDENT STOP — DO NOT EXECUTE EXTERNAL DATABASE COMMANDS.'
const historicalMarker = 'Migration instruction status: HISTORICAL — DO NOT EXECUTE.'
const inertArchiveMarker = '## Post-resolution external exercise archive — INERT, DO NOT EXECUTE'

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
  ['imperative migration step', /\b(?:apply|run)\s+(?:the\s+)?migration\b/i],
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

test('the external database incident stop remains active and authority-gated', async () => {
  const stop = await readFile(new URL('database-incident-stop.md', docsRoot), 'utf8')

  assert.match(stop, /Incident state: ACTIVE/)
  assert.match(stop, /Tom identifies the affected external project\/environment/)
  assert.match(stop, /authorizes a bounded read-only assessment plan/)
  assert.match(stop, /Tom explicitly approves the remediation, roll-forward, or rollback plan/)
  assert.match(stop, /every\s+external database inspection or write that plan authorizes/)
  assert.match(stop, /Only after that explicit approval/)
  assert.doesNotMatch(stop, /Incident state: RESOLVED/)
})

test('active runbooks expose no executable external database instruction', async () => {
  const staging = await readFile(new URL('railway-staging.md', docsRoot), 'utf8')
  const archiveOffset = staging.indexOf(inertArchiveMarker)

  assert.equal(hasLeadingMarker(staging, activeStopMarker), true)
  assert.match(staging, /database-incident-stop\.md/)
  assert.notEqual(archiveOffset, -1)

  const activeRunbook = staging.slice(0, archiveOffset)
  const inertArchive = staging.slice(archiveOffset)
  assert.deepEqual(findUnsafeInstructions(activeRunbook), [])
  assert.match(activeRunbook, /db:migrate:disposable/)
  assert.ok(findUnsafeInstructions(inertArchive).some((finding) => finding.startsWith('SQL ')))
  assert.doesNotMatch(inertArchive.slice(inertArchiveMarker.length), /^## /m)
  assert.match(inertArchive, /Tom explicitly approves an incident\s+assessment/)
})

test('every retained historical database instruction is prominently deactivated', async () => {
  const { stdout } = await execFile('git', ['ls-files', 'docs'])
  const markdownPaths = stdout
    .split(/\r?\n/)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.slice('docs/'.length))
  const unguarded = []

  for (const path of markdownPaths) {
    const source = await readFile(new URL(path.replaceAll('\\', '/'), docsRoot), 'utf8')
    const findings = findUnsafeInstructions(source)
    if (findings.length === 0) continue

    if (
      !hasLeadingMarker(source, activeStopMarker) &&
      !hasLeadingMarker(source, historicalMarker)
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
