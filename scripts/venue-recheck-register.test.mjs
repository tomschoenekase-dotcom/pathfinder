import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRecheckRegister, main } from './venue-recheck-register.mjs'

// Fictional venue only.
const record = (n, title, content) => ({
  itemKey: `00000000-0000-4000-8000-00000000000${n}`,
  provenance: { contentOrigin: 'AI_GENERATED', sourceName: 'Fictional fixture' },
  value: { title, category: 'Attractions', content },
})
const pkg = {
  schemaVersion: 3,
  places: { create: [], update: [], delete: [] },
  knowledgeEntries: {
    create: [
      record(1, 'Moonbeam hours', 'Moonbeam Garden hours.\nHours: 9am to 5pm daily.'),
      record(2, 'Lantern Walk', 'Lantern Walk is an evening path.\nHours: 6pm to 9pm Friday.'),
      record(3, 'Gift shop', 'The gift shop sells postcards.\nPrice: $2 per postcard.'),
      record(4, 'Contact', 'Call the fictional desk at 555-0100.'),
    ],
    update: [],
    delete: [],
  },
}
const coverage = {
  schemaVersion: 1,
  profile: 'garden',
  rows: [
    {
      category: 'hours-season',
      status: 'KNOWN',
      records: ['/knowledgeEntries/create/0/value/content'],
      recheckBy: '2026-11-01',
    },
    {
      category: 'admission-prices',
      status: 'KNOWN',
      records: ['/knowledgeEntries/create/2'],
      recheckBy: '2026-10-20',
    },
    { category: 'contact', status: 'KNOWN', records: ['/knowledgeEntries/create/3'] },
  ],
}

test('register keys records by itemKey with the earliest governing deadline', () => {
  const register = buildRecheckRegister(pkg, coverage, '2026-10-25')
  const byTitle = Object.fromEntries(register.rows.map((row) => [row.title, row]))
  assert.equal(byTitle['Moonbeam hours'].state, 'CURRENT')
  assert.equal(byTitle['Moonbeam hours'].daysLeft, 7)
  assert.equal(byTitle['Moonbeam hours'].itemKey, '00000000-0000-4000-8000-000000000001')
  assert.equal(byTitle['Gift shop'].state, 'OVERDUE')
  assert.equal(byTitle['Contact'].state, 'NO_DEADLINE')
  // A copied Hours line outside the hours row has no deadline anyone will recheck.
  assert.equal(byTitle['Lantern Walk'].state, 'UNBOUND_LABELED_FACT')
  assert.deepEqual(byTitle['Lantern Walk'].unboundCategories, ['hours-season'])
  assert.deepEqual(register.summary, {
    records: 4,
    overdue: 1,
    unboundLabeledFacts: 1,
    noDeadline: 1,
    current: 1,
  })
})

test('deadline equal to as-of is still current; the next day is overdue', () => {
  const tight = structuredClone(coverage)
  tight.rows[0].recheckBy = '2026-10-25'
  assert.equal(buildRecheckRegister(pkg, tight, '2026-10-25').rows[0].state, 'CURRENT')
  assert.equal(buildRecheckRegister(pkg, tight, '2026-10-26').rows[0].state, 'OVERDUE')
})

test('invalid as-of dates fail closed', () => {
  for (const asOf of ['2026-02-30', '2026-10-25T00:00:00Z', ''])
    assert.throws(() => buildRecheckRegister(pkg, coverage, asOf))
})

test('CLI binds input hashes, never overwrites inputs and exits non-zero on overdue facts', async (t) => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? os.tmpdir(), 'recheck-register-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const packagePath = path.join(dir, 'package.json')
  const coveragePath = path.join(dir, 'coverage.json')
  await writeFile(packagePath, JSON.stringify(pkg))
  await writeFile(coveragePath, JSON.stringify(coverage))
  const output = path.join(dir, 'register.json')
  const args = ['--package', packagePath, '--coverage', coveragePath, '--as-of', '2026-10-25']
  assert.equal(await main([...args, '--output', output]), 1)
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.match(report.bindings.package.sha256, /^[a-f0-9]{64}$/)
  await assert.rejects(main([...args, '--output', packagePath]), /overwrite/)
  await assert.rejects(main([...args, '--output', output]), /EEXIST/)
})
