import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBatch, runProcess } from './venue-authoring-batch.mjs'

const fixtureRoot = fileURLToPath(new URL('./fixtures/venue-authoring-batch/', import.meta.url))
const fixtureChild = path.join(fixtureRoot, 'child.mjs')
const hash = (v) => createHash('sha256').update(v).digest('hex')
const save = (file, data) => writeFile(file, JSON.stringify(data))
const asOf = '2026-10-25T12:00:00Z'
// Tests inherit task-scoped TEMP/TMP; no in-vault QA or OS-wide environment changes.
const tempRoot = process.env.TEMP ?? os.tmpdir()

async function fixture(count = 1) {
  const base = await mkdtemp(path.join(tempRoot, 'authoring-batch-'))
  const venues = []
  for (let n = 0; n < count; n++) {
    const name = `fictional-${n}`
    const packet = path.join(base, name)
    await mkdir(path.join(packet, 'sources'), { recursive: true })
    await copyFile(path.join(fixtureRoot, 'package.json'), path.join(packet, 'package.json'))
    const source = 'Fictional Moonbeam Observatory source text.\n'
    await writeFile(path.join(packet, 'sources', 'S001.txt'), source)
    await save(path.join(packet, 'source-ledger.json'), {
      schemaVersion: 1,
      sources: [
        {
          sourceId: 'S001',
          observedAt: '2026-10-24',
          recheckBy: '2026-10-26',
          text: { file: 'S001.txt', sha256: hash(source) },
        },
      ],
    })
    const categories = [
      'hours-season',
      'closures',
      'admission-prices',
      'tickets-booking',
      'address-parking',
      'contact',
      'accessibility',
      'food-allergen-policy',
      'pets-service-animals',
      'weather-policy',
    ]
    await save(path.join(packet, 'coverage.json'), {
      schemaVersion: 1,
      profile: 'other',
      // Core guest categories can never be NOT_APPLICABLE; they disclose the unknown instead.
      rows: categories.map((category) =>
        ['hours-season', 'admission-prices', 'address-parking', 'contact'].includes(category)
          ? {
              category,
              status: 'UNKNOWN',
              records: ['/knowledgeEntries/create/0'],
              sources: [],
              observedAt: '2026-10-24',
              recheckBy: '2026-10-26',
              publishImpact: 'DISCLOSE',
              rationale: 'Fictional fixture discloses this unknown category.',
            }
          : {
              category,
              status: 'NOT_APPLICABLE',
              records: [],
              sources: [],
              observedAt: '2026-10-24',
              recheckBy: '2026-10-26',
              publishImpact: 'NONE',
              rationale: 'Fictional fixture category does not apply.',
            },
      ),
    })
    await save(path.join(packet, 'acceptance-manifest.json'), {
      schemaVersion: 1,
      tenantId: 'fictional-tenant',
      venueId: name,
      package: 'package.json',
      evidence: {},
    })
    venues.push({
      id: name,
      profile: 'other',
      packet: name,
      destination: name,
      acceptanceManifest: 'acceptance-manifest.json',
    })
  }
  const manifestPath = path.join(base, 'manifest.json')
  const manifest = { schemaVersion: 1, asOf, venues }
  await save(manifestPath, manifest)
  return {
    base,
    manifest,
    manifestPath,
    outputDir: path.join(base, 'run-1'),
    async update() {
      await save(manifestPath, manifest)
    },
  }
}
// Outer orchestration seam only: this synthetic report intentionally cannot satisfy
// the acceptance composer's native preview recomputation contract.
const previewFixture = (command, args, opts) => {
  if (args[0] === 'scripts/venue-guide-preview.mjs')
    return runProcess(
      command,
      [
        fixtureChild,
        'preview',
        args[args.indexOf('--package') + 1],
        args[args.indexOf('--output') + 1],
      ],
      opts,
    )
  return runProcess(command, args, opts)
}

test('argument arrays preserve Windows metacharacters without shell interpretation', async () => {
  const values = ["fictional space's", 'x&echo injected', '$(not-code)', ';bad', 'C:\\a b\\x']
  const result = await runProcess(process.execPath, [fixtureChild, 'echo', ...values])
  assert.equal(result.exitCode, 0)
  assert.deepEqual(JSON.parse(result.stdout), values)
})
test('child timeout and nonzero failure retain deterministic failure evidence', async () => {
  const timed = await runProcess(process.execPath, [fixtureChild, 'sleep'], { timeoutMs: 100 })
  assert.equal(timed.failure, 'TIMEOUT')
  const failed = await runProcess(process.execPath, [fixtureChild, 'fail'])
  assert.equal(failed.exitCode, 7)
  assert.match(failed.stderr, /Fictional child failure/)
})
test('timeout terminates supported parent-and-renderer topology', async () => {
  const result = await runProcess(process.execPath, [fixtureChild, 'tree'], { timeoutMs: 600 })
  assert.equal(result.failure, 'TIMEOUT')
  assert.equal(result.treeKill.exitCode, 0)
  assert.equal(result.cleanupUnconfirmed, false)
  const pid = Number(result.stdout.trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i)
})
test(
  'real production renderer integration',
  { skip: process.env.TORCHIKO_BATCH_REAL_PREVIEW !== '1' },
  async () => {
    const f = await fixture()
    const result = await runBatch(f)
    const venue = result.venues[0]
    assert.equal(venue.stages.guidePreview.processPassed, true)
    assert.equal(venue.structural.status, 'PASS')
    assert.equal(venue.stages.coverage.readinessPassed, true)
    assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
    assert.equal(result.toolBindings.length, 6)
  },
)
test('synthetic outer preview stays structural only while native acceptance rejects its report', async () => {
  const f = await fixture()
  const result = await runBatch({ ...f, toolRunner: previewFixture })
  const venue = result.venues[0]
  assert.equal(venue.sourceIntegrity.status, 'PASS')
  assert.equal(venue.freshness.status, 'PASS')
  assert.equal(venue.stages.coverage.readinessPassed, true)
  assert.equal(venue.structural.status, 'PASS')
  assert.equal(venue.stages.acceptance.status, 'MEASURED')
  assert.equal(venue.stages.acceptance.readinessPassed, false)
  assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
  assert.equal(result.requestedChecksPassed, false)
  assert.ok(venue.inputBindings.length >= 5)
  const receipt = JSON.parse(
    await readFile(path.join(f.outputDir, 'fictional-0', 'acceptance.json')),
  )
  assert.equal(receipt.fields.coverage.status, 'MEASURED')
  assert.equal(receipt.fields.coverage.readinessPassed, true)
  assert.equal(receipt.fields.guestLink.status, 'NOT_MEASURED')
})
test('measured valid coverage blockers fail requested readiness and preserve report', async () => {
  const f = await fixture()
  const coverageFile = path.join(f.base, 'fictional-0', 'coverage.json')
  const coverage = JSON.parse(await readFile(coverageFile))
  coverage.rows[0].publishImpact = 'BLOCKS'
  await save(coverageFile, coverage)
  const result = await runBatch({ ...f, toolRunner: previewFixture })
  const stage = result.venues[0].stages.coverage
  assert.equal(stage.status, 'MEASURED')
  assert.equal(stage.processPassed, true)
  assert.equal(stage.checkPassed, true)
  assert.equal(stage.readinessPassed, false)
  assert.ok(stage.report.sha256)
  const receipt = JSON.parse(
    await readFile(path.join(f.outputDir, 'fictional-0', 'acceptance.json')),
  )
  assert.equal(receipt.fields.coverage.status, 'MEASURED')
  assert.equal(receipt.fields.coverage.readinessPassed, false)
})
test('mixed preflight outcomes preserve partial hashes and continue later independent venues', async () => {
  const f = await fixture(2)
  await unlink(path.join(f.base, 'fictional-0', 'coverage.json'))
  f.manifest.venues[1].checks = ['sourceIntegrity', 'coverage']
  await f.update()
  const result = await runBatch(f)
  assert.equal(result.venues[0].requestedChecksPassed, false)
  assert.equal(result.venues[0].inputBindings.length, 2)
  assert.equal(result.venues[1].requestedChecksPassed, true)
  assert.equal(result.requestedChecksPassed, false)
})
test('failure and timeout logs survive and later venue runs', async () => {
  for (const mode of ['fail', 'sleep']) {
    const f = await fixture(2)
    for (const venue of f.manifest.venues) venue.checks = ['sourceIntegrity']
    await f.update()
    let calls = 0
    const toolRunner = (command, args, options) =>
      ++calls === 1
        ? runProcess(command, [fixtureChild, mode], { ...options, timeoutMs: 100 })
        : runProcess(command, args, options)
    const result = await runBatch({ ...f, toolRunner })
    assert.equal(result.venues[0].requestedChecksPassed, false)
    assert.equal(result.venues[1].requestedChecksPassed, true)
    const log = JSON.parse(
      await readFile(path.join(f.outputDir, 'fictional-0', 'sourceIntegrity-process.json')),
    )
    assert.equal(mode === 'sleep' ? log.failure : log.exitCode, mode === 'sleep' ? 'TIMEOUT' : 7)
  }
})
test('input disappearance after a child does not abort later venues', async () => {
  const f = await fixture(2)
  for (const venue of f.manifest.venues) venue.checks = ['sourceIntegrity']
  await f.update()
  let calls = 0
  const toolRunner = async (...args) => {
    const result = await runProcess(...args)
    if (++calls === 1) await unlink(path.join(f.base, 'fictional-0', 'package.json'))
    return result
  }
  const result = await runBatch({ ...f, toolRunner })
  assert.match(result.venues[0].errors.join(), /Input unavailable after run/)
  assert.equal(result.venues[1].requestedChecksPassed, true)
})
test('changed input bytes retain both hashes and invalidate the venue', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity']
  await f.update()
  const toolRunner = async (...args) => {
    const result = await runProcess(...args)
    await writeFile(
      path.join(f.base, 'fictional-0', 'sources', 'S001.txt'),
      'Fictional changed source.\n',
    )
    return result
  }
  const result = await runBatch({ ...f, toolRunner })
  const venue = result.venues[0]
  assert.match(venue.errors.join(), /Input bytes changed/)
  const old = venue.inputBindings.find((b) => b.file.endsWith('S001.txt'))
  const changed = venue.finalInputBindings.find((b) => b.file === old.file)
  assert.notEqual(old.sha256, changed.sha256)
})
test('reruns never replace retained evidence and a new destination works', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity']
  await f.update()
  await runBatch(f)
  const before = await readFile(path.join(f.outputDir, 'batch-result.json'))
  await assert.rejects(runBatch(f), /already exists/)
  assert.deepEqual(await readFile(path.join(f.outputDir, 'batch-result.json')), before)
  assert.equal(
    (await runBatch({ ...f, outputDir: path.join(f.base, 'run-2') })).requestedChecksPassed,
    true,
  )
})
test('duplicate destinations and path escapes are rejected before output creation', async () => {
  const f = await fixture(2)
  f.manifest.venues[1].destination = 'FICTIONAL-0'
  await f.update()
  await assert.rejects(runBatch(f), /unique/)
  f.manifest.venues[1].destination = '../escape'
  await f.update()
  await assert.rejects(runBatch(f), /safe destinations/)
  f.manifest.venues[1].destination = 'fictional-1'
  f.manifest.venues[1].packet = '../outside'
  await f.update()
  await assert.rejects(runBatch(f), /bounded relative/)
})
test('source symlink escape fails its venue and output overlap is always rejected', async () => {
  const f = await fixture()
  const outside = path.join(f.base, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'fictional.txt'), 'Fictional outside text')
  await symlink(
    outside,
    path.join(f.base, 'fictional-0', 'sources', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const result = await runBatch(f)
  assert.match(result.venues[0].errors.join(), /symlinks/)
  await assert.rejects(
    runBatch({ ...f, outputDir: path.join(f.base, 'fictional-0', 'nested-run') }),
    /overlaps/,
  )
})
test('canonical packet junction overlap fails before reserving any output', async () => {
  const f = await fixture()
  await symlink(
    path.join(f.base, 'fictional-0'),
    path.join(f.base, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  f.manifest.venues[0].packet = 'alias'
  await f.update()
  await assert.rejects(
    runBatch({ ...f, outputDir: path.join(f.base, 'fictional-0', 'nested-run') }),
    /canonical input packet/,
  )
  await unlink(path.join(f.base, 'fictional-0', 'coverage.json'))
  await assert.rejects(
    runBatch({ ...f, outputDir: path.join(f.base, 'fictional-0', 'nested-invalid-run') }),
    /canonical input packet/,
  )
})
test('escaping packet junction cannot hide an input/output collision', async () => {
  const f = await fixture()
  const external = await mkdtemp(path.join(tempRoot, 'authoring-external-'))
  await symlink(
    external,
    path.join(f.base, 'external-alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  f.manifest.venues[0].packet = 'external-alias'
  await f.update()
  await assert.rejects(
    runBatch({ ...f, outputDir: path.join(external, 'nested-run') }),
    /canonical input packet/,
  )
})
test('canonical reserved directory alias is rejected without opening any reserved file', async () => {
  const f = await fixture()
  // Empty synthetic directory: no credential/Gold/holdout file is created or read.
  const reserved = path.join(f.base, 'credentials.fixture')
  await mkdir(reserved)
  await symlink(
    reserved,
    path.join(f.base, 'reserved-alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  f.manifest.venues[0].packet = 'reserved-alias'
  await f.update()
  const result = await runBatch(f)
  assert.match(result.venues[0].errors.join(), /bounded relative/)
  assert.equal(result.venues[0].inputBindings.length, 0)
})
test('acceptance evidence escapes are refused before any composer can read them', async () => {
  const f = await fixture()
  await save(path.join(f.base, 'fictional-0', 'acceptance-manifest.json'), {
    schemaVersion: 1,
    tenantId: 'fictional',
    venueId: 'fictional-0',
    package: 'package.json',
    evidence: { guestLink: { file: '../outside.json', sha256: 'a'.repeat(64) } },
  })
  const result = await runBatch(f)
  assert.equal(result.venues[0].requestedChecksPassed, false)
  assert.match(result.venues[0].errors.join(), /bounded relative/)
  assert.ok(result.venues[0].inputBindings.length >= 4)
})
test('CLI uses nonzero status for requested failures and emits JSON plus human summary', async () => {
  const f = await fixture()
  const child = await runProcess(process.execPath, [
    fileURLToPath(new URL('./venue-authoring-batch.mjs', import.meta.url)),
    '--manifest',
    f.manifestPath,
    '--output-dir',
    f.outputDir,
  ])
  assert.equal(child.exitCode, 1)
  assert.equal(JSON.parse(child.stdout).requestedChecksPassed, false)
  assert.match(child.stderr, /1 venues: 0 passed, 1 failed/)
})

test(
  'native batch retains ordinary knowledge and excludes SOURCE_CONNECTION through acceptance',
  { skip: process.env.TORCHIKO_BATCH_REAL_PREVIEW !== '1' },
  async () => {
    const f = await fixture()
    const file = path.join(f.base, 'fictional-0', 'package.json')
    const baselineProcess = await runProcess(process.execPath, [
      'scripts/venue-guide-preview.mjs',
      '--package',
      file,
      '--as-of',
      asOf.slice(0, 10),
    ])
    assert.equal(baselineProcess.exitCode, 0)
    const baseline = JSON.parse(baselineProcess.stdout)
    const pkg = JSON.parse(await readFile(file))
    pkg.knowledgeEntries.create.push({
      ...structuredClone(pkg.knowledgeEntries.create[0]),
      itemKey: '00000000-0000-4000-8000-000000000002',
      provenance: { ...pkg.knowledgeEntries.create[0].provenance, sourceType: 'SOURCE_CONNECTION' },
      value: {
        title: 'Connected-only fictional topic',
        category: 'general',
        content: 'Fictional connected-source content.',
        isEnabled: true,
      },
    })
    await save(file, pkg)
    const result = await runBatch(f)
    const venue = result.venues[0]
    const preview = JSON.parse(
      await readFile(path.join(f.outputDir, 'fictional-0', 'guidePreview.json')),
    )
    const receipt = JSON.parse(
      await readFile(path.join(f.outputDir, 'fictional-0', 'acceptance.json')),
    )
    assert.deepEqual(preview.counts, { places: 0, knowledge: 1 })
    assert.deepEqual(preview.default, baseline.default)
    assert.deepEqual(preview.evidence, baseline.evidence)
    assert.match(preview.assumptions.join(' '), /SOURCE_CONNECTION knowledge are excluded/)
    assert.equal(preview.packageSha256, hash(await readFile(file)))
    assert.equal(venue.stages.guidePreview.processPassed, true)
    assert.equal(venue.stages.guidePreview.readinessPassed, true)
    assert.equal(receipt.fields.guidePreview.status, 'MEASURED')
    assert.equal(receipt.fields.guidePreview.readinessPassed, true)
    assert.equal(receipt.fields.coverage.readinessPassed, true)
    assert.equal(receipt.fields.guestLink.status, 'NOT_MEASURED')
    assert.equal(receipt.verdict, 'NOT_READY')
    assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
  },
)

test(
  'expired UNKNOWN disclosure fails coverage while native preview remains measured',
  { skip: process.env.TORCHIKO_BATCH_REAL_PREVIEW !== '1' },
  async () => {
    const f = await fixture()
    const file = path.join(f.base, 'fictional-0', 'coverage.json')
    const coverage = JSON.parse(await readFile(file))
    Object.assign(coverage.rows[0], {
      status: 'UNKNOWN',
      publishImpact: 'DISCLOSE',
      records: ['/knowledgeEntries/create/0/value/content'],
      recheckBy: '2026-10-24',
    })
    await save(file, coverage)
    const result = await runBatch(f)
    const venue = result.venues[0]
    const receipt = JSON.parse(
      await readFile(path.join(f.outputDir, 'fictional-0', 'acceptance.json')),
    )
    assert.equal(venue.stages.coverage.status, 'MEASURED')
    assert.equal(venue.stages.coverage.checkPassed, false)
    assert.equal(venue.stages.coverage.processPassed, false)
    assert.equal(venue.stages.coverage.readinessPassed, false)
    const report = JSON.parse(
      await readFile(path.join(f.outputDir, 'fictional-0', 'coverage.json')),
    )
    assert.ok(report.errors.some((error) => /stale recheckBy/.test(error)))
    assert.equal(receipt.fields.coverage.status, 'NOT_MEASURED')
    assert.match(receipt.fields.coverage.reason, /coverage report does not match recomputed inputs/)
    assert.equal(receipt.fields.guidePreview.status, 'MEASURED')
    assert.equal(receipt.fields.guidePreview.readinessPassed, true)
    assert.equal(receipt.verdict, 'NOT_READY')
    assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
    assert.equal(result.requestedChecksPassed, false)
  },
)
test('acceptance manifest venueId must equal the batch venue id', async () => {
  const f = await fixture(2)
  // fictional-1 points at a manifest that names fictional-0's identity.
  await save(path.join(f.base, 'fictional-1', 'acceptance-manifest.json'), {
    schemaVersion: 1,
    tenantId: 'fictional-tenant',
    venueId: 'fictional-0',
    package: 'package.json',
    evidence: {},
  })
  const result = await runBatch({ ...f, toolRunner: previewFixture })
  assert.equal(
    result.venues[0].errors.some((e) => /venueId does not match/.test(e)),
    false,
  )
  const borrowed = result.venues[1]
  assert.equal(borrowed.requestedChecksPassed, false)
  assert.match(borrowed.errors.join(), /venueId does not match batch venue id/)
  assert.equal(borrowed.stages.acceptance, undefined)
  assert.equal(borrowed.publicationReadiness.verdict, 'NOT_READY')
  assert.equal(result.requestedChecksPassed, false)
})
test('batch tenantId, when given, must equal the manifest tenantId', async () => {
  const f = await fixture()
  f.manifest.venues[0].tenantId = 'other-tenant'
  await f.update()
  const result = await runBatch({ ...f, toolRunner: previewFixture })
  assert.match(result.venues[0].errors.join(), /tenantId does not match/)
})
test('acceptance.json never says PUBLISH_CANDIDATE when the final result is NOT_READY', async () => {
  const f = await fixture()
  const coverageFile = path.join(f.base, 'fictional-0', 'coverage.json')
  const coverage = JSON.parse(await readFile(coverageFile))
  coverage.rows[0].publishImpact = 'BLOCKS' // a different requested check fails
  await save(coverageFile, coverage)
  const candidateRunner = async (command, args, opts) => {
    if (args[0] !== 'scripts/venue-acceptance-receipt.mjs')
      return previewFixture(command, args, opts)
    const fields = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`f${i}`, { status: 'MEASURED', readinessPassed: true }]),
    )
    await save(args[args.indexOf('--output') + 1], {
      verdict: 'PUBLISH_CANDIDATE',
      fields,
      missingItems: [],
    })
    return { exitCode: 0, signal: null, failure: null, stdout: '', stderr: '' }
  }
  const result = await runBatch({ ...f, toolRunner: candidateRunner })
  const venue = result.venues[0]
  assert.equal(venue.requestedChecksPassed, false)
  assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
  const dir = path.join(f.outputDir, 'fictional-0')
  const final = JSON.parse(await readFile(path.join(dir, 'acceptance.json')))
  assert.equal(final.verdict, 'NOT_READY')
  assert.equal(final.childVerdict, 'PUBLISH_CANDIDATE')
  assert.ok(final.batchDowngrade.errors.length > 0)
  const original = JSON.parse(await readFile(path.join(dir, 'acceptance-child-report.json')))
  assert.equal(original.verdict, 'PUBLISH_CANDIDATE')
  const bound = hash(await readFile(path.join(dir, 'acceptance.json')))
  assert.equal(venue.stages.acceptance.report.sha256, bound)
  assert.equal(
    venue.stages.acceptance.originalReport.sha256,
    hash(await readFile(path.join(dir, 'acceptance-child-report.json'))),
  )
})

test('S1 regression: batch requires an explicit venue profile', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity']
  delete f.manifest.venues[0].profile
  await f.update()
  await assert.rejects(runBatch(f), /VENUE_PROFILE_REQUIRED/)
})

test('S1 regression: batch rejects a zoo coverage profile downgraded to other', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity', 'coverage']
  f.manifest.venues[0].profile = 'zoo-wildlife'
  await f.update()
  const report = await runBatch(f)
  assert.equal(report.venues[0].publicationReadiness.verdict, 'NOT_READY')
  assert.match(report.venues[0].errors.join('\n'), /COVERAGE_PROFILE_MISMATCH/)
})

for (const variant of ['raw-only', 'hash-mismatch', 'audit-omitted']) {
  test(`S1 regression: cited coverage text must pass auditor (${variant})`, async () => {
    const f = await fixture()
    const packet = path.join(f.base, 'fictional-0')
    const source = await readFile(path.join(packet, 'sources', 'S001.txt'), 'utf8')
    const coverageFile = path.join(packet, 'coverage.json')
    const coverage = JSON.parse(await readFile(coverageFile))
    coverage.rows.find((row) => row.category === 'contact').sources = [
      { sourceId: 'S001', start: 0, end: source.length, text: source },
    ]
    await save(coverageFile, coverage)
    f.manifest.venues[0].checks =
      variant === 'audit-omitted' ? ['coverage'] : ['sourceIntegrity', 'coverage']
    await f.update()
    const ledgerFile = path.join(packet, 'source-ledger.json')
    const ledger = JSON.parse(await readFile(ledgerFile))
    if (variant === 'raw-only') {
      ledger.sources[0].raw = ledger.sources[0].text
      delete ledger.sources[0].text
    }
    if (variant === 'hash-mismatch') ledger.sources[0].text.sha256 = '0'.repeat(64)
    await save(ledgerFile, ledger)
    const report = await runBatch(f)
    const venue = report.venues[0]
    assert.equal(venue.stages.coverage.checkPassed, true)
    assert.equal(venue.stages.coverage.readinessPassed, false)
    assert.match(venue.errors.join('\n'), /COVERAGE_SOURCE_NOT_AUDITED: S001/)
    assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
  })
}

test('S1 regression: readiness findings block batch with a specific record reason', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity', 'coverage']
  await f.update()
  const file = path.join(f.base, 'fictional-0', 'package.json')
  const pkg = JSON.parse(await readFile(file))
  const copy = structuredClone(pkg.knowledgeEntries.create[0])
  copy.itemKey = '00000000-0000-4000-8000-000000000002'
  copy.value.content = 'Fictional copied ride schedule.\nHours: 9am to 5pm.'
  pkg.knowledgeEntries.create.push(copy)
  await save(file, pkg)
  const report = await runBatch(f)
  const venue = report.venues[0]
  assert.equal(venue.stages.coverage.checkPassed, true)
  assert.equal(venue.stages.coverage.readinessPassed, false)
  assert.match(
    venue.errors.join('\n'),
    /READINESS_FINDING: hours-season \/knowledgeEntries\/create\/1: labeled record is not bound/,
  )
  assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
})

test('S1 regression: batch saves a bound per-venue recheck register', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity', 'coverage']
  await f.update()
  const report = await runBatch(f)
  const venue = report.venues[0]
  const file = path.join(f.outputDir, 'fictional-0', 'RECHECK-REGISTER.json')
  const register = JSON.parse(await readFile(file))
  assert.equal(register.asOf, asOf.slice(0, 10))
  assert.equal(register.rows[0].state, 'CURRENT')
  assert.equal(register.rows[0].recheckBy, '2026-10-26')
  assert.ok(register.rows[0].itemKey)
  assert.equal(venue.recheckRegister.sha256, hash(await readFile(file)))
  assert.equal(
    register.bindings.package.sha256,
    venue.inputBindings.find((entry) => entry.file.endsWith('package.json')).sha256,
  )
  assert.match(register.bindings.checker.gitBlob, /^[a-f0-9]{40}$/)
  assert.equal(report.checkerVersion.gitBlob, register.bindings.checker.gitBlob)
})

test('S1 regression: audited nested text source passes without a legacy alias', async () => {
  const f = await fixture()
  f.manifest.venues[0].checks = ['sourceIntegrity', 'coverage']
  await f.update()
  const packet = path.join(f.base, 'fictional-0')
  const source = await readFile(path.join(packet, 'sources', 'S001.txt'), 'utf8')
  await mkdir(path.join(packet, 'sources', 'nested'))
  await writeFile(path.join(packet, 'sources', 'nested', 'retained.txt'), source)
  await writeFile(path.join(packet, 'sources', 'S001.txt'), 'Unrelated fictional legacy text.')
  const ledgerFile = path.join(packet, 'source-ledger.json')
  const ledger = JSON.parse(await readFile(ledgerFile))
  ledger.sources[0].text.file = 'nested/retained.txt'
  await save(ledgerFile, ledger)
  const coverageFile = path.join(packet, 'coverage.json')
  const coverage = JSON.parse(await readFile(coverageFile))
  coverage.rows.find((row) => row.category === 'contact').sources = [
    { sourceId: 'S001', start: 0, end: source.length, text: source },
  ]
  await save(coverageFile, coverage)
  const report = await runBatch(f)
  const venue = report.venues[0]
  assert.equal(venue.sourceIntegrity.status, 'PASS')
  assert.equal(venue.stages.coverage.readinessPassed, true, venue.errors.join('\n'))
  assert.equal(venue.requestedChecksPassed, true)
  assert.equal(venue.publicationReadiness.verdict, 'NOT_READY')
  const measured = JSON.parse(
    await readFile(path.join(f.outputDir, 'fictional-0', 'coverage.json')),
  )
  assert.equal(path.basename(measured.bindings.sources[0].file), 'retained.txt')
  assert.equal(path.basename(measured.bindings.sourcesRoot), 'sources')
})
