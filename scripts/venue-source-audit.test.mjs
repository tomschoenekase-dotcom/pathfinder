import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, symlink, mkdir, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditSources, main } from './venue-source-audit.mjs'

const fixture = fileURLToPath(new URL('./fixtures/venue-source-audit/', import.meta.url))
// Caller sets TEMP/TMP to the external task allocation. Retain test artifacts for inspection.
async function setup(mutate = () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fictional-source-audit-'))
  await cp(fixture, dir, { recursive: true })
  const ledgerPath = path.join(dir, 'ledger.json')
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  await mutate(ledger, dir)
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2))
  return {
    dir,
    ledger,
    options: { ledgerPath, sourcesDir: path.join(dir, 'sources'), asOf: '2026-10-25' },
  }
}
const capture = () => {
  let stdout = '',
    stderr = ''
  return {
    stdout: {
      write: (value) => {
        stdout += value
      },
    },
    stderr: {
      write: (value) => {
        stderr += value
      },
    },
    output: () => ({ stdout, stderr }),
  }
}
const cli = (options, output) => [
  '--ledger',
  options.ledgerPath,
  '--sources-dir',
  options.sourcesDir,
  '--as-of',
  options.asOf,
  '--output',
  output,
]

test('fictional HTML/PDF and extracted text independently bind exact bytes; repeatable and read-only', async () => {
  const { options } = await setup()
  const before = await readFile(options.ledgerPath)
  const report = await auditSources(options)
  assert.equal(report.passed, true, report.errors.join('\n'))
  assert.equal(report.integrity.status, 'PASS')
  assert.equal(report.freshness.status, 'PASS')
  assert.equal(report.extraction.status, 'NOT_VERIFIED')
  assert.equal(report.semantic.status, 'NOT_VERIFIED')
  assert.equal(report.bindings.sources.length, 4)
  assert.equal(report.bindings.sourcesRoot.toLowerCase(), options.sourcesDir.toLowerCase())
  assert.notEqual(report.bindings.sources[0].sha256, report.bindings.sources[1].sha256)
  assert.deepEqual(await auditSources(options), report)
  assert.deepEqual(await readFile(options.ledgerPath), before)
})

for (const file of ['garden.html', 'garden.txt', 'map.pdf', 'map.txt']) {
  test(`tampered ${file} fails its own target while actual byte binding changes`, async () => {
    const { options } = await setup()
    const before = await auditSources(options)
    await writeFile(path.join(options.sourcesDir, file), 'tampered fictional bytes')
    const after = await auditSources(options)
    assert.equal(after.integrity.status, 'FAIL')
    assert.match(after.errors.join('\n'), /HASH_MISMATCH/)
    const changed = after.bindings.sources.find((entry) => path.basename(entry.file) === file)
    assert.notEqual(
      changed.sha256,
      before.bindings.sources.find((entry) => path.basename(entry.file) === file).sha256,
    )
  })
}
const invalidIntegrity = [
  [
    'missing ID',
    (l) => {
      delete l.sources[0].sourceId
    },
    /SOURCE_ID_INVALID/,
  ],
  [
    'duplicate ID',
    (l) => {
      l.sources[1].sourceId = l.sources[0].sourceId
    },
    /SOURCE_ID_DUPLICATE/,
  ],
  [
    'case-fold ID collision',
    (l) => {
      l.sources[1].sourceId = l.sources[0].sourceId.toLowerCase()
    },
    /SOURCE_ID_DUPLICATE/,
  ],
  [
    'device ID',
    (l) => {
      l.sources[0].sourceId = 'CON'
    },
    /SOURCE_ID_INVALID/,
  ],
  [
    'legacy unsupported ledger',
    (l) => {
      delete l.schemaVersion
      l.sources = [{ sourceId: 'S001' }]
    },
    /SCHEMA_INVALID.*|HASH_TARGET_MISSING/s,
  ],
  [
    'empty source set',
    (l) => {
      l.sources = []
    },
    /SOURCES_EMPTY/,
  ],
  [
    'unknown top-level field',
    (l) => {
      l.freshness = { status: 'STALE' }
    },
    /SCHEMA_INVALID/,
  ],
  [
    'unknown explicit recheck flag',
    (l) => {
      l.sources[0].recheckRequired = true
    },
    /SOURCE_FIELDS_UNSUPPORTED/,
  ],
  [
    'unknown stale structure',
    (l) => {
      l.sources[0].freshness = { status: 'STALE' }
    },
    /SOURCE_FIELDS_UNSUPPORTED/,
  ],
  [
    'unknown expiry',
    (l) => {
      l.sources[0].expiresAt = '2026-10-01'
    },
    /SOURCE_FIELDS_UNSUPPORTED/,
  ],
  [
    'missing target',
    (l) => {
      delete l.sources[0].raw
      delete l.sources[0].text
    },
    /HASH_TARGET_MISSING/,
  ],
  [
    'missing retained file',
    (l) => {
      l.sources[0].raw.file = 'missing.html'
    },
    /RETAINED_FILE_UNAVAILABLE/,
  ],
  [
    'wrong hash target',
    (l) => {
      l.sources[0].raw.sha256 = l.sources[0].text.sha256
    },
    /HASH_MISMATCH/,
  ],
  [
    'missing extracted hash',
    (l) => {
      delete l.sources[0].text.sha256
    },
    /HASH_TARGET_INVALID/,
  ],
  [
    'ambiguous hash declaration',
    (l) => {
      l.sources[0].sha256 = l.sources[0].raw.sha256
    },
    /HASH_DECLARATION_UNSUPPORTED/,
  ],
  [
    'same file for raw/text',
    (l) => {
      l.sources[0].text = { ...l.sources[0].raw }
    },
    /RETAINED_FILE_COLLISION/,
  ],
  ...[
    '../outside.txt',
    'C:/outside.txt',
    '//server/share.txt',
    'garden.txt:ads',
    'NUL',
    'a\\b.txt',
    './garden.txt',
    'a/../garden.txt',
    'garden.txt ',
  ].map((file) => [
    `unsafe retained path ${file}`,
    (l) => {
      l.sources[0].text.file = file
    },
    /HASH_TARGET_INVALID/,
  ]),
]
for (const [name, mutate, pattern] of invalidIntegrity) {
  test(name, async () => {
    const { options } = await setup(mutate)
    const report = await auditSources(options)
    assert.equal(report.passed, false)
    assert.equal(report.integrity.status, 'FAIL')
    assert.match(report.errors.join('\n'), pattern)
  })
}
const invalidFreshness = [
  [
    'malformed observation',
    (s) => {
      s.observedAt = '2026-02-30'
    },
    /OBSERVATION_INVALID/,
  ],
  [
    'missing observation',
    (s) => {
      delete s.observedAt
    },
    /OBSERVATION_INVALID/,
  ],
  [
    'invalid instant',
    (s) => {
      s.observedAt = '2026-02-30T12:00:00Z'
    },
    /OBSERVATION_INVALID/,
  ],
  [
    'non-UTC observation',
    (s) => {
      s.observedAt = '2026-10-24T12:00:00-05:00'
    },
    /OBSERVATION_INVALID/,
  ],
  [
    'future observation day',
    (s) => {
      s.observedAt = '2026-10-26'
    },
    /OBSERVATION_FUTURE/,
  ],
  [
    'future observation instant',
    (s) => {
      s.observedAt = '2026-10-26T00:00:00Z'
    },
    /OBSERVATION_FUTURE/,
  ],
  [
    'explicit stale',
    (s) => {
      s.stale = true
    },
    /RECHECK_REQUIRED/,
  ],
  [
    'explicit recheck',
    (s) => {
      s.needsRecheck = true
    },
    /RECHECK_REQUIRED/,
  ],
  [
    'invalid freshness flag',
    (s) => {
      s.stale = 'false'
    },
    /FRESHNESS_FLAG_INVALID/,
  ],
  [
    'malformed recheck',
    (s) => {
      s.recheckBy = '2026-13-01'
    },
    /RECHECK_DATE_INVALID/,
  ],
  [
    'overdue recheck',
    (s) => {
      s.recheckBy = '2026-10-24'
    },
    /RECHECK_OVERDUE/,
  ],
  [
    'recheck before observation',
    (s) => {
      s.recheckBy = '2026-10-23'
    },
    /RECHECK_BEFORE_OBSERVATION/,
  ],
  [
    'instant deadline expired during as-of day',
    (s) => {
      s.recheckBy = '2026-10-25T12:00:00Z'
    },
    /RECHECK_OVERDUE/,
  ],
]
for (const [name, mutate, pattern] of invalidFreshness) {
  test(name, async () => {
    const { options } = await setup((ledger) => mutate(ledger.sources[0]))
    const report = await auditSources(options)
    assert.equal(report.integrity.status, 'PASS')
    assert.equal(report.freshness.status, 'FAIL')
    assert.equal(report.passed, false)
    assert.match(report.errors.join('\n'), pattern)
  })
}
test('same-day date/instant observations and date deadline are inclusive UTC', async () => {
  const { options } = await setup((ledger) => {
    ledger.sources[0].observedAt = '2026-10-25T23:59:59.999Z'
    ledger.sources[1].observedAt = '2026-10-25'
    ledger.sources.forEach((source) => {
      source.recheckBy = '2026-10-25'
    })
  })
  assert.equal((await auditSources(options)).passed, true)
})
test('missing freshness condition is NOT_VERIFIED; false flags do not establish freshness', async () => {
  const { options } = await setup((ledger) => {
    delete ledger.sources[0].recheckBy
    ledger.sources[0].stale = false
  })
  const report = await auditSources(options)
  assert.equal(report.integrity.status, 'PASS')
  assert.equal(report.freshness.status, 'NOT_VERIFIED')
  assert.equal(report.passed, false)
})
test('text-only declaration is auditable but never establishes raw provenance or extraction', async () => {
  const { options } = await setup((ledger) => {
    delete ledger.sources[0].raw
  })
  const report = await auditSources(options)
  assert.equal(report.passed, true)
  assert.equal(report.extraction.status, 'NOT_VERIFIED')
  assert.equal(report.bindings.sources.filter((source) => source.sourceId === 'SHTML').length, 1)
})
test('escaped symlink file and directory are rejected before their bytes are bound', async () => {
  const { dir, options } = await setup((ledger) => {
    ledger.sources[0].raw.file = 'link/garden.html'
  })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'fictional-audit-outside-'))
  await writeFile(path.join(outside, 'garden.html'), 'outside must not be read')
  await symlink(outside, path.join(dir, 'sources', 'link'), 'junction')
  const report = await auditSources(options)
  assert.match(report.errors.join('\n'), /PATH_ESCAPE/)
  assert.equal(
    report.bindings.sources.some(
      (source) => source.target === 'raw' && source.sourceId === 'SHTML',
    ),
    false,
  )
})
test('safe CLI rerun refuses existing report, retains exact output and inputs', async () => {
  const { dir, options } = await setup()
  const output = path.join(dir, 'audit.json')
  const io = capture()
  assert.equal(await main(cli(options, output), io), 0)
  const bytes = await readFile(output)
  assert.equal(await main(cli(options, output), io), 2)
  assert.deepEqual(await readFile(output), bytes)
  assert.match(io.output().stderr, /EEXIST/)
})
test('hardlinked raw/text paths are a retained-file collision', async () => {
  const { options } = await setup(async (ledger, dir) => {
    await link(path.join(dir, 'sources', 'garden.html'), path.join(dir, 'sources', 'alias.txt'))
    ledger.sources[0].text = { ...ledger.sources[0].raw, file: 'alias.txt' }
  })
  const report = await auditSources(options)
  assert.equal(report.integrity.status, 'FAIL')
  assert.match(report.errors.join('\n'), /RETAINED_FILE_COLLISION.*hardlinks/)
})
test('CLI returns 1 and retains failed audit; malformed input returns 2 without report', async () => {
  const { dir, options } = await setup((ledger) => {
    ledger.sources[0].stale = true
  })
  assert.equal(await main(cli(options, path.join(dir, 'failed.json')), capture()), 1)
  await writeFile(options.ledgerPath, '{broken')
  assert.equal(await main(cli(options, path.join(dir, 'malformed.json')), capture()), 2)
  await assert.rejects(readFile(path.join(dir, 'malformed.json')), { code: 'ENOENT' })
})
test('CLI refuses source input output, source root, dangling output symlink, and output ancestor alias', async () => {
  const { dir, options } = await setup()
  assert.equal(await main(cli(options, options.ledgerPath), capture()), 2)
  assert.equal(await main(cli(options, options.sourcesDir), capture()), 2)
  assert.equal(await main(cli(options, path.join(options.sourcesDir, 'report.json')), capture()), 2)
  const actual = path.join(dir, 'reports')
  await mkdir(actual)
  const alias = path.join(dir, 'report-alias')
  await symlink(actual, alias, 'junction')
  assert.equal(await main(cli(options, path.join(alias, 'report.json')), capture()), 2)
  // Junction creation does not require Windows developer mode, unlike file symlinks.
  const occupied = path.join(dir, 'occupied.json')
  await symlink(path.join(dir, 'nonexistent-target'), occupied, 'junction')
  assert.equal(await main(cli(options, occupied), capture()), 2)
})
test('invalid as-of and duplicate/unknown CLI arguments fail closed', async () => {
  const { dir, options } = await setup()
  await assert.rejects(auditSources({ ...options, asOf: '2026-02-30' }), /real YYYY-MM-DD/)
  for (const extra of [['--as-of', '2026-10-25'], ['--unknown', 'value'], ['--output']]) {
    assert.equal(
      await main([...cli(options, path.join(dir, 'unused.json')), ...extra], capture()),
      2,
    )
  }
})
