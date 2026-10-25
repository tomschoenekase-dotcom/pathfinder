import test from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeReceipt, evidenceKinds, sha256 } from './venue-acceptance-receipt.mjs'
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
  const binding = save('source.json', { sources: [] })
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
  ].map((category) => ({
    category,
    status: 'NOT_APPLICABLE',
    records: [],
    sources: [],
    observedAt: '2026-10-23',
    recheckBy: '2026-10-26',
    publishImpact: 'NONE',
    rationale: 'Fictional fixture category does not apply.',
  }))
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
        sources: [],
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
    guestLink: { usable: true, url: 'https://example.invalid/guide' },
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
      turnsCompleted: 1,
      criticalFailures: 0,
      results: [
        {
          question: 'Where is the fictional observatory?',
          answer: 'At the fictional address.',
          completed: true,
          criticalFailure: false,
          firstTextMs: 10,
          completionMs: 20,
        },
      ],
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
  const run = () => {
    save('manifest.json', manifest)
    return composeReceipt(resolve(root, 'manifest.json'), { asOf: now })
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
    if (impact === 'NONE') assert.match(result.missingItems.join(), /required success predicates/)
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
