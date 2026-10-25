import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkCoverage, main, pointer } from './venue-coverage/check.mjs'
const fixture = fileURLToPath(new URL('./fixtures/venue-coverage/', import.meta.url))
async function run(t, mutate = () => {}, asOf = '2026-10-24') {
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
    asOf,
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

test('UNKNOWN DISCLOSE cannot rely on an enabled past event body omitted by production', async (t) => {
  const { report } = await run(
    t,
    async (coverage, dir) => {
      const filename = path.join(dir, 'package.json')
      const pkg = JSON.parse(await readFile(filename, 'utf8'))
      Object.assign(pkg.knowledgeEntries.create[0].value, {
        title: 'Fictional Garden Festival 2025',
        category: 'Events',
        content: 'Current opening hours are unconfirmed. Ask the fictional garden before visiting.',
        isEnabled: true,
      })
      pkg.knowledgeEntries.create[0].provenance.sourceType = 'MANUAL'
      await writeFile(filename, JSON.stringify(pkg))
    },
    '2026-10-25',
  )
  assert.equal(report.passed, false)
  assert.ok(report.errors.some((error) => error.includes('PAST')))
})
test('SOURCE_CONNECTION knowledge cannot supply a guest-visible disclosure', async (t) => {
  const { report } = await run(t, async (c, dir) => {
    const filename = path.join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(filename, 'utf8'))
    pkg.knowledgeEntries.create[0].provenance.sourceType = 'SOURCE_CONNECTION'
    await writeFile(filename, JSON.stringify(pkg))
  })
  assert.equal(report.passed, false)
  assert.ok(report.errors.some((error) => error.includes('SOURCE_CONNECTION')))
})
for (const [title, content] of [
  ['Fictional Garden Festival 2027', 'Current opening hours are unconfirmed. Ask staff.'],
  [
    'Fictional Garden Festival 2025',
    'The 2027 run is announced. Current opening hours are unconfirmed. Ask staff.',
  ],
  ['Current visitor information', 'Current opening hours are unconfirmed. Ask staff.'],
])
  test(`current or future eligible disclosure remains admissible: ${title} / ${content.slice(0, 12)}`, async (t) => {
    const { report } = await run(
      t,
      async (c, dir) => {
        const filename = path.join(dir, 'package.json')
        const pkg = JSON.parse(await readFile(filename, 'utf8'))
        Object.assign(pkg.knowledgeEntries.create[0].value, {
          title,
          category: 'Events',
          content,
          isEnabled: true,
        })
        await writeFile(filename, JSON.stringify(pkg))
      },
      '2026-10-25',
    )
    assert.equal(report.passed, true, report.errors.join('\n'))
  })
test('raw research prose retained by the production renderer remains a disclosure', async (t) => {
  const { report, options } = await run(t, async (c, dir) => {
    const filename = path.join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(filename, 'utf8'))
    pkg.knowledgeEntries.create[0].value.content = 'For testing, opening hours are unconfirmed.'
    await writeFile(filename, JSON.stringify(pkg))
  })
  assert.equal(report.passed, true, report.errors.join('\n'))
  let cli
  for (const anchor of [
    new URL('../packages/api/package.json', import.meta.url),
    new URL('../node_modules/.pnpm/node_modules/tsx/package.json', import.meta.url),
  ]) {
    try {
      cli = createRequire(anchor).resolve('tsx/cli')
      break
    } catch {
      /* Existing installed dependency only. */
    }
  }
  assert.ok(cli, 'installed tsx CLI required for the production-renderer regression')
  const pkg = JSON.parse(await readFile(options.packagePath, 'utf8'))
  const entry = pkg.knowledgeEntries.create[0].value
  const moduleUrl = new URL('../packages/api/src/lib/guest-venue-directory.ts', import.meta.url)
    .href
  const code = `import {buildGuestVenueGuidePrompt} from ${JSON.stringify(moduleUrl)};const entry=${JSON.stringify(entry)};const result=buildGuestVenueGuidePrompt({incomplete:false,places:[],knowledge:[{id:'fictional-regression',...entry,sourceType:'MANUAL',sourceName:null,sourceUrl:null}]},{currentDate:'2026-10-24'});process.stdout.write(JSON.stringify({mode:result.mode,retained:result.prompt.includes(entry.content)}));`
  const child = spawnSync(process.execPath, [cli, '-e', code], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { mode: 'FULL', retained: true })
})

test('unavailable installed production helpers fail closed instead of assuming disclosure visibility', async (t) => {
  const { options, dir } = await run(t)
  const isolatedChecker = path.join(dir, 'isolated-checker.mjs')
  await cp(fileURLToPath(new URL('./venue-coverage/check.mjs', import.meta.url)), isolatedChecker)
  const isolated = await import(pathToFileURL(isolatedChecker).href)
  const report = await isolated.checkCoverage(options)
  assert.equal(report.passed, false)
  assert.ok(
    report.errors.some((error) => error.includes('unavailable') || error.includes('Cannot find')),
  )
})
test('invalid temporal classifier input fails closed', async (t) => {
  const { report } = await run(t, async (c, dir) => {
    const filename = path.join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(filename, 'utf8'))
    pkg.knowledgeEntries.create[0].value.category = 42
    await writeFile(filename, JSON.stringify(pkg))
  })
  assert.equal(report.passed, false)
  assert.ok(report.errors.some((error) => error.includes('visibility unverified')))
})
test('a title-only "unconfirmed" is not a guest disclosure', async (t) => {
  // Superseded 2026-10-25: this case previously passed. A body like "Ask staff for details."
  // states nothing unconfirmed to a guest who receives the body without its title.
  const { report } = await run(t, async (c, dir) => {
    const filename = path.join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(filename, 'utf8'))
    Object.assign(pkg.knowledgeEntries.create[0].value, {
      title: 'Visitor hours and unconfirmed source conflicts',
      content: 'Ask staff for details.',
    })
    await writeFile(filename, JSON.stringify(pkg))
  })
  assert.equal(report.passed, false)
  assert.match(report.errors.join('\n'), /body must state unconfirmed/)
})
async function withPackage(t, edit, mutate = () => {}) {
  return run(t, async (c, dir) => {
    const filename = path.join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(filename, 'utf8'))
    edit(pkg)
    await writeFile(filename, JSON.stringify(pkg))
    await mutate(c, dir)
  })
}
for (const content of [
  'Hours are not unconfirmed.',
  'Admission is $50. It is NOT UNCONFIRMED.',
  'Prices are no longer unconfirmed.',
  'Parking isn’t unconfirmed today.',
]) {
  test(`negated disclosure is rejected: ${content}`, async (t) => {
    const { report } = await withPackage(t, (pkg) => {
      pkg.knowledgeEntries.create[0].value.content = content
    })
    assert.equal(report.passed, false)
    assert.match(report.errors.join('\n'), /body must state unconfirmed/)
  })
}
test('disclosure inside a multi-sentence body still counts', async (t) => {
  const { report } = await withPackage(t, (pkg) => {
    pkg.knowledgeEntries.create[0].value.content =
      'Visitors enter at the north gate. Current visitor details are unconfirmed.'
  })
  assert.equal(report.passed, true, report.errors.join('\n'))
})
const addRecord = async (dir, value) => {
  const filename = path.join(dir, 'package.json')
  const pkg = JSON.parse(await readFile(filename, 'utf8'))
  pkg.knowledgeEntries.create.push({
    itemKey: '00000000-0000-4000-8000-00000000000' + (pkg.knowledgeEntries.create.length + 1),
    provenance: { contentOrigin: 'AI_GENERATED', sourceName: 'Fictional fixture' },
    value: { title: 'Fictional booking', category: 'Tickets', ...value },
  })
  await writeFile(filename, JSON.stringify(pkg))
  return `/knowledgeEntries/create/${pkg.knowledgeEntries.create.length - 1}`
}
const matrix = [
  [
    'UNKNOWN with impact NONE',
    (c) => Object.assign(c.rows[3], { publishImpact: 'NONE' }),
    /UNKNOWN requires publishImpact BLOCKS or DISCLOSE/,
  ],
  [
    'CONFLICTED with impact NONE',
    (c) =>
      Object.assign(c.rows[3], {
        status: 'CONFLICTED',
        publishImpact: 'NONE',
        humanDecision: 'Which booking terms apply?',
      }),
    /CONFLICTED requires publishImpact/,
  ],
  [
    'NEEDS_HUMAN with impact NONE',
    (c) =>
      Object.assign(c.rows[3], {
        status: 'NEEDS_HUMAN',
        publishImpact: 'NONE',
        humanDecision: 'Which booking terms apply?',
      }),
    /NEEDS_HUMAN requires publishImpact/,
  ],
  [
    'KNOWN with impact BLOCKS',
    (c) => Object.assign(c.rows[5], { publishImpact: 'BLOCKS' }),
    /KNOWN cannot have publishImpact BLOCKS/,
  ],
  [
    'NOT_APPLICABLE hours',
    (c) =>
      Object.assign(c.rows[0], {
        status: 'NOT_APPLICABLE',
        publishImpact: 'NONE',
        records: [],
        rationale: 'This fictional garden is a virtual exhibit only.',
      }),
    /hours-season cannot be NOT_APPLICABLE/,
  ],
  [
    'NOT_APPLICABLE with a throwaway rationale',
    (c) =>
      Object.assign(c.rows[9], {
        status: 'NOT_APPLICABLE',
        publishImpact: 'NONE',
        records: [],
        rationale: 'n/a',
      }),
    /NOT_APPLICABLE requires a specific rationale/,
  ],
  [
    'CONFLICTED DISCLOSE without an unconfirmed body',
    async (c, dir) => {
      const ref = await addRecord(dir, { content: 'Booking is online.' })
      Object.assign(c.rows[3], {
        status: 'CONFLICTED',
        humanDecision: 'Which booking terms apply?',
        records: [ref],
      })
    },
    /rows\[3\]: CONFLICTED DISCLOSE needs at least one record body that states unconfirmed/,
  ],
  [
    'recheckBy years after observedAt',
    (c) => Object.assign(c.rows[0], { recheckBy: '2099-12-31' }),
    /recheckBy is too far after observedAt/,
  ],
  [
    'one-character span',
    (c) => {
      c.rows[5].sources[0] = {
        ...c.rows[5].sources[0],
        end: c.rows[5].sources[0].start + 1,
        text: 'F',
      }
    },
    /rows\[5\]: invalid source span/,
  ],
  [
    'string isEnabled',
    async (c, dir) => {
      c.rows[3].records = [
        await addRecord(dir, { content: 'Booking is unconfirmed.', isEnabled: 'false' }),
      ]
    },
    /isEnabled must be boolean/,
  ],
]
for (const [name, mutate, expected] of matrix)
  test(`status, impact and evidence rules reject: ${name}`, async (t) => {
    const { report } = await run(t, mutate)
    assert.equal(report.passed, false, name)
    assert.match(report.errors.join('\n'), expected)
  })
test('labeled hours and price records outside their rows become readiness findings', async (t) => {
  const { report } = await withPackage(t, (pkg) => {
    pkg.knowledgeEntries.create.push(
      {
        itemKey: '00000000-0000-4000-8000-000000000002',
        provenance: { contentOrigin: 'AI_GENERATED', sourceName: 'Fictional fixture' },
        value: {
          title: 'Lantern Walk',
          category: 'Attractions',
          content:
            'Lantern Walk is a fictional evening path.\nHours: 6pm to 9pm Friday.\nPrice: $4.',
        },
      },
      {
        itemKey: '00000000-0000-4000-8000-000000000003',
        provenance: { contentOrigin: 'AI_GENERATED', sourceName: 'Fictional fixture' },
        value: {
          title: 'Retired Path',
          category: 'Attractions',
          content: 'Retired Path is closed.\nHours: 9am to 5pm daily.',
          isEnabled: false,
        },
      },
    )
  })
  // Contract checks still pass; readiness is reported separately and never relabels the verdict.
  assert.equal(report.passed, true, report.errors.join('\n'))
  assert.deepEqual(
    report.readinessFindings.map((f) => [f.category, f.record]),
    [
      ['hours-season', '/knowledgeEntries/create/1'],
      ['admission-prices', '/knowledgeEntries/create/1'],
    ],
  )
})
test('binding a labeled record to its row clears the readiness finding', async (t) => {
  const { report } = await withPackage(
    t,
    (pkg) => {
      pkg.knowledgeEntries.create.push({
        itemKey: '00000000-0000-4000-8000-000000000002',
        provenance: { contentOrigin: 'AI_GENERATED', sourceName: 'Fictional fixture' },
        value: {
          title: 'Lantern Walk',
          category: 'Attractions',
          content: 'Lantern Walk is a fictional evening path.\nHours: unconfirmed for this season.',
        },
      })
    },
    (c) => {
      c.rows[0].records.push('/knowledgeEntries/create/1/value/content')
    },
  )
  assert.equal(report.passed, true, report.errors.join('\n'))
  assert.deepEqual(report.readinessFindings, [])
})
for (const [content, ok] of [
  ['Hours are not listed or unconfirmed.', true],
  ['The price isn\u2019t posted and is unconfirmed.', true],
  ['No unconfirmed claims appear here.', false],
  ['Parking is available without unconfirmed fees.', false],
]) {
  test(`negation must sit next to unconfirmed: ${content}`, async (t) => {
    const { report } = await withPackage(t, (pkg) => {
      pkg.knowledgeEntries.create[0].value.content = content
    })
    assert.equal(report.passed, ok, report.errors.join('\n'))
  })
}
const labeledRecord = (n, content, extra = {}) => ({
  itemKey: `00000000-0000-4000-8000-00000000001${n}`,
  provenance: {
    contentOrigin: 'AI_GENERATED',
    sourceName: 'Fictional fixture',
    ...extra.provenance,
  },
  value: { title: `Fictional ride ${n}`, category: 'Attractions', content, ...extra.value },
})
test('labeled facts with no coverage row for their category are reported', async (t) => {
  const { report } = await withPackage(t, (pkg) => {
    pkg.knowledgeEntries.create.push(
      labeledRecord(1, 'A fictional train.\nHeight: minimum height unconfirmed'),
    )
  })
  assert.deepEqual(
    report.readinessFindings.map((f) => [f.category, f.record, f.reason]),
    [
      [
        'rider-height-safety',
        '/knowledgeEntries/create/1',
        'labeled record has no coverage row for its category',
      ],
    ],
  )
})
test('labeled findings cover update ops and place hours, and skip connected sources', async (t) => {
  const { report } = await withPackage(t, (pkg) => {
    pkg.knowledgeEntries.update.push({
      id: '10000000-0000-4000-8000-000000000001',
      ...labeledRecord(2, 'An updated fictional path.\nHours: 9am to 5pm daily.'),
    })
    pkg.knowledgeEntries.create.push(
      labeledRecord(3, 'A connected fictional feed.\nHours: 8am to 4pm.', {
        provenance: { sourceType: 'SOURCE_CONNECTION' },
      }),
    )
    pkg.places.create.push({
      itemKey: '00000000-0000-4000-8000-000000000020',
      provenance: { contentOrigin: 'AI_GENERATED', sourceName: 'Fictional fixture' },
      value: { name: 'Fictional Kiosk', type: 'shop', hours: 'Daily 10am to 4pm' },
    })
  })
  assert.deepEqual(
    report.readinessFindings.map((f) => [f.category, f.record]),
    [
      ['hours-season', '/knowledgeEntries/update/0'],
      ['hours-season', '/places/create/0'],
    ],
  )
})
test('an event Hours line bound to the events row is not an hours-season finding', async (t) => {
  const { report } = await withPackage(
    t,
    (pkg) => {
      pkg.knowledgeEntries.create.push(
        labeledRecord(4, 'A fictional lantern night.\nHours: 6pm to 9pm on December 5, 2026.'),
      )
    },
    (c) => {
      c.rows.push({
        category: 'events',
        status: 'KNOWN',
        records: ['/knowledgeEntries/create/1'],
        sources: [{ ...c.rows[5].sources[0] }],
        observedAt: '2026-10-23',
        recheckBy: '2026-11-15',
        publishImpact: 'NONE',
        rationale: 'Fictional dated event row.',
      })
    },
  )
  assert.equal(report.passed, true, report.errors.join('\n'))
  assert.deepEqual(report.readinessFindings, [])
})
