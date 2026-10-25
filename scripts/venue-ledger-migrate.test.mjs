import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { auditSources } from './venue-source-audit.mjs'
import {
  canonicalObservedAt,
  main,
  migrateLedger,
  recheckByFromCoverage,
} from './venue-ledger-migrate.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const tempRoot = process.env.TEMP ?? os.tmpdir()
const quiet = { stdout: { write() {} }, stderr: { write() {} } }

// Fictional venue folder with the legacy shapes seen in real ledgers.
async function legacyVenue(sources, extra = {}) {
  const venue = await mkdtemp(path.join(tempRoot, 'ledger-migrate-'))
  await mkdir(path.join(venue, 'sources'))
  await mkdir(path.join(venue, 'evidence'))
  const files = {
    'sources/A.html': '<p>Fictional Lantern Garden opens at 9 am.</p>',
    'sources/A.txt': 'Fictional Lantern Garden opens at 9 am.',
    'evidence/B.raw': '<p>Fictional pond rules.</p>',
    'sources/B.txt': 'Fictional pond rules.',
    'sources/C.txt': 'Fictional parking note.',
  }
  for (const [file, body] of Object.entries(files)) await writeFile(path.join(venue, file), body)
  const ledgerPath = path.join(venue, 'source-ledger.json')
  const ledger = { artifactType: 'fictional-legacy', records: [{ keep: true }], ...extra, sources }
  await writeFile(ledgerPath, JSON.stringify(ledger))
  return { venue, files, ledgerPath, sourcesDir: path.join(venue, 'sources') }
}

test('observedAt keeps day values, truncates sub-millisecond digits and rejects junk', () => {
  assert.deepEqual(canonicalObservedAt('2026-10-23'), { value: '2026-10-23' })
  assert.deepEqual(canonicalObservedAt('2026-10-23T16:00:44.378518+00:00'), {
    value: '2026-10-23T16:00:44.378Z',
    normalizedFrom: '2026-10-23T16:00:44.378518+00:00',
  })
  assert.equal(canonicalObservedAt('2026-10-23T11:00:00-05:00').value, '2026-10-23T16:00:00.000Z')
  assert.ok(canonicalObservedAt('yesterday').error)
  assert.ok(canonicalObservedAt(undefined).error)
})

test('a source inherits the earliest recheckBy of the coverage rows citing it', () => {
  const deadlines = recheckByFromCoverage({
    rows: [
      { category: 'hours-season', recheckBy: '2026-11-30', sources: [{ sourceId: 'A' }] },
      { category: 'closures', recheckBy: '2026-11-01', sources: [{ sourceId: 'A' }] },
      { category: 'contact', sources: [{ sourceId: 'C' }] },
    ],
  })
  assert.deepEqual(deadlines.get('A'), { recheckBy: '2026-11-01', categories: ['closures'] })
  assert.equal(deadlines.has('C'), false)
})

test('legacy spellings map to strict targets and the result passes the real auditor', async () => {
  const fixture = await legacyVenue([
    {
      sourceId: 'A',
      url: 'https://example.invalid/a',
      observedAt: '2026-10-24T08:00:00.123456+00:00',
      rawPath: 'sources/A.html',
      textPath: 'sources/A.txt',
      sha256: hash('<p>Fictional Lantern Garden opens at 9 am.</p>'),
      textSha256: hash('Fictional Lantern Garden opens at 9 am.'),
      verification: 'FETCHED',
    },
  ])
  const coverage = path.join(fixture.venue, 'coverage.json')
  await writeFile(
    coverage,
    JSON.stringify({
      rows: [{ category: 'hours-season', recheckBy: '2026-11-01', sources: [{ sourceId: 'A' }] }],
    }),
  )
  const { ledger, report } = await migrateLedger({ ...fixture, coveragePath: coverage })
  assert.deepEqual(ledger, {
    schemaVersion: 1,
    sources: [
      {
        sourceId: 'A',
        observedAt: '2026-10-24T08:00:00.123Z',
        raw: { file: 'A.html', sha256: hash('<p>Fictional Lantern Garden opens at 9 am.</p>') },
        text: { file: 'A.txt', sha256: hash('Fictional Lantern Garden opens at 9 am.') },
        recheckBy: '2026-11-01',
      },
    ],
  })
  assert.deepEqual(report.sources[0].fieldsNotCarried, ['url', 'verification'])
  assert.deepEqual(report.legacyTopLevelFieldsNotCarried, ['artifactType', 'records'])
  const strictPath = path.join(fixture.venue, 'strict.json')
  await writeFile(strictPath, JSON.stringify(ledger))
  const audit = await auditSources({
    ledgerPath: strictPath,
    sourcesDir: fixture.sourcesDir,
    asOf: '2026-10-25',
  })
  assert.equal(audit.passed, true)
})

test('targets outside the sources directory or without a declared hash are not declared', async () => {
  const fixture = await legacyVenue([
    {
      id: 'B',
      observedAt: '2026-10-24',
      rawFile: 'evidence\\B.raw',
      textFile: 'sources/B.txt',
      sha256: hash('<p>Fictional pond rules.</p>'),
    },
  ])
  const { ledger, report } = await migrateLedger(fixture)
  // Raw lives outside sources/; text has no declared hash and nothing attests one.
  assert.equal(ledger.sources.length, 0)
  assert.equal(report.excluded[0].reason, 'no auditable retained target')
  assert.match(report.excluded[0].notes.join('\n'), /outside the sources directory/)
  assert.match(report.excluded[0].notes.join('\n'), /no declared SHA-256/)
})

test('attested text hashes are used only where the legacy ledger declares none, and are labelled', async () => {
  const fixture = await legacyVenue([
    { sourceId: 'C', observedAt: '2026-10-24', textPath: 'sources/C.txt' },
  ])
  const attestedTextPath = path.join(fixture.venue, 'attested.json')
  await writeFile(
    attestedTextPath,
    JSON.stringify({
      schemaVersion: 1,
      method: 'fictional reproduction',
      sources: { C: hash('Fictional parking note.') },
    }),
  )
  const { ledger, report } = await migrateLedger({ ...fixture, attestedTextPath })
  assert.deepEqual(ledger.sources[0].text, {
    file: 'C.txt',
    sha256: hash('Fictional parking note.'),
  })
  assert.equal(report.sources[0].targets[0].hashOrigin, 'attested: fictional reproduction')
  assert.equal(ledger.sources[0].recheckBy, undefined)
  assert.match(report.sources[0].notes.join('\n'), /no recheckBy/)
  await writeFile(attestedTextPath, JSON.stringify({ schemaVersion: 1, sources: { C: 'x' } }))
  await assert.rejects(migrateLedger({ ...fixture, attestedTextPath }), /method/)
})

test('a wrong declared hash is carried unchanged so the auditor, not the migration, fails it', async () => {
  const fixture = await legacyVenue([
    {
      sourceId: 'C',
      observedAt: '2026-10-24',
      textPath: 'sources/C.txt',
      textSha256: '0'.repeat(64),
      recheckBy: '2026-11-01',
    },
  ])
  const { ledger } = await migrateLedger(fixture)
  assert.equal(ledger.sources[0].text.sha256, '0'.repeat(64))
  const strictPath = path.join(fixture.venue, 'strict.json')
  await writeFile(strictPath, JSON.stringify(ledger))
  const audit = await auditSources({
    ledgerPath: strictPath,
    sourcesDir: fixture.sourcesDir,
    asOf: '2026-10-25',
  })
  assert.match(audit.errors.join('\n'), /HASH_MISMATCH/)
})

test('failed fetches, conflicting spellings and duplicate ids are excluded with reasons', async () => {
  const fixture = await legacyVenue([
    { sourceId: 'gone', observedAt: '2026-10-24', status: 'FAILED', error: 'HTTP Error 403' },
    {
      sourceId: 'A',
      id: 'other',
      observedAt: '2026-10-24',
      textPath: 'sources/A.txt',
      textSha256: hash('Fictional Lantern Garden opens at 9 am.'),
    },
    {
      sourceId: 'C',
      observedAt: '2026-10-24',
      textPath: 'sources/C.txt',
      textSha256: hash('Fictional parking note.'),
    },
    {
      sourceId: 'c',
      observedAt: '2026-10-24',
      textPath: 'sources/C.txt',
      textSha256: hash('Fictional parking note.'),
    },
  ])
  const { ledger, report } = await migrateLedger(fixture)
  assert.deepEqual(
    ledger.sources.map((source) => source.sourceId),
    ['C'],
  )
  const reasons = Object.fromEntries(report.excluded.map((entry) => [entry.index, entry.reason]))
  assert.equal(reasons[0], 'no auditable retained target')
  assert.equal(report.excluded[0].legacyError, 'HTTP Error 403')
  assert.match(reasons[1], /source id declared differently/)
  assert.match(reasons[3], /duplicate source id/)
})

test('coverage citations of uncarried sources are surfaced in the summary', async () => {
  const fixture = await legacyVenue([
    { sourceId: 'gone', observedAt: '2026-10-24', status: 'FAILED' },
  ])
  const coverage = path.join(fixture.venue, 'coverage.json')
  await writeFile(
    coverage,
    JSON.stringify({ rows: [{ category: 'contact', sources: [{ sourceId: 'gone' }] }] }),
  )
  const { report } = await migrateLedger({ ...fixture, coveragePath: coverage })
  assert.deepEqual(report.summary.citedByCoverageButNotCarried, ['gone'])
})

test('CLI never overwrites the legacy ledger or an existing output, and leaves the legacy bytes alone', async () => {
  const fixture = await legacyVenue([
    {
      sourceId: 'C',
      observedAt: '2026-10-24',
      textPath: 'sources/C.txt',
      textSha256: hash('Fictional parking note.'),
    },
  ])
  const before = await readFile(fixture.ledgerPath)
  const base = ['--ledger', fixture.ledgerPath, '--sources-dir', fixture.sourcesDir]
  assert.equal(
    await main(
      [...base, '--output', fixture.ledgerPath, '--report', path.join(fixture.venue, 'r.json')],
      quiet,
    ),
    2,
  )
  const output = path.join(fixture.venue, 'strict.json')
  const reportPath = path.join(fixture.venue, 'report.json')
  assert.equal(await main([...base, '--output', output, '--report', reportPath], quiet), 0)
  assert.equal(await main([...base, '--output', output, '--report', reportPath], quiet), 2)
  assert.deepEqual(await readFile(fixture.ledgerPath), before)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).sources.length, 1)
})
