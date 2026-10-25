import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { checkCoverage, main, pointer } from './venue-coverage/check.mjs'
const fixture = fileURLToPath(new URL('./fixtures/venue-coverage/', import.meta.url))
async function run(t, mutate = () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fictional-coverage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(fixture, dir, { recursive: true })
  const coveragePath = path.join(dir, 'coverage.json')
  const coverage = JSON.parse(await readFile(coveragePath, 'utf8'))
  await mutate(coverage, dir)
  await writeFile(coveragePath, JSON.stringify(coverage))
  const options = {
    packagePath: path.join(dir, 'package.json'),
    ledgerPath: path.join(dir, 'ledger.json'),
    coveragePath,
    sourcesDir: path.join(dir, 'sources'),
    asOf: '2026-10-24',
  }
  return { report: await checkCoverage(options), options, dir }
}
test('fictional fixture passes and binds all input bytes without editing', async (t) => {
  const { report, options } = await run(t)
  assert.equal(report.passed, true, report.errors.join('\n'))
  assert.match(report.bindings.package.sha256, /^[a-f0-9]{64}$/)
  assert.equal(report.bindings.sources.length, 1)
  const before = await readFile(options.packagePath)
  assert.deepEqual(await checkCoverage(options), report)
  assert.deepEqual(await readFile(options.packagePath), before)
})
const failures = [
  [
    'invalid top-level rows',
    (c) => {
      c.rows = {}
    },
  ],
  [
    'ledger sources malformed',
    async (c, dir) => {
      await writeFile(path.join(dir, 'ledger.json'), '{"sources":{}}')
    },
  ],
  [
    'invalid source span schema',
    (c) => {
      c.rows[5].sources[0].extra = true
    },
  ],
  [
    'N/A requires rationale',
    (c) => {
      c.rows[0].status = 'NOT_APPLICABLE'
      c.rows[0].rationale = ' '
    },
  ],
  ['missing category', (c) => c.rows.pop()],
  ['duplicate category', (c) => c.rows.push(c.rows[0])],
  [
    'invalid profile',
    (c) => {
      c.profile = 'guess'
    },
  ],
  [
    'unknown schema version',
    (c) => {
      c.schemaVersion = 2
    },
  ],
  [
    'unexpected row field',
    (c) => {
      c.rows[0].applicability = 'yes'
    },
  ],
  [
    'invalid status',
    (c) => {
      c.rows[0].status = 'MAYBE'
    },
  ],
  [
    'invalid impact',
    (c) => {
      c.rows[0].publishImpact = 'PERHAPS'
    },
  ],
  [
    'missing rationale',
    (c) => {
      c.rows[0].rationale = ''
    },
  ],
  [
    'missing known record',
    (c) => {
      c.rows[5].records = []
    },
  ],
  [
    'missing known source',
    (c) => {
      c.rows[5].sources = []
    },
  ],
  [
    'missing pointer',
    (c) => {
      c.rows[5].records = ['/missing']
    },
  ],
  [
    'invalid pointer escape',
    (c) => {
      c.rows[5].records = ['/knowledgeEntries/create/~3']
    },
  ],
  [
    'unknown disclosure absent',
    async (c, dir) => {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          schemaVersion: 3,
          knowledgeEntries: {
            create: [{ value: { title: 'Details', content: 'Details available.' } }],
          },
        }),
      )
    },
  ],
  [
    'unknown disclosure lacks record',
    (c) => {
      c.rows[0].records = []
    },
  ],
  [
    'human question missing',
    (c) => {
      c.rows[0].status = 'NEEDS_HUMAN'
    },
  ],
  [
    'conflict question missing',
    (c) => {
      c.rows[0].status = 'CONFLICTED'
    },
  ],
  [
    'missing recheck',
    (c) => {
      delete c.rows[0].recheckBy
    },
  ],
  [
    'stale recheck',
    (c) => {
      c.rows[0].recheckBy = '2026-10-23'
    },
  ],
  [
    'impossible date',
    (c) => {
      c.rows[0].observedAt = '2026-02-30'
    },
  ],
  [
    'future observation',
    (c) => {
      c.rows[0].observedAt = '2026-10-25'
    },
  ],
  [
    'invalid span text',
    (c) => {
      c.rows[5].sources[0].text = 'invented'
    },
  ],
  [
    'span exceeds source',
    (c) => {
      c.rows[5].sources[0].end = 999
    },
  ],
  [
    'negative span',
    (c) => {
      c.rows[5].sources[0].start = -1
    },
  ],
  [
    'fractional span',
    (c) => {
      c.rows[5].sources[0].start = 0.5
    },
  ],
  [
    'unknown ledger id',
    (c) => {
      c.rows[5].sources[0].sourceId = 'missing'
    },
  ],
  [
    'source traversal',
    (c) => {
      c.rows[5].sources[0].sourceId = '../private'
    },
  ],
  [
    'ledger traversal',
    async (c, dir) => {
      await writeFile(
        path.join(dir, 'ledger.json'),
        JSON.stringify({ sources: [{ sourceId: '../private' }] }),
      )
    },
  ],
  [
    'duplicate ledger id',
    async (c, dir) => {
      await writeFile(
        path.join(dir, 'ledger.json'),
        JSON.stringify({ sources: [{ sourceId: 'S001' }, { sourceId: 'S001' }] }),
      )
    },
  ],
  [
    'missing retained source',
    async (c, dir) => {
      await rm(path.join(dir, 'sources/S001.txt'))
    },
  ],
  [
    'package version invalid',
    async (c, dir) => {
      await writeFile(path.join(dir, 'package.json'), '{"schemaVersion":2}')
    },
  ],
  [
    'amusement needs safety',
    (c) => {
      c.profile = 'amusement'
    },
  ],
  [
    'wildlife needs encounter rules',
    (c) => {
      c.profile = 'zoo-wildlife'
    },
  ],
  [
    'events requires recheck',
    (c) => {
      c.rows.push({ ...c.rows[5], category: 'events' })
    },
  ],
]
for (const [name, mutate] of failures)
  test(`fails closed: ${name}`, async (t) => {
    const { report } = await run(t, mutate)
    assert.equal(report.passed, false)
    assert.ok(report.errors.length)
  })
test('JSON pointer uses own properties, strict array indices and escaped keys', () => {
  assert.equal(pointer({ 'a/b': { '~': 3 } }, '/a~1b/~0'), 3)
  for (const ref of ['/constructor', '/__proto__', '/0/constructor', '/01', '/-', ''])
    assert.throws(() => pointer([{}], ref))
})
test('CLI creates report exclusively and refuses input overwrite', async (t) => {
  const { options, dir } = await run(t)
  const args = Object.entries({
    '--package': options.packagePath,
    '--ledger': options.ledgerPath,
    '--coverage': options.coveragePath,
    '--sources': options.sourcesDir,
    '--as-of': options.asOf,
    '--output': path.join(dir, 'COVERAGE-REPORT.json'),
  }).flat()
  assert.equal(await main(args), 0)
  await assert.rejects(main(args))
  args[args.length - 1] = options.packagePath
  await assert.rejects(main(args), /overwrite/)
  await assert.rejects(main(['--as-of', '2026-02-30']))
  await assert.rejects(checkCoverage({ ...options, asOf: '2026-02-30' }), /real/)
})

for (const [name, ref, patch] of [
  [
    'metadata source name',
    '/knowledgeEntries/create/0',
    (p) => {
      p.knowledgeEntries.create[0].value.content = 'Details available.'
      p.knowledgeEntries.create[0].provenance.sourceName = 'unconfirmed'
    },
  ],
  [
    'metadata pointer',
    '/knowledgeEntries/create/0/provenance/sourceName',
    (p) => {
      p.knowledgeEntries.create[0].provenance.sourceName = 'unconfirmed'
    },
  ],
  [
    'whole package',
    '/',
    (p) => {
      p[''] = 'unconfirmed'
    },
  ],
  ['numeric schema', '/schemaVersion', (p) => {}],
  ['operation container', '/knowledgeEntries', (p) => {}],
  [
    'disabled record',
    '/knowledgeEntries/create/0',
    (p) => {
      p.knowledgeEntries.create[0].value.isEnabled = false
    },
  ],
  [
    'non-text field',
    '/knowledgeEntries/create/0/value/isEnabled',
    (p) => {
      p.knowledgeEntries.create[0].value.isEnabled = true
    },
  ],
])
  test(`guest disclosure/KNOWN pointers reject ${name}`, async (t) => {
    const { report } = await run(t, async (c, dir) => {
      const filename = path.join(dir, 'package.json')
      const pkg = JSON.parse(await readFile(filename, 'utf8'))
      patch(pkg)
      await writeFile(filename, JSON.stringify(pkg))
      c.rows[0].records = [ref]
      c.rows[5].records = [ref]
    })
    assert.equal(report.passed, false)
  })
test('explicit guest content field pointers pass', async (t) => {
  const { report } = await run(t, (c) => {
    for (const row of c.rows) row.records = ['/knowledgeEntries/create/0/value/content']
  })
  assert.equal(report.passed, true, report.errors.join('\n'))
})
