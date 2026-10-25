import test from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MIN_VISITOR_QA_TURNS,
  composeReceipt,
  evidenceKinds,
  sha256,
} from './venue-acceptance-receipt.mjs'
import { checkerVersion } from './venue-coverage/check.mjs'
const checkerBinding = await checkerVersion()
const qa = resolve(dirname(fileURLToPath(import.meta.url)), '../../qa/S5')
mkdirSync(qa, { recursive: true })
const now = '2026-10-25T12:00:00Z'
const nativeChild = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('./venue-guide-preview.mjs', import.meta.url)),
    '--package',
    fileURLToPath(new URL('./fixtures/venue-acceptance/package.json', import.meta.url)),
    '--as-of',
    now.slice(0, 10),
  ],
  { encoding: 'utf8', timeout: 40_000, windowsHide: true },
)
assert.equal(nativeChild.status, 0, nativeChild.stderr)
const nativePreview = JSON.parse(nativeChild.stdout)

function fixture() {
  const root = mkdtempSync(resolve(qa, 'fixture-'))
  const save = (name, data) => {
    const path = resolve(root, name)
    writeFileSync(path, JSON.stringify(data))
    return { file: path, sha256: sha256(readFileSync(path)) }
  }
  const pkg = JSON.parse(
    readFileSync(new URL('./fixtures/venue-acceptance/package.json', import.meta.url)),
  )
  const packageFile = save('package.json', pkg)
  const revision = 'a'.repeat(40)
  mkdirSync(resolve(root, 'sources'))
  const binding = save('source.json', { sources: [{ sourceId: 'fictional-source' }] })
  const sourceText = 'The fictional observatory opens at nine and the desk answers questions.'
  const sourceFile = resolve(root, 'sources', 'fictional-source.txt')
  writeFileSync(sourceFile, sourceText)
  const sourceBinding = {
    sourceId: 'fictional-source',
    file: realpathSync.native(sourceFile),
    sha256: sha256(readFileSync(sourceFile)),
  }
  const coreCategories = ['hours-season', 'admission-prices', 'address-parking', 'contact']
  const rows = [
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
  ].map((category) =>
    coreCategories.includes(category)
      ? {
          category,
          status: 'KNOWN',
          records: ['/knowledgeEntries/create/0'],
          sources: [
            { sourceId: 'fictional-source', start: 0, end: 30, text: sourceText.slice(0, 30) },
          ],
          observedAt: '2026-10-23',
          recheckBy: '2026-10-26',
          publishImpact: 'NONE',
          rationale: 'Fictional fixture row backed by the fictional source.',
        }
      : {
          category,
          status: 'NOT_APPLICABLE',
          records: [],
          sources: [],
          observedAt: '2026-10-23',
          recheckBy: '2026-10-26',
          publishImpact: 'NONE',
          rationale: 'Fictional fixture category does not apply.',
        },
  )
  const coverageInput = save('coverage-input.json', {
    schemaVersion: 1,
    profile: 'other',
    rows,
  })
  const data = {
    coverage: {
      passed: true,
      verdict: 'PASS',
      asOf: '2026-10-25',
      errors: [],
      rows,
      bindings: {
        package: packageFile,
        ledger: binding,
        coverage: coverageInput,
        sources: [sourceBinding],
        sourcesRoot: realpathSync.native(resolve(root, 'sources')),
        checker: structuredClone(checkerBinding),
      },
    },
    checkPackage: {
      ready: true,
      importable: true,
      errorCount: 0,
      errors: [],
      guideQuality: { total: 0 },
      otherWarnings: [],
      venueId: 'fictional-venue',
    },
    import: {
      operationId: 'fictional-operation',
      status: 'APPLIED',
      receipt: {
        status: 'APPLIED',
        operationId: 'fictional-operation',
        packageSha256: packageFile.sha256,
        tenantId: 'fictional-tenant',
        venueId: 'fictional-venue',
      },
    },
    guestLink: {
      usable: true,
      url: 'https://example.invalid/guide',
      venueId: 'fictional-venue',
    },
    embeddings: { mode: 'audit', actionableReasons: [], recordsAudited: 1 },
    guidePreview: { ...structuredClone(nativePreview), packageSha256: packageFile.sha256 },
    servingRoute: {
      guideStrategy: 'default',
      modelKey: 'fictional-model',
      effectiveModelKey: 'fictional-model',
      workloadOverride: null,
      venueScopeExceptions: [],
      deployedRevision: revision,
    },
    visitorQa: {
      route: 'guest',
      routeVerified: true,
      turnsCompleted: MIN_VISITOR_QA_TURNS,
      criticalFailures: 0,
      questionSet: { file: 'fictional-questions.json', sha256: 'c'.repeat(64) },
      results: Array.from({ length: MIN_VISITOR_QA_TURNS }, (_, i) => ({
        question: `Fictional visitor question number ${i + 1}?`,
        answer: 'At the fictional address.',
        completed: true,
        criticalFailure: false,
        firstTextMs: 10,
        completionMs: 20,
      })),
    },
    phoneCheck: {
      rendered: true,
      passed: true,
      viewport: '390x844',
      checkedBy: 'fictional-reviewer',
    },
  }
  const manifest = {
    schemaVersion: 1,
    tenantId: 'fictional-tenant',
    venueId: 'fictional-venue',
    package: packageFile.file,
    evidence: {},
  }
  const envelopes = {}
  for (const kind of evidenceKinds) {
    envelopes[kind] = {
      schemaVersion: 1,
      kind,
      tenantId: manifest.tenantId,
      venueId: manifest.venueId,
      packageSha256: packageFile.sha256,
      measuredAt: '2026-10-25T11:00:00Z',
      expiresAt: '2026-10-26T00:00:00Z',
      environment: 'hosted',
      deployedRevision: revision,
      data: data[kind],
    }
    manifest.evidence[kind] = save(`${kind}.json`, envelopes[kind])
  }
  const run = (options = {}) => {
    save('manifest.json', manifest)
    return composeReceipt(resolve(root, 'manifest.json'), { asOf: now, now, ...options })
  }
  return {
    root,
    manifest,
    envelopes,
    save,
    run,
    change(kind, mutate) {
      mutate(envelopes[kind])
      manifest.evidence[kind] = save(`${kind}.json`, envelopes[kind])
    },
  }
}
test('complete typed, bound evidence yields a candidate without publication authority', () => {
  const result = fixture().run()
  assert.equal(result.verdict, 'PUBLISH_CANDIDATE')
  assert.equal(Object.hasOwn(result, 'accuracy'), false)
})
for (const kind of evidenceKinds) {
  test(`missing ${kind} fails closed`, () => {
    const f = fixture()
    delete f.manifest.evidence[kind]
    assert.equal(f.run().verdict, 'NOT_READY')
  })
  test(`generic pass for ${kind} fails closed`, () => {
    const f = fixture()
    f.change(kind, (e) => {
      e.data = { pass: true }
    })
    assert.equal(f.run().verdict, 'NOT_READY')
  })
}
test('modified evidence without refreshed manifest hash is rejected', () => {
  const f = fixture()
  f.save('import.json', { pass: true })
  assert.match(f.run().missingItems.join(), /sha256 mismatch/)
})
for (const [name, mutation] of [
  [
    'wrong package',
    (e) => {
      e.packageSha256 = 'b'.repeat(64)
    },
  ],
  [
    'wrong venue',
    (e) => {
      e.venueId = 'another-fictional-venue'
    },
  ],
  [
    'stale',
    (e) => {
      e.expiresAt = '2026-10-24T12:00:00Z'
    },
  ],
  [
    'future',
    (e) => {
      e.measuredAt = '2026-10-26T12:00:00Z'
    },
  ],
  [
    'local only',
    (e) => {
      e.environment = 'local'
    },
  ],
  [
    'wrong deployment',
    (e) => {
      e.deployedRevision = 'b'.repeat(40)
    },
  ],
  [
    'before import',
    (e) => {
      e.measuredAt = '2026-10-25T10:00:00Z'
    },
  ],
])
  test(`${name} cannot pass`, () => {
    const f = fixture()
    f.change('visitorQa', mutation)
    assert.equal(f.run().verdict, 'NOT_READY')
  })
test('coverage BLOCKS cannot pass', () => {
  const f = fixture()
  f.change('coverage', (e) => {
    e.data.rows[0].publishImpact = 'BLOCKS'
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})
test('coverage input bytes are rehashed', () => {
  const f = fixture()
  f.save('source.json', { changed: true })
  assert.match(f.run().missingItems.join(), /coverage input binding mismatch/)
})
test('applied receipt must bind operation and package', () => {
  const f = fixture()
  f.change('import', (e) => {
    e.data.receipt.operationId = 'other'
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})
test('critical QA failure blocks', () => {
  const f = fixture()
  f.change('visitorQa', (e) => {
    e.data.results[0].criticalFailure = true
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})
test('actionable embedding reasons block', () => {
  const f = fixture()
  f.change('embeddings', (e) => {
    e.data.actionableReasons = ['stale']
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})

test('coverage cannot omit a bound row or invent PASS over invalid input', () => {
  const f = fixture()
  f.change('coverage', (e) => {
    e.data.rows = e.data.rows.slice(1)
  })
  assert.equal(f.run().verdict, 'NOT_READY')
  const g = fixture()
  const artifact = g.save('coverage-input.json', {
    schemaVersion: 1,
    profile: 'other',
    rows: [],
  })
  g.change('coverage', (e) => {
    e.data.rows = []
    e.data.bindings.coverage = artifact
  })
  assert.equal(g.run().verdict, 'NOT_READY')
})
for (const status of ['NEEDS_HUMAN', 'CONFLICTED'])
  test(`${status} blocks even with NONE impact`, () => {
    const f = fixture()
    const e = f.envelopes.coverage
    e.data.rows[0].status = status
    e.data.rows[0].humanDecision = 'Which fictional policy applies?'
    e.data.bindings.coverage = f.save('coverage-input.json', {
      schemaVersion: 1,
      profile: 'other',
      rows: e.data.rows,
    })
    f.change('coverage', () => {})
    assert.equal(f.run().verdict, 'NOT_READY')
  })
test('calendar rollover timestamp is rejected', () => {
  const f = fixture()
  f.change('phoneCheck', (e) => {
    e.measuredAt = '2026-02-30T00:00:00Z'
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})
test('equal instants with different UTC precision preserve chronological order', () => {
  const f = fixture()
  f.change('phoneCheck', (e) => {
    e.measuredAt = '2026-10-25T11:00:00.000Z'
  })
  assert.equal(f.run().verdict, 'PUBLISH_CANDIDATE')
})
for (const impact of ['NONE', 'DISCLOSE'])
  test(`native valid UNKNOWN/${impact} requires guest disclosure to be a candidate`, () => {
    const f = fixture()
    f.change('coverage', (e) => {
      e.data.rows[0].status = 'UNKNOWN'
      e.data.rows[0].publishImpact = impact
      e.data.rows[0].records = ['/knowledgeEntries/create/0/value/content']
      e.data.bindings.coverage = f.save('coverage-input.json', {
        schemaVersion: 1,
        profile: 'other',
        rows: e.data.rows,
      })
    })
    const result = f.run()
    assert.equal(result.verdict, impact === 'DISCLOSE' ? 'PUBLISH_CANDIDATE' : 'NOT_READY')
    if (impact === 'NONE')
      assert.match(result.missingItems.join(), /required success predicates|coverage/)
  })

for (const [status, impact] of [
  ['UNKNOWN', 'BLOCKS'],
  ['CONFLICTED', 'NONE'],
  ['NEEDS_HUMAN', 'DISCLOSE'],
  ['UNKNOWN', 'NONE'],
])
  test(`valid measured coverage with ${status}/${impact} retains negative evidence`, () => {
    const f = fixture()
    f.change('coverage', (e) => {
      const row = e.data.rows[0]
      row.status = status
      row.publishImpact = impact
      row.records = ['/knowledgeEntries/create/0/value/content']
      if (['CONFLICTED', 'NEEDS_HUMAN'].includes(status))
        row.humanDecision = 'Which fictional hours are confirmed?'
      e.data.bindings.coverage = f.save('coverage-input.json', {
        schemaVersion: 1,
        profile: 'other',
        rows: e.data.rows,
      })
    })
    const result = f.run()
    const field = result.fields.coverage
    assert.equal(result.verdict, 'NOT_READY')
    // A checker that rejects status/impact disagreement (NONE) leaves the field NOT_MEASURED.
    if (impact === 'NONE' && field.status === 'NOT_MEASURED') return
    assert.equal(field.status, 'MEASURED')
    assert.equal(field.readinessPassed, false)
    assert.ok(field.failureReason)
    assert.equal(field.file, f.manifest.evidence.coverage.file)
    assert.equal(field.sha256, f.manifest.evidence.coverage.sha256)
    assert.equal(field.timestamp, f.envelopes.coverage.measuredAt)
  })
test('missing, stale and hash-invalid coverage are not measured', () => {
  for (const failure of ['missing', 'stale', 'hash']) {
    const f = fixture()
    if (failure === 'missing') delete f.manifest.evidence.coverage
    else if (failure === 'stale')
      f.change('coverage', (e) => {
        e.expiresAt = '2026-10-24T00:00:00Z'
      })
    else f.save('coverage.json', { invalid: true })
    const result = f.run()
    assert.equal(result.fields.coverage.status, 'NOT_MEASURED')
    assert.equal(result.verdict, 'NOT_READY')
  }
})

for (const [name, mutate] of [
  [
    'stale report day',
    (d) => {
      d.asOf = '2026-10-24'
    },
  ],
  [
    'inconsistent saved verdict',
    (d) => {
      d.verdict = 'FAIL'
    },
  ],
  [
    'inconsistent saved errors',
    (d) => {
      d.errors = ['invented error']
    },
  ],
  [
    'inconsistent saved passed',
    (d) => {
      d.passed = false
    },
  ],
])
  test(`invalid coverage metadata: ${name} stays NOT_MEASURED`, () => {
    const f = fixture()
    f.change('coverage', (e) => mutate(e.data))
    const result = f.run()
    assert.equal(result.fields.coverage.status, 'NOT_MEASURED')
    assert.equal(result.verdict, 'NOT_READY')
    assert.match(result.fields.coverage.reason, /metadata/)
  })

for (const [name, mutate] of [
  [
    'stale rendering day',
    (d) => {
      d.asOf = '2020-01-01'
    },
  ],
  [
    'future rendering day',
    (d) => {
      d.asOf = '2099-01-01'
    },
  ],
  [
    'missing rendering day',
    (d) => {
      delete d.asOf
    },
  ],
  [
    'impossible FULL size',
    (d) => {
      d.default.renderedChars = 999999
    },
  ],
  [
    'impossible evidence mode',
    (d) => {
      d.evidence.mode = 'FULL'
    },
  ],
  [
    'incorrect full-guide size',
    (d) => {
      d.default.fullGuideRenderedChars += 1
    },
  ],
  [
    'invented record count',
    (d) => {
      d.counts.knowledge += 1
    },
  ],
  [
    'omitted authority assumptions',
    (d) => {
      d.assumptions = []
    },
  ],
])
  test(`native preview rejects ${name}`, () => {
    const f = fixture()
    f.change('guidePreview', (e) => mutate(e.data))
    const result = f.run()
    assert.equal(result.verdict, 'NOT_READY')
    assert.equal(result.fields.guidePreview.status, 'NOT_MEASURED')
    assert.match(result.fields.guidePreview.reason, /as-of day|native recomputation/)
  })

test('native preview is recomputed after package changes despite refreshed attestation hashes', () => {
  const f = fixture()
  const pkg = JSON.parse(readFileSync(f.manifest.package, 'utf8'))
  pkg.knowledgeEntries.create[0].value.content +=
    ' Additional fictional visitor guidance changes rendered length.'
  const updated = f.save('package.json', pkg)
  for (const kind of evidenceKinds)
    f.change(kind, (e) => {
      e.packageSha256 = updated.sha256
      if (kind === 'coverage') e.data.bindings.package = updated
      if (kind === 'guidePreview') e.data.packageSha256 = updated.sha256
      if (kind === 'import') e.data.receipt.packageSha256 = updated.sha256
    })
  const result = f.run()
  assert.equal(result.verdict, 'NOT_READY')
  assert.match(result.fields.guidePreview.reason, /native recomputation/)
})

// ---- Hardening regressions (M1-M4, m1, guestLink) ----
const rebindCoverage = (f, mutateRows) =>
  f.change('coverage', (e) => {
    mutateRows(e.data.rows)
    e.data.bindings.coverage = f.save('coverage-input.json', {
      schemaVersion: 1,
      profile: 'other',
      rows: e.data.rows,
    })
  })
const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString()
const addMinutes = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString()
const realChecker = new URL('./venue-coverage/check.mjs', import.meta.url).href
// Test seam: a wrapper checker module so the composer's recomputation can be varied.
const stubChecker = (f, body) => {
  const file = resolve(f.root, 'stub-checker.mjs')
  writeFileSync(
    file,
    `import { checkCoverage as real } from ${JSON.stringify(realChecker)}\nexport const checkCoverage = async (a) => { const r = await real(a); return ${body} }\n`,
  )
  return pathToFileURL(file).href
}

for (const category of ['hours-season', 'admission-prices', 'address-parking', 'contact'])
  test(`core category ${category} marked NOT_APPLICABLE is not coverage-ready`, () => {
    const f = fixture()
    rebindCoverage(f, (rows) => {
      const row = rows.find((r) => r.category === category)
      row.status = 'NOT_APPLICABLE'
      row.records = []
      row.sources = []
      row.rationale = 'Fictional claim that this core category does not apply here.'
    })
    const result = f.run()
    assert.equal(result.verdict, 'NOT_READY')
    const field = result.fields.coverage
    // Either the coverage checker rejects it (NOT_MEASURED) or the composer marks it not ready.
    if (field.status === 'MEASURED') {
      assert.equal(field.readinessPassed, false)
      assert.match(field.failureReason, /NOT_APPLICABLE/)
    } else assert.equal(field.status, 'NOT_MEASURED')
  })

test('composer independently rejects core NOT_APPLICABLE even when the checker accepts it', () => {
  const f = fixture()
  const coverageCheckerUrl = stubChecker(f, "{ ...r, passed: true, verdict: 'PASS', errors: [] }")
  rebindCoverage(f, (rows) => {
    const row = rows.find((r) => r.category === 'contact')
    row.status = 'NOT_APPLICABLE'
    row.records = []
    row.sources = []
  })
  const result = f.run({ coverageCheckerUrl })
  assert.equal(result.verdict, 'NOT_READY')
  assert.equal(result.fields.coverage.status, 'MEASURED')
  assert.equal(result.fields.coverage.readinessPassed, false)
  assert.match(result.fields.coverage.failureReason, /NOT_APPLICABLE/)
})

for (const [name, findings, ready] of [
  ['non-empty readinessFindings', [{ category: 'hours-season', reason: 'unbound label' }], false],
  ['malformed readinessFindings', 'oops', false],
  ['empty readinessFindings', [], true],
])
  test(`recomputed ${name} ${ready ? 'keep' : 'block'} coverage readiness`, () => {
    const f = fixture()
    const coverageCheckerUrl = stubChecker(
      f,
      `{ ...r, readinessFindings: ${JSON.stringify(findings)} }`,
    )
    const result = f.run({ coverageCheckerUrl })
    assert.equal(result.verdict, ready ? 'PUBLISH_CANDIDATE' : 'NOT_READY')
    assert.equal(result.fields.coverage.readinessPassed, ready)
    if (!ready) assert.match(result.fields.coverage.failureReason, /readinessFindings/)
  })

test('a saved report claiming empty readinessFindings does not override the recomputed ones', () => {
  const f = fixture()
  const coverageCheckerUrl = stubChecker(f, "{ ...r, readinessFindings: ['x'] }")
  f.change('coverage', (e) => {
    e.data.readinessFindings = []
  })
  assert.equal(f.run({ coverageCheckerUrl }).verdict, 'NOT_READY')
})

test('visitorQa requires the minimum number of completed turns', () => {
  const f = fixture()
  f.change('visitorQa', (e) => {
    e.data.results = e.data.results.slice(0, MIN_VISITOR_QA_TURNS - 1)
    e.data.turnsCompleted = e.data.results.length
  })
  const result = f.run()
  assert.equal(result.verdict, 'NOT_READY')
  assert.equal(result.fields.visitorQa.status, 'NOT_MEASURED')
})
test('visitorQa rejects the one trivial turn from the review', () => {
  const f = fixture()
  f.change('visitorQa', (e) => {
    e.data.turnsCompleted = 1
    e.data.results = [
      {
        question: 'x',
        answer: 'y',
        completed: true,
        criticalFailure: false,
        firstTextMs: 0,
        completionMs: 0,
      },
    ]
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})
test('visitorQa rejects duplicate question text', () => {
  const f = fixture()
  f.change('visitorQa', (e) => {
    e.data.results[1].question = `  ${e.data.results[0].question.toUpperCase()} `
  })
  const result = f.run()
  assert.equal(result.verdict, 'NOT_READY')
  assert.equal(result.fields.visitorQa.status, 'NOT_MEASURED')
})
test('visitorQa rejects firstTextMs of zero', () => {
  const f = fixture()
  f.change('visitorQa', (e) => {
    e.data.results[3].firstTextMs = 0
    e.data.results[3].completionMs = 0
  })
  assert.equal(f.run().verdict, 'NOT_READY')
})
for (const [name, mutate] of [
  ['missing', (d) => delete d.questionSet],
  ['non-hex digest', (d) => (d.questionSet.sha256 = 'z'.repeat(64))],
  ['short digest', (d) => (d.questionSet.sha256 = 'c'.repeat(63))],
  ['missing file', (d) => (d.questionSet.file = '')],
])
  test(`visitorQa questionSet ${name} fails closed`, () => {
    const f = fixture()
    f.change('visitorQa', (e) => mutate(e.data))
    assert.equal(f.run().verdict, 'NOT_READY')
  })

test('hosted evidence window longer than 14 days is NOT_MEASURED; exactly 14 days passes', () => {
  const f = fixture()
  f.change('import', (e) => {
    e.expiresAt = addDays(e.measuredAt, 14)
  })
  f.change('visitorQa', (e) => {
    e.expiresAt = addDays(e.measuredAt, 14)
  })
  assert.equal(f.run().verdict, 'PUBLISH_CANDIDATE')
  f.change('visitorQa', (e) => {
    e.expiresAt = addDays(e.measuredAt, 15)
  })
  const result = f.run()
  assert.equal(result.verdict, 'NOT_READY')
  assert.equal(result.fields.visitorQa.status, 'NOT_MEASURED')
  assert.match(result.fields.visitorQa.reason, /validity window/)
})
for (const kind of ['coverage', 'checkPackage', 'guidePreview'])
  test(`local evidence ${kind} window longer than 7 days is NOT_MEASURED; exactly 7 days passes`, () => {
    const f = fixture()
    f.change(kind, (e) => {
      e.expiresAt = addDays(e.measuredAt, 7)
    })
    assert.equal(f.run().verdict, 'PUBLISH_CANDIDATE')
    f.change(kind, (e) => {
      e.expiresAt = addDays(e.measuredAt, 8)
    })
    const result = f.run()
    assert.equal(result.verdict, 'NOT_READY')
    assert.equal(result.fields[kind].status, 'NOT_MEASURED')
    assert.match(result.fields[kind].reason, /validity window/)
  })

test('asOf more than 60 minutes from the real clock can never be a publish candidate', () => {
  const f = fixture()
  assert.equal(f.run({ now: addMinutes(now, 60) }).verdict, 'PUBLISH_CANDIDATE')
  assert.equal(f.run({ now: addMinutes(now, -60) }).verdict, 'PUBLISH_CANDIDATE')
  for (const skew of [61, -61, 60 * 24 * 30]) {
    const result = f.run({ now: addMinutes(now, skew) })
    assert.equal(result.verdict, 'NOT_READY')
    assert.ok(
      result.missingItems.includes(
        'asOf: historical or future replay cannot produce a publish candidate',
      ),
    )
  }
})
test('replays remain reportable and the receipt records the real compose time', () => {
  const f = fixture()
  const later = addMinutes(now, 600)
  const result = f.run({ now: later })
  assert.equal(result.generatedAt, now)
  assert.equal(result.composedAt, later)
  assert.equal(result.fields.visitorQa.status, 'MEASURED')
})

test('embeddings must audit at least the created knowledge entries plus places', () => {
  const f = fixture()
  const pkg = JSON.parse(readFileSync(f.manifest.package, 'utf8'))
  pkg.knowledgeEntries.create.push({
    ...structuredClone(pkg.knowledgeEntries.create[0]),
    itemKey: '00000000-0000-4000-8000-000000000002',
  })
  pkg.places.create.push({
    itemKey: '00000000-0000-4000-8000-000000000003',
    value: { name: 'Fictional hall', isActive: true },
  })
  const updated = f.save('package.json', pkg)
  for (const kind of evidenceKinds)
    f.change(kind, (e) => {
      e.packageSha256 = updated.sha256
      if (kind === 'coverage') e.data.bindings.package = updated
      if (kind === 'guidePreview') e.data.packageSha256 = updated.sha256
      if (kind === 'import') e.data.receipt.packageSha256 = updated.sha256
      if (kind === 'embeddings') e.data.recordsAudited = 2
    })
  const short = f.run()
  assert.equal(short.fields.embeddings.status, 'NOT_MEASURED')
  assert.match(short.fields.embeddings.reason, /recordsAudited/)
  f.change('embeddings', (e) => {
    e.data.recordsAudited = 3
  })
  assert.equal(f.run().fields.embeddings.readinessPassed, true)
})

test('non-JSON evidence is hashed first and its contents never reach the receipt', () => {
  const f = fixture()
  const secret = 'API_KEY=sk-live-fictional-0000'
  const path = resolve(f.root, 'phoneCheck.json')
  writeFileSync(path, secret)
  // Hash mismatch: reported as a mismatch, not as a parse error.
  let result = f.run()
  assert.match(result.fields.phoneCheck.reason, /sha256 mismatch/)
  // Hash match but not JSON: fixed message only.
  f.manifest.evidence.phoneCheck = { file: path, sha256: sha256(readFileSync(path)) }
  result = f.run()
  assert.equal(result.fields.phoneCheck.reason, 'evidence file is not valid JSON')
  assert.equal(JSON.stringify(result).includes('API_KEY'), false)
  assert.equal(JSON.stringify(result).includes('Unexpected token'), false)
})

test('guestLink must be bound to the venue', () => {
  for (const mutate of [
    (d) => delete d.venueId,
    (d) => (d.venueId = 'another-fictional-venue'),
    (d) => (d.environment = 'local'),
  ]) {
    const f = fixture()
    f.change('guestLink', (e) => mutate(e.data))
    const result = f.run()
    assert.equal(result.verdict, 'NOT_READY')
    assert.equal(result.fields.guestLink.status, 'NOT_MEASURED')
  }
  const f = fixture()
  f.change('guestLink', (e) => delete e.data.venueId)
  assert.match(f.run().fields.guestLink.reason, /not bound to venue/)
})

test('nested declared text.file remains a measured candidate through receipt recomputation', () => {
  const f = fixture()
  const sourceText = 'The fictional observatory opens at nine and the desk answers questions.'
  mkdirSync(resolve(f.root, 'sources', 'nested'))
  const file = resolve(f.root, 'sources', 'nested', 'retained.txt')
  writeFileSync(file, sourceText)
  f.change('coverage', (e) => {
    e.data.bindings.ledger = f.save('source.json', {
      schemaVersion: 1,
      sources: [
        {
          sourceId: 'fictional-source',
          text: { file: 'nested/retained.txt', sha256: sha256(readFileSync(file)) },
        },
      ],
    })
    e.data.bindings.sources[0] = {
      sourceId: 'fictional-source',
      file: realpathSync.native(file),
      sha256: sha256(readFileSync(file)),
    }
  })
  const report = f.run()
  assert.equal(report.fields.coverage.status, 'MEASURED', report.fields.coverage.reason)
  assert.equal(report.fields.coverage.readinessPassed, true)
  assert.equal(report.verdict, 'PUBLISH_CANDIDATE')
})

test('missing or tampered coverage source-root binding fails receipt recomputation', () => {
  for (const variant of ['missing', 'tampered']) {
    const f = fixture()
    f.change('coverage', (e) => {
      if (variant === 'missing') delete e.data.bindings.sourcesRoot
      else e.data.bindings.sourcesRoot = f.root
    })
    const report = f.run()
    assert.equal(report.verdict, 'NOT_READY')
    assert.equal(report.fields.coverage.status, 'NOT_MEASURED')
    assert.match(
      report.fields.coverage.reason,
      variant === 'missing'
        ? /coverage sources root binding missing/
        : /coverage report does not match recomputed inputs/,
    )
  }
})

test('tampered coverage checker binding cannot become a candidate', () => {
  const f = fixture()
  f.change('coverage', (e) => {
    e.data.bindings.checker.gitBlob = '0'.repeat(40)
  })
  const report = f.run()
  assert.equal(report.verdict, 'NOT_READY')
  assert.match(report.fields.coverage.reason, /coverage report does not match recomputed inputs/)
})
