import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeReceipt, evidenceKinds, sha256 } from './venue-acceptance-receipt.mjs'
const qa = resolve(dirname(fileURLToPath(import.meta.url)), '../../qa/S5')
mkdirSync(qa, { recursive: true })
const now = '2026-10-25T12:00:00Z'
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
  const binding = save('source.json', { text: 'Fictional observatory hours' })
  const metrics = {
    mode: 'FULL',
    renderedChars: 50,
    maxFullChars: 120000,
    rendererTruncated: false,
  }
  const data = {
    coverage: {
      passed: true,
      verdict: 'PASS',
      asOf: '2026-10-25',
      errors: [],
      rows: [{ status: 'KNOWN', publishImpact: 'NONE' }],
      bindings: { package: packageFile, ledger: binding, coverage: binding, sources: [binding] },
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
    guidePreview: {
      schemaVersion: 1,
      packageSha256: packageFile.sha256,
      scope: 'CREATE_ONLY_PACKAGE_PREVIEW',
      default: metrics,
      evidence: { ...metrics, mode: 'DIRECTORY' },
    },
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
